//! Native arrival notifications, and taps that open the matching message.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};

use crate::commands::AppState;
use crate::db::Database;
use crate::models::AppSettings;
use crate::strings::notify as copy;
use crate::tray;

/// Recent notices that a tap can still resolve. Older ones are forgotten.
const MAX_NOTICES: usize = 32;

static NEXT_NOTICE_ID: AtomicI32 = AtomicI32::new(1);
static NOTICES: Mutex<NoticeMap> = Mutex::new(NoticeMap::new());

#[derive(Clone, Debug, PartialEq, Eq)]
struct NoticeTarget {
    account_id: String,
    message_id: i64,
}

/// Bounded id to message map. The oldest entry is evicted first.
struct NoticeMap {
    entries: VecDeque<(i32, NoticeTarget)>,
}

impl NoticeMap {
    const fn new() -> Self {
        Self {
            entries: VecDeque::new(),
        }
    }

    fn insert(&mut self, id: i32, target: NoticeTarget) {
        if self.entries.len() == MAX_NOTICES {
            self.entries.pop_front();
        }
        self.entries.push_back((id, target));
    }

    fn get(&self, id: i32) -> Option<NoticeTarget> {
        self.entries
            .iter()
            .find(|(entry, _)| *entry == id)
            .map(|(_, target)| target.clone())
    }
}

fn notices() -> MutexGuard<'static, NoticeMap> {
    NOTICES.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Reserves a notification id and remembers where a tap on it leads.
fn remember(target: NoticeTarget) -> i32 {
    let id = NEXT_NOTICE_ID.fetch_add(1, Ordering::Relaxed);
    notices().insert(id, target);
    id
}

/// Payload of the `notification-open` event. Ids only, never text.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenPayload {
    account_id: String,
    message_id: i64,
}

/// Registers the tap handler at startup. The plugin reports taps only while
/// a handler is registered, and only the tap action is handled here.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app
        .notification()
        .on_action(move |action| route_tap(&handle, action));
}

fn route_tap<R: Runtime>(app: &AppHandle<R>, action: &ActionPerformed) {
    if action.action_id() != "tap" {
        return;
    }
    let Some(notice_id) = action.notification().map(|notice| notice.id()) else {
        return;
    };
    let Some(target) = notices().get(notice_id) else {
        return;
    };
    // Window calls belong on the main thread; the handler runs on a plugin thread.
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        tray::show_main(&app_for_main);
        let _ = app_for_main.emit(
            "notification-open",
            OpenPayload {
                account_id: target.account_id,
                message_id: target.message_id,
            },
        );
    });
}

/// Arrival notice for the newest unread Inbox message after the previous
/// pass. Sync stores rows with rising ids, so arrival order never depends on
/// the sender's Date header.
pub(crate) fn notify_new_mail(
    app: &AppHandle,
    db: &Database,
    account_id: &str,
    previous_message_id: Option<i64>,
) {
    let Ok(Some(message)) = db.newest_unread_inbox_after(account_id, previous_message_id) else {
        return;
    };
    if !arrival_allowed(app, db, account_id) {
        return;
    }
    show_arrival(app, db, account_id, &message);
}

/// Arrival notice for the message a rule's notify action matched.
pub(crate) fn rule_notice(app: &AppHandle, db: &Database, account_id: &str, message_id: i64) {
    if !arrival_allowed(app, db, account_id) {
        return;
    }
    let Ok(Some(message)) = db.rule_notice_message(account_id, message_id) else {
        return;
    };
    show_arrival(app, db, account_id, &message);
}

fn arrival_allowed(app: &AppHandle, db: &Database, account_id: &str) -> bool {
    let account_enabled = db
        .account(account_id)
        .is_ok_and(|account| account.summary.notify_new_mail);
    let settings = app.state::<AppState>().settings.get().ok();
    arrival_permitted(account_enabled, settings.as_ref(), local_minutes_now())
}

/// Pure gate: the account toggle, the global toggle, and quiet hours.
fn arrival_permitted(account_enabled: bool, settings: Option<&AppSettings>, now: u32) -> bool {
    if !account_enabled {
        return false;
    }
    !settings.is_some_and(|settings| {
        !settings.notify_new_mail
            || crate::settings::quiet_hours_active(
                &settings.quiet_hours_start,
                &settings.quiet_hours_end,
                now,
            )
    })
}

fn show_arrival(
    app: &AppHandle,
    db: &Database,
    account_id: &str,
    message: &crate::models::MessageSummary,
) {
    let settings = app.state::<AppState>().settings.get().ok();
    let private = settings
        .as_ref()
        .map(|settings| settings.private_notifications)
        .unwrap_or(true);
    let play_sound = settings
        .as_ref()
        .map(|settings| settings.new_mail_sound)
        .unwrap_or(true);
    // With several accounts, say which one received the mail. The account's
    // own display name is shown, never its address, even in private mode.
    let account_label = (db.account_count().unwrap_or(0) > 1)
        .then(|| db.account(account_id).ok())
        .flatten()
        .map(|account| account.summary.display_name)
        .filter(|name| !name.trim().is_empty());
    let (title, body) = arrival_text(
        private,
        account_label.as_deref(),
        &message.sender_name,
        &message.sender_address,
        &message.subject,
    );
    let id = remember(NoticeTarget {
        account_id: account_id.to_string(),
        message_id: message.id,
    });
    let mut notice = app.notification().builder().id(id).title(title).body(body);
    if play_sound {
        notice = notice.sound(new_mail_sound_name());
    }
    let _ = notice.show();
}

