#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_nap;
mod commands;
mod content_blocking;
mod credentials;
mod db;
mod html_sanitize;
mod mail;
mod models;
// Background OAuth groundwork (no UI yet): consumed by a future setup flow.
#[allow(dead_code)]
mod oauth;
mod security;
mod settings;
mod storage;
mod threat_blocking;
mod window_fx;
mod window_snap;

use commands::AppState;
use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, MenuItemKind, SubmenuBuilder},
    Emitter, Manager, Runtime,
};
#[cfg(target_os = "macos")]
use tauri::{RunEvent, WindowEvent};

fn main() {
    let builder = tauri::Builder::default()
        .on_menu_event(|app, event| {
            let action = event.id().as_ref();
            if matches!(action, "settings" | "check-for-updates") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            let _ = app.emit("menu-action", action);
        })
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(all(
        feature = "direct-updater",
        not(any(feature = "flatpak", feature = "mas", feature = "msstore"))
    ))]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            std::fs::create_dir_all(&data_dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700))?;
            }
            // Windows keeps the mail database in the local (non-roaming)
            // profile; migrate any legacy roaming database first.
            let mail_dir = storage::mail_data_dir(app.handle())?;
            storage::migrate_legacy_mail_data(&data_dir, &mail_dir);
            std::fs::create_dir_all(&mail_dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&mail_dir, std::fs::Permissions::from_mode(0o700))?;
            }
            let database_path = mail_dir.join("postal-snap.sqlite3");
            let attachment_dir = mail_dir.join("draft-attachments");
            std::fs::create_dir_all(&attachment_dir)?;
            let orphan_cleanup_dir = attachment_dir.clone();
            let database = db::Database::open(&database_path).map_err(std::io::Error::other)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&database_path, std::fs::Permissions::from_mode(0o600))?;
            }
            let settings = settings::SettingsStore::load(data_dir.join("settings.json"), &database)
                .map_err(std::io::Error::other)?;
            app.manage(AppState::new(database, settings, attachment_dir));
            if std::env::args().any(|argument| argument == "--cleanup-credentials") {
                if let Ok(accounts) = app.state::<AppState>().db.list_accounts() {
                    for account in accounts {
                        let _ = credentials::remove(&account.id);
                    }
                }
                app.handle().exit(0);
                return Ok(());
            }
            tauri::async_runtime::spawn(content_blocking::warmup());
            tauri::async_runtime::spawn(threat_blocking::warmup());

            let handle = app.handle().clone();
            let (accounts, startup_error) = match app
                .state::<AppState>()
                .db
                .list_accounts()
            {
                Ok(accounts) => (accounts, None),
                Err(_) => (
                    Vec::new(),
                    Some(
                        "Postal Snap could not open saved accounts. Your mail data was not deleted. Restart Postal Snap to try again.".to_string(),
                    ),
                ),
            };
            let has_startup_error = startup_error.is_some();
            app.state::<AppState>().set_startup_error(startup_error)?;
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("Postal Snap window configuration is missing.")?;
            let window_builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)
                .map_err(|error| error.to_string())?
                .on_navigation(allowed_webview_navigation);
            #[cfg(target_os = "macos")]
            let window_builder = window_builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            // Frameless custom caption (IYERIS/Zinnia). Do not attach a Win32
            // menubar onto this HWND — muda paints it through glass on activate.
            #[cfg(target_os = "windows")]
            let window_builder = window_builder.decorations(false);
            window_builder.build().map_err(|error| error.to_string())?;
            install_menu(
                app,
                !has_startup_error && mail_actions_enabled(accounts.len()),
            )?;
            #[cfg(all(
                target_os = "linux",
                not(any(feature = "flatpak", feature = "mas", feature = "msstore"))
            ))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            if !has_startup_error {
                let account_ids = accounts
                    .iter()
                    .map(|account| account.id.clone())
                    .collect();
                tauri::async_runtime::spawn(commands::cleanup_orphaned_account_dirs(
                    orphan_cleanup_dir,
                    account_ids,
                ));
            }
            for account in accounts {
                let state = app.state::<AppState>();
                if state
                    .ensure_watcher(account.id.clone(), handle.clone())
                    .is_err()
                {
                    let _ = state.db.set_account_state(
                        &account.id,
                        "offline",
                        Some("Background sync is unavailable. Use Get Mail to retry."),
                    );
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window_snap::on_window_destroyed(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::accounts::list_accounts,
            commands::accounts::test_account,
            commands::accounts::test_saved_account,
            commands::accounts::update_account_password,
            commands::accounts::add_account,
            commands::accounts::remove_account,
            commands::accounts::erase_all_data,
            commands::sync::list_mailboxes,
            commands::sync::sync_account,
            commands::messages::list_messages,
            commands::messages::get_message,
            commands::messages::set_message_flags,
            commands::messages::set_messages_flags,
            commands::messages::move_message,
            commands::messages::move_message_to_mailbox,
            commands::messages::move_messages_to_mailbox,
            commands::messages::mark_mailbox_read,
            commands::folders::suggest_recipients,
            commands::folders::create_folder,
            commands::folders::rename_folder,
            commands::folders::delete_folder,
            commands::folders::empty_trash,
            commands::folders::empty_junk,
            commands::messages::search_cached_messages,
            commands::messages::search_server_messages,
            commands::drafts_send::save_draft,
            commands::drafts_send::list_drafts,
            commands::drafts_send::get_draft,
            commands::drafts_send::delete_draft,
            commands::drafts_send::send_message,
            commands::outbox::list_outbox,
            commands::outbox::get_outbox,
            commands::outbox::retry_outbox,
            commands::outbox::retry_sent_copy,
            commands::drafts_send::send_scheduled_outbox,
            commands::snooze_filters::snooze_message,
            commands::snooze_filters::unsnooze_message,
            commands::snooze_filters::list_snoozed,
            commands::snooze_filters::list_filter_rules,
            commands::snooze_filters::create_filter_rule,
            commands::snooze_filters::update_filter_rule,
            commands::snooze_filters::delete_filter_rule,
            commands::outbox::delete_outbox,
            commands::outbox::restore_outbox,
            commands::attachments::save_attachment,
            commands::attachments::preview_attachment,
            commands::attachments::prepare_forward_attachments,
            commands::attachments::choose_attachments,
            commands::security_net::fetch_remote_image,
            commands::security_net::inspect_external_url,
            commands::security_net::open_external_url,
            commands::security_net::open_help_url,
            commands::attachments::read_message_inline_image,
            commands::attachments::read_compose_image,
            commands::attachments::release_compose_attachments,
            commands::settings_system::get_settings,
            commands::settings_system::save_settings,
            commands::settings_system::set_mail_shortcut_guard,
            commands::settings_system::export_settings,
            commands::settings_system::import_settings,
            commands::settings_system::get_startup_notice,
            commands::settings_system::get_startup_error,
            commands::settings_system::get_cache_usage,
            commands::settings_system::clear_downloaded_mail,
            commands::settings_system::get_distribution_channel,
            commands::settings_system::get_license_credits,
            commands::accounts::discover_account_aliases,
            commands::accounts::update_account_aliases,
            commands::accounts::update_account_display_name,
            commands::accounts::update_account_signature,
            commands::accounts::get_account_inbox_counts,
            commands::sync::list_all_mailboxes,
            commands::sync::sync_all_accounts,
            commands::settings_system::show_native_confirm,
            commands::settings_system::show_native_message,
            commands::settings_system::relaunch_app,
            window_fx::set_workspace_window_fx,
            window_fx::supports_workspace_window_fx,
            window_fx::accessibility_reduce_transparency,
            window_snap::set_snap_overlay_bounds,
        ])
        .build(tauri::generate_context!())
        .expect("Postal Snap failed to start");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } = &event
        {
            if label == "main" {
                api.prevent_close();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
        }
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = &event
        {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

/// Custom Windows chrome is frameless + transparent. Attaching muda's Win32
/// menubar (`SetMenu`) makes File / Edit / Message / View paint through the
/// WebView2 caption on `WM_NCACTIVATE`. Zinnia never installs a Windows app
/// menu; IYERIS keeps native menus optional. Postal Snap follows that: macOS
/// keeps the system menu bar, Linux keeps a decorated GTK menu, Windows uses
/// frontend shortcuts only.
fn attaches_native_window_menu() -> bool {
    !cfg!(target_os = "windows")
}

fn install_menu<R: Runtime>(app: &tauri::App<R>, has_accounts: bool) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let _ = (app, has_accounts);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        app.set_menu(build_application_menu(app, has_accounts)?)?;
        Ok(())
    }
}

