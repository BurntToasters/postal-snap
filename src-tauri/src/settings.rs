use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::{
    db::Database,
    models::{
        AppSettings, CachePolicy, LastFromAddress, MailboxView, PinnedMailbox, PortableCachePolicy,
        PortableSettings, PortableSettingsFile,
    },
};

const MAX_SETTINGS_BYTES: usize = 64 * 1024;
const PORTABLE_APPLICATION: &str = "postal-snap";
const PORTABLE_FORMAT_VERSION: u32 = 1;

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<AppSettings>,
    startup_notice: Mutex<Option<String>>,
    write_lock: Mutex<()>,
    migration_pending: Mutex<bool>,
    /// Mirrors `keepAttachmentsOffline` into the sync path, which only sees the database.
    db: Option<Database>,
}

impl SettingsStore {
    pub fn load(path: PathBuf, db: &Database) -> Result<Self, String> {
        let mut startup_notice = None;
        let mut migration_pending = false;
        let settings = match read_bounded(&path) {
            Ok(Some(raw)) => match parse_and_validate(&raw) {
                Ok(settings) => settings,
                Err(_) => {
                    backup_invalid(&path)?;
                    startup_notice = Some(
                        "Postal Snap found damaged settings and restored safe defaults."
                            .to_string(),
                    );
                    let settings = AppSettings::default();
                    write_atomic(&path, &serialize(&settings)?)?;
                    settings
                }
            },
            Ok(None) => match db.legacy_settings().and_then(normalize_legacy) {
                Ok(settings) => {
                    write_atomic(&path, &serialize(&settings)?)?;
                    settings
                }
                Err(_) => {
                    migration_pending = true;
                    startup_notice = Some(
                        "Postal Snap could not migrate saved settings. Safe defaults are temporary; restart Postal Snap to try again."
                            .to_string(),
                    );
                    AppSettings::default()
                }
            },
            Err(_) => {
                backup_invalid(&path)?;
                startup_notice = Some(
                    "Postal Snap could not read settings and restored safe defaults.".to_string(),
                );
                let settings = AppSettings::default();
                write_atomic(&path, &serialize(&settings)?)?;
                settings
            }
        };
        db.set_keep_attachments_offline(settings.keep_attachments_offline);
        Ok(Self {
            path,
            current: Mutex::new(settings),
            startup_notice: Mutex::new(startup_notice),
            write_lock: Mutex::new(()),
            migration_pending: Mutex::new(migration_pending),
            db: Some(db.clone()),
        })
    }

    /// Defaults that are never written, for a launch whose settings file or
    /// mail database could not be opened. Saves are refused like a pending
    /// migration so the user's real file is not replaced.
    pub fn unavailable(path: PathBuf) -> Self {
        Self {
            path,
            current: Mutex::new(AppSettings::default()),
            startup_notice: Mutex::new(None),
            write_lock: Mutex::new(()),
            migration_pending: Mutex::new(true),
            db: None,
        }
    }

    pub fn get(&self) -> Result<AppSettings, String> {
        let settings = self
            .current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(settings.clone())
    }

    pub fn save(&self, settings: AppSettings) -> Result<AppSettings, String> {
        let _write_guard = self
            .write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *self
            .migration_pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            return Err(
                "Saved application settings could not be migrated. Restart Postal Snap or import/reset settings."
                    .to_string(),
            );
        }
        self.save_locked(settings)
    }

    fn save_locked(&self, mut settings: AppSettings) -> Result<AppSettings, String> {
        settings.image_senders = canonicalize_image_senders(&settings.image_senders)?;
        settings.pinned_mailboxes = canonicalize_pinned_mailboxes(&settings.pinned_mailboxes)?;
        settings.hidden_mailboxes = canonicalize_hidden_mailboxes(&settings.hidden_mailboxes)?;
        settings.collapsed_mailboxes =
            canonicalize_collapsed_mailboxes(&settings.collapsed_mailboxes)?;
        settings.last_from_addresses =
            canonicalize_last_from_addresses(&settings.last_from_addresses)?;
        settings.mailbox_views = canonicalize_mailbox_views(&settings.mailbox_views)?;
        validate(&settings)?;
        write_atomic(&self.path, &serialize(&settings)?)?;
        *self
            .current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = settings.clone();
        if let Some(db) = &self.db {
            db.set_keep_attachments_offline(settings.keep_attachments_offline);
        }
        *self
            .migration_pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
        Ok(settings)
    }

    pub fn take_startup_notice(&self) -> Result<Option<String>, String> {
        let notice = self
            .startup_notice
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        Ok(notice)
    }

    pub fn export_to(&self, path: &Path) -> Result<(), String> {
        let _write_guard = self
            .write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = self.get()?;
        let portable = PortableSettingsFile {
            application: PORTABLE_APPLICATION.into(),
            format_version: PORTABLE_FORMAT_VERSION,
            preferences: PortableSettings::from(&current),
        };
        let contents = serde_json::to_string_pretty(&portable)
            .map_err(|_| "Could not prepare settings export.".to_string())?;
        write_atomic(path, &contents)
    }

    pub fn import_from(&self, path: &Path) -> Result<AppSettings, String> {
        let _write_guard = self
            .write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let raw = read_bounded(path)?.ok_or_else(|| "Settings file was not found.".to_string())?;
        let portable: PortableSettingsFile = serde_json::from_str(&raw)
            .map_err(|_| "Settings export is invalid or unsupported.".to_string())?;
        if portable.application != PORTABLE_APPLICATION
            || portable.format_version != PORTABLE_FORMAT_VERSION
        {
            return Err("Settings export is invalid or unsupported.".to_string());
        }
        let current = self.get()?;
        let next = portable.preferences.apply_to(&current);
        self.save_locked(next)
    }

    /// Preference-only reset retained for settings tests; the UI now exposes
    /// only the Accounts "Reset & Restart" path (`erase_all_data`).
    #[cfg(test)]
    pub fn reset_preferences(&self) -> Result<AppSettings, String> {
        let _write_guard = self
            .write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = self.get()?;
        let next = PortableSettings::default().apply_to(&current);
        self.save_locked(next)
    }
}

