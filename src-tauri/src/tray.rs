//! Windows notification-area icon and macOS menu bar extra for close-to-tray.
//! Linux ignores the preference and still quits when the window closes.

use tauri::{AppHandle, Emitter, Manager, Runtime};

pub fn should_hide_on_close(close_to_tray: bool, tray_active: bool) -> bool {
    if !close_to_tray {
        return false;
    }
    if cfg!(target_os = "macos") {
        return true;
    }
    cfg!(target_os = "windows") && tray_active
}

pub fn tray_is_active() -> bool {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        native::tray_is_active()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        false
    }
}

pub fn sync<R: Runtime>(app: &AppHandle<R>, close_to_tray: bool) {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    native::sync(app, close_to_tray);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = (app, close_to_tray);
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod native {
    use super::{show_main, AppHandle, Emitter, Runtime};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    const TRAY_ID: &str = "postal-snap";
    static TRAY_ACTIVE: AtomicBool = AtomicBool::new(false);

    pub fn tray_is_active() -> bool {
        TRAY_ACTIVE.load(Ordering::Relaxed)
    }

    pub fn sync<R: Runtime>(app: &AppHandle<R>, close_to_tray: bool) {
        if !close_to_tray {
            remove(app);
            show_main(app);
            return;
        }
        if tray_is_active() && app.tray_by_id(TRAY_ID).is_some() {
            return;
        }
        match install(app) {
            Ok(()) => TRAY_ACTIVE.store(true, Ordering::Relaxed),
            Err(_) => {
                TRAY_ACTIVE.store(false, Ordering::Relaxed);
                let _ = app.emit(
                    "app-warning",
                    "Postal Snap could not show the background icon.",
                );
            }
        }
    }

    fn remove<R: Runtime>(app: &AppHandle<R>) {
        let _ = app.remove_tray_by_id(TRAY_ID);
        TRAY_ACTIVE.store(false, Ordering::Relaxed);
    }

    fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        let icon =
            tauri::image::Image::from_bytes(include_bytes!("../icons/macos_statusbaricn.png"))
                .map_err(|_| "background icon unavailable".to_string())?;
        #[cfg(target_os = "windows")]
        let icon = app
            .default_window_icon()
            .cloned()
            .ok_or_else(|| "background icon unavailable".to_string())?;
        let open = MenuItemBuilder::with_id("tray-open", "Open Postal Snap")
            .build(app)
            .map_err(|_| "background icon unavailable".to_string())?;
        let quit = MenuItemBuilder::with_id("tray-quit", "Quit Postal Snap")
            .build(app)
            .map_err(|_| "background icon unavailable".to_string())?;
        let menu = MenuBuilder::new(app)
            .items(&[&open, &quit])
            .build()
            .map_err(|_| "background icon unavailable".to_string())?;
        let builder = TrayIconBuilder::with_id(TRAY_ID)
            .icon(icon)
            .tooltip("Postal Snap")
            .menu(&menu)
            .show_menu_on_left_click(cfg!(target_os = "macos"))
            .on_menu_event(|app, event| match event.id.as_ref() {
                "tray-open" => show_main(app),
                "tray-quit" => {
                    let _ = app.emit("tray-quit", ());
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    if cfg!(target_os = "windows") {
                        show_main(tray.app_handle());
                    }
                }
            });
        #[cfg(target_os = "macos")]
        let builder = builder.icon_as_template(true);
        builder
            .build(app)
            .map_err(|_| "background icon unavailable".to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::should_hide_on_close;

    #[test]
    fn macos_status_bar_icon_is_png() {
        let bytes = include_bytes!("../icons/macos_statusbaricn.png");
        assert_eq!(
            &bytes[..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );
        let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
        assert!(width > 0 && height > 0);
    }

    #[test]
    fn hide_on_close_is_windows_or_macos_only() {
        assert!(!should_hide_on_close(false, true));
        assert!(!should_hide_on_close(false, false));
        if cfg!(target_os = "macos") {
            assert!(should_hide_on_close(true, false));
            assert!(should_hide_on_close(true, true));
        } else if cfg!(target_os = "windows") {
            assert!(!should_hide_on_close(true, false));
            assert!(should_hide_on_close(true, true));
        } else {
            assert!(!should_hide_on_close(true, true));
            assert!(!should_hide_on_close(true, false));
        }
    }
}
