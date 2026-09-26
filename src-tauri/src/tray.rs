//! Windows notification-area icon and macOS menu bar extra for close-to-tray.
//! Linux ignores the preference and still quits when the window closes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

/// A background-update restart is itself an app activation; ignore
/// activations this soon after starting hidden.
const RELAUNCH_ACTIVATION_GRACE: Duration = Duration::from_secs(10);
static LAUNCHED_HIDDEN: AtomicBool = AtomicBool::new(false);

/// True while the window was closed into the tray or menu bar. Minimize and
/// macOS Hide do not count, so background updates never interrupt them.
static HIDDEN_TO_TRAY: AtomicBool = AtomicBool::new(false);

pub fn is_hidden_to_tray() -> bool {
    HIDDEN_TO_TRAY.load(Ordering::Relaxed)
}

/// macOS activates the app when its notification is clicked. While closed to
/// the menu bar there is no window or Dock icon, so open the window.
pub fn should_show_on_activation(
    hidden_to_tray: bool,
    launched_hidden: bool,
    since_launch: Duration,
) -> bool {
    hidden_to_tray && !(launched_hidden && since_launch < RELAUNCH_ACTIVATION_GRACE)
}

/// Open the window when macOS activates Postal Snap while it is closed to
/// the menu bar, for example from a notification click.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
pub fn watch_activation<R: Runtime>(app: &AppHandle<R>) {
    use block2::RcBlock;
    use objc2_app_kit::NSApplicationDidBecomeActiveNotification;
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};
    use std::ptr::NonNull;

    let app = app.clone();
    let started = std::time::Instant::now();
    let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
        if should_show_on_activation(
            is_hidden_to_tray(),
            LAUNCHED_HIDDEN.load(Ordering::Relaxed),
            started.elapsed(),
        ) {
            show_main(&app);
        }
    });
    let center = NSNotificationCenter::defaultCenter();
    // SAFETY: the block runs on the main queue, where AppKit and Tauri window
    // calls belong, and captures only a Send + Sync AppHandle.
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidBecomeActiveNotification),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    // Observe for the life of the app.
    std::mem::forget(observer);
}

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

/// Close the window into the tray or menu bar. macOS also leaves the Dock
/// and hands focus back, like other menu bar apps.
pub fn hide_main_to_tray<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.hide();
    HIDDEN_TO_TRAY.store(true, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle();
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        let _ = app.hide();
    }
    crate::update_relaunch::arm_background_update(window.app_handle());
}

/// Start in the tray or menu bar with no window (update relaunch).
pub fn start_hidden_in_tray<R: Runtime>(app: &AppHandle<R>) {
    HIDDEN_TO_TRAY.store(true, Ordering::Relaxed);
    LAUNCHED_HIDDEN.store(true, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    HIDDEN_TO_TRAY.store(false, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let _ = app.show();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod native {
    use super::{show_main, AppHandle, Runtime};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Emitter;

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
    use super::{should_hide_on_close, should_show_on_activation};
    use std::time::Duration;

    #[test]
    fn activation_opens_the_window_only_when_closed_to_the_tray() {
        // A notification click while waiting in the menu bar opens the window.
        assert!(should_show_on_activation(true, false, Duration::ZERO));
        // Nothing to do while the window is already open.
        assert!(!should_show_on_activation(false, false, Duration::ZERO));
        // A background-update restart activates the app; stay hidden.
        assert!(!should_show_on_activation(
            true,
            true,
            Duration::from_secs(2)
        ));
        assert!(should_show_on_activation(
            true,
            true,
            Duration::from_secs(30)
        ));
    }

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