impl From<&AppSettings> for PortableSettings {
    fn from(settings: &AppSettings) -> Self {
        Self {
            reading_pane: settings.reading_pane.clone(),
            text_scale: settings.text_scale,
            private_notifications: settings.private_notifications,
            theme: settings.theme.clone(),
            density: settings.density.clone(),
            cache_policy: PortableCachePolicy::from(&settings.cache_policy),
            folder_pane_width: settings.folder_pane_width,
            message_pane_width: settings.message_pane_width,
            reader_pane_height: settings.reader_pane_height,
            undo_send_seconds: settings.undo_send_seconds,
            window_effects: settings.window_effects,
            sidebar_visible: settings.sidebar_visible,
            block_advertising_and_tracking: settings.block_advertising_and_tracking,
            block_reported_threats: settings.block_reported_threats,
            image_senders: settings.image_senders.clone(),
            group_threads: settings.group_threads,
            bcc_self: settings.bcc_self,
            signature_above_quote: settings.signature_above_quote,
            reply_to_all: settings.reply_to_all,
            unread_folders_only: settings.unread_folders_only,
            composer_width: settings.composer_width,
            composer_height: settings.composer_height,
            last_from_addresses: settings.last_from_addresses.clone(),
            mailbox_sort: settings.mailbox_sort.clone(),
            mailbox_filter: settings.mailbox_filter.clone(),
            mailbox_views: settings.mailbox_views.clone(),
            pinned_mailboxes: settings.pinned_mailboxes.clone(),
            hidden_mailboxes: settings.hidden_mailboxes.clone(),
            collapsed_mailboxes: settings.collapsed_mailboxes.clone(),
            recent_move_mailbox_id: settings.recent_move_mailbox_id,
            show_message_previews: settings.show_message_previews,
            new_mail_sound: settings.new_mail_sound,
            quiet_hours_start: settings.quiet_hours_start.clone(),
            quiet_hours_end: settings.quiet_hours_end.clone(),
            mark_read: settings.mark_read.clone(),
            notify_new_mail: settings.notify_new_mail,
            close_to_tray: settings.close_to_tray,
            badge_scope: settings.badge_scope.clone(),
            keep_attachments_offline: settings.keep_attachments_offline,
            update_check_interval: settings.update_check_interval.clone(),
        }
    }
}

impl PortableSettings {
    fn apply_to(&self, current: &AppSettings) -> AppSettings {
        AppSettings {
            schema_version: 2,
            reading_pane: self.reading_pane.clone(),
            text_scale: self.text_scale,
            private_notifications: self.private_notifications,
            theme: self.theme.clone(),
            density: self.density.clone(),
            cache_policy: (&self.cache_policy).into(),
            last_account_id: current.last_account_id.clone(),
            last_mailbox_id: current.last_mailbox_id,
            folder_pane_width: self.folder_pane_width,
            message_pane_width: self.message_pane_width,
            reader_pane_height: self.reader_pane_height,
            undo_send_seconds: self.undo_send_seconds,
            window_effects: self.window_effects,
            sidebar_visible: self.sidebar_visible,
            block_advertising_and_tracking: self.block_advertising_and_tracking,
            block_reported_threats: true,
            image_senders: self.image_senders.clone(),
            group_threads: self.group_threads,
            bcc_self: self.bcc_self,
            signature_above_quote: self.signature_above_quote,
            reply_to_all: self.reply_to_all,
            unread_folders_only: self.unread_folders_only,
            composer_width: self.composer_width,
            composer_height: self.composer_height,
            last_from_addresses: self.last_from_addresses.clone(),
            mailbox_sort: self.mailbox_sort.clone(),
            mailbox_filter: self.mailbox_filter.clone(),
            mailbox_views: self.mailbox_views.clone(),
            pinned_mailboxes: self.pinned_mailboxes.clone(),
            hidden_mailboxes: self.hidden_mailboxes.clone(),
            collapsed_mailboxes: self.collapsed_mailboxes.clone(),
            recent_move_mailbox_id: self.recent_move_mailbox_id,
            show_message_previews: self.show_message_previews,
            new_mail_sound: self.new_mail_sound,
            quiet_hours_start: self.quiet_hours_start.clone(),
            quiet_hours_end: self.quiet_hours_end.clone(),
            mark_read: self.mark_read.clone(),
            notify_new_mail: self.notify_new_mail,
            close_to_tray: self.close_to_tray,
            badge_scope: self.badge_scope.clone(),
            keep_attachments_offline: self.keep_attachments_offline,
            update_check_interval: self.update_check_interval.clone(),
            update_channel: current.update_channel.clone(),
            setup_completed: current.setup_completed,
            setup_step: current.setup_step.clone(),
        }
    }
}

impl Default for PortableSettings {
    fn default() -> Self {
        Self::from(&AppSettings::default())
    }
}

impl From<&CachePolicy> for PortableCachePolicy {
    fn from(policy: &CachePolicy) -> Self {
        Self {
            mode: policy.mode.clone(),
            days: policy.days,
            max_bytes: policy.max_bytes,
        }
    }
}

impl From<&PortableCachePolicy> for CachePolicy {
    fn from(policy: &PortableCachePolicy) -> Self {
        Self {
            mode: policy.mode.clone(),
            days: policy.days,
            max_bytes: policy.max_bytes,
        }
    }
}

fn normalize_legacy(mut settings: AppSettings) -> Result<AppSettings, String> {
    settings.schema_version = 2;
    // Legacy settings predates integrated glass/sidebar preferences.
    settings.window_effects = false;
    if !matches!(settings.density.as_str(), "comfortable" | "compact") {
        settings.density = "comfortable".into();
    }
    // First-run progress did not exist before this version. Existing installs
    // have already passed first launch, so treat legacy data as completed.
    settings.setup_completed = true;
    settings.setup_step = None;
    validate(&settings)?;
    Ok(settings)
}

fn parse_and_validate(raw: &str) -> Result<AppSettings, String> {
    let mut settings: AppSettings =
        serde_json::from_str(raw).map_err(|_| "Settings JSON is invalid.".to_string())?;
    if settings.schema_version == 1 {
        return normalize_legacy(settings);
    }
    // Files written before first-run tracking lack the flag. Do not force
    // existing users through setup again; fresh installs have no file.
    if !raw.contains("setupCompleted") {
        settings.setup_completed = true;
        settings.setup_step = None;
    }
    settings.image_senders = canonicalize_image_senders(&settings.image_senders)?;
    settings.pinned_mailboxes = canonicalize_pinned_mailboxes(&settings.pinned_mailboxes)?;
    settings.hidden_mailboxes = canonicalize_hidden_mailboxes(&settings.hidden_mailboxes)?;
    settings.collapsed_mailboxes = canonicalize_collapsed_mailboxes(&settings.collapsed_mailboxes)?;
    settings.last_from_addresses = canonicalize_last_from_addresses(&settings.last_from_addresses)?;
    settings.mailbox_views = canonicalize_mailbox_views(&settings.mailbox_views)?;
    validate(&settings)?;
    Ok(settings)
}

/// Remembered image consent is an address, stored once, in a stable form.
fn normalize_image_sender(value: &str) -> Option<String> {
    let address = value.trim().to_lowercase();
    let length = address.chars().count();
    if !(3..=200).contains(&length) {
        return None;
    }
    if address
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return None;
    }
    let mut parts = address.split('@');
    let local = parts.next().unwrap_or("");
    let domain = parts.next().unwrap_or("");
    if parts.next().is_some() || local.is_empty() || domain.is_empty() {
        return None;
    }
    Some(address)
}

fn canonicalize_image_senders(values: &[String]) -> Result<Vec<String>, String> {
    if values.len() > 100 {
        return Err("Save up to 100 sender addresses.".into());
    }
    let mut next = Vec::new();
    for value in values {
        let address = normalize_image_sender(value)
            .ok_or_else(|| "Enter a sender address for image loading.".to_string())?;
        if !next.iter().any(|existing| existing == &address) {
            next.push(address);
        }
    }
    Ok(next)
}