#[cfg_attr(all(target_os = "windows", not(test)), expect(dead_code))]
fn build_application_menu<R: Runtime>(
    app: &tauri::App<R>,
    has_accounts: bool,
) -> tauri::Result<Menu<R>> {
    let handle = app.handle();
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+Comma")
        .build(handle)?;
    let compose = MenuItemBuilder::with_id("compose", "New Message")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let get_mail = MenuItemBuilder::with_id("get-mail", "Get Mail")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+N")
        .build(handle)?;
    let reply = MenuItemBuilder::with_id("reply", "Reply")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+R")
        .build(handle)?;
    let reply_all = MenuItemBuilder::with_id("reply-all", "Reply All")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+R")
        .build(handle)?;
    let forward = MenuItemBuilder::with_id("forward", "Forward")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+F")
        .build(handle)?;
    let archive = MenuItemBuilder::with_id("archive", "Archive")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+E")
        .build(handle)?;
    let trash = MenuItemBuilder::with_id("trash", "Move to Trash")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Backspace")
        .build(handle)?;
    let flag = MenuItemBuilder::with_id("toggle-star", "Flag")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+L")
        .build(handle)?;
    let junk = MenuItemBuilder::with_id("junk", "Move to Junk")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+J")
        .build(handle)?;
    let toggle_read = MenuItemBuilder::with_id("toggle-read", "Mark as Read")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+U")
        .build(handle)?;
    let print = MenuItemBuilder::with_id("print", "Print…")
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+P")
        .build(handle)?;
    let file_print = MenuItemBuilder::with_id("file-print", "Print…")
        .enabled(has_accounts)
        .build(handle)?;
    let find_in_message = MenuItemBuilder::with_id("find-in-message", "Find in Message")
        .enabled(has_accounts)
        .accelerator("Alt+CmdOrCtrl+F")
        .build(handle)?;
    let pane_right = MenuItemBuilder::with_id("reading-pane-right", "Reading Pane on Right")
        .accelerator("CmdOrCtrl+Alt+Right")
        .build(handle)?;
    let pane_bottom = MenuItemBuilder::with_id("reading-pane-bottom", "Reading Pane Below")
        .accelerator("CmdOrCtrl+Alt+Down")
        .build(handle)?;
    let pane_hidden = MenuItemBuilder::with_id("reading-pane-hidden", "Hide Reading Pane")
        .accelerator("CmdOrCtrl+Alt+Up")
        .build(handle)?;
    let text_larger = MenuItemBuilder::with_id("text-larger", "Make Text Larger")
        .accelerator("CmdOrCtrl+Plus")
        .build(handle)?;
    let text_smaller = MenuItemBuilder::with_id("text-smaller", "Make Text Smaller")
        .accelerator("CmdOrCtrl+-")
        .build(handle)?;

    let check_updates =
        MenuItemBuilder::with_id("check-for-updates", "Check for Updates…").build(handle)?;

    let mut app_menu_builder = SubmenuBuilder::with_id(handle, "app", "Postal Snap")
        .about(None)
        .separator();
    if compiled_updater_menu_visible() {
        app_menu_builder = app_menu_builder.item(&check_updates);
    }
    let app_menu_builder = app_menu_builder
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others();
    #[cfg(target_os = "macos")]
    let app_menu_builder = app_menu_builder.show_all();
    let app_menu = app_menu_builder.separator().quit().build()?;
    let file_menu = SubmenuBuilder::with_id(handle, "file", "File")
        .item(&compose)
        .item(&get_mail)
        .separator()
        .item(&file_print)
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::with_id(handle, "edit", "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find_in_message)
        .build()?;
    let message_menu = SubmenuBuilder::with_id(handle, "message", "Message")
        .item(&reply)
        .item(&reply_all)
        .item(&forward)
        .separator()
        .item(&archive)
        .item(&junk)
        .item(&trash)
        .separator()
        .item(&flag)
        .item(&toggle_read)
        .separator()
        .item(&print)
        .build()?;
    let view_menu = SubmenuBuilder::with_id(handle, "view", "View")
        .item(&text_larger)
        .item(&text_smaller)
        .separator()
        .item(&pane_right)
        .item(&pane_bottom)
        .item(&pane_hidden)
        .separator()
        .fullscreen()
        .build()?;
    #[cfg(target_os = "macos")]
    let window_menu = SubmenuBuilder::with_id(handle, "window", "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;
    let menu = MenuBuilder::new(handle)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &message_menu,
            &view_menu,
            #[cfg(target_os = "macos")]
            &window_menu,
        ])
        .build()?;
    Ok(menu)
}

