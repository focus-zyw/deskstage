// Windows 自带 OCR:读剪贴板里的图片 → 识别文本行。
// 关键:剪贴板/数据传输的 WinRT 类必须从 STA(单线程套间)激活——
// 在 MTA 线程上会报"不支持从MTA中激活单线程类"。
// 因此整个流程放到专用 STA 线程上执行:初始化 STA → 发起 WinRT 异步 →
// 以轮询等待完成(完成回调走系统线程池,无需消息泵)。线程用完即弃。

use std::task::{Context, Poll};

#[derive(serde::Serialize)]
pub struct OcrOutput {
  pub lines: Vec<String>,
  pub lang: String,
}

#[tauri::command]
pub async fn ocr_clipboard() -> Result<OcrOutput, String> {
  // 专用 STA 线程执行,结果经通道回传
  let (tx, rx) = std::sync::mpsc::channel();
  std::thread::spawn(move || {
    let _ = tx.send(ocr_impl_sta());
  });
  match rx.recv() {
    Ok(r) => r,
    Err(_) => Err("OCR 线程异常退出".into()),
  }
}

#[cfg(windows)]
fn ocr_impl_sta() -> Result<OcrOutput, String> {
  use windows::ApplicationModel::DataTransfer::{Clipboard, StandardDataFormats};
  use windows::Globalization::Language;
  use windows::Graphics::Imaging::BitmapDecoder;
  use windows::Media::Ocr::OcrEngine;
  use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
  use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, MSG, PeekMessageW, PM_REMOVE, TranslateMessage};

  // 本线程是专用的,STA 初始化必成功(S_FALSE 表示已初始化过,同样可用)
  unsafe {
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
  }

  // 阻塞等待 WinRT 异步完成:完成回调在系统线程池触发,这里只等事件,无需消息泵。
  // IAsyncOperation 只实现 std 的 IntoFuture(不实现 Future),需引入 trait 后调 into_future()
  fn block<F, T>(fut: F) -> windows::core::Result<T>
  where
    F: std::future::IntoFuture<Output = windows::core::Result<T>>,
  {
    use std::task::{RawWaker, RawWakerVTable, Waker};
    fn noop(_: *const ()) {}
    fn clone(p: *const ()) -> RawWaker { RawWaker::new(p, &VTBL) }
    static VTBL: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
    let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTBL)) };
    let mut cx = Context::from_waker(&waker);
    let mut fut = Box::pin(fut.into_future());
    loop {
      if let Poll::Ready(v) = std::future::Future::poll(fut.as_mut(), &mut cx) {
        return v;
      }
      // STA 等待剪贴板延迟渲染数据时必须泵消息,否则会死等
      unsafe {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
          let _ = TranslateMessage(&msg);
          DispatchMessageW(&msg);
        }
      }
      std::thread::sleep(std::time::Duration::from_millis(4));
    }
  }

  fn str_err(e: windows::core::Error) -> String { e.to_string() }

  let view = Clipboard::GetContent().map_err(str_err)?;
  let bmp_format = StandardDataFormats::Bitmap().map_err(str_err)?;
  if !view.Contains(&bmp_format).unwrap_or(false) {
    return Err("剪贴板里没有图片(先截屏,再提取文字)".into());
  }

  let stream_ref = block(view.GetBitmapAsync().map_err(str_err)?).map_err(str_err)?;
  let stream = block(stream_ref.OpenReadAsync().map_err(str_err)?).map_err(str_err)?;
  let decoder = block(BitmapDecoder::CreateAsync(&stream).map_err(str_err)?).map_err(str_err)?;
  let bitmap = block(decoder.GetSoftwareBitmapAsync().map_err(str_err)?).map_err(str_err)?;

  // 优先 zh-Hans(简体输出);系统只有繁体包时回退 zh-Hant(输出会是繁体,前端提示)
  let try_lang = |tag: &str| -> Option<OcrEngine> {
    let lang = Language::CreateLanguage(&windows::core::HSTRING::from(tag)).ok()?;
    OcrEngine::TryCreateFromLanguage(&lang).ok()
  };
  let engine = try_lang("zh-Hans-CN")
    .or_else(|| try_lang("zh-Hant"))
    .or_else(|| OcrEngine::TryCreateFromUserProfileLanguages().ok());
  let Some(engine) = engine else {
    return Err("系统缺少中文 OCR 语言包:设置 → 时间和语言 → 语言 → 添加中文,并下载基本输入".into());
  };
  let lang = engine
    .RecognizerLanguage()
    .and_then(|l| l.LanguageTag())
    .map(|t| t.to_string())
    .unwrap_or_default();

  let result = block(engine.RecognizeAsync(&bitmap).map_err(str_err)?).map_err(str_err)?;
  let text = result.Text().map_err(str_err)?.to_string();

  let lines: Vec<String> = text
    .split(['\r', '\n'])
    .map(|l| l.trim())
    .filter(|l| !l.is_empty())
    .map(String::from)
    .collect();
  if lines.is_empty() {
    // 空结果时带上引擎语言:简体包未装时命中的常是繁体/英文引擎,便于定位
    let tag = engine
      .RecognizerLanguage()
      .and_then(|l| l.LanguageTag())
      .map(|t| t.to_string())
      .unwrap_or_default();
    if !tag.starts_with("zh-Hans") {
      return Err(format!(
        "没识别出文字(当前识别引擎:{tag};系统未装简体中文识别组件——到 设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项,下载'文字识别'后重试)"
      ));
    }
    return Err("没识别出文字(该区域可能没有可识别文本)".into());
  }
  Ok(OcrOutput { lines, lang: engine_tag_of(&engine) })
}



#[cfg(not(windows))]
#[tauri::command]
pub async fn ocr_clipboard() -> Result<Vec<String>, String> {
  Err("OCR 仅支持 Windows".into())
}

#[cfg(windows)]
fn engine_tag_of(engine: &windows::Media::Ocr::OcrEngine) -> String {
  engine
    .RecognizerLanguage()
    .and_then(|l| l.LanguageTag())
    .map(|t| t.to_string())
    .unwrap_or_default()
}