fn minutes_of_day(value: &str) -> Option<u32> {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    let hour: u32 = value.get(..2)?.parse().ok()?;
    let minute: u32 = value.get(3..)?.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

/// Local minutes from midnight. The end minute is when alerts resume.
pub(crate) fn quiet_hours_active(start: &str, end: &str, now_minutes: u32) -> bool {
    let (Some(start), Some(end)) = (minutes_of_day(start), minutes_of_day(end)) else {
        return false;
    };
    if start == end || now_minutes >= 24 * 60 {
        return false;
    }
    if start < end {
        now_minutes >= start && now_minutes < end
    } else {
        now_minutes >= start || now_minutes < end
    }
}

/// Both times blank, or two different HH:MM values.
fn quiet_hours_ok(start: &str, end: &str) -> bool {
    if start.is_empty() && end.is_empty() {
        return true;
    }
    match (minutes_of_day(start), minutes_of_day(end)) {
        (Some(start), Some(end)) => start != end,
        _ => false,
    }
}

fn composer_size_ok(width: u32, height: u32) -> bool {
    let width_ok = width == 0 || (480..=4000).contains(&width);
    let height_ok = height == 0 || (360..=3000).contains(&height);
    (width == 0) == (height == 0) && width_ok && height_ok
}

fn validate(settings: &AppSettings) -> Result<(), String> {
    let valid_setup_step = settings
        .setup_step
        .as_deref()
        .is_none_or(|step| matches!(step, "welcome" | "appearance" | "comfort" | "account"));
    if settings.schema_version != 2
        || !(0.85..=2.0).contains(&settings.text_scale)
        || !settings.cache_policy.is_valid()
        || !valid_setup_step
        || !matches!(
            settings.reading_pane.as_str(),
            "right" | "bottom" | "hidden"
        )
        || !matches!(settings.theme.as_str(), "system" | "light" | "dark")
        || !matches!(settings.density.as_str(), "comfortable" | "compact")
        || !matches!(
            settings.update_check_interval.as_str(),
            "startupAnd6h" | "startupAnd12h" | "startupAnd24h" | "startup" | "manual"
        )
        || !matches!(settings.update_channel.as_str(), "auto" | "stable" | "beta")
        || !matches!(settings.badge_scope.as_str(), "activeInbox" | "allInboxes")
        || !(210..=420).contains(&settings.folder_pane_width)
        || !(300..=720).contains(&settings.message_pane_width)
        || !(240..=800).contains(&settings.reader_pane_height)
        || !composer_size_ok(settings.composer_width, settings.composer_height)
        || settings.undo_send_seconds > 30
        || !matches!(settings.mark_read.as_str(), "open" | "after2s" | "manual")
        || !matches!(
            settings.mailbox_sort.as_str(),
            "date"
                | "dateOldest"
                | "sender"
                | "senderDesc"
                | "subject"
                | "subjectDesc"
                | "size"
                | "sizeAsc"
        )
        || !matches!(
            settings.mailbox_filter.as_str(),
            "all" | "unread" | "starred" | "attachments" | "pinned" | "toMe" | "invitations"
        )
        || settings
            .recent_move_mailbox_id
            .is_some_and(|mailbox_id| mailbox_id <= 0)
        || settings
            .last_account_id
            .as_ref()
            .is_some_and(|value| uuid::Uuid::parse_str(value).is_err())
        || !quiet_hours_ok(&settings.quiet_hours_start, &settings.quiet_hours_end)
    {
        return Err("Invalid application settings.".into());
    }
    let canonical = canonicalize_image_senders(&settings.image_senders)?;
    if canonical != settings.image_senders {
        return Err("Enter a sender address for image loading.".into());
    }
    let pinned = canonicalize_pinned_mailboxes(&settings.pinned_mailboxes)?;
    if pinned != settings.pinned_mailboxes {
        return Err("Choose a mailbox to pin.".into());
    }
    let hidden = canonicalize_hidden_mailboxes(&settings.hidden_mailboxes)?;
    if hidden != settings.hidden_mailboxes {
        return Err("Choose a mailbox to hide.".into());
    }
    let collapsed = canonicalize_collapsed_mailboxes(&settings.collapsed_mailboxes)?;
    if collapsed != settings.collapsed_mailboxes {
        return Err("Choose a folder to collapse.".into());
    }
    let from_addresses = canonicalize_last_from_addresses(&settings.last_from_addresses)?;
    if from_addresses != settings.last_from_addresses {
        return Err("Choose a From address.".into());
    }
    let mailbox_views = canonicalize_mailbox_views(&settings.mailbox_views)?;
    if mailbox_views != settings.mailbox_views {
        return Err("Choose a mailbox list.".into());
    }
    Ok(())
}

/// Pinned mailboxes are unique account and mailbox pairs, at most 30.
fn canonicalize_pinned_mailboxes(values: &[PinnedMailbox]) -> Result<Vec<PinnedMailbox>, String> {
    canonicalize_mailbox_list(
        values,
        30,
        "Choose a mailbox to pin.",
        "Pin up to 30 mailboxes.",
    )
}

fn canonicalize_hidden_mailboxes(values: &[PinnedMailbox]) -> Result<Vec<PinnedMailbox>, String> {
    canonicalize_mailbox_list(
        values,
        100,
        "Choose a mailbox to hide.",
        "Hide up to 100 mailboxes.",
    )
}

fn from_address_ok(value: &str) -> bool {
    let address = value.trim();
    if address.len() > 320 || address.chars().any(|character| character.is_control()) {
        return false;
    }
    let mut parts = address.split('@');
    let local = parts.next().unwrap_or("");
    let host = parts.next().unwrap_or("");
    parts.next().is_none()
        && !local.is_empty()
        && !host.is_empty()
        && !local.contains(char::is_whitespace)
        && !host.contains(char::is_whitespace)
        && !local.contains('<')
        && !host.contains('>')
}

fn mailbox_sort_ok(value: &str) -> bool {
    matches!(
        value,
        "date"
            | "dateOldest"
            | "sender"
            | "senderDesc"
            | "subject"
            | "subjectDesc"
            | "size"
            | "sizeAsc"
    )
}

fn mailbox_filter_ok(value: &str) -> bool {
    matches!(
        value,
        "all" | "unread" | "starred" | "attachments" | "pinned" | "toMe" | "invitations"
    )
}

fn canonicalize_mailbox_views(values: &[MailboxView]) -> Result<Vec<MailboxView>, String> {
    let mut next = Vec::new();
    for view in values {
        let account_id = view.account_id.trim();
        if uuid::Uuid::parse_str(account_id).is_err()
            || view.mailbox_id <= 0
            || !mailbox_sort_ok(&view.sort)
            || !mailbox_filter_ok(&view.filter)
        {
            return Err("Choose a mailbox list.".into());
        }
        next.retain(|kept: &MailboxView| {
            kept.account_id != account_id || kept.mailbox_id != view.mailbox_id
        });
        next.push(MailboxView {
            account_id: account_id.to_string(),
            mailbox_id: view.mailbox_id,
            sort: view.sort.clone(),
            filter: view.filter.clone(),
        });
        if next.len() > 40 {
            return Err("Remember up to 40 mailbox lists.".into());
        }
    }
    Ok(next)
}

fn canonicalize_last_from_addresses(
    values: &[LastFromAddress],
) -> Result<Vec<LastFromAddress>, String> {
    let mut seen = std::collections::HashSet::new();
    let mut unique = Vec::new();
    for value in values {
        let account_id = value.account_id.trim();
        let address = value.address.trim();
        if uuid::Uuid::parse_str(account_id).is_err() || !from_address_ok(address) {
            return Err("Choose a From address.".into());
        }
        if !seen.insert(account_id.to_string()) {
            if let Some(existing) = unique
                .iter_mut()
                .find(|item: &&mut LastFromAddress| item.account_id == account_id)
            {
                existing.address = address.to_string();
            }
            continue;
        }
        unique.push(LastFromAddress {
            account_id: account_id.to_string(),
            address: address.to_string(),
        });
    }
    if unique.len() > 40 {
        return Err("Remember up to 40 From addresses.".into());
    }
    Ok(unique)
}

fn canonicalize_collapsed_mailboxes(
    values: &[PinnedMailbox],
) -> Result<Vec<PinnedMailbox>, String> {
    canonicalize_mailbox_list(
        values,
        200,
        "Choose a folder to collapse.",
        "Collapse up to 200 folders.",
    )
}

fn canonicalize_mailbox_list(
    values: &[PinnedMailbox],
    limit: usize,
    invalid: &str,
    overflow: &str,
) -> Result<Vec<PinnedMailbox>, String> {
    let mut next = Vec::new();
    for pin in values {
        if uuid::Uuid::parse_str(&pin.account_id).is_err() || pin.mailbox_id <= 0 {
            return Err(invalid.into());
        }
        if next.iter().any(|kept: &PinnedMailbox| {
            kept.account_id == pin.account_id && kept.mailbox_id == pin.mailbox_id
        }) {
            continue;
        }
        next.push(pin.clone());
        if next.len() > limit {
            return Err(overflow.into());
        }
    }
    Ok(next)
}

pub fn require_threat_off_confirm(
    current: &AppSettings,
    next: &AppSettings,
    confirm_token: Option<&str>,
) -> Result<(), String> {
    if current.block_reported_threats
        && !next.block_reported_threats
        && confirm_token != Some("CONFIRM")
    {
        return Err("Type CONFIRM to turn off reported-threat protection.".into());
    }
    Ok(())
}

fn serialize(settings: &AppSettings) -> Result<String, String> {
    serde_json::to_string_pretty(settings)
        .map_err(|_| "Could not serialize application settings.".to_string())
}

fn read_bounded(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not inspect application settings.".into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Settings path is not a regular file.".into());
    }
    if metadata.len() > MAX_SETTINGS_BYTES as u64 {
        return Err("Settings file is too large.".into());
    }
    let file =
        fs::File::open(path).map_err(|_| "Could not open application settings.".to_string())?;
    let mut raw = String::new();
    file.take((MAX_SETTINGS_BYTES + 1) as u64)
        .read_to_string(&mut raw)
        .map_err(|_| "Could not read application settings.".to_string())?;
    if raw.len() > MAX_SETTINGS_BYTES {
        return Err("Settings file is too large.".into());
    }
    Ok(Some(raw))
}

