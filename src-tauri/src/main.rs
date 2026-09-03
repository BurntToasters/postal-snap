#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod credentials;
mod db;
mod mail;
mod models;
mod security;
mod settings;
// FUTURE IMPLEMENTATION: Native window blur / vibrancy (macOS vibrancy / Windows Mica·Acrylic, mirrored from Zinnia).
mod window_fx;

use commands::AppState;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, MenuItemKind, SubmenuBuilder},
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
            let database_path = data_dir.join("postal-snap.sqlite3");
            let attachment_dir = data_dir.join("draft-attachments");
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
            install_menu(
                app,
                !has_startup_error && mail_actions_enabled(accounts.len()),
            )?;
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
        .invoke_handler(tauri::generate_handler![
            commands::list_accounts,
            commands::test_account,
            commands::add_account,
            commands::remove_account,
            commands::list_mailboxes,
            commands::sync_account,
            commands::list_messages,
            commands::get_message,
            commands::set_message_flags,
            commands::move_message,
            commands::move_message_to_mailbox,
            commands::search_cached_messages,
            commands::search_server_messages,
            commands::save_draft,
            commands::list_drafts,
            commands::get_draft,
            commands::delete_draft,
            commands::send_message,
            commands::list_outbox,
            commands::get_outbox,
            commands::retry_outbox,
            commands::retry_sent_copy,
            commands::delete_outbox,
            commands::save_attachment,
            commands::prepare_forward_attachments,
            commands::choose_attachments,
            commands::fetch_remote_image,
            commands::read_message_inline_image,
            commands::read_compose_image,
            commands::release_compose_attachments,
            commands::get_settings,
            commands::save_settings,
            commands::export_settings,
            commands::import_settings,
            commands::reset_settings,
            commands::get_startup_notice,
            commands::get_startup_error,
            commands::get_cache_usage,
            commands::clear_downloaded_mail,
            commands::get_distribution_channel,
            commands::discover_account_aliases,
            commands::update_account_aliases,
            commands::update_account_display_name,
            commands::get_account_inbox_counts,
            commands::list_all_mailboxes,
            commands::sync_all_accounts,
            commands::search_all_cached_messages,
            commands::show_native_confirm,
            commands::show_native_message,
            commands::relaunch_app,
            // FUTURE IMPLEMENTATION: Native window blur / vibrancy commands
            window_fx::set_workspace_window_fx,
            window_fx::supports_workspace_window_fx,
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

fn install_menu<R: Runtime>(app: &tauri::App<R>, has_accounts: bool) -> tauri::Result<()> {
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
        .accelerator("CmdOrCtrl+Shift+M")
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
        .build()?;
    let message_menu = SubmenuBuilder::with_id(handle, "message", "Message")
        .item(&reply)
        .item(&reply_all)
        .item(&forward)
        .separator()
        .item(&archive)
        .item(&trash)
        .build()?;
    let view_menu = SubmenuBuilder::with_id(handle, "view", "View")
        .item(&text_larger)
        .item(&text_smaller)
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
    app.set_menu(menu)?;
    Ok(())
}

pub(crate) fn mail_actions_enabled(account_count: usize) -> bool {
    account_count > 0
}

fn updater_menu_policy(target_is_macos: bool, direct_updater: bool, store_build: bool) -> bool {
    target_is_macos && direct_updater && !store_build
}

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
    let Some(menu) = app.menu() else {
        return Err("Application menu is unavailable.".into());
    };
    for (submenu_id, item_ids) in [
        ("file", &["compose", "get-mail"][..]),
        (
            "message",
            &["reply", "reply-all", "forward", "archive", "trash"][..],
        ),
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

#[cfg(test)]
mod tests {
    #[cfg(not(target_os = "macos"))]
    use super::{install_menu, set_mail_menu_enabled};
    use super::{mail_actions_enabled, updater_menu_policy};
    #[cfg(not(target_os = "macos"))]
    use tauri::menu::MenuItemKind;

    #[test]
    fn mail_actions_follow_account_lifecycle() {
        assert!(!mail_actions_enabled(0));
        assert!(mail_actions_enabled(1));
        assert!(mail_actions_enabled(2));
    }

    #[test]
    fn updater_menu_policy_is_direct_macos_only() {
        assert!(updater_menu_policy(true, true, false));
        assert!(!updater_menu_policy(true, true, true));
        assert!(!updater_menu_policy(true, false, false));
        assert!(!updater_menu_policy(false, true, false));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn actual_mail_menu_items_follow_account_lifecycle() {
        let app = tauri::test::mock_app();
        install_menu(&app, false).unwrap();
        assert_mail_items_enabled(&app, false);

        set_mail_menu_enabled(app.handle(), true).unwrap();
        assert_mail_items_enabled(&app, true);

        set_mail_menu_enabled(app.handle(), false).unwrap();
        assert_mail_items_enabled(&app, false);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn updater_menu_visibility_matches_distribution_features() {
        let app = tauri::test::mock_app();
        install_menu(&app, false).unwrap();
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

    #[cfg(not(target_os = "macos"))]
    fn assert_mail_items_enabled(app: &tauri::App<tauri::test::MockRuntime>, expected: bool) {
        let menu = app.menu().unwrap();
        for (submenu_id, item_ids) in [
            ("file", &["compose", "get-mail"][..]),
            (
                "message",
                &["reply", "reply-all", "forward", "archive", "trash"][..],
            ),
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
