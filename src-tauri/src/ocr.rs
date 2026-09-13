// Windows 自带 OCR:读剪贴板里的图片 → 识别文本行。
// 关键:剪贴板/数据传输的 WinRT 类必须从 STA(单线程套间)激活——
// 在 MTA 线程上会报"不支持从MTA中激活单线程类"。
// 因此整个流程放到专用 STA 线程上执行:初始化 STA → 发起 WinRT 异步 →
// 以轮询等待完成(完成回调走系统线程池,无需消息泵)。线程用完即弃。
// 另含 clipboard_image_base64:剪贴板位图 → PNG base64,供前端把原图发给
// 视觉模型(AI 识别优先、本地 OCR 兜底,见 src/translation/ocr.ts)。

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

#[tauri::command]
pub async fn clipboard_image_base64() -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(clipboard_png_base64_sta());
    });
    match rx.recv() {
        Ok(r) => r,
        Err(_) => Err("剪贴板读取线程异常退出".into()),
    }
}

#[cfg(windows)]
fn str_err(e: windows::core::Error) -> String {
    e.to_string()
}

// 阻塞等待 WinRT 异步完成:完成回调在系统线程池触发,这里只等事件,无需消息泵。
// IAsyncOperation 只实现 std 的 IntoFuture(不实现 Future),需引入 trait 后调 into_future()
#[cfg(windows)]
fn block<F, T>(fut: F) -> windows::core::Result<T>
where
    F: std::future::IntoFuture<Output = windows::core::Result<T>>,
{
    use std::task::RawWaker;
    use std::task::RawWakerVTable;
    use std::task::Waker;
    fn noop(_: *const ()) {}
    fn clone(p: *const ()) -> RawWaker {
        RawWaker::new(p, &VTBL)
    }
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
            use windows::Win32::UI::WindowsAndMessaging::{
                DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
            };
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(4));
    }
}

// 剪贴板位图 → PNG base64。失败信息原样抛给前端,由前端决定提示或回落本地 OCR。
#[cfg(windows)]
fn clipboard_png_base64_sta() -> Result<String, String> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    let bitmap = read_clipboard_bitmap_sta()?;
    encode_png_base64(&bitmap)
}

// 从剪贴板取位图并解码为 SoftwareBitmap(须在 STA 线程上调用)。
#[cfg(windows)]
fn read_clipboard_bitmap_sta() -> Result<windows::Graphics::Imaging::SoftwareBitmap, String> {
    use windows::ApplicationModel::DataTransfer::{Clipboard, StandardDataFormats};
    use windows::Graphics::Imaging::BitmapDecoder;

    let view = Clipboard::GetContent().map_err(str_err)?;
    let bmp_format = StandardDataFormats::Bitmap().map_err(str_err)?;
    if !view.Contains(&bmp_format).unwrap_or(false) {
        return Err("剪贴板里没有图片(先截屏,再提取文字)".into());
    }

    let stream_ref = block(view.GetBitmapAsync().map_err(str_err)?).map_err(str_err)?;
    let stream = block(stream_ref.OpenReadAsync().map_err(str_err)?).map_err(str_err)?;
    let decoder = block(BitmapDecoder::CreateAsync(&stream).map_err(str_err)?).map_err(str_err)?;
    block(decoder.GetSoftwareBitmapAsync().map_err(str_err)?).map_err(str_err)
}

// SoftwareBitmap 统一重编码为 PNG(任意来源格式都收敛,体积远小于 BMP),再转 base64。
#[cfg(windows)]
fn encode_png_base64(
    bitmap: &windows::Graphics::Imaging::SoftwareBitmap,
) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    use windows::Graphics::Imaging::BitmapEncoder;
    use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};

    let stream = InMemoryRandomAccessStream::new().map_err(str_err)?;
    let encoder = block(
        BitmapEncoder::CreateAsync(BitmapEncoder::PngEncoderId().map_err(str_err)?, &stream)
            .map_err(str_err)?,
    )
    .map_err(str_err)?;
    encoder.SetSoftwareBitmap(bitmap).map_err(str_err)?;
    block(encoder.FlushAsync().map_err(str_err)?).map_err(str_err)?;

    let size = stream.Size().map_err(str_err)?;
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).map_err(str_err)?)
        .map_err(str_err)?;
    let loaded = block(reader.LoadAsync(size as u32).map_err(str_err)?).map_err(str_err)?;
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes).map_err(str_err)?;
    Ok(STANDARD.encode(&bytes))
}

