//! Windows notification-area icon and macOS menu bar extra for close-to-tray.
//! Linux ignores the preference and still quits when the window closes.

use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(target_os = "macos", test))]
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

/// A background-update restart is itself an app activation; ignore
/// activations this soon after starting hidden.
#[cfg(any(target_os = "macos", test))]
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
#[cfg(any(target_os = "macos", test))]
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

/// Left click on the tray or menu bar icon hides the window when it is the
/// one in use, and otherwise brings it back and forward. A macOS menu bar
/// click keeps focus, so focus decides there; a Windows tray click moves
/// focus to the taskbar first, so visibility decides.
#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub fn tray_click_hides(
    visible: bool,
    minimized: bool,
    focused: bool,
    click_keeps_focus: bool,
) -> bool {
    visible && !minimized && (focused || !click_keeps_focus)
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TrayClickAction {
    Toggle,
    ShowMenu,
    Ignore,
}

/// Left up toggles. On macOS the menu is detached, so right up pops it;
/// Windows shows its attached menu natively.
#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub fn tray_click_action(
    button: tauri::tray::MouseButton,
    state: tauri::tray::MouseButtonState,
    is_macos: bool,
) -> TrayClickAction {
    use tauri::tray::{MouseButton, MouseButtonState};
    match (button, state) {
        (MouseButton::Left, MouseButtonState::Up) => TrayClickAction::Toggle,
        (MouseButton::Right, MouseButtonState::Up) if is_macos => TrayClickAction::ShowMenu,
        _ => TrayClickAction::Ignore,
    }
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
    use super::{show_main, tray_click_action, AppHandle, Runtime, TrayClickAction};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{TrayIconBuilder, TrayIconEvent};
    use tauri::{Emitter, Manager};

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

    fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if super::tray_click_hides(visible, minimized, focused, cfg!(target_os = "macos")) {
            // Same path as closing, so macOS leaves the Dock and a ready
            // update can install in the background.
            super::hide_main_to_tray(&window);
        } else {
            show_main(app);
        }
    }

    // performClick tracks the menu until it closes, so detach right after.
    #[cfg(target_os = "macos")]
    fn show_menu_once<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, menu: &tauri::menu::Menu<R>) {
        if tray.set_menu(Some(menu.clone())).is_err() {
            return;
        }
        let _ = tray.with_inner_tray_icon(|t| t.show_menu());
        let _ = tray.set_menu(None::<tauri::menu::Menu<R>>);
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
            .tooltip("Postal Snap");
        // macOS: an attached menu opens on left click, so attach it only
        // around a right click. Windows keeps the menu attached.
        #[cfg(target_os = "windows")]
        let builder = builder.menu(&menu);
        let builder = builder
            // Left click shows or hides the window; right click opens the menu.
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "tray-open" => show_main(app),
                "tray-quit" => {
                    let _ = app.emit("tray-quit", ());
                }
                _ => {}
            })
            .on_tray_icon_event(move |tray, event| {
                let TrayIconEvent::Click {
                    button,
                    button_state,
                    ..
                } = event
                else {
                    return;
                };
                match tray_click_action(button, button_state, cfg!(target_os = "macos")) {
                    TrayClickAction::Toggle => toggle_main(tray.app_handle()),
                    TrayClickAction::ShowMenu => {
                        #[cfg(target_os = "macos")]
                        show_menu_once(tray, &menu);
                    }
                    TrayClickAction::Ignore => {}
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
    use super::{
        should_hide_on_close, should_show_on_activation, tray_click_action, tray_click_hides,
        TrayClickAction,
    };
    use std::time::Duration;
    use tauri::tray::{MouseButton, MouseButtonState};

    // Failure modes for tray clicks:
    // - left click opens the menu instead of toggling (macOS attached menu)
    // - right click toggles the window instead of opening the menu
    // - Down and Up both fire, so the window toggles twice
    // - menu stays attached after the popup, so left click opens it again
    // - hidden window is not restored by a click
    // - Dock/Accessory policy is not reset when the window returns
    // - notification-click activation stops reopening the window
    #[test]
    fn left_up_toggles_on_both_platforms() {
        for mac in [true, false] {
            let up = MouseButtonState::Up;
            assert_eq!(
                tray_click_action(MouseButton::Left, up, mac),
                TrayClickAction::Toggle
            );
        }
    }

    #[test]
    fn right_up_opens_menu_only_on_macos() {
        let up = MouseButtonState::Up;
        assert_eq!(
            tray_click_action(MouseButton::Right, up, true),
            TrayClickAction::ShowMenu
        );
        // Windows opens its attached menu natively.
        assert_eq!(
            tray_click_action(MouseButton::Right, up, false),
            TrayClickAction::Ignore
        );
    }

    #[test]
    fn down_and_other_buttons_are_ignored() {
        for mac in [true, false] {
            for button in [MouseButton::Left, MouseButton::Right, MouseButton::Middle] {
                assert_eq!(
                    tray_click_action(button, MouseButtonState::Down, mac),
                    TrayClickAction::Ignore
                );
            }
            assert_eq!(
                tray_click_action(MouseButton::Middle, MouseButtonState::Up, mac),
                TrayClickAction::Ignore
            );
        }
    }

    #[test]
    fn left_click_toggles_the_window() {
        // macOS: the click keeps focus, so only the front window hides. A
        // window behind other apps comes forward instead.
        assert!(tray_click_hides(true, false, true, true));
        assert!(!tray_click_hides(true, false, false, true));
        // Windows: the taskbar takes focus first, so visibility decides.
        assert!(tray_click_hides(true, false, false, false));
        // Hidden or minimized: always bring it back.
        assert!(!tray_click_hides(false, false, true, true));
        assert!(!tray_click_hides(true, true, true, true));
        assert!(!tray_click_hides(true, true, false, false));
    }

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