fn backup_invalid(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
            let unique = format!("settings.json.corrupt-{stamp}-{}", uuid::Uuid::new_v4());
            let backup = path.with_file_name(unique);
            fs::rename(path, backup)
                .map_err(|_| "Could not preserve damaged application settings.".to_string())?;
            prune_corrupt_backups(path);
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not inspect damaged application settings.".into()),
    }
}

fn prune_corrupt_backups(path: &Path) {
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return,
    };
    let mut backups: Vec<PathBuf> = Vec::new();
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("settings.json.corrupt-") {
            backups.push(entry.path());
        }
    }
    // Newest first by filename (timestamp prefix sorts chronologically).
    backups.sort_by(|a, b| b.cmp(a));
    for stale in backups.into_iter().skip(5) {
        let _ = fs::remove_file(stale);
    }
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if contents.len() > MAX_SETTINGS_BYTES {
        return Err("Settings payload is too large.".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Settings path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Could not create application data directory.".to_string())?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Settings path is invalid.".to_string())?;
    let temporary = parent.join(format!(".{filename}.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Could not create temporary application settings.".to_string())?;
    if file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
        .is_err()
    {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err("Could not save application settings.".into());
    }
    drop(file);
    fs::rename(&temporary, path).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        "Could not replace application settings.".to_string()
    })?;
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembered_image_senders_round_trip_and_reject_bad_addresses() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        let saved = store
            .save(AppSettings {
                image_senders: vec!["Ada@Example.com".into(), "ada@example.com".into()],
                ..AppSettings::default()
            })
            .unwrap();
        assert_eq!(saved.image_senders, vec!["ada@example.com".to_string()]);

        let missing = serde_json::to_value(AppSettings::default()).unwrap();
        let mut missing = missing.as_object().unwrap().clone();
        missing.remove("imageSenders");
        let parsed = parse_and_validate(&serde_json::Value::Object(missing).to_string()).unwrap();
        assert!(parsed.image_senders.is_empty());

        let bad = store.save(AppSettings {
            image_senders: vec!["not an address".into()],
            ..AppSettings::default()
        });
        assert!(bad.is_err());

        let too_many = (0..101)
            .map(|index| format!("person{index}@example.test"))
            .collect();
        let overflow = store.save(AppSettings {
            image_senders: too_many,
            ..AppSettings::default()
        });
        assert_eq!(overflow.unwrap_err(), "Save up to 100 sender addresses.");
    }

    #[test]
    fn pinned_mailboxes_round_trip_and_reject_bad_pairs() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        let account = "11111111-1111-1111-1111-111111111111";
        let saved = store
            .save(AppSettings {
                pinned_mailboxes: vec![
                    PinnedMailbox {
                        account_id: account.into(),
                        mailbox_id: 4,
                    },
                    PinnedMailbox {
                        account_id: account.into(),
                        mailbox_id: 4,
                    },
                ],
                ..AppSettings::default()
            })
            .unwrap();
        assert_eq!(saved.pinned_mailboxes.len(), 1);
        assert_eq!(saved.pinned_mailboxes[0].mailbox_id, 4);

        let missing = serde_json::to_value(AppSettings::default()).unwrap();
        let mut missing = missing.as_object().unwrap().clone();
        missing.remove("pinnedMailboxes");
        let parsed = parse_and_validate(&serde_json::Value::Object(missing).to_string()).unwrap();
        assert!(parsed.pinned_mailboxes.is_empty());

        let bad = store.save(AppSettings {
            pinned_mailboxes: vec![PinnedMailbox {
                account_id: account.into(),
                mailbox_id: 0,
            }],
            ..AppSettings::default()
        });
        assert_eq!(bad.unwrap_err(), "Choose a mailbox to pin.");

        let overflow = store.save(AppSettings {
            pinned_mailboxes: (1..=31)
                .map(|mailbox_id| PinnedMailbox {
                    account_id: account.into(),
                    mailbox_id,
                })
                .collect(),
            ..AppSettings::default()
        });
        assert_eq!(overflow.unwrap_err(), "Pin up to 30 mailboxes.");

        let hidden = store
            .save(AppSettings {
                hidden_mailboxes: vec![PinnedMailbox {
                    account_id: account.into(),
                    mailbox_id: 2,
                }],
                ..AppSettings::default()
            })
            .unwrap();
        assert_eq!(hidden.hidden_mailboxes.len(), 1);
        let bad_hide = store.save(AppSettings {
            hidden_mailboxes: vec![PinnedMailbox {
                account_id: account.into(),
                mailbox_id: 0,
            }],
            ..AppSettings::default()
        });
        assert_eq!(bad_hide.unwrap_err(), "Choose a mailbox to hide.");
    }

    #[test]
    fn recent_move_folder_is_kept_and_rejects_a_blank_id() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        let saved = store
            .save(AppSettings {
                recent_move_mailbox_id: Some(12),
                ..AppSettings::default()
            })
            .unwrap();
        assert_eq!(saved.recent_move_mailbox_id, Some(12));

        let missing = serde_json::to_value(AppSettings::default()).unwrap();
        let mut missing = missing.as_object().unwrap().clone();
        missing.remove("recentMoveMailboxId");
        let parsed = parse_and_validate(&serde_json::Value::Object(missing).to_string()).unwrap();
        assert_eq!(parsed.recent_move_mailbox_id, None);

        let bad = store.save(AppSettings {
            recent_move_mailbox_id: Some(0),
            ..AppSettings::default()
        });
        assert!(bad.is_err());
    }

    #[test]
    fn composer_window_size_is_kept_and_rejects_a_partial_size() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        let saved = store
            .save(AppSettings {
                composer_width: 700,
                composer_height: 500,
                ..AppSettings::default()
            })
            .unwrap();
        assert_eq!(saved.composer_width, 700);
        assert_eq!(saved.composer_height, 500);
        let partial = store.save(AppSettings {
            composer_width: 700,
            ..AppSettings::default()
        });
        assert_eq!(partial.unwrap_err(), "Invalid application settings.");
    }

    #[test]
    fn mailbox_view_is_kept_per_folder_and_rejects_a_bad_filter() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        let account = "11111111-1111-1111-1111-111111111111";
        let saved = store
            .save(AppSettings {
                mailbox_views: vec![
                    MailboxView {
                        account_id: account.into(),
                        mailbox_id: 1,
                        sort: "date".into(),
                        filter: "unread".into(),
                    },
                    MailboxView {
                        account_id: account.into(),
                        mailbox_id: 1,
                        sort: "dateOldest".into(),
                        filter: "all".into(),
                    },
                    MailboxView {
                        account_id: account.into(),
                        mailbox_id: 2,
                        sort: "sender".into(),
                        filter: "starred".into(),
                    },
                ],
                ..AppSettings::default()
            })
            .unwrap();
        assert_eq!(saved.mailbox_views.len(), 2);
        assert_eq!(saved.mailbox_views[0].mailbox_id, 1);
        assert_eq!(saved.mailbox_views[0].sort, "dateOldest");
        assert_eq!(saved.mailbox_views[0].filter, "all");
        assert_eq!(saved.mailbox_views[1].mailbox_id, 2);
        let bad = store.save(AppSettings {
            mailbox_views: vec![MailboxView {
                account_id: account.into(),
                mailbox_id: 1,
                sort: "date".into(),
                filter: "sideways".into(),
            }],
            ..AppSettings::default()
        });
        assert_eq!(bad.unwrap_err(), "Choose a mailbox list.");
    }

    #[test]
    fn last_from_address_is_kept_and_rejects_a_blank_address() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        let account = "11111111-1111-1111-1111-111111111111";
        let saved = store
            .save(AppSettings {
                last_from_addresses: vec![
                    LastFromAddress {
                        account_id: account.into(),
                        address: "sam@example.test".into(),
                    },
                    LastFromAddress {
                        account_id: account.into(),
                        address: "work@example.test".into(),
                    },
                ],
                ..AppSettings::default()
            })
            .unwrap();
        assert_eq!(saved.last_from_addresses.len(), 1);
        assert_eq!(saved.last_from_addresses[0].address, "work@example.test");
        let bad = store.save(AppSettings {
            last_from_addresses: vec![LastFromAddress {
                account_id: account.into(),
                address: "not an address".into(),
            }],
            ..AppSettings::default()
        });
        assert_eq!(bad.unwrap_err(), "Choose a From address.");
    }

    #[test]
    fn defaults_round_trip_and_validate() {
        let defaults = AppSettings::default();
        assert!(!defaults.bcc_self);
        assert!(defaults.signature_above_quote);
        assert!(!defaults.reply_to_all);
        assert!(defaults.collapsed_mailboxes.is_empty());
        assert!(!defaults.unread_folders_only);
        assert_eq!(defaults.composer_width, 0);
        assert_eq!(defaults.composer_height, 0);
        assert!(defaults.last_from_addresses.is_empty());
        assert!(defaults.mailbox_views.is_empty());
        assert_eq!(defaults.mailbox_sort, "date");
        assert_eq!(defaults.mailbox_filter, "all");
        assert!(defaults.show_message_previews);
        assert!(defaults.new_mail_sound);
        assert!(defaults.quiet_hours_start.is_empty());
        assert!(defaults.quiet_hours_end.is_empty());
        assert_eq!(
            parse_and_validate(&serialize(&defaults).unwrap())
                .unwrap()
                .density,
            "comfortable"
        );
        let mut value = serde_json::to_value(&defaults).unwrap();
        value.as_object_mut().unwrap().remove("bccSelf");
        value.as_object_mut().unwrap().remove("signatureAboveQuote");
        value.as_object_mut().unwrap().remove("replyToAll");
        value.as_object_mut().unwrap().remove("mailboxSort");
        value.as_object_mut().unwrap().remove("mailboxFilter");
        value.as_object_mut().unwrap().remove("showMessagePreviews");
        value.as_object_mut().unwrap().remove("newMailSound");
        value.as_object_mut().unwrap().remove("quietHoursStart");
        value.as_object_mut().unwrap().remove("quietHoursEnd");
        let parsed: AppSettings = serde_json::from_value(value).unwrap();
        assert!(!parsed.bcc_self);
        assert!(parsed.signature_above_quote);
        assert!(!parsed.reply_to_all);
        assert_eq!(parsed.mailbox_sort, "date");
        assert_eq!(parsed.mailbox_filter, "all");
        assert!(parsed.show_message_previews);
        assert!(parsed.new_mail_sound);
        assert!(parsed.quiet_hours_start.is_empty());
        assert!(parsed.quiet_hours_end.is_empty());
        assert!(!quiet_hours_active("", "", 22 * 60));
        assert!(!quiet_hours_active("22:00", "", 22 * 60));
        assert!(!quiet_hours_active("22:00", "22:00", 22 * 60));
        assert!(quiet_hours_active("22:00", "07:00", 23 * 60));
        assert!(quiet_hours_active("22:00", "07:00", 6 * 60));
        assert!(!quiet_hours_active("22:00", "07:00", 12 * 60));
        assert!(quiet_hours_active("09:00", "17:00", 9 * 60));
        assert!(!quiet_hours_active("09:00", "17:00", 17 * 60));
        assert!(validate(&AppSettings {
            quiet_hours_start: "25:00".into(),
            quiet_hours_end: "07:00".into(),
            ..AppSettings::default()
        })
        .is_err());
        let bad_sort = AppSettings {
            mailbox_sort: "sideways".into(),
            ..AppSettings::default()
        };
        assert!(validate(&bad_sort).is_err());
    }

    #[test]
    fn rejects_invalid_density_and_oversized_files() {
        let settings = AppSettings {
            density: "tiny".into(),
            ..AppSettings::default()
        };
        assert!(validate(&settings).is_err());

        let undo = AppSettings {
            undo_send_seconds: 31,
            ..AppSettings::default()
        };
        assert!(validate(&undo).is_err());
        let undo_ok = AppSettings {
            undo_send_seconds: 30,
            ..AppSettings::default()
        };
        assert!(validate(&undo_ok).is_ok());

        let mut marked = AppSettings::default();
        assert_eq!(marked.mark_read, "open");
        marked.mark_read = "after2s".into();
        assert!(validate(&marked).is_ok());
        marked.mark_read = "manual".into();
        assert!(validate(&marked).is_ok());
        marked.mark_read = "soon".into();
        assert!(validate(&marked).is_err());
        let mut stored = serde_json::to_value(AppSettings::default()).unwrap();
        stored.as_object_mut().unwrap().remove("markRead");
        let parsed = parse_and_validate(&stored.to_string()).unwrap();
        assert_eq!(parsed.mark_read, "open");

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, vec![b'x'; MAX_SETTINGS_BYTES + 1]).unwrap();
        assert!(read_bounded(&path).is_err());
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        write_atomic(&path, "{\"schemaVersion\":2}").unwrap();
        write_atomic(&path, "{\"schemaVersion\":2,\"theme\":\"dark\"}").unwrap();
        assert!(fs::read_to_string(path).unwrap().contains("dark"));
    }

    #[test]
    fn atomic_failure_keeps_current_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load(path.clone(), &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(store
            .save(AppSettings {
                theme: "light".into(),
                ..AppSettings::default()
            })
            .is_err());
        assert_eq!(store.get().unwrap().theme, "dark");
        assert!(path.is_dir());
    }

    #[test]
    fn corrupt_settings_are_preserved_and_replaced_with_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, "{not json").unwrap();
        let store = SettingsStore::load(path.clone(), &Database::memory()).unwrap();
        assert_eq!(store.get().unwrap().theme, "system");
        assert!(store.take_startup_notice().unwrap().is_some());
        assert!(store.take_startup_notice().unwrap().is_none());
        assert!(fs::read_dir(directory.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("settings.json.corrupt-")
        }));
        assert!(fs::read_to_string(path).unwrap().contains("schemaVersion"));
    }

    #[test]
    fn failed_legacy_migration_uses_temporary_defaults_without_committing_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let db = Database::memory();
        db.set_legacy_settings_raw_for_test("not-json");

        let store = SettingsStore::load(path.clone(), &db).unwrap();

        assert_eq!(store.get().unwrap().theme, "system");
        assert!(store.take_startup_notice().unwrap().is_some());
        assert!(!path.exists());
        assert!(store.save(AppSettings::default()).is_err());
        assert!(!path.exists());

        store.reset_preferences().unwrap();
        assert!(path.is_file());
        assert!(store.save(AppSettings::default()).is_ok());
    }

    #[test]
    fn badge_scope_defaults_validates_and_round_trips_portably() {
        assert_eq!(AppSettings::default().badge_scope, "activeInbox");

        let mut legacy = serde_json::to_value(AppSettings::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("badgeScope");
        let parsed = parse_and_validate(&legacy.to_string()).unwrap();
        assert_eq!(parsed.badge_scope, "activeInbox");

        let mut portable = serde_json::to_value(PortableSettings::default()).unwrap();
        portable.as_object_mut().unwrap().remove("badgeScope");
        let parsed: PortableSettings = serde_json::from_value(portable).unwrap();
        assert_eq!(parsed.badge_scope, "activeInbox");

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let export_path = directory.path().join("export.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                badge_scope: "allInboxes".into(),
                ..AppSettings::default()
            })
            .unwrap();
        store.export_to(&export_path).unwrap();
        store.save(AppSettings::default()).unwrap();
        assert_eq!(
            store.import_from(&export_path).unwrap().badge_scope,
            "allInboxes"
        );

        let invalid = store.save(AppSettings {
            badge_scope: "allMail".into(),
            ..AppSettings::default()
        });
        assert_eq!(invalid.unwrap_err(), "Invalid application settings.");
    }

    #[test]
    fn portable_export_excludes_account_selection_and_round_trips_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let export_path = directory.path().join("Postal Snap Settings.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                last_account_id: Some(uuid::Uuid::new_v4().to_string()),
                last_mailbox_id: Some(42),
                ..AppSettings::default()
            })
            .unwrap();

        store.export_to(&export_path).unwrap();
        let raw = fs::read_to_string(&export_path).unwrap();
        assert!(!raw.contains("lastAccountId"));
        assert!(!raw.contains("lastMailboxId"));
        assert_eq!(
            serde_json::from_str::<PortableSettingsFile>(&raw)
                .unwrap()
                .preferences
                .theme,
            "dark"
        );

        let imported = store.import_from(&export_path).unwrap();
        assert_eq!(imported.theme, "dark");
        assert_eq!(imported.last_mailbox_id, Some(42));
    }

    #[test]
    fn portable_import_rejects_invalid_data_without_mutating_current_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let import_path = directory.path().join("invalid.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        let mut value = serde_json::to_value(PortableSettingsFile {
            application: PORTABLE_APPLICATION.into(),
            format_version: PORTABLE_FORMAT_VERSION,
            preferences: PortableSettings::from(&store.get().unwrap()),
        })
        .unwrap();
        value["formatVersion"] = serde_json::json!(99);
        fs::write(&import_path, serde_json::to_vec(&value).unwrap()).unwrap();

        assert!(store.import_from(&import_path).is_err());
        assert_eq!(store.get().unwrap().theme, "dark");
    }

    #[test]
    fn portable_import_rejects_foreign_application_without_mutating_current_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let import_path = directory.path().join("foreign.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        let mut value = serde_json::to_value(PortableSettingsFile {
            application: PORTABLE_APPLICATION.into(),
            format_version: PORTABLE_FORMAT_VERSION,
            preferences: PortableSettings::from(&store.get().unwrap()),
        })
        .unwrap();
        value["application"] = serde_json::json!("another-app");
        fs::write(&import_path, serde_json::to_vec(&value).unwrap()).unwrap();

        assert!(store.import_from(&import_path).is_err());
        assert_eq!(store.get().unwrap().theme, "dark");
    }

    #[test]
    fn portable_import_rejects_partial_cache_policy_without_mutating_current_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let import_path = directory.path().join("partial.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        let mut value = serde_json::to_value(PortableSettingsFile {
            application: PORTABLE_APPLICATION.into(),
            format_version: PORTABLE_FORMAT_VERSION,
            preferences: PortableSettings::from(&store.get().unwrap()),
        })
        .unwrap();
        value["preferences"]["cachePolicy"]
            .as_object_mut()
            .unwrap()
            .remove("days");
        fs::write(&import_path, serde_json::to_vec(&value).unwrap()).unwrap();

        assert!(store.import_from(&import_path).is_err());
        assert_eq!(store.get().unwrap().theme, "dark");
    }

    #[test]
    fn portable_import_rejects_oversized_files_without_mutating_current_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let import_path = directory.path().join("oversized.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        fs::write(&import_path, vec![b'x'; MAX_SETTINGS_BYTES + 1]).unwrap();

        assert!(store.import_from(&import_path).is_err());
        assert_eq!(store.get().unwrap().theme, "dark");
    }

    #[test]
    fn reset_preferences_preserves_account_selection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let account_id = uuid::Uuid::new_v4().to_string();
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                theme: "dark".into(),
                density: "compact".into(),
                last_account_id: Some(account_id.clone()),
                last_mailbox_id: Some(42),
                ..AppSettings::default()
            })
            .unwrap();

        let reset = store.reset_preferences().unwrap();
        assert_eq!(reset.theme, "system");
        assert_eq!(reset.density, "comfortable");
        assert_eq!(reset.last_account_id, Some(account_id));
        assert_eq!(reset.last_mailbox_id, Some(42));
    }

    #[test]
    fn window_effects_default_on_and_survive_portable_round_trip() {
        assert!(AppSettings::default().window_effects);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let export_path = directory.path().join("export.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                window_effects: true,
                ..AppSettings::default()
            })
            .unwrap();
        store.export_to(&export_path).unwrap();
        let raw = fs::read_to_string(&export_path).unwrap();
        assert!(raw.contains("windowEffects"));
        store.save(AppSettings::default()).unwrap();
        let imported = store.import_from(&export_path).unwrap();
        assert!(imported.window_effects);
        // Files written before the toggle existed still load.
        let legacy = "{\"schemaVersion\":2,\"readingPane\":\"right\",\"textScale\":1,\"privateNotifications\":false,\"theme\":\"system\",\"density\":\"comfortable\",\"cachePolicy\":{\"mode\":\"recent\",\"days\":90,\"maxBytes\":1073741824},\"lastAccountId\":null,\"lastMailboxId\":null,\"folderPaneWidth\":264,\"messagePaneWidth\":400,\"readerPaneHeight\":360}";
        let parsed: AppSettings = serde_json::from_str(legacy).unwrap();
        assert!(!parsed.window_effects);
        assert!(parsed.block_advertising_and_tracking);
        assert!(parsed.block_reported_threats);
        // Exports from newer versions with unknown fields still import.
        let future = "{\"application\":\"postal-snap\",\"formatVersion\":1,\"preferences\":{\"readingPane\":\"right\",\"textScale\":1,\"privateNotifications\":false,\"theme\":\"dark\",\"density\":\"comfortable\",\"cachePolicy\":{\"mode\":\"recent\",\"days\":90,\"maxBytes\":1073741824},\"folderPaneWidth\":264,\"messagePaneWidth\":400,\"readerPaneHeight\":360,\"windowEffects\":false,\"nextBigThing\":true}}";
        let import_path = directory.path().join("future.json");
        fs::write(&import_path, future).unwrap();
        assert_eq!(store.import_from(&import_path).unwrap().theme, "dark");
    }

    #[test]
    fn protection_toggles_default_on_and_survive_portable_round_trip() {
        assert!(AppSettings::default().block_advertising_and_tracking);
        assert!(AppSettings::default().block_reported_threats);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let export_path = directory.path().join("export.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                block_advertising_and_tracking: false,
                block_reported_threats: false,
                ..AppSettings::default()
            })
            .unwrap();
        store.export_to(&export_path).unwrap();
        let raw = fs::read_to_string(&export_path).unwrap();
        assert!(raw.contains("blockAdvertisingAndTracking"));
        assert!(raw.contains("blockReportedThreats"));
        store.save(AppSettings::default()).unwrap();
        let imported = store.import_from(&export_path).unwrap();
        assert!(!imported.block_advertising_and_tracking);
        assert!(
            imported.block_reported_threats,
            "import cannot turn off reported-threat checks; Advanced CONFIRM is required"
        );
        let reset = store.reset_preferences().unwrap();
        assert!(reset.block_advertising_and_tracking);
        assert!(reset.block_reported_threats);
    }

    #[test]
    fn unlimited_storage_and_full_mode_pass_validation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        let settings = AppSettings {
            cache_policy: CachePolicy {
                mode: "full".into(),
                days: 0,
                max_bytes: 0,
            },
            ..AppSettings::default()
        };
        store.save(settings).unwrap();
        let loaded = store.get().unwrap();
        assert_eq!(loaded.cache_policy.mode, "full");
        assert_eq!(loaded.cache_policy.max_bytes, 0);
        assert!(loaded.cache_policy.is_unlimited());
    }

    #[test]
    fn turning_off_reported_threats_requires_confirm_token() {
        let on = AppSettings::default();
        let off = AppSettings {
            block_reported_threats: false,
            ..AppSettings::default()
        };
        assert!(require_threat_off_confirm(&on, &off, None).is_err());
        assert!(require_threat_off_confirm(&on, &off, Some("nope")).is_err());
        assert!(require_threat_off_confirm(&on, &off, Some("CONFIRM")).is_ok());
        assert!(require_threat_off_confirm(&on, &on, None).is_ok());
    }

    #[test]
    fn first_run_progress_defaults_and_validates() {
        let defaults = AppSettings::default();
        assert!(!defaults.setup_completed);
        assert_eq!(defaults.setup_step, None);
        assert!(validate(&defaults).is_ok());

        let bad = AppSettings {
            setup_step: Some("third-party".into()),
            ..AppSettings::default()
        };
        assert!(validate(&bad).is_err());

        for step in ["welcome", "appearance", "comfort", "account"] {
            let ok = AppSettings {
                setup_step: Some(step.into()),
                ..AppSettings::default()
            };
            assert!(validate(&ok).is_ok());
        }

        // Files written before first-run tracking still load.
        let legacy_raw = "{\"schemaVersion\":2,\"readingPane\":\"right\",\"textScale\":1,\"privateNotifications\":false,\"theme\":\"system\",\"density\":\"comfortable\",\"cachePolicy\":{\"mode\":\"recent\",\"days\":90,\"maxBytes\":1073741824},\"lastAccountId\":null,\"lastMailboxId\":null,\"folderPaneWidth\":264,\"messagePaneWidth\":400,\"readerPaneHeight\":360}";
        let legacy_direct: AppSettings = serde_json::from_str(legacy_raw).unwrap();
        assert!(!legacy_direct.setup_completed);
        assert_eq!(
            legacy_direct.update_check_interval,
            AppSettings::default().update_check_interval
        );
        // parse_and_validate migrates pre-existing files to completed so
        // current users are not forced through setup again.
        let legacy = parse_and_validate(legacy_raw).unwrap();
        assert!(legacy.setup_completed);
        assert_eq!(legacy.setup_step, None);
        assert_eq!(legacy.update_check_interval, "startupAnd6h");
        assert!(legacy.close_to_tray);
    }

    // Failure modes for keepAttachmentsOffline:
    // 1. Old settings files default to partial prefetch instead of off.
    // 2. Export drops the flag, so an imported backup silently loses it.
    // 3. Import leaks the flag into a non-boolean value that fails validation.
    #[test]
    fn keep_attachments_offline_defaults_off_and_round_trips() {
        assert!(!AppSettings::default().keep_attachments_offline);
        let legacy_raw = "{\"schemaVersion\":2,\"readingPane\":\"right\",\"textScale\":1,\"privateNotifications\":false,\"theme\":\"system\",\"density\":\"comfortable\",\"cachePolicy\":{\"mode\":\"recent\",\"days\":90,\"maxBytes\":1073741824},\"lastAccountId\":null,\"lastMailboxId\":null,\"folderPaneWidth\":264,\"messagePaneWidth\":400,\"readerPaneHeight\":360}";
        let parsed: AppSettings = serde_json::from_str(legacy_raw).unwrap();
        assert!(!parsed.keep_attachments_offline);

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let export_path = directory.path().join("export.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                keep_attachments_offline: true,
                ..AppSettings::default()
            })
            .unwrap();
        assert!(store.get().unwrap().keep_attachments_offline);
        assert!(store.db.as_ref().unwrap().keep_attachments_offline());
        store.export_to(&export_path).unwrap();
        let raw = fs::read_to_string(&export_path).unwrap();
        assert!(raw.contains("keepAttachmentsOffline"));
        store.save(AppSettings::default()).unwrap();
        let imported = store.import_from(&export_path).unwrap();
        assert!(imported.keep_attachments_offline);
    }

    #[test]
    fn close_to_tray_defaults_on() {
        assert!(AppSettings::default().close_to_tray);
        let legacy_raw = "{\"schemaVersion\":2,\"readingPane\":\"right\",\"textScale\":1,\"privateNotifications\":false,\"theme\":\"system\",\"density\":\"comfortable\",\"cachePolicy\":{\"mode\":\"recent\",\"days\":90,\"maxBytes\":1073741824},\"lastAccountId\":null,\"lastMailboxId\":null,\"folderPaneWidth\":264,\"messagePaneWidth\":400,\"readerPaneHeight\":360}";
        let parsed: AppSettings = serde_json::from_str(legacy_raw).unwrap();
        assert!(parsed.close_to_tray);
        assert!(validate(&parsed).is_ok());

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let export_path = directory.path().join("export.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                close_to_tray: false,
                ..AppSettings::default()
            })
            .unwrap();
        store.export_to(&export_path).unwrap();
        let raw = fs::read_to_string(&export_path).unwrap();
        assert!(raw.contains("closeToTray"));
        store.save(AppSettings::default()).unwrap();
        let imported = store.import_from(&export_path).unwrap();
        assert!(!imported.close_to_tray);
    }

    #[test]
    fn update_check_interval_defaults_and_validates() {
        assert_eq!(AppSettings::default().update_check_interval, "startupAnd6h");
        for interval in [
            "startupAnd6h",
            "startupAnd12h",
            "startupAnd24h",
            "startup",
            "manual",
        ] {
            let ok = AppSettings {
                update_check_interval: interval.into(),
                ..AppSettings::default()
            };
            assert!(validate(&ok).is_ok());
        }
        let bad = AppSettings {
            update_check_interval: "hourly".into(),
            ..AppSettings::default()
        };
        assert!(validate(&bad).is_err());

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let export_path = directory.path().join("export.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                update_check_interval: "manual".into(),
                ..AppSettings::default()
            })
            .unwrap();
        store.export_to(&export_path).unwrap();
        let raw = fs::read_to_string(&export_path).unwrap();
        assert!(raw.contains("updateCheckInterval"));
        store.save(AppSettings::default()).unwrap();
        let imported = store.import_from(&export_path).unwrap();
        assert_eq!(imported.update_check_interval, "manual");
    }

    #[test]
    fn update_channel_defaults_validates_and_ignores_import() {
        let legacy_raw = "{\"schemaVersion\":2,\"readingPane\":\"right\",\"textScale\":1,\"privateNotifications\":false,\"theme\":\"system\",\"density\":\"comfortable\",\"cachePolicy\":{\"mode\":\"recent\",\"days\":90,\"maxBytes\":1073741824},\"lastAccountId\":null,\"lastMailboxId\":null,\"folderPaneWidth\":264,\"messagePaneWidth\":400,\"readerPaneHeight\":360}";
        assert_eq!(
            parse_and_validate(legacy_raw).unwrap().update_channel,
            "auto"
        );
        for channel in ["auto", "stable", "beta"] {
            let ok = AppSettings {
                update_channel: channel.into(),
                ..AppSettings::default()
            };
            assert!(validate(&ok).is_ok());
        }
        let bad = AppSettings {
            update_channel: "nightly".into(),
            ..AppSettings::default()
        };
        assert!(validate(&bad).is_err());

        // Import must never switch the local channel.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let export_path = directory.path().join("export.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                update_channel: "beta".into(),
                ..AppSettings::default()
            })
            .unwrap();
        store.export_to(&export_path).unwrap();
        let raw = fs::read_to_string(&export_path).unwrap();
        assert!(!raw.contains("updateChannel"));
        store
            .save(AppSettings {
                update_channel: "stable".into(),
                ..AppSettings::default()
            })
            .unwrap();
        let imported = store.import_from(&export_path).unwrap();
        assert_eq!(imported.update_channel, "stable");
    }

    #[test]
    fn portable_round_trip_preserves_first_run_progress() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let export_path = directory.path().join("export.json");
        let store = SettingsStore::load(path, &Database::memory()).unwrap();
        store
            .save(AppSettings {
                setup_completed: true,
                setup_step: Some("account".into()),
                theme: "dark".into(),
                ..AppSettings::default()
            })
            .unwrap();
        store.export_to(&export_path).unwrap();
        let raw = fs::read_to_string(&export_path).unwrap();
        assert!(!raw.contains("setupCompleted"));
        assert!(!raw.contains("setupStep"));
        let imported = store.import_from(&export_path).unwrap();
        assert!(imported.setup_completed);
        assert_eq!(imported.setup_step.as_deref(), Some("account"));
        let reset = store.reset_preferences().unwrap();
        assert!(reset.setup_completed);
        assert_eq!(reset.setup_step.as_deref(), Some("account"));
    }

    #[test]
    fn corrupt_backups_are_pruned_to_newest_five() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        for index in 0..8 {
            let name = format!("settings.json.corrupt-2024010100000{index}-test");
            fs::write(directory.path().join(name), "bad").unwrap();
        }
        fs::write(&path, "{not json").unwrap();
        let _store = SettingsStore::load(path.clone(), &Database::memory()).unwrap();
        let remaining = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.corrupt-")
            })
            .count();
        assert_eq!(remaining, 5);
    }
}
