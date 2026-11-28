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

/// Claim the durable catch-up arrival burst before asking the OS to display
/// anything. Startup and disabled-notification passes consume it silently.
pub(crate) fn notify_new_mail(
    app: &AppHandle,
    db: &Database,
    account_id: &str,
    allow_notice: bool,
) {
    let Ok(Some(message)) = db.consume_new_mail_arrival(account_id) else {
        return;
    };
    if !allow_notice || !arrival_allowed(app, db, account_id) {
        return;
    }
    show_arrival(app, db, account_id, &message);
}

/// Arrival notice for the message a rule's notify action matched. Returns whether
/// an OS notification was queued.
pub(crate) fn rule_notice(
    app: &AppHandle,
    db: &Database,
    account_id: &str,
    message_id: i64,
) -> bool {
    let allowed = arrival_allowed(app, db, account_id);
    let Ok(Some(message)) = db.rule_notice_message(account_id, message_id) else {
        return false;
    };
    if !db
        .claim_rule_notification(account_id, message_id)
        .unwrap_or(false)
    {
        return false;
    }
    if !allowed {
        return false;
    }
    show_arrival(app, db, account_id, &message);
    true
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
    let now = crate::date_time::now_local();
    u32::from(now.hour()) * 60 + u32::from(now.minute())
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
    fn quiet_hour_clock_uses_native_local_wall_time() {
        let before =
            time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
        let actual = local_minutes_now();
        let after =
            time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
        let minutes =
            |value: time::OffsetDateTime| u32::from(value.hour()) * 60 + u32::from(value.minute());
        assert!(
            actual == minutes(before) || actual == minutes(after),
            "local quiet-hour minute did not match the native wall clock"
        );
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

    // Failure modes:
    // - A message already notified by a filter rule triggers a second new-mail notice.
    // - Suppressing the rule-notified message hides a different unread Inbox arrival.
    #[test]
    fn new_mail_skips_rule_notified_messages_without_hiding_others() {
        use crate::db::CachedMessage;
        use crate::models::{
            AccountRecord, AccountSummary, BodyFormat, MailboxRole, ProviderKind, ServerConfig,
            TlsMode,
        };

        let db = Database::memory();
        let account = AccountRecord {
            summary: AccountSummary {
                id: "account-1".into(),
                provider: ProviderKind::Manual,
                provider_id: None,
                app_password_policy: None,
                app_password_url: None,
                password_format: None,
                email: "sam@example.com".into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                signature_html: String::new(),
                reply_to: String::new(),
                color: None,
                default_body_format: BodyFormat::Html,
                notify_new_mail: true,
            },
            imap: ServerConfig {
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: "sam@example.com".into(),
                trusted_certificate: None,
            },
            smtp: ServerConfig {
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: "sam@example.com".into(),
                trusted_certificate: None,
            },
        };
        db.insert_account(&account).unwrap();
        let inbox = db
            .upsert_mailbox(
                "account-1",
                "INBOX",
                &MailboxRole::Inbox,
                Some(1),
                Some(2),
                Some(0),
                0,
            )
            .unwrap();
        let insert = |uid: u32| {
            let msg = CachedMessage {
                uid,
                internal_at: None,
                message_id: Some(format!("<{uid}@example.com>")),
                subject: format!("Msg {uid}"),
                sender_name: "Sender".into(),
                sender_address: "sender@example.com".into(),
                recipients: "sam@example.com".into(),
                received_at: "2026-08-18T12:00:00Z".into(),
                preview: "Hello".into(),
                is_read: false,
                is_starred: false,
                size: 32,
                to: vec!["sam@example.com".into()],
                cc: vec![],
                bcc: vec![],
                reply_to: None,
                thread_parent: None,
                text_body: "Hello".into(),
                html_body: None,
                attachments: vec![],
                raw_message: b"Subject: Hi\r\n\r\nHello".to_vec(),
                has_attachments: false,
                is_answered: false,
                is_forwarded: false,
                has_calendar: false,
                calendar_json: None,
                list_unsubscribe: None,
                list_unsubscribe_post: None,
                importance: String::new(),
                disposition_to: String::new(),
            };
            db.upsert_message("account-1", inbox, &msg).unwrap();
        };
        insert(1);
        let first_id = db.list_messages(inbox, None, 10).unwrap().items[0].id;
        db.record_new_mail_arrival("account-1", first_id).unwrap();
        assert!(db.claim_rule_notification("account-1", first_id).unwrap());

        insert(2);
        let items = db.list_messages(inbox, None, 10).unwrap().items;
        let second_id = items
            .iter()
            .find(|item| item.id != first_id)
            .expect("second message")
            .id;
        db.record_new_mail_arrival("account-1", second_id).unwrap();
        let picked = db
            .consume_new_mail_arrival("account-1")
            .unwrap()
            .expect("unrelated unread arrival still notifies");
        assert_eq!(picked.id, second_id);
    }
}
