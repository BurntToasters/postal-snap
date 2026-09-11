//! Windows 11 Snap Layout support for Postal Snap's frameless titlebar.
//!
//! WebView2 owns the client-area hit test, so an HTML maximize button cannot
//! return `HTMAXBUTTON`. A tiny transparent native child window covers only the
//! maximize button and supplies that native hit test. This mirrors IYERIS's
//! stable titlebar bridge and is a no-op on macOS and Linux.

const MAX_CLIENT_COORDINATE: i32 = 100_000;
const MAX_CAPTION_BUTTON_SIZE: i32 = 512;

fn valid_bounds(x: i32, y: i32, width: i32, height: i32) -> bool {
    let hidden = width == 0 && height == 0;
    let visible = (1..=MAX_CAPTION_BUTTON_SIZE).contains(&width)
        && (1..=MAX_CAPTION_BUTTON_SIZE).contains(&height);
    (hidden || visible)
        && (0..=MAX_CLIENT_COORDINATE).contains(&x)
        && (0..=MAX_CLIENT_COORDINATE).contains(&y)
}

/// Position, create, or hide the native maximize-button hit-test overlay.
/// Coordinates are physical pixels in the calling window's client space.
#[tauri::command]
pub fn set_snap_overlay_bounds(
    window: tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    if window.label() != "main" || !valid_bounds(x, y, width, height) {
        return Err("Window control geometry was invalid.".to_string());
    }
    #[cfg(target_os = "windows")]
    win::set_bounds(&window, x, y, width, height);
    #[cfg(not(target_os = "windows"))]
    let _ = (&window, x, y, width, height);
    Ok(())
}

