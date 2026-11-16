//! Native window glass for the main window.
//! Windows uses Mica through public APIs. macOS uses sidebar vibrancy only in
//! builds with `macos-vibrancy`, which enables Tauri's private API; direct
//! builds opt in and store builds never do. Everything else stays opaque.

use tauri::WebviewWindow;

const DARK_CHROME: tauri::window::Color = tauri::window::Color(0x12, 0x12, 0x12, 0xff);
const LIGHT_CHROME: tauri::window::Color = tauri::window::Color(0xf5, 0xf5, 0xf5, 0xff);

#[cfg(any(
    target_os = "windows",
    all(target_os = "macos", feature = "macos-vibrancy")
))]
const GLASS_FAILED: &str = "Could not apply window glass.";

#[cfg(any(
    target_os = "windows",
    all(target_os = "macos", feature = "macos-vibrancy")
))]
fn apply_native_glass(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        window_vibrancy::apply_mica(window, Some(dark)).map_err(|_| GLASS_FAILED.to_string())
    }
    #[cfg(all(target_os = "macos", feature = "macos-vibrancy"))]
    {
        let _ = dark;
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        apply_vibrancy(
            window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        )
        .map_err(|_| GLASS_FAILED.to_string())
    }
}

#[cfg(any(
    target_os = "windows",
    all(target_os = "macos", feature = "macos-vibrancy")
))]
fn clear_native_glass(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        window_vibrancy::clear_mica(window).map_err(|_| "Could not clear window glass.".to_string())
    }
    #[cfg(all(target_os = "macos", feature = "macos-vibrancy"))]
    {
        window_vibrancy::clear_vibrancy(window)
            .map(|_| ())
            .map_err(|_| "Could not clear window glass.".to_string())
    }
}

fn paint_opaque_background(window: &WebviewWindow, dark: bool) {
    let color = if dark { DARK_CHROME } else { LIGHT_CHROME };
    let _ = window.set_background_color(Some(color));
}

pub fn apply_basic_window_fx(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(any(
        target_os = "windows",
        all(target_os = "macos", feature = "macos-vibrancy")
    ))]
    {
        let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
        let result = apply_native_glass(window, dark);
        if result.is_err() {
            paint_opaque_background(window, dark);
        }
        result
    }
    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "macos", feature = "macos-vibrancy")
    )))]
    {
        let _ = window;
        paint_opaque_background(window, dark);
        Ok(())
    }
}

pub fn clear_basic_window_fx(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(any(
        target_os = "windows",
        all(target_os = "macos", feature = "macos-vibrancy")
    ))]
    {
        let result = clear_native_glass(window);
        paint_opaque_background(window, dark);
        result
    }
    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "macos", feature = "macos-vibrancy")
    )))]
    {
        let _ = window;
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

/// True when this build can draw native glass behind the window.
pub fn supports_basic_window_fx() -> bool {
    cfg!(target_os = "windows") || cfg!(all(target_os = "macos", feature = "macos-vibrancy"))
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
    fn supports_basic_window_fx_matches_support_matrix() {
        let expected = cfg!(target_os = "windows")
            || cfg!(all(target_os = "macos", feature = "macos-vibrancy"));
        assert_eq!(supports_basic_window_fx(), expected);
        assert_eq!(supports_workspace_window_fx(), expected);
    }

    #[cfg(all(target_os = "macos", feature = "macos-vibrancy"))]
    #[test]
    fn macos_vibrancy_build_claims_native_glass() {
        assert!(supports_basic_window_fx());
    }

    #[cfg(all(target_os = "macos", not(feature = "macos-vibrancy")))]
    #[test]
    fn macos_without_vibrancy_feature_stays_opaque() {
        assert!(!supports_basic_window_fx());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_stays_opaque() {
        assert!(!supports_basic_window_fx());
    }
}
