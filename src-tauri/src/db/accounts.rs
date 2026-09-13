use super::{db_error, parse_provider, parse_tls, Database};
use rusqlite::{params, OptionalExtension};

use crate::models::{AccountRecord, AccountSummary, ServerConfig};

impl Database {
    pub fn list_accounts(&self) -> Result<Vec<AccountSummary>, String> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(
            "SELECT id, provider, email, display_name, sync_state, error, aliases_json, auth_method, signature FROM accounts ORDER BY created_at",
        ).map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                let aliases_json: String = row.get(6).unwrap_or_else(|_| "[]".into());
                let aliases: Vec<String> = serde_json::from_str(&aliases_json).unwrap_or_default();
                Ok(AccountSummary {
                    id: row.get(0)?,
                    provider: parse_provider(&row.get::<_, String>(1)?),
                    email: row.get(2)?,
                    display_name: row.get(3)?,
                    sync_state: row.get(4)?,
                    error: row.get(5)?,
                    aliases,
                    auth_method: row
                        .get::<_, Option<String>>(7)?
                        .unwrap_or_else(|| "password".into()),
                    signature: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                })
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn account(&self, id: &str) -> Result<AccountRecord, String> {
        let conn = self.conn()?;
        conn.query_row(
            "SELECT id, provider, email, display_name, sync_state, error,
                    imap_host, imap_port, imap_tls, imap_username,
                    smtp_host, smtp_port, smtp_tls, smtp_username,
                    aliases_json, auth_method, signature
             FROM accounts WHERE id = ?1",
            [id],
            |row| {
                let aliases_json: String = row.get(14).unwrap_or_else(|_| "[]".into());
                let aliases: Vec<String> = serde_json::from_str(&aliases_json).unwrap_or_default();
                Ok(AccountRecord {
                    summary: AccountSummary {
                        id: row.get(0)?,
                        provider: parse_provider(&row.get::<_, String>(1)?),
                        email: row.get(2)?,
                        display_name: row.get(3)?,
                        sync_state: row.get(4)?,
                        error: row.get(5)?,
                        aliases,
                        auth_method: row
                            .get::<_, Option<String>>(15)?
                            .unwrap_or_else(|| "password".into()),
                        signature: row.get::<_, Option<String>>(16)?.unwrap_or_default(),
                    },
                    imap: ServerConfig {
                        host: row.get(6)?,
                        port: row.get::<_, u16>(7)?,
                        tls_mode: parse_tls(&row.get::<_, String>(8)?),
                        username: row.get(9)?,
                    },
                    smtp: ServerConfig {
                        host: row.get(10)?,
                        port: row.get::<_, u16>(11)?,
                        tls_mode: parse_tls(&row.get::<_, String>(12)?),
                        username: row.get(13)?,
                    },
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Account not found.".into())
    }

    pub fn insert_account(&self, account: &AccountRecord) -> Result<(), String> {
        let conn = self.conn()?;
        let aliases_json =
            serde_json::to_string(&account.summary.aliases).unwrap_or_else(|_| "[]".into());
        conn.execute(
            "INSERT INTO accounts (
                id, provider, email, display_name, sync_state,
                imap_host, imap_port, imap_tls, imap_username,
                smtp_host, smtp_port, smtp_tls, smtp_username,
                aliases_json, auth_method
             ) VALUES (?1, ?2, ?3, ?4, 'idle', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                account.summary.id,
                account.summary.provider.as_str(),
                account.summary.email,
                account.summary.display_name,
                account.imap.host,
                account.imap.port,
                account.imap.tls_mode.as_str(),
                account.imap.username,
                account.smtp.host,
                account.smtp.port,
                account.smtp.tls_mode.as_str(),
                account.smtp.username,
                aliases_json,
                account.summary.auth_method,
            ],
        )
        .map_err(|error| {
            if is_duplicate_account_email(&error) {
                "An account with this email address is already set up.".to_string()
            } else {
                db_error(error)
            }
        })?;
        Ok(())
    }

    pub fn email_taken(&self, email: &str) -> Result<bool, String> {
        let found: Option<i64> = self
            .conn()?
            .query_row(
                "SELECT 1 FROM accounts WHERE email = ?1 LIMIT 1",
                [email],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        Ok(found.is_some())
    }

    pub fn update_account_servers(
        &self,
        id: &str,
        imap: &ServerConfig,
        smtp: &ServerConfig,
    ) -> Result<(), String> {
        let updated = self
            .conn()?
            .execute(
                "UPDATE accounts SET imap_host=?2, imap_port=?3, imap_tls=?4, imap_username=?5,
                 smtp_host=?6, smtp_port=?7, smtp_tls=?8, smtp_username=?9 WHERE id=?1",
                params![
                    id,
                    imap.host,
                    imap.port,
                    imap.tls_mode.as_str(),
                    imap.username,
                    smtp.host,
                    smtp.port,
                    smtp.tls_mode.as_str(),
                    smtp.username,
                ],
            )
            .map_err(db_error)?;
        if updated != 1 {
            return Err("Account not found.".into());
        }
        Ok(())
    }

    pub fn update_account_aliases(
        &self,
        id: &str,
        aliases: &[String],
    ) -> Result<AccountSummary, String> {
        let aliases_json = serde_json::to_string(aliases)
            .map_err(|_| "Failed to serialize aliases.".to_string())?;
        {
            let conn = self.conn()?;
            conn.execute(
                "UPDATE accounts SET aliases_json = ?2 WHERE id = ?1",
                params![id, aliases_json],
            )
            .map_err(db_error)?;
        }
        let record = self.account(id)?;
        Ok(record.summary)
    }

    pub fn update_account_display_name(&self, id: &str, display_name: &str) -> Result<(), String> {
        let conn = self.conn()?;
        let updated = conn
            .execute(
                "UPDATE accounts SET display_name = ?1 WHERE id = ?2",
                params![display_name.trim(), id],
            )
            .map_err(db_error)?;
        if updated != 1 {
            return Err("Account not found.".into());
        }
        Ok(())
    }

    pub fn update_account_signature(
        &self,
        id: &str,
        signature: &str,
    ) -> Result<AccountSummary, String> {
        let trimmed = signature.trim();
        if trimmed.len() > 2000
            || trimmed
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("Keep the signature under 2000 characters of plain text.".into());
        }
        {
            let conn = self.conn()?;
            let updated = conn
                .execute(
                    "UPDATE accounts SET signature = ?1 WHERE id = ?2",
                    params![trimmed, id],
                )
                .map_err(db_error)?;
            if updated != 1 {
                return Err("Account not found.".into());
            }
        }
        let record = self.account(id)?;
        Ok(record.summary)
    }

    pub fn remove_account(&self, id: &str) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(db_error)?;
        tx.execute(
            "DELETE FROM message_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id=?1)",
            [id],
        )
        .map_err(db_error)?;
        let removed = tx
            .execute("DELETE FROM accounts WHERE id = ?1", [id])
            .map_err(db_error)?;
        if removed != 1 {
            return Err("Account not found.".into());
        }
        // Removing the last duplicate lets the database enforce uniqueness
        // again. While other duplicates remain this fails and is retried by
        // the next startup or account removal.
        let _ = super::ensure_account_email_unique_index(&tx);
        tx.commit().map_err(db_error)
    }

    pub fn account_count(&self) -> Result<usize, String> {
        let count: i64 = self
            .conn()?
            .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))
            .map_err(db_error)?;
        Ok(count.max(0) as usize)
    }

    pub fn set_account_state(
        &self,
        id: &str,
        state: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE accounts SET sync_state = ?2, error = ?3 WHERE id = ?1",
                params![id, state, error],
            )
            .map_err(db_error)?;
        Ok(())
    }
}

/// SQLite reports the `accounts_email_unique` index as a generic constraint
/// violation. Treat it as the friendly duplicate-account error so a race
/// between the command's `email_taken` check and the insert cannot surface a
/// raw database failure.
fn is_duplicate_account_email(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, Some(message))
            if code.code == rusqlite::ErrorCode::ConstraintViolation
                && code.extended_code == 2067
                && (message.contains("accounts.email")
                    || message.contains("accounts_email_unique"))
    )
}