#[cfg(windows)]
fn ocr_impl_sta() -> Result<OcrOutput, String> {
    use windows::Globalization::Language;
    use windows::Media::Ocr::OcrEngine;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

    // 本线程是专用的,STA 初始化必成功(S_FALSE 表示已初始化过,同样可用)
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let bitmap = read_clipboard_bitmap_sta()?;

    // 优先 zh-Hans(简体输出);系统只有繁体包时回退 zh-Hant(输出会是繁体,前端提示)
    let try_lang = |tag: &str| -> Option<OcrEngine> {
        let lang = Language::CreateLanguage(&windows::core::HSTRING::from(tag)).ok()?;
        OcrEngine::TryCreateFromLanguage(&lang).ok()
    };
    let engine = try_lang("zh-Hans-CN")
        .or_else(|| try_lang("zh-Hant"))
        .or_else(|| OcrEngine::TryCreateFromUserProfileLanguages().ok());
    let Some(engine) = engine else {
        return Err(
            "系统缺少中文 OCR 语言包:设置 → 时间和语言 → 语言 → 添加中文,并下载基本输入".into(),
        );
    };

    let result = block(engine.RecognizeAsync(&bitmap).map_err(str_err)?).map_err(str_err)?;
    let text = result.Text().map_err(str_err)?.to_string();

    let lines: Vec<String> = text
        .split(['\r', '\n'])
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(squeeze_cjk_spaces)
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
    Ok(OcrOutput {
        lines,
        lang: engine_tag_of(&engine),
    })
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

// Windows OCR 对中文逐字输出,每个字之间都插空格("你 好 世 界")。
// 只在空格两侧都是 CJK 字符时才删,中西文混排间的空格保留。
#[cfg(windows)]
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
    0x3000..=0x303F      // CJK 符号与标点(。、《》)
    | 0x3400..=0x4DBF    // 汉字扩展 A
    | 0x4E00..=0x9FFF    // 基本区汉字
    | 0xF900..=0xFAFF    // 兼容汉字
    | 0xFF00..=0xFFEF    // 全角字符(,!?及全角字母)
    | 0x20000..=0x2FA1F) // 扩展 B 起
}

#[cfg(windows)]
fn squeeze_cjk_spaces(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_whitespace() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // 找出连续空白串 [i, j),两侧都是 CJK 才整段删除
        let mut j = i;
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        if !(i > 0 && j < chars.len() && is_cjk(chars[i - 1]) && is_cjk(chars[j])) {
            out.extend(chars[i..j].iter());
        }
        i = j;
    }
    out
}

#[cfg(all(test, windows))]
mod tests {
    use super::squeeze_cjk_spaces;

    #[test]
    fn removes_spaces_only_between_cjk() {
        assert_eq!(
            squeeze_cjk_spaces("你 好 世 界 ， 虚 拟 角 色 中 文 测 试 123"),
            "你好世界，虚拟角色中文测试 123"
        );
        assert_eq!(squeeze_cjk_spaces("abc 你 好 def"), "abc 你好 def");
        assert_eq!(squeeze_cjk_spaces("hello world"), "hello world");
    }

    /// 手动端到端:先跑 temp/test-ocr.ps1 往剪贴板放一张图,再 `cargo test -- --ignored`。
    /// 无图时跳过,不因剪贴板状态而误报。
    #[test]
    #[ignore]
    fn clipboard_png_base64_e2e() {
        match super::clipboard_png_base64_sta() {
            Ok(b64) => assert!(
                b64.starts_with("iVBOR"),
                "应输出 PNG base64,实得前缀:{}",
                &b64[..32.min(b64.len())]
            ),
            Err(e) => {
                if e.contains("剪贴板里没有图片") {
                    println!("skip: {e}");
                } else {
                    panic!("{e}");
                }
            }
        }
    }
}