/// Title and body. Private mode shows no sender or subject.
fn arrival_text(
    private: bool,
    account_label: Option<&str>,
    sender_name: &str,
    sender_address: &str,
    subject: &str,
) -> (String, String) {
    if private {
        return (
            account_label.map_or_else(|| copy::NEW_MAIL.to_string(), copy::new_mail_for),
            copy::OPEN_TO_READ.to_string(),
        );
    }
    let sender = if sender_name.is_empty() {
        sender_address
    } else {
        sender_name
    };
    let body = match account_label {
        Some(name) => format!("{subject}\n{name}"),
        None => subject.to_string(),
    };
    (sender.to_string(), body)
}

fn local_minutes_now() -> u32 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    now.hour() * 60 + now.minute()
}

/// System sound for a new-mail alert. Each desktop has its own name.
fn new_mail_sound_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "Mail"
    } else if cfg!(target_os = "macos") {
        "Ping"
    } else {
        "message-new-email"
    }
}

#[cfg(test)]
mod tests {
    // Notification failure modes, written before the code above:
    // - the 33rd notice evicts the oldest id, never a newer one
    // - an unknown or evicted id resolves to nothing
    // - a disabled account gets no notice, even with the global toggle on
    // - private mode never shows a sender or subject
    use super::*;

    fn target(message_id: i64) -> NoticeTarget {
        NoticeTarget {
            account_id: "account-1".into(),
            message_id,
        }
    }

    #[test]
    fn notice_map_evicts_only_the_oldest_entry_at_the_cap() {
        let mut map = NoticeMap::new();
        for index in 0..MAX_NOTICES as i32 {
            map.insert(index + 1, target(i64::from(index)));
        }
        assert_eq!(map.get(1), Some(target(0)));
        map.insert(1_000, target(999));
        assert_eq!(map.entries.len(), MAX_NOTICES);
        assert_eq!(map.get(1), None);
        assert_eq!(map.get(2), Some(target(1)));
        assert_eq!(map.get(1_000), Some(target(999)));
    }

    #[test]
    fn unknown_notice_id_resolves_to_nothing() {
        let mut map = NoticeMap::new();
        map.insert(7, target(1));
        assert_eq!(map.get(8), None);
        assert_eq!(map.get(-1), None);
    }

    #[test]
    fn remembered_ids_are_unique_and_resolve_to_their_message() {
        let first = remember(target(41));
        let second = remember(target(42));
        assert_ne!(first, second);
        assert_eq!(notices().get(first), Some(target(41)));
        assert_eq!(notices().get(second), Some(target(42)));
    }

    #[test]
    fn disabled_account_gets_no_notice_even_when_global_is_on() {
        assert!(!arrival_permitted(false, None, 600));
    }

    #[test]
    fn global_toggle_and_quiet_hours_still_block_an_enabled_account() {
        let muted = AppSettings {
            notify_new_mail: false,
            ..AppSettings::default()
        };
        assert!(!arrival_permitted(true, Some(&muted), 600));
        let quiet = AppSettings {
            quiet_hours_start: "09:00".into(),
            quiet_hours_end: "17:00".into(),
            ..AppSettings::default()
        };
        assert!(!arrival_permitted(true, Some(&quiet), 600));
        assert!(arrival_permitted(true, Some(&quiet), 18 * 60));
    }

    #[test]
    fn private_mode_text_shows_no_sender_or_subject() {
        assert_eq!(
            arrival_text(true, None, "Ada", "ada@example.com", "Secret plan"),
            ("New mail".into(), "Open Postal Snap to read it.".into())
        );
        assert_eq!(
            arrival_text(true, Some("Work"), "Ada", "ada@example.com", "Secret plan"),
            (
                "New mail for Work".into(),
                "Open Postal Snap to read it.".into()
            )
        );
    }

    #[test]
    fn open_text_uses_name_then_address_and_subject() {
        assert_eq!(
            arrival_text(false, None, "Ada", "ada@example.com", "Hi"),
            ("Ada".into(), "Hi".into())
        );
        assert_eq!(
            arrival_text(false, Some("Work"), "", "ada@example.com", "Hi"),
            ("ada@example.com".into(), "Hi\nWork".into())
        );
    }

    #[test]
    fn mail_sound_has_a_name_on_every_desktop() {
        assert!(!new_mail_sound_name().is_empty());
    }
}