pub(crate) fn mail_actions_enabled(account_count: usize) -> bool {
    account_count > 0
}

#[cfg_attr(all(target_os = "windows", not(test)), expect(dead_code))]
fn updater_menu_policy(target_is_macos: bool, direct_updater: bool, store_build: bool) -> bool {
    target_is_macos && direct_updater && !store_build
}

#[cfg_attr(all(target_os = "windows", not(test)), expect(dead_code))]
fn compiled_updater_menu_visible() -> bool {
    updater_menu_policy(
        cfg!(target_os = "macos"),
        cfg!(feature = "direct-updater"),
        cfg!(any(
            feature = "flatpak",
            feature = "mas",
            feature = "msstore"
        )),
    )
}

pub fn set_mail_menu_enabled<R: Runtime>(
    app: &tauri::AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    if !attaches_native_window_menu() {
        let _ = (app, enabled);
        return Ok(());
    }
    let Some(menu) = app.menu() else {
        return Err("Application menu is unavailable.".into());
    };
    set_mail_menu_items_enabled(&menu, enabled)
}

fn set_mail_menu_items_enabled<R: Runtime>(menu: &Menu<R>, enabled: bool) -> Result<(), String> {
    for (submenu_id, item_ids) in [
        ("file", &["compose", "get-mail", "file-print"][..]),
        (
            "message",
            &[
                "reply",
                "reply-all",
                "forward",
                "archive",
                "junk",
                "trash",
                "toggle-star",
                "toggle-read",
                "print",
            ][..],
        ),
        ("edit", &["find-in-message"][..]),
    ] {
        let Some(MenuItemKind::Submenu(submenu)) = menu.get(submenu_id) else {
            return Err("Application mail menu is unavailable.".into());
        };
        for id in item_ids {
            let Some(MenuItemKind::MenuItem(item)) = submenu.get(*id) else {
                return Err("Application mail command is unavailable.".into());
            };
            item.set_enabled(enabled)
                .map_err(|_| "Application mail command could not be updated.".to_string())?;
        }
    }
    Ok(())
}

