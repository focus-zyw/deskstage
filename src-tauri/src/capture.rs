// 屏幕截图(ShareX 式冻结框选)的 Rust 侧:
// - capture_screen:BitBlt 冻结主屏(物理像素)→ PNG 存临时文件,返回路径
// - capture_finish:覆盖窗框选后按物理像素裁剪 → RGBA 写入系统剪贴板 → 删临时文件
// - set_capture_excluded:SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
//   把本窗口从系统级屏幕捕获中排除(截图/OBS 录屏都拍不到角色),需 Win10 2004+
//
// 角色排除是双保险:主窗口在冻结抓屏前由前端隐藏 260ms(WDA 关闭时的兜底),
// WDA 开启时即使窗口可见,抓屏/录屏也不会带上角色。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

fn temp_capture_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data")
        .join("temp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("screenshot-frozen.png"))
}

/// 把本窗口从系统级屏幕捕获中排除(enable)/恢复可见于捕获(disable)。
/// WDA_EXCLUDEFROMCAPTURE 需 Windows 10 2004+;老系统上返回错误由前端忽略。
#[tauri::command]
pub fn set_capture_excluded(window: tauri::WebviewWindow, enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
        };
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let affinity = if enable {
            WDA_EXCLUDEFROMCAPTURE
        } else {
            WDA_NONE
        };
        unsafe { SetWindowDisplayAffinity(hwnd, affinity).map_err(|e| e.to_string())? };
    }
    #[cfg(not(windows))]
    let _ = (window, enable);
    Ok(())
}

/// 冻结主屏为 PNG(物理像素),返回临时文件路径。
#[tauri::command]
#[cfg(windows)]
pub fn capture_screen(app: AppHandle) -> Result<String, String> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        if w <= 0 || h <= 0 {
            return Err("获取屏幕尺寸失败".into());
        }
        let hdc_screen = GetDC(None);
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        let bmp = CreateCompatibleBitmap(hdc_screen, w, h);
        let old = SelectObject(hdc_mem, bmp.into());

        // CAPTUREBLT:连带分层窗口(否则半透明元素会缺)
        let blit = BitBlt(
            hdc_mem,
            0,
            0,
            w,
            h,
            Some(hdc_screen),
            0,
            0,
            SRCCOPY | CAPTUREBLT,
        );

        // top-down(negative height)逐行 BGRA
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(
            hdc_mem,
            bmp,
            0,
            h as u32,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        SelectObject(hdc_mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(None, hdc_screen);

        if blit.is_err() || lines != h {
            return Err("抓屏失败".into());
        }

        // BGRA → RGBA(裁剪/剪贴板都吃 RGBA)
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        let img = image::RgbaImage::from_raw(w as u32, h as u32, buf).ok_or("图像缓冲错误")?;
        let path = temp_capture_path(&app)?;
        img.save_with_format(&path, image::ImageFormat::Png)
            .map_err(|e| format!("保存截图失败:{e}"))?;
        Ok(path.to_string_lossy().into_owned())
    }
}

#[tauri::command]
#[cfg(not(windows))]
pub fn capture_screen(_app: AppHandle) -> Result<String, String> {
    Err("仅支持 Windows".into())
}

/// 按物理像素从冻结图裁出选区;用途(剪贴板/落盘)与临时文件清理由调用方决定。
fn crop_frozen(
    app: &AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<image::RgbaImage, String> {
    if width < 1 || height < 1 {
        return Err("选区太小".into());
    }
    let path = temp_capture_path(app)?;
    let img = image::open(&path).map_err(|e| format!("读取冻结图失败:{e}"))?;
    let img = img.crop_imm(
        x.max(0) as u32,
        y.max(0) as u32,
        width as u32,
        height as u32,
    );
    Ok(img.to_rgba8())
}

fn cleanup_frozen(app: &AppHandle) {
    if let Ok(path) = temp_capture_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// 覆盖窗框选完成:按物理像素裁剪冻结图 → RGBA 写入系统剪贴板 → 清理临时文件。
#[tauri::command]
pub fn capture_finish(
    app: AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let rgba = crop_frozen(&app, x, y, width, height)?;
    let (w, h) = rgba.dimensions();
    let image = tauri::image::Image::new_owned(rgba.into_raw(), w, h);
    app.clipboard()
        .write_image(&image)
        .map_err(|e| format!("写入剪贴板失败:{e}"))?;
    cleanup_frozen(&app);
    Ok(())
}

/// 框选另存为:裁剪冻结图 → PNG 写入用户在保存对话框选定的路径 → 清理临时文件。
#[tauri::command]
pub fn capture_save(
    app: AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    path: String,
) -> Result<(), String> {
    let rgba = crop_frozen(&app, x, y, width, height)?;
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    rgba.save_with_format(&path, image::ImageFormat::Png)
        .map_err(|e| format!("保存截图失败:{e}"))?;
    cleanup_frozen(&app);
    Ok(())
}

/// 丢弃冻结图(取消框选时前端调用,避免临时文件残留)。
#[tauri::command]
pub fn capture_cleanup(app: AppHandle) -> Result<(), String> {
    cleanup_frozen(&app);
    Ok(())
}
