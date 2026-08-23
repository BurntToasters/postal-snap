#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod credentials;
mod db;
mod mail;
mod models;
mod security;
mod settings;

use commands::AppState;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Emitter, Manager,
};
#[cfg(target_os = "macos")]
use tauri::{RunEvent, WindowEvent};

fn main() {
    let builder = tauri::Builder::default()
        .on_menu_event(|app, event| {
            let _ = app.emit("menu-action", event.id().as_ref());
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
            install_menu(app)?;
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
            let accounts = app
                .state::<AppState>()
                .db
                .list_accounts()
                .unwrap_or_default();
            for account in accounts {
                app.state::<AppState>()
                    .ensure_watcher(account.id, handle.clone())?;
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
            commands::get_startup_notice,
            commands::get_cache_usage,
            commands::clear_downloaded_mail,
            commands::get_distribution_channel,
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

fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+Comma")
        .build(handle)?;
    let compose = MenuItemBuilder::with_id("compose", "New Message")
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let get_mail = MenuItemBuilder::with_id("get-mail", "Get Mail")
        .accelerator("CmdOrCtrl+Shift+M")
        .build(handle)?;
    let reply = MenuItemBuilder::with_id("reply", "Reply")
        .accelerator("CmdOrCtrl+R")
        .build(handle)?;
    let reply_all = MenuItemBuilder::with_id("reply-all", "Reply All")
        .accelerator("CmdOrCtrl+Shift+R")
        .build(handle)?;
    let forward = MenuItemBuilder::with_id("forward", "Forward")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(handle)?;
    let archive = MenuItemBuilder::with_id("archive", "Archive")
        .accelerator("CmdOrCtrl+E")
        .build(handle)?;
    let trash = MenuItemBuilder::with_id("trash", "Move to Trash")
        .accelerator("CmdOrCtrl+Backspace")
        .build(handle)?;
    let text_larger = MenuItemBuilder::with_id("text-larger", "Make Text Larger")
        .accelerator("CmdOrCtrl+Plus")
        .build(handle)?;
    let text_smaller = MenuItemBuilder::with_id("text-smaller", "Make Text Smaller")
        .accelerator("CmdOrCtrl+-")
        .build(handle)?;

    let app_menu = SubmenuBuilder::new(handle, "Postal Snap")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .separator()
        .quit()
        .build()?;
    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(&compose)
        .item(&get_mail)
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let message_menu = SubmenuBuilder::new(handle, "Message")
        .item(&reply)
        .item(&reply_all)
        .item(&forward)
        .separator()
        .item(&archive)
        .item(&trash)
        .build()?;
    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(&text_larger)
        .item(&text_smaller)
        .separator()
        .fullscreen()
        .build()?;
    let menu = MenuBuilder::new(handle)
        .items(&[&app_menu, &file_menu, &edit_menu, &message_menu, &view_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}
