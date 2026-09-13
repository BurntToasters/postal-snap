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
                "UPDATE messages SET preview='',text_body='',html_body=NULL,raw_message=X''",
                [],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    pub fn evict_to_policy(&self, policy: &CachePolicy) -> Result<(), String> {
        if policy.is_unlimited() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        if policy.mode == "recent" && policy.days > 0 {
            let transaction = conn.transaction().map_err(db_error)?;
            let cutoff = format!("-{} days", policy.days);
            transaction
                .execute(
                    "UPDATE message_fts SET body='' WHERE rowid IN (
                    SELECT id FROM messages WHERE received_at < datetime('now', ?1)
                    AND LENGTH(raw_message) > 0
                 )",
                    [&cutoff],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE messages SET text_body='',html_body=NULL,raw_message=X''
                 WHERE received_at < datetime('now', ?1) AND LENGTH(raw_message) > 0",
                    [&cutoff],
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
        }
        if policy.max_bytes > 0 {
            loop {
                let bytes: i64 = conn
                    .query_row(
                        "SELECT COALESCE(SUM(LENGTH(raw_message)),0) FROM messages",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(db_error)?;
                if bytes <= policy.max_bytes.min(i64::MAX as u64) as i64 {
                    break;
                }
                let ids = {
                    let mut statement = conn
                        .prepare(
                            "SELECT id FROM messages WHERE LENGTH(raw_message) > 0
                         ORDER BY accessed_at ASC LIMIT 25",
                        )
                        .map_err(db_error)?;
                    let ids = statement
                        .query_map([], |row| row.get::<_, i64>(0))
                        .map_err(db_error)?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(db_error)?;
                    ids
                };
                if ids.is_empty() {
                    break;
                }
                let transaction = conn.transaction().map_err(db_error)?;
                for id in ids {
                    transaction
                        .execute("UPDATE message_fts SET body='' WHERE rowid=?1", [id])
                        .map_err(db_error)?;
                    transaction.execute(
                        "UPDATE messages SET text_body='',html_body=NULL,raw_message=X'' WHERE id=?1",
                        [id],
                    ).map_err(db_error)?;
                }
                transaction.commit().map_err(db_error)?;
            }
        }
        Ok(())
    }
}
