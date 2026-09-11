use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePointerRegion {
    pub id: String,
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePointerEvent {
    kind: &'static str,
    id: String,
    x: i32,
    y: i32,
    delta_y: i32,
}

#[cfg(windows)]
mod platform {
    use super::{NativePointerEvent, NativePointerRegion};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::thread;
    use tauri::Emitter;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, MSG,
        MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEWHEEL,
    };

    #[derive(Default)]
    struct HookState {
        regions: Vec<NativePointerRegion>,
        captured_id: Option<String>,
        sender: Option<mpsc::Sender<NativePointerEvent>>,
    }

    static STATE: OnceLock<Mutex<HookState>> = OnceLock::new();

    fn state() -> &'static Mutex<HookState> {
        STATE.get_or_init(|| Mutex::new(HookState::default()))
    }

    fn containing_region(regions: &[NativePointerRegion], x: i32, y: i32) -> Option<String> {
        regions
            .iter()
            .find(|region| {
                x >= region.left && x <= region.right && y >= region.top && y <= region.bottom
            })
            .map(|region| region.id.clone())
    }

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= HC_ACTION as i32 {
            // WH_MOUSE_LL guarantees lparam points to MSLLHOOKSTRUCT for mouse messages.
            let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            let message = wparam.0 as u32;
            if let Ok(mut hook) = state().lock() {
                let event =
                    match message {
                        WM_LBUTTONDOWN => containing_region(&hook.regions, info.pt.x, info.pt.y)
                            .map(|id| {
                                hook.captured_id = Some(id.clone());
                                NativePointerEvent {
                                    kind: "down",
                                    id,
                                    x: info.pt.x,
                                    y: info.pt.y,
                                    delta_y: 0,
                                }
                            }),
                        WM_LBUTTONUP => hook.captured_id.take().map(|id| NativePointerEvent {
                            kind: "up",
                            id,
                            x: info.pt.x,
                            y: info.pt.y,
                            delta_y: 0,
                        }),
                        WM_MOUSEWHEEL => containing_region(&hook.regions, info.pt.x, info.pt.y)
                            .map(|id| {
                                // Win32 向上滚为正，DOM WheelEvent 向上滚的 deltaY 为负。
                                let wheel_delta = ((info.mouseData >> 16) as u16 as i16) as i32;
                                NativePointerEvent {
                                    kind: "wheel",
                                    id,
                                    x: info.pt.x,
                                    y: info.pt.y,
                                    delta_y: -wheel_delta,
                                }
                            }),
                        _ => None,
                    };

                if let Some(event) = event {
                    if let Some(sender) = &hook.sender {
                        let _ = sender.send(event);
                    }
                    // 原生热区的事件由前端合成；不让点击/滚轮继续落到底层浏览器。
                    return LRESULT(1);
                }
            }
        }

        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    pub fn set_regions(regions: Vec<NativePointerRegion>) {
        if let Ok(mut hook) = state().lock() {
            hook.regions = regions;
        }
    }

    pub fn spawn(handle: tauri::AppHandle) {
        let (sender, receiver) = mpsc::channel();
        if let Ok(mut hook) = state().lock() {
            hook.sender = Some(sender);
        }

        thread::spawn(move || {
            for event in receiver {
                let _ = handle.emit("native-pointer", event);
            }
        });

        thread::spawn(|| unsafe {
            let Ok(hook) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) else {
                log::error!("无法安装角色鼠标钩子");
                return;
            };
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {}
            let _ = UnhookWindowsHookEx(hook);
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn native_region_edges_are_inclusive() {
            let regions = vec![NativePointerRegion {
                id: "char-a".into(),
                left: 10,
                top: 20,
                right: 30,
                bottom: 40,
            }];
            assert_eq!(
                containing_region(&regions, 10, 40).as_deref(),
                Some("char-a")
            );
            assert_eq!(containing_region(&regions, 31, 40), None);
        }
    }
}

#[tauri::command]
pub fn set_native_pointer_regions(regions: Vec<NativePointerRegion>) {
    #[cfg(windows)]
    platform::set_regions(regions);
    #[cfg(not(windows))]
    let _ = regions;
}

pub fn spawn(handle: tauri::AppHandle) {
    #[cfg(windows)]
    platform::spawn(handle);
    #[cfg(not(windows))]
    let _ = handle;
}
