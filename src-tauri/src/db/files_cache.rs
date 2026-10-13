use super::{adjust_mailbox_counts, db_error, Database};
use rusqlite::{params, OptionalExtension};
use std::path::Path;

use crate::models::{AppSettings, CachePolicy, CacheUsage};

impl Database {
    pub fn record_flag_change(
        &self,
        account_id: &str,
        message_id: i64,
        is_read: Option<bool>,
        is_starred: Option<bool>,
        queued: Option<&serde_json::Value>,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(db_error)?;
        let (
            source_mailbox_id,
            pending_destination_id,
            was_read,
            source_overlay_active,
            destination_overlay_active,
        ): (i64, Option<i64>, bool, bool, bool) = tx
            .query_row(
                "SELECT m.mailbox_id,m.pending_move_to,m.is_read != 0,
                         COALESCE(m.pending_move_to IS NOT NULL AND m.pending_source_generation=s.counts_generation,0),
                         COALESCE(m.pending_move_to IS NOT NULL AND m.pending_destination_generation=d.counts_generation,0)
                 FROM messages m JOIN mailboxes s ON s.id=m.mailbox_id
                 LEFT JOIN mailboxes d ON d.id=m.pending_move_to
                 WHERE m.id=?1 AND m.account_id=?2",
                params![message_id, account_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Message not found.".to_string())?;
        let operations: Vec<(i64, String)> = {
            let mut statement = tx.prepare(
                "SELECT id,payload FROM offline_ops WHERE account_id=?1 AND kind='flags' AND json_valid(payload) AND json_extract(payload,'$.messageId')=?2 ORDER BY id"
            ).map_err(db_error)?;
            let rows = statement
                .query_map(params![account_id, message_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .map_err(db_error)?
                .collect::<Result<_, _>>()
                .map_err(db_error)?;
            rows
        };
        for (id, payload) in operations {
            let mut operation: serde_json::Value = serde_json::from_str(&payload)
                .map_err(|_| "Queued flag change could not be read.".to_string())?;
            if is_read.is_some() {
                operation["isRead"] = serde_json::Value::Null;
            }
            if is_starred.is_some() {
                operation["isStarred"] = serde_json::Value::Null;
            }
            let has_read = !operation["isRead"].is_null();
            let has_star = !operation["isStarred"].is_null();
            if !has_read && !has_star {
                tx.execute("DELETE FROM offline_ops WHERE id=?1", [id])
                    .map_err(db_error)?;
                continue;
            }
            let dedupe = format!("flags:{message_id}:{has_read}:{has_star}");
            let collision: Option<i64> = tx
                .query_row(
                    "SELECT id FROM offline_ops WHERE account_id=?1 AND dedupe_key=?2 AND id<>?3",
                    params![account_id, dedupe, id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
            if let Some(other_id) = collision {
                let older = id.min(other_id);
                tx.execute("DELETE FROM offline_ops WHERE id=?1", [older])
                    .map_err(db_error)?;
                if older == id {
                    continue;
                }
            }
            tx.execute(
                "UPDATE offline_ops SET payload=?2,dedupe_key=?3 WHERE id=?1",
                params![id, operation.to_string(), dedupe],
            )
            .map_err(db_error)?;
        }
        if let Some(operation) = queued {
            for (read, star) in [(is_read, None), (None, is_starred)] {
                if read.is_none() && star.is_none() {
                    continue;
                }
                let mut field = operation.clone();
                field["isRead"] = read
                    .map(serde_json::Value::Bool)
                    .unwrap_or(serde_json::Value::Null);
                field["isStarred"] = star
                    .map(serde_json::Value::Bool)
                    .unwrap_or(serde_json::Value::Null);
                let dedupe = format!("flags:{message_id}:{}:{}", read.is_some(), star.is_some());
                tx.execute(
                    "INSERT INTO offline_ops(account_id,kind,payload,dedupe_key) VALUES(?1,'flags',?2,?3)
                     ON CONFLICT(account_id,dedupe_key) DO UPDATE SET payload=excluded.payload,created_at=CURRENT_TIMESTAMP",
                    params![account_id, field.to_string(), dedupe],
                ).map_err(db_error)?;
            }
        }
        tx.execute(
            "UPDATE messages SET is_read=COALESCE(?2,is_read),is_starred=COALESCE(?3,is_starred) WHERE id=?1",
            params![message_id, is_read.map(i32::from), is_starred.map(i32::from)],
        ).map_err(db_error)?;
        if let Some(is_read) = is_read.filter(|value| *value != was_read) {
            let delta = if is_read { -1 } else { 1 };
            if pending_destination_id.is_none() || !source_overlay_active {
                adjust_mailbox_counts(&tx, source_mailbox_id, 0, Some(delta))?;
            }
            if let Some(destination_id) =
                pending_destination_id.filter(|_| destination_overlay_active)
            {
                adjust_mailbox_counts(&tx, destination_id, 0, Some(delta))?;
            }
        }
        tx.commit().map_err(db_error)
    }

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

    pub fn remove_operation_by_dedupe(
        &self,
        account_id: &str,
        dedupe_key: &str,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "DELETE FROM offline_ops WHERE account_id=?1 AND dedupe_key=?2",
                params![account_id, dedupe_key],
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

    /// Point grants at attachment files that moved with the mail data
    /// folder. Only paths under `old_dir` are rewritten, matched by path
    /// component, so `draft-attachments2` is never touched.
    pub fn rebase_file_grant_paths(&self, old_dir: &Path, new_dir: &Path) -> Result<usize, String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let rows = {
            let mut statement = transaction
                .prepare("SELECT token,path FROM file_grants")
                .map_err(db_error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(db_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?
        };
        let mut changed = 0;
        for (token, path) in rows {
            let Ok(relative) = Path::new(&path).strip_prefix(old_dir) else {
                continue;
            };
            let rebased = new_dir.join(relative);
            transaction
                .execute(
                    "UPDATE file_grants SET path=?1 WHERE token=?2",
                    params![rebased.to_string_lossy(), token],
                )
                .map_err(db_error)?;
            changed += 1;
        }
        transaction.commit().map_err(db_error)?;
        Ok(changed)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Failure modes covered:
    /// 1. A grant under the old attachment folder is not rebased: broken send.
    /// 2. A lookalike folder (`draft-attachments2`) is rewritten: wrong file.
    /// 3. An unrelated absolute path is rewritten: data corruption.
    /// 4. Running twice rewrites again: idempotence broken.
    #[test]
    fn rebases_only_grants_under_the_old_attachment_folder() {
        let db = Database::memory();
        db.conn()
            .unwrap()
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        let old = Path::new("/roaming/draft-attachments");
        let new = Path::new("/local/draft-attachments");
        let grants = [
            ("inside", "/roaming/draft-attachments/a.bin"),
            ("lookalike", "/roaming/draft-attachments2/b.bin"),
            ("unrelated", "/elsewhere/c.bin"),
        ];
        for (token, path) in grants {
            db.conn()
                .unwrap()
                .execute(
                    "INSERT INTO file_grants(token,account_id,path,size,created_at) VALUES(?1,'account-1',?2,1,CURRENT_TIMESTAMP)",
                    params![token, path],
                )
                .unwrap();
        }

        assert_eq!(db.rebase_file_grant_paths(old, new).unwrap(), 1);

        let resolve = |token: &str| db.resolve_file(token, "account-1").unwrap();
        assert_eq!(
            resolve("inside"),
            Path::new("/local/draft-attachments/a.bin")
        );
        assert_eq!(
            resolve("lookalike"),
            Path::new("/roaming/draft-attachments2/b.bin")
        );
        assert_eq!(resolve("unrelated"), Path::new("/elsewhere/c.bin"));

        assert_eq!(db.rebase_file_grant_paths(old, new).unwrap(), 0);
        assert_eq!(
            resolve("inside"),
            Path::new("/local/draft-attachments/a.bin")
        );
    }
}
