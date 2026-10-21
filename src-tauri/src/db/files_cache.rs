use super::{db_error, Database};
use rusqlite::{params, OptionalExtension};
use std::path::Path;

use crate::models::{AppSettings, CachePolicy, CacheUsage};

/// Shared with the schema tests so `EXPLAIN QUERY PLAN` checks the real text.
/// Its ORDER BY must match the `messages_prefetch_order` index expression.
pub(super) const PREFETCH_CANDIDATES_SQL: &str = "SELECT uid, received_at, size FROM messages
     WHERE mailbox_id=?1 AND body_bytes=0 AND LENGTH(raw_message)=0 AND body_partial=0 AND size<=?2
     AND prefetch_failures<5 AND parse_pending<2
     AND (prefetch_retry_at IS NULL OR prefetch_retry_at<=strftime('%Y-%m-%dT%H:%M:%S+00:00','now'))
     AND (?3 IS NULL OR julianday(COALESCE(internal_at,received_at)) >= julianday(?3))
     ORDER BY COALESCE(internal_at,received_at) DESC, uid DESC
     LIMIT ?4";

database_operations! {
impl Database {
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
        let conn = self.read_conn()?;
        let (bytes, message_count): (i64, i64) = conn
            .query_row(
                "SELECT COALESCE(SUM(body_bytes),0), COUNT(*) FROM messages WHERE body_bytes>0",
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
            attachment_leftovers: false,
        })
    }

    /// Return freed space to the disk and drop old pages from the WAL. Run
    /// after large removals; it holds the database for the whole rewrite.
    pub fn compact(&self) -> Result<(), String> {
        // Writer, then reader: no read path takes the writer while holding
        // the reader. Holding both lets the WAL truncate fully.
        let conn = self.conn()?;
        let _reads_paused = self.reader.as_ref().map(|reader| {
            reader
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        });
        conn.execute("VACUUM", []).map_err(db_error)?;
        let busy: i64 = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .map_err(db_error)?;
        if busy != 0 {
            return Err("Postal Snap could not finish freeing disk space. Try again.".into());
        }
        Ok(())
    }

    pub fn clear_downloaded_mail(&self) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        transaction
            .execute("UPDATE message_fts SET body=''", [])
            .map_err(db_error)?;
        transaction
            .execute(
                "UPDATE messages SET preview='',text_body='',html_body=NULL,raw_message=X'',body_bytes=0,body_partial=0,
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
            "account_id=?1 AND (body_bytes>0 OR body_partial=1)",
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
            .read_conn()?
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
            attachment_leftovers: false,
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
        Ok(self
            .prefetch_candidate_rows(mailbox_id, policy, limit, budget_bytes, max_item_bytes)?
            .into_iter()
            .map(|(uid, received_at, _)| (uid, received_at))
            .collect())
    }

    /// Candidates with their declared sizes, so the fetch can pick a prefix.
    pub fn prefetch_candidate_rows(
        &self,
        mailbox_id: i64,
        policy: &CachePolicy,
        limit: u32,
        budget_bytes: u64,
        max_item_bytes: u64,
    ) -> Result<Vec<(u32, String, u64)>, String> {
        let cutoff = policy.cutoff().map(crate::mail::parse::canonical_time);
        let conn = self.conn()?;
        let mut statement = conn.prepare_cached(PREFETCH_CANDIDATES_SQL).map_err(db_error)?;
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
                    selected.push((uid, received_at, size));
                }
                break;
            }
            total = total.saturating_add(size);
            selected.push((uid, received_at, size));
        }
        Ok(selected)
    }
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
                "UPDATE messages SET text_body='',html_body=NULL,raw_message=X'',body_bytes=0,body_partial=0 WHERE {filter}"
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
