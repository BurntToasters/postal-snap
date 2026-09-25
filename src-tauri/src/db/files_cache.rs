use super::{db_error, Database};
use rusqlite::{params, OptionalExtension};
use std::path::Path;

use crate::models::{AppSettings, CachePolicy, CacheUsage};

impl Database {
    pub fn queue_operation<T: serde::Serialize>(
        &self,
        account_id: &str,
        kind: &str,
        payload: &T,
        dedupe_key: Option<&str>,
    ) -> Result<(), String> {
        let json = serde_json::to_string(payload)
            .map_err(|_| "Could not queue the offline change.".to_string())?;
        self.conn()?
            .execute(
                "INSERT INTO offline_ops(account_id,kind,payload,dedupe_key) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(account_id,dedupe_key) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,created_at=CURRENT_TIMESTAMP",
                params![account_id, kind, json, dedupe_key],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn queued_operations(
        &self,
        account_id: &str,
    ) -> Result<Vec<(i64, String, String)>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare("SELECT id,kind,payload FROM offline_ops WHERE account_id=?1 ORDER BY id")
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn remove_operation(&self, account_id: &str, id: i64) -> Result<(), String> {
        self.conn()?
            .execute(
                "DELETE FROM offline_ops WHERE id=?1 AND account_id=?2",
                params![id, account_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn grant_file(
        &self,
        token: &str,
        account_id: &str,
        path: &Path,
        size: u64,
    ) -> Result<(), String> {
        self.account(account_id)?;
        self.conn()?.execute(
            "INSERT INTO file_grants(token,account_id,path,size,created_at) VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP)
             ON CONFLICT(token) DO UPDATE SET path=excluded.path,size=excluded.size",
            params![token, account_id, path.to_string_lossy(), size.min(i64::MAX as u64) as i64],
        ).map_err(db_error)?;
        Ok(())
    }

    pub fn resolve_file(
        &self,
        token: &str,
        account_id: &str,
    ) -> Result<std::path::PathBuf, String> {
        let path: Option<String> = self
            .conn()?
            .query_row(
                "SELECT path FROM file_grants WHERE token=?1 AND account_id=?2",
                params![token, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        path.map(Into::into)
            .ok_or_else(|| "The selected attachment permission has expired.".into())
    }

    pub fn unreferenced_files(
        &self,
        account_id: &str,
    ) -> Result<Vec<(String, std::path::PathBuf)>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT token,path FROM file_grants WHERE account_id=?1 AND token NOT IN (SELECT token FROM attachment_refs)",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    std::path::PathBuf::from(row.get::<_, String>(1)?),
                ))
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn expired_unreferenced_files(
        &self,
        account_id: &str,
    ) -> Result<Vec<(String, std::path::PathBuf)>, String> {
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT token,path FROM file_grants WHERE account_id=?1
                 AND created_at < datetime('now','-1 day')
                 AND token NOT IN (SELECT token FROM attachment_refs)",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    std::path::PathBuf::from(row.get::<_, String>(1)?),
                ))
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn remove_file_grant(&self, token: &str, account_id: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "DELETE FROM file_grants WHERE token=?1 AND account_id=?2 AND token NOT IN (SELECT token FROM attachment_refs)",
                params![token, account_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn legacy_settings(&self) -> Result<AppSettings, String> {
        let json: Option<String> = self
            .conn()?
            .query_row("SELECT value FROM settings WHERE key='app'", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_error)?;
        json.map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| "Saved application settings are damaged.".to_string())
        })
        .transpose()
        .map(|settings| settings.unwrap_or_default())
    }

    #[cfg(test)]
    pub fn set_legacy_settings_raw_for_test(&self, value: &str) {
        self.conn()
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES('app',?1)",
                [value],
            )
            .unwrap();
    }

    pub fn cache_usage(&self, max_bytes: u64) -> Result<CacheUsage, String> {
        let conn = self.conn()?;
        let (bytes, message_count): (i64, i64) = conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(raw_message)),0), COALESCE(SUM(CASE WHEN LENGTH(raw_message) > 0 THEN 1 ELSE 0 END),0) FROM messages",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_error)?;
        // Queued outbox MIME is real local storage even though it is exempt
        // from cache eviction; surface it instead of hiding it.
        let outbox_bytes: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(mime_bytes)),0) FROM outbox",
                [],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        Ok(CacheUsage {
            bytes: bytes.max(0) as u64 + outbox_bytes.max(0) as u64,
            max_bytes,
            message_count: message_count.max(0) as u64,
        })
    }

    pub fn clear_downloaded_mail(&self) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute("UPDATE message_fts SET body=''", [])
            .map_err(db_error)?;
        transaction
            .execute(
                "UPDATE messages SET preview='',text_body='',html_body=NULL,raw_message=X'',body_bytes=0,
                 prefetch_failures=0,prefetch_retry_at=NULL",
                [],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    /// Drop downloaded bodies for one account; envelopes, drafts and outbox
    /// rows are untouched so the account keeps its full message list.
    pub fn clear_account_downloads(&self, account_id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        clear_bodies(
            &transaction,
            "account_id=?1 AND body_bytes>0",
            params![account_id],
        )?;
        transaction.commit().map_err(db_error)
    }

    /// Fill per-account download policy columns that are still NULL (new
    /// accounts and databases migrated to v18) from the app default. Rows
    /// that already carry a policy are never overwritten.
    pub fn seed_account_cache_policies(&self, default: &CachePolicy) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE accounts SET cache_mode=?1,cache_days=?2,cache_max_bytes=?3 WHERE cache_mode IS NULL",
                params![
                    default.mode,
                    default.days,
                    default.max_bytes.min(i64::MAX as u64) as i64
                ],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn account_cache_policy(
        &self,
        account_id: &str,
        default: &CachePolicy,
    ) -> Result<CachePolicy, String> {
        let row: Option<(Option<String>, Option<u32>, Option<i64>)> = self
            .conn()?
            .query_row(
                "SELECT cache_mode,cache_days,cache_max_bytes FROM accounts WHERE id=?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(db_error)?;
        let Some((mode, days, max_bytes)) = row else {
            return Err("Account not found.".into());
        };
        let policy = match mode {
            Some(mode) => CachePolicy {
                mode,
                days: days.unwrap_or(default.days),
                max_bytes: max_bytes.unwrap_or(0).max(0) as u64,
            },
            None => default.clone(),
        };
        Ok(if policy.is_valid() {
            policy
        } else {
            default.clone()
        })
    }

    /// Store a validated per-account policy. When the new policy keeps mail
    /// the old one did not, folders whose backfill stopped at the old cutoff
    /// resume. Returns whether that happened.
    pub fn set_account_cache_policy(
        &self,
        account_id: &str,
        policy: &CachePolicy,
        default: &CachePolicy,
    ) -> Result<bool, String> {
        if !policy.is_valid() {
            return Err("Choose a valid download setting.".into());
        }
        let previous = self.account_cache_policy(account_id, default)?;
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let changed = transaction
            .execute(
                "UPDATE accounts SET cache_mode=?2,cache_days=?3,cache_max_bytes=?4 WHERE id=?1",
                params![
                    account_id,
                    policy.mode,
                    policy.days,
                    policy.max_bytes.min(i64::MAX as u64) as i64
                ],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("Account not found.".into());
        }
        let widened = policy.widens(&previous);
        if widened {
            transaction
                .execute(
                    "UPDATE mailboxes SET backfill_state='active' WHERE account_id=?1 AND backfill_state='cutoff'",
                    [account_id],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(widened)
    }

    pub fn account_cache_usage(
        &self,
        account_id: &str,
        max_bytes: u64,
    ) -> Result<CacheUsage, String> {
        let (bytes, message_count): (i64, i64) = self
            .conn()?
            .query_row(
                "SELECT COALESCE(SUM(body_bytes),0), COUNT(*) FROM messages WHERE account_id=?1 AND body_bytes>0",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_error)?;
        Ok(CacheUsage {
            bytes: bytes.max(0) as u64,
            max_bytes,
            message_count: message_count.max(0) as u64,
        })
    }

    /// Apply one account's policy. The date rule keeps anything opened in the
    /// last seven days; the size rule keeps the newest-or-most-recently-read
    /// bodies whose running total fits the cap. Only body columns change.
    pub fn evict_account_to_policy(
        &self,
        account_id: &str,
        policy: &CachePolicy,
    ) -> Result<(), String> {
        if policy.is_unlimited() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        if let Some(cutoff) = policy.cutoff() {
            let cutoff = crate::mail::parse::canonical_time(cutoff);
            clear_bodies(
                &transaction,
                "account_id=?1 AND body_bytes>0
                 AND julianday(COALESCE(internal_at,received_at)) < julianday(?2)
                 AND julianday(accessed_at) < julianday('now','-7 days')",
                params![account_id, cutoff],
            )?;
        }
        if policy.max_bytes > 0 {
            clear_bodies(
                &transaction,
                "id IN (
                   SELECT id FROM (
                     SELECT id, SUM(body_bytes) OVER (
                       ORDER BY MAX(julianday(COALESCE(internal_at,received_at)), julianday(accessed_at)) DESC, id DESC
                     ) AS running
                     FROM messages WHERE account_id=?1 AND body_bytes>0
                   ) WHERE running > ?2
                 )",
                params![account_id, policy.max_bytes.min(i64::MAX as u64) as i64],
            )?;
        }
        transaction.commit().map_err(db_error)
    }

    /// Bodies that background prefetch should download next for one folder,
    /// newest first. Candidates respect the Recent cutoff, skip rows backing
    /// off after failures, and are chosen by declared size so the batch fits
    /// `budget_bytes` before anything is fetched.
    pub fn prefetch_candidates(
        &self,
        mailbox_id: i64,
        policy: &CachePolicy,
        limit: u32,
        budget_bytes: u64,
        max_item_bytes: u64,
    ) -> Result<Vec<(u32, String)>, String> {
        let cutoff = policy.cutoff().map(crate::mail::parse::canonical_time);
        let conn = self.conn()?;
        let mut statement = conn
            .prepare(
                "SELECT uid, received_at, size FROM messages
                 WHERE mailbox_id=?1 AND body_bytes=0 AND LENGTH(raw_message)=0 AND size<=?2
                 AND prefetch_failures<5
                 AND (prefetch_retry_at IS NULL OR prefetch_retry_at<=strftime('%Y-%m-%dT%H:%M:%S+00:00','now'))
                 AND (?3 IS NULL OR julianday(COALESCE(internal_at,received_at)) >= julianday(?3))
                 ORDER BY COALESCE(internal_at,received_at) DESC, uid DESC
                 LIMIT ?4",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(
                params![
                    mailbox_id,
                    max_item_bytes.min(i64::MAX as u64) as i64,
                    cutoff,
                    limit
                ],
                |row| {
                    Ok((
                        row.get::<_, u32>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let mut selected = Vec::new();
        let mut total = 0u64;
        for (uid, received_at, size) in rows {
            let size = size.max(0) as u64;
            if total.saturating_add(size) > budget_bytes {
                if selected.is_empty() {
                    selected.push((uid, received_at));
                }
                break;
            }
            total = total.saturating_add(size);
            selected.push((uid, received_at));
        }
        Ok(selected)
    }
}

/// Clear body columns and FTS body text for the rows matched by `filter`
/// (a `WHERE` clause over `messages`). Envelope columns stay.
fn clear_bodies(
    transaction: &rusqlite::Transaction,
    filter: &str,
    parameters: impl rusqlite::Params + Clone,
) -> Result<(), String> {
    transaction
        .execute(
            &format!("UPDATE message_fts SET body='' WHERE rowid IN (SELECT id FROM messages WHERE {filter})"),
            parameters.clone(),
        )
        .map_err(db_error)?;
    transaction
        .execute(
            &format!(
                "UPDATE messages SET text_body='',html_body=NULL,raw_message=X'',body_bytes=0 WHERE {filter}"
            ),
            parameters,
        )
        .map_err(db_error)?;
    Ok(())
}