/// Drop bookkeeping after Windows destroys the parent HWND.
pub fn on_window_destroyed(window: &tauri::Window) {
    #[cfg(target_os = "windows")]
    win::remove(window);
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

#[cfg(target_os = "windows")]
mod win {
    // All unsafe code is confined to this reviewed Win32 adapter. HWND values
    // come from Tauri, calls run on the owning thread, and geometry is bounded
    // before this module receives it.
    #![allow(unsafe_code)]

    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};

    use tauri::{Emitter, WebviewWindow, Window};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetWindowLongPtrW, RegisterClassExW, SetWindowLongPtrW,
        SetWindowPos, ShowWindow, GWLP_USERDATA, HTMAXBUTTON, HWND_TOP, SWP_NOACTIVATE,
        SWP_SHOWWINDOW, SW_HIDE, WINDOW_EX_STYLE, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP,
        WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS,
    };

    struct Overlay {
        hwnd: isize,
        window: WebviewWindow,
        hovered: bool,
    }

    fn overlays() -> &'static Mutex<HashMap<isize, Overlay>> {
        static OVERLAYS: OnceLock<Mutex<HashMap<isize, Overlay>>> = OnceLock::new();
        OVERLAYS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn class_name() -> PCWSTR {
        w!("PostalSnapSnapOverlay")
    }

    fn parent_hwnd(window: &WebviewWindow) -> Option<isize> {
        window.hwnd().ok().map(|handle| handle.0 as isize)
    }

    pub fn set_bounds(window: &WebviewWindow, x: i32, y: i32, width: i32, height: i32) {
        let Some(parent) = parent_hwnd(window) else {
            return;
        };
        let owned = window.clone();
        // Tauri commands can run on worker threads; Win32 window operations
        // must run on the thread that owns the parent window.
        let _ = window.run_on_main_thread(move || unsafe {
            let overlay = match overlay_for(parent) {
                Some(hwnd) => hwnd,
                None => match create_overlay(parent, owned) {
                    Some(hwnd) => hwnd,
                    None => return,
                },
            };
            if width == 0 || height == 0 {
                let _ = ShowWindow(overlay, SW_HIDE);
            } else {
                let _ = SetWindowPos(
                    overlay,
                    Some(HWND_TOP),
                    x,
                    y,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        });
    }

    pub fn remove(window: &Window) {
        if let Ok(handle) = window.hwnd() {
            if let Ok(mut map) = overlays().lock() {
                map.remove(&(handle.0 as isize));
            }
        }
    }

    fn overlay_for(parent: isize) -> Option<HWND> {
        let map = overlays().lock().ok()?;
        map.get(&parent)
            .map(|overlay| HWND(overlay.hwnd as *mut c_void))
    }

    /// SAFETY: caller runs on parent window's owning thread. Parent HWND comes
    /// from Tauri and remains alive while its child overlay exists.
    unsafe fn create_overlay(parent: isize, window: WebviewWindow) -> Option<HWND> {
        ensure_class();
        let instance = HINSTANCE(GetModuleHandleW(PCWSTR::null()).ok()?.0);
        let overlay = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name(),
            PCWSTR::null(),
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            Some(HWND(parent as *mut c_void)),
            None,
            Some(instance),
            None,
        )
        .ok()?;
        SetWindowLongPtrW(overlay, GWLP_USERDATA, parent);
        if let Ok(mut map) = overlays().lock() {
            map.insert(
                parent,
                Overlay {
                    hwnd: overlay.0 as isize,
                    window,
                    hovered: false,
                },
            );
        }
        Some(overlay)
    }

    /// SAFETY: caller runs on main thread. Registration happens once.
    unsafe fn ensure_class() {
        static REGISTERED: OnceLock<bool> = OnceLock::new();
        REGISTERED.get_or_init(|| {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(overlay_proc),
                hInstance: HINSTANCE(GetModuleHandleW(PCWSTR::null()).unwrap_or_default().0),
                lpszClassName: class_name(),
                ..Default::default()
            };
            RegisterClassExW(&class);
            true
        });
    }

    fn window_for(overlay: HWND) -> Option<WebviewWindow> {
        let parent = unsafe { GetWindowLongPtrW(overlay, GWLP_USERDATA) };
        let map = overlays().lock().ok()?;
        map.get(&parent).map(|entry| entry.window.clone())
    }

    fn set_hovered(overlay: HWND, hovered: bool) -> bool {
        let parent = unsafe { GetWindowLongPtrW(overlay, GWLP_USERDATA) };
        let mut map = match overlays().lock() {
            Ok(map) => map,
            Err(_) => return false,
        };
        match map.get_mut(&parent) {
            Some(entry) if entry.hovered != hovered => {
                entry.hovered = hovered;
                true
            }
            _ => false,
        }
    }

    unsafe extern "system" fn overlay_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_NCHITTEST => return LRESULT(HTMAXBUTTON as isize),
            WM_NCLBUTTONDOWN => return LRESULT(0),
            WM_NCLBUTTONUP => {
                if let Some(window) = window_for(hwnd) {
                    let maximized = window.is_maximized().unwrap_or(false);
                    let _ = if maximized {
                        window.unmaximize()
                    } else {
                        window.maximize()
                    };
                }
                return LRESULT(0);
            }
            WM_NCMOUSEMOVE => {
                if set_hovered(hwnd, true) {
                    if let Some(window) = window_for(hwnd) {
                        let _ = window.emit("snap-max-hover", true);
                    }
                    let mut tracking = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE | TME_NONCLIENT,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    let _ = TrackMouseEvent(&mut tracking);
                }
                return LRESULT(0);
            }
            WM_NCMOUSELEAVE if set_hovered(hwnd, false) => {
                if let Some(window) = window_for(hwnd) {
                    let _ = window.emit("snap-max-hover", false);
                }
            }
            _ => {}
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::valid_bounds;

    #[test]
    fn accepts_visible_and_hidden_caption_bounds() {
        assert!(valid_bounds(100, 0, 46, 44));
        assert!(valid_bounds(0, 0, 0, 0));
    }

    #[test]
    fn rejects_partial_hidden_negative_and_oversized_bounds() {
        assert!(!valid_bounds(0, 0, 0, 44));
        assert!(!valid_bounds(-1, 0, 46, 44));
        assert!(!valid_bounds(0, 0, 513, 44));
    }
}
