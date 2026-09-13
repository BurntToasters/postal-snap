//! Native window blur: Windows Mica / Acrylic via public OS APIs.
//! macOS keeps opaque chrome because making WKWebView transparent requires the
//! private `macos-private-api` feature, which must stay off for the store
//! train. Linux is intentionally a no-op and stays fully opaque.

use tauri::WebviewWindow;

#[cfg(target_os = "windows")]
fn acrylic_tint(dark: bool) -> (u8, u8, u8, u8) {
    if dark {
        (30, 30, 30, 180)
    } else {
        (245, 245, 245, 200)
    }
}

#[cfg(target_os = "windows")]
fn apply_windows(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    use window_vibrancy::{apply_acrylic, apply_mica};
    match apply_mica(window, Some(dark)) {
        Ok(()) => Ok(()),
        Err(_) => apply_acrylic(window, Some(acrylic_tint(dark)))
            .map_err(|_| "Could not apply window glass.".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn clear_windows(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::{clear_acrylic, clear_mica};
    let mica = clear_mica(window);
    let acrylic = clear_acrylic(window);
    if mica.is_ok() || acrylic.is_ok() {
        Ok(())
    } else {
        Err("Could not clear window glass.".to_string())
    }
}

fn paint_opaque_background(window: &WebviewWindow, dark: bool) {
    let color = if dark {
        tauri::window::Color(0x12, 0x12, 0x12, 0xff)
    } else {
        tauri::window::Color(0xf5, 0xf5, 0xf5, 0xff)
    };
    let _ = window.set_background_color(Some(color));
}

pub fn apply_basic_window_fx(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
        let result = apply_windows(window, dark);
        if result.is_err() {
            paint_opaque_background(window, dark);
        }
        result
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dark;
        paint_opaque_background(window, dark);
        Ok(())
    }
}

pub fn clear_basic_window_fx(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let result = clear_windows(window);
        paint_opaque_background(window, dark);
        result
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dark;
        paint_opaque_background(window, dark);
        Ok(())
    }
}

/// Enable or disable native background blur / glass on the calling window.
#[tauri::command]
pub fn set_workspace_window_fx(
    window: WebviewWindow,
    enabled: bool,
    dark: bool,
) -> Result<bool, String> {
    if !supports_basic_window_fx() {
        paint_opaque_background(&window, dark);
        let _ = enabled;
        return Ok(false);
    }

    if enabled {
        apply_basic_window_fx(&window, dark).map(|()| true)
    } else {
        clear_basic_window_fx(&window, dark).map(|()| false)
    }
}

pub fn supports_basic_window_fx() -> bool {
    cfg!(target_os = "windows")
}

/// WebKit does not implement `prefers-reduced-transparency`, so macOS must
/// consult the OS setting directly when a future build offers glass again.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn accessibility_reduce_transparency() -> bool {
    use objc2_app_kit::NSWorkspace;
    NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn accessibility_reduce_transparency() -> bool {
    false
}

#[tauri::command]
pub fn supports_workspace_window_fx() -> bool {
    supports_basic_window_fx()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_basic_window_fx_matches_platform() {
        let expected = cfg!(target_os = "windows");
        assert_eq!(supports_basic_window_fx(), expected);
        assert_eq!(supports_workspace_window_fx(), expected);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn acrylic_tint_is_theme_aware() {
        let dark = acrylic_tint(true);
        let light = acrylic_tint(false);
        assert_eq!(dark, (30, 30, 30, 180));
        assert_eq!(light.0, 245);
        assert!(light.0 > dark.0);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_platforms_do_not_claim_native_glass() {
        assert!(!supports_basic_window_fx());
        assert!(!supports_workspace_window_fx());
    }
}