pub fn update_mail_menu_or_warn<R: Runtime>(app: &tauri::AppHandle<R>, enabled: bool) {
    if set_mail_menu_enabled(app, enabled).is_err() {
        let _ = app.emit(
            "app-warning",
            "Postal Snap could not update menu commands. Restart Postal Snap to restore them.",
        );
    }
}

fn allowed_webview_navigation(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" | "ipc" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "tauri.localhost" | "ipc.localhost")
        ),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        allowed_webview_navigation, attaches_native_window_menu, mail_actions_enabled,
        updater_menu_policy,
    };
    #[cfg(not(target_os = "macos"))]
    use super::{build_application_menu, set_mail_menu_items_enabled};
    #[cfg(target_os = "windows")]
    use super::{install_menu, set_mail_menu_enabled};
    #[cfg(not(target_os = "macos"))]
    use tauri::menu::MenuItemKind;

    #[test]
    fn webview_navigation_stays_on_app_origins() {
        assert!(allowed_webview_navigation(
            &url::Url::parse("http://localhost:5173/").unwrap(),
        ));
        assert!(allowed_webview_navigation(
            &url::Url::parse("https://tauri.localhost/").unwrap(),
        ));
        assert!(allowed_webview_navigation(
            &url::Url::parse("tauri://localhost/").unwrap(),
        ));
        assert!(!allowed_webview_navigation(
            &url::Url::parse("https://example.com/").unwrap(),
        ));
        assert!(!allowed_webview_navigation(
            &url::Url::parse("https://evil.example/").unwrap(),
        ));
    }

    #[test]
    fn mail_actions_follow_account_lifecycle() {
        assert!(!mail_actions_enabled(0));
        assert!(mail_actions_enabled(1));
        assert!(mail_actions_enabled(2));
    }

    #[test]
    fn native_window_menu_follows_custom_chrome() {
        assert_eq!(attaches_native_window_menu(), !cfg!(target_os = "windows"));
    }

    #[test]
    fn updater_menu_policy_is_direct_macos_only() {
        assert!(updater_menu_policy(true, true, false));
        assert!(!updater_menu_policy(true, true, true));
        assert!(!updater_menu_policy(true, false, false));
        assert!(!updater_menu_policy(false, true, false));
    }

    #[cfg(not(target_os = "macos"))]
    fn attach_test_menu(app: &tauri::App<tauri::test::MockRuntime>, has_accounts: bool) {
        let menu = build_application_menu(app, has_accounts).unwrap();
        app.set_menu(menu).unwrap();
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn actual_mail_menu_items_follow_account_lifecycle() {
        let app = tauri::test::mock_app();
        attach_test_menu(&app, false);
        assert_mail_items_enabled(&app, false);

        let menu = app.menu().unwrap();
        set_mail_menu_items_enabled(&menu, true).unwrap();
        assert_mail_items_enabled(&app, true);

        set_mail_menu_items_enabled(&menu, false).unwrap();
        assert_mail_items_enabled(&app, false);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn updater_menu_visibility_matches_distribution_features() {
        let app = tauri::test::mock_app();
        attach_test_menu(&app, false);
        let menu = app.menu().unwrap();
        let Some(MenuItemKind::Submenu(app_menu)) = menu.get("app") else {
            panic!("app menu missing");
        };
        let expected = cfg!(all(
            target_os = "macos",
            feature = "direct-updater",
            not(any(
                feature = "flatpak",
                feature = "mas",
                feature = "msstore"
            ))
        ));
        assert_eq!(app_menu.get("check-for-updates").is_some(), expected);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_install_menu_does_not_attach_a_native_menubar() {
        let app = tauri::test::mock_app();
        install_menu(&app, true).unwrap();
        assert!(app.menu().is_none());
        set_mail_menu_enabled(app.handle(), true).unwrap();
        assert!(app.menu().is_none());
    }

    #[cfg(not(target_os = "macos"))]
    fn assert_mail_items_enabled(app: &tauri::App<tauri::test::MockRuntime>, expected: bool) {
        let menu = app.menu().unwrap();
        for (submenu_id, item_ids) in [
            ("file", &["compose", "get-mail", "file-print"][..]),
            (
                "message",
                &[
                    "reply",
                    "reply-all",
                    "forward",
                    "archive",
                    "junk",
                    "trash",
                    "toggle-star",
                    "toggle-read",
                    "print",
                ][..],
            ),
            ("edit", &["find-in-message"][..]),
        ] {
            let Some(MenuItemKind::Submenu(submenu)) = menu.get(submenu_id) else {
                panic!("{submenu_id} menu missing");
            };
            for id in item_ids {
                let Some(MenuItemKind::MenuItem(item)) = submenu.get(*id) else {
                    panic!("{id} item missing");
                };
                assert_eq!(item.is_enabled().unwrap(), expected, "{id}");
            }
        }
    }
}
