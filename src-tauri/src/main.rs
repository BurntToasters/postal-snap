#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_nap;
mod bridge;
mod commands;
mod content_blocking;
mod credentials;
mod db;
mod download_mark;
mod html_sanitize;
mod mail;
mod models;
// Background OAuth groundwork (no UI yet): consumed by a future setup flow.
#[allow(dead_code)]
mod oauth;
mod providers;
mod resume_watch;
mod search_query;
mod security;
mod settings;
mod storage;
mod strings;
mod threat_blocking;
mod tray;
mod unsubscribe;
mod update_relaunch;
// Store editions keep only the IPC stub; their stores handle updates.
#[cfg_attr(
    any(
        not(feature = "direct-updater"),
        feature = "flatpak",
        feature = "mas",
        feature = "msstore"
    ),
    allow(dead_code)
)]
mod update_schedule;
mod window_fx;
mod window_snap;

use commands::AppState;
use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, MenuItemKind, SubmenuBuilder},
    Emitter, Manager, Runtime, WindowEvent,
};

fn main() {
    let builder = tauri::Builder::default()
        .on_menu_event(|app, event| {
            let action = event.id().as_ref();
            if action == "tray-quit" {
                let _ = app.emit("tray-quit", ());
                return;
            }
            if action == "app-quit" {
                // A ready update installs from the frontend on quit.
                if update_relaunch::update_ready() {
                    let _ = app.emit("tray-quit", ());
                } else {
                    app.exit(0);
                }
                return;
            }
            if matches!(action, "settings" | "check-for-updates" | "tray-open") {
                tray::show_main(app);
            }
            let _ = app.emit("menu-action", action);
        })
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main(app);
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
            let relaunch = update_relaunch::take(&data_dir);
            // Windows keeps the mail database in the local (non-roaming)
            // profile; migrate any legacy roaming database first.
            let target_dir = storage::mail_data_dir(app.handle())?;
            let mail_dir = match storage::migrate_legacy_mail_data(&data_dir, &target_dir) {
                Ok(_) => target_dir,
                Err(_) => {
                    // Keep using the legacy folder so no mail is hidden.
                    eprintln!("Mail data migration did not complete; using the previous folder.");
                    data_dir.clone()
                }
            };
            std::fs::create_dir_all(&mail_dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&mail_dir, std::fs::Permissions::from_mode(0o700))?;
            }
            let database_path = mail_dir.join("postal-snap.sqlite3");
            let attachment_dir = mail_dir.join("draft-attachments");
            std::fs::create_dir_all(&attachment_dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&attachment_dir, std::fs::Permissions::from_mode(0o700))?;
            }
            let orphan_cleanup_dir = attachment_dir.clone();
            // A database that cannot open must not exit silently: open an
            // empty stand-in and explain in the window. Nothing is written.
            let (database, database_error) = match db::Database::open(&database_path) {
                Ok(database) => (database, None),
                Err(error) => (
                    db::Database::unavailable().map_err(std::io::Error::other)?,
                    Some(if error == db::NEWER_DATABASE {
                        "This mail was saved by a newer version of Postal Snap. Install the latest Postal Snap to open it. Your mail data was not changed."
                    } else {
                        "Postal Snap could not open its mail database. Your mail data was not deleted. Restart your computer, then open Postal Snap again."
                    }),
                ),
            };
            if database_error.is_none() {
                // Idempotent: also repairs grants left behind by an earlier
                // migration whose rebase did not finish.
                if mail_dir != data_dir
                    && database
                        .rebase_file_grant_paths(&data_dir.join(storage::ATTACHMENT_DIR), &attachment_dir)
                        .is_err()
                {
                    eprintln!("Saved attachment locations could not be updated.");
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&database_path, std::fs::Permissions::from_mode(0o600))?;
                }
            }
            let settings_path = data_dir.join("settings.json");
            let (settings, settings_error) = if database_error.is_some() {
                (settings::SettingsStore::unavailable(settings_path), None)
            } else {
                match settings::SettingsStore::load(settings_path.clone(), &database) {
                    Ok(settings) => (settings, None),
                    Err(_) => (
                        settings::SettingsStore::unavailable(settings_path),
                        Some("Postal Snap could not open its settings file. Check free disk space and folder permissions, then restart Postal Snap."),
                    ),
                }
            };
            let storage_error = database_error.or(settings_error);
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
            let (accounts, startup_error) = match (
                storage_error,
                app.state::<AppState>().db.list_accounts(),
            ) {
                (Some(error), _) => (Vec::new(), Some(error.to_string())),
                (None, Ok(accounts)) => (accounts, None),
                (None, Err(_)) => (
                    Vec::new(),
                    Some(
                        "Postal Snap could not open saved accounts. Your mail data was not deleted. Restart Postal Snap to try again.".to_string(),
                    ),
                ),
            };
            let has_startup_error = startup_error.is_some();
            if storage_error.is_some() {
                app.state::<AppState>().set_storage_unavailable();
            } else {
                let db = app.state::<AppState>().db.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = db.maintain_search_index();
                });
            }
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
                .on_navigation({
                    let app = app.handle().clone();
                    move |url| {
                        if allowed_webview_navigation(url) {
                            return true;
                        }
                        // macOS WebKit asks this policy for a mail link's
                        // popup first. Deny it; the reader confirms the link.
                        if let Some(target) = frame_link_target(url) {
                            let _ = app.emit("frame-link", target);
                        }
                        false
                    }
                })
                .on_new_window({
                    let app = app.handle().clone();
                    move |url, _features| {
                        // WebKitGTK routes mail link popups here instead.
                        // Never open a window.
                        if let Some(target) = frame_link_target(&url) {
                            let _ = app.emit("frame-link", target);
                        }
                        tauri::webview::NewWindowResponse::Deny
                    }
                });
            #[cfg(target_os = "macos")]
            let window_builder = window_builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            // Frameless custom caption (IYERIS/Zinnia). Do not attach a Win32
            // menubar onto this HWND — muda paints it through glass on activate.
            #[cfg(target_os = "windows")]
            let window_builder = window_builder.decorations(false);
            let close_to_tray = app
                .state::<AppState>()
                .settings
                .get()
                .map(|settings| settings.close_to_tray)
                .unwrap_or(true);
            let start_hidden = relaunch == Some(update_relaunch::RelaunchMode::Background)
                && close_to_tray;
            window_builder
                .visible(!start_hidden)
                .build()
                .map_err(|error| error.to_string())?;
            tray::sync(app.handle(), close_to_tray);
            #[cfg(target_os = "macos")]
            tray::watch_activation(app.handle());
            // Never leave a hidden window with no icon to reopen it.
            if start_hidden {
                if tray::should_hide_on_close(close_to_tray, tray::tray_is_active()) {
                    tray::start_hidden_in_tray(app.handle());
                } else {
                    tray::show_main(app.handle());
                }
            }
            install_menu(
                app,
                !has_startup_error && mail_actions_enabled(accounts.len()),
            )?;
            #[cfg(all(
                feature = "direct-updater",
                not(any(feature = "flatpak", feature = "mas", feature = "msstore"))
            ))]
            update_schedule::start(app.handle());
            resume_watch::start(app.handle());
            #[cfg(all(
                target_os = "linux",
                not(any(feature = "flatpak", feature = "mas", feature = "msstore"))
            ))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Claim mailto on first launch only. Later launches refresh
                // the entry (an AppImage may move) only while Postal Snap is
                // still the default, so a user's later choice is kept.
                let marker = data_dir.join("mailto-claimed");
                let deep_link = app.deep_link();
                let claim =
                    !marker.exists() || deep_link.is_registered("mailto").unwrap_or(false);
                if claim && deep_link.register_all().is_ok() {
                    let _ = std::fs::write(&marker, b"");
                }
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
            {
                // Schema v18 added per-account download policies; accounts
                // that predate it inherit the app-wide setting exactly once.
                let state = app.state::<AppState>();
                if let Ok(settings) = state.settings.get() {
                    let _ = state.db.seed_account_cache_policies(&settings.cache_policy);
                }
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
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let enabled = window
                        .try_state::<AppState>()
                        .and_then(|state| state.settings.get().ok())
                        .map(|settings| settings.close_to_tray)
                        .unwrap_or(true);
                    if tray::should_hide_on_close(enabled, tray::tray_is_active()) {
                        api.prevent_close();
                        if let Some(webview) = window.app_handle().get_webview_window("main") {
                            tray::hide_main_to_tray(&webview);
                        }
                    }
                }
            }
            if let WindowEvent::DragDrop(drag) = event {
                commands::drag_drop::on_drag_drop(window, drag);
            }
            if matches!(event, WindowEvent::Destroyed) {
                window_snap::on_window_destroyed(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::compatibility::get_account_connection,
            commands::compatibility::update_account_connection,
            commands::compatibility::import_bridge_certificate,
            commands::compatibility::approve_bridge_certificate,
            commands::compatibility::remove_bridge_certificate,
            commands::compatibility::get_folder_assignments,
            commands::compatibility::set_folder_assignment,
            commands::badge::set_unread_badge,
            commands::accounts::list_accounts,
            commands::accounts::test_account,
            providers::discover_mail_settings,
            commands::accounts::test_saved_account,
            commands::accounts::update_account_password,
            commands::accounts::add_account,
            commands::accounts::connect_oauth_account,
            commands::accounts::remove_account,
            commands::accounts::erase_all_data,
            commands::sync::list_mailboxes,
            commands::sync::sync_account,
            commands::messages::list_messages,
            commands::messages::get_message,
            commands::messages::find_cached_message,
            commands::messages::get_message_source,
            commands::messages::save_message_eml,
            commands::messages::unsubscribe_one_click,
            commands::messages::set_message_flags,
            commands::messages::set_messages_flags,
            commands::messages::set_messages_pinned,
            commands::messages::move_message,
            commands::messages::move_message_to_mailbox,
            commands::messages::copy_message_to_mailbox,
            commands::messages::copy_messages_to_mailbox,
            commands::messages::move_messages_to_mailbox,
            commands::messages::mark_mailbox_read,
            commands::folders::suggest_recipients,
            commands::folders::create_folder,
            commands::folders::rename_folder,
            commands::folders::move_folder,
            commands::folders::delete_folder,
            commands::folders::delete_trash_messages,
            commands::folders::empty_trash,
            commands::folders::empty_junk,
            commands::messages::list_recent_searches,
            commands::messages::remember_search,
            commands::messages::forget_recent_search,
            commands::messages::forget_recent_searches,
            commands::messages::search_cached_messages,
            commands::messages::search_server_messages,
            commands::drafts_send::save_draft,
            commands::drafts_send::list_drafts,
            commands::drafts_send::get_draft,
            commands::drafts_send::delete_draft,
            commands::drafts_send::send_message,
            commands::drafts_send::send_read_receipt,
            commands::drafts_send::decline_read_receipt,
            commands::outbox::list_outbox,
            commands::outbox::get_outbox,
            commands::outbox::retry_outbox,
            commands::outbox::retry_sent_copy,
            commands::outbox::retry_archive_after_send,
            commands::outbox::dismiss_archive_warning,
            commands::drafts_send::send_scheduled_outbox,
            commands::snooze_filters::snooze_message,
            commands::snooze_filters::snooze_messages,
            commands::snooze_filters::unsnooze_message,
            commands::snooze_filters::list_snoozed,
            commands::snooze_filters::list_filter_rules,
            commands::snooze_filters::create_filter_rule,
            commands::snooze_filters::update_filter_rule,
            commands::snooze_filters::delete_filter_rule,
            commands::snooze_filters::reorder_filter_rules,
            commands::snooze_filters::preview_filter_rule,
            commands::snooze_filters::mute_conversation,
            commands::snooze_filters::unmute_conversation,
            commands::outbox::delete_outbox,
            commands::outbox::restore_outbox,
            commands::attachments::save_attachment,
            commands::attachments::save_all_attachments,
            commands::attachments::save_chosen_attachments,
            commands::attachments::save_conversation_attachments,
            commands::attachments::save_messages_eml,
            commands::attachments::preview_attachment,
            commands::attachments::prepare_forward_attachments,
            commands::attachments::prepare_reply_attachments,
            commands::attachments::prepare_forwarded_message,
            commands::attachments::choose_attachments,
            commands::attachments::stage_pasted_image,
            commands::drag_drop::attach_dropped_files,
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
            commands::accounts::update_account_reply_to,
            commands::accounts::update_account_signature,
            commands::accounts::update_account_default_body_format,
            commands::accounts::get_account_inbox_counts,
            commands::accounts::update_account_color,
            commands::accounts::reorder_accounts,
            commands::accounts::get_account_removal_impact,
            commands::cache_policy::get_account_cache_policy,
            commands::cache_policy::set_account_cache_policy,
            commands::cache_policy::get_account_cache_usage,
            commands::cache_policy::clear_account_downloads,
            commands::cache_policy::get_sync_progress,
            commands::messages::load_older_messages,
            commands::sync::list_all_mailboxes,
            commands::sync::sync_all_accounts,
            commands::settings_system::show_native_confirm,
            commands::settings_system::show_native_message,
            commands::settings_system::print_webview,
            commands::settings_system::relaunch_app,
            commands::settings_system::quit_app,
            commands::settings_system::tray_is_active,
            commands::settings_system::prepare_update_relaunch,
            commands::settings_system::clear_update_relaunch,
            commands::settings_system::get_update_relaunch,
            commands::settings_system::set_update_ready,
            commands::settings_system::background_update_allowed,
            commands::settings_system::begin_update_install,
            commands::settings_system::release_update_install,
            commands::settings_system::schedule_background_update,
            commands::settings_system::mark_update_checked,
            window_fx::set_workspace_window_fx,
            window_fx::supports_workspace_window_fx,
            window_fx::accessibility_reduce_transparency,
            window_snap::set_snap_overlay_bounds,
        ])
        .build(tauri::generate_context!())
        .expect("Postal Snap failed to start");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = &event
        {
            tray::show_main(app);
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
    let settings = MenuItemBuilder::with_id("settings", strings::menu::SETTINGS)
        .accelerator("CmdOrCtrl+Comma")
        .build(handle)?;
    let compose = MenuItemBuilder::with_id("compose", strings::menu::NEW_MESSAGE)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let get_mail = MenuItemBuilder::with_id("get-mail", strings::menu::GET_MAIL)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+N")
        .build(handle)?;
    let reply = MenuItemBuilder::with_id("reply", strings::menu::REPLY)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+R")
        .build(handle)?;
    let reply_all = MenuItemBuilder::with_id("reply-all", strings::menu::REPLY_ALL)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+R")
        .build(handle)?;
    let forward = MenuItemBuilder::with_id("forward", strings::menu::FORWARD)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+F")
        .build(handle)?;
    let redirect = MenuItemBuilder::with_id("redirect", strings::menu::REDIRECT)
        .enabled(has_accounts)
        .build(handle)?;
    let archive = MenuItemBuilder::with_id("archive", strings::menu::ARCHIVE)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+E")
        .build(handle)?;
    let trash = MenuItemBuilder::with_id("trash", strings::menu::MOVE_TO_TRASH)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Backspace")
        .build(handle)?;
    let flag = MenuItemBuilder::with_id("toggle-star", strings::menu::FLAG)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+L")
        .build(handle)?;
    let junk = MenuItemBuilder::with_id("junk", strings::menu::MOVE_TO_JUNK)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+J")
        .build(handle)?;
    let toggle_read = MenuItemBuilder::with_id("toggle-read", strings::menu::MARK_AS_READ)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+Shift+U")
        .build(handle)?;
    let print = MenuItemBuilder::with_id("print", strings::menu::PRINT)
        .enabled(has_accounts)
        .accelerator("CmdOrCtrl+P")
        .build(handle)?;
    let file_print = MenuItemBuilder::with_id("file-print", strings::menu::PRINT)
        .enabled(has_accounts)
        .build(handle)?;
    let find_in_message =
        MenuItemBuilder::with_id("find-in-message", strings::menu::FIND_IN_MESSAGE)
            .enabled(has_accounts)
            .accelerator("Alt+CmdOrCtrl+F")
            .build(handle)?;
    let pane_right =
        MenuItemBuilder::with_id("reading-pane-right", strings::menu::READING_PANE_ON_RIGHT)
            .accelerator("CmdOrCtrl+Alt+Right")
            .build(handle)?;
    let pane_bottom =
        MenuItemBuilder::with_id("reading-pane-bottom", strings::menu::READING_PANE_BELOW)
            .accelerator("CmdOrCtrl+Alt+Down")
            .build(handle)?;
    let pane_hidden =
        MenuItemBuilder::with_id("reading-pane-hidden", strings::menu::HIDE_READING_PANE)
            .accelerator("CmdOrCtrl+Alt+Up")
            .build(handle)?;
    let text_larger = MenuItemBuilder::with_id("text-larger", strings::menu::MAKE_TEXT_LARGER)
        .accelerator("CmdOrCtrl+Plus")
        .build(handle)?;
    let text_smaller = MenuItemBuilder::with_id("text-smaller", strings::menu::MAKE_TEXT_SMALLER)
        .accelerator("CmdOrCtrl+-")
        .build(handle)?;

    let check_updates =
        MenuItemBuilder::with_id("check-for-updates", strings::menu::CHECK_FOR_UPDATES)
            .build(handle)?;

    let mut app_menu_builder = SubmenuBuilder::with_id(handle, "app", strings::menu::POSTAL_SNAP)
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
    // Custom Quit so a downloaded update can install before exit.
    let quit = MenuItemBuilder::with_id("app-quit", strings::menu::QUIT_POSTAL_SNAP)
        .accelerator("CmdOrCtrl+Q")
        .build(handle)?;
    let app_menu = app_menu_builder.separator().item(&quit).build()?;
    let file_menu = SubmenuBuilder::with_id(handle, "file", strings::menu::FILE)
        .item(&compose)
        .item(&get_mail)
        .separator()
        .item(&file_print)
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::with_id(handle, "edit", strings::menu::EDIT)
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
    let message_menu = SubmenuBuilder::with_id(handle, "message", strings::menu::MESSAGE)
        .item(&reply)
        .item(&reply_all)
        .item(&forward)
        .item(&redirect)
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
    let view_menu = SubmenuBuilder::with_id(handle, "view", strings::menu::VIEW)
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
    let window_menu = SubmenuBuilder::with_id(handle, "window", strings::menu::WINDOW)
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
                "redirect",
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

/// Link targets a denied frame popup may hand to the reader. The reader still
/// inspects and confirms before anything opens.
fn frame_link_target(url: &url::Url) -> Option<String> {
    let text = url.as_str();
    (matches!(url.scheme(), "http" | "https" | "mailto") && text.len() <= 16 * 1024)
        .then(|| text.to_string())
}

fn allowed_webview_navigation(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" | "ipc" => true,
        // Reader and print frames load sanitized mail via srcdoc. WebKit on
        // macOS 27 and WebKitGTK ask this policy for subframe loads too.
        "about" => matches!(url.path(), "srcdoc" | "blank"),
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost" | "ipc.localhost") => true,
            // Only the Vite dev server; release builds never load it.
            Some("localhost" | "127.0.0.1") => cfg!(debug_assertions),
            _ => false,
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        allowed_webview_navigation, attaches_native_window_menu, frame_link_target,
        mail_actions_enabled, updater_menu_policy,
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
        // Regression: cancelling about:srcdoc blanked every message body.
        assert!(allowed_webview_navigation(
            &url::Url::parse("about:srcdoc").unwrap(),
        ));
        assert!(allowed_webview_navigation(
            &url::Url::parse("about:blank").unwrap(),
        ));
        assert!(!allowed_webview_navigation(
            &url::Url::parse("about:config").unwrap(),
        ));
        assert!(!allowed_webview_navigation(
            &url::Url::parse("data:text/html,<p>x</p>").unwrap(),
        ));
        assert!(!allowed_webview_navigation(
            &url::Url::parse("file:///etc/passwd").unwrap(),
        ));
    }

    #[test]
    fn frame_links_route_only_web_and_mailto_targets() {
        let parse = |text: &str| url::Url::parse(text).unwrap();
        assert_eq!(
            frame_link_target(&parse("https://library.example.test/hours")).as_deref(),
            Some("https://library.example.test/hours"),
        );
        assert!(frame_link_target(&parse("mailto:jane@example.test")).is_some());
        assert!(frame_link_target(&parse("javascript:alert(1)")).is_none());
        assert!(frame_link_target(&parse("file:///etc/passwd")).is_none());
        assert!(frame_link_target(&parse("tauri://localhost/")).is_none());
        let long = format!("https://example.test/{}", "a".repeat(16 * 1024));
        assert!(frame_link_target(&parse(&long)).is_none());
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
                    "redirect",
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
