use super::{db_error, parse_provider, parse_tls, Database};
use rusqlite::{params, OptionalExtension};

use crate::models::{AccountRecord, AccountSummary, BodyFormat, ServerConfig};

fn normalized_signature(signature: &str) -> Result<String, String> {
    let normalized = signature.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim();
    if trimmed.chars().count() > 2000
        || trimmed
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err("Keep the signature under 2000 characters of plain text.".into());
    }
    Ok(trimmed.to_string())
}

database_operations! {
impl Database {
    /// Keep account creation and attachment deletion under the same writer lock.
    pub(crate) fn remove_unowned_account_dir(&self, path: &std::path::Path) -> Result<(), String> {
        let id = path.file_name().and_then(|name| name.to_str())
            .ok_or_else(|| "Could not inspect unused attachments.".to_string())?;
        let conn = self.conn()?;
        let owned: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE id = ?1)",
            [id], |row| row.get(0),
        ).map_err(db_error)?;
        if !owned {
            match std::fs::remove_dir_all(path) {
                Ok(()) => {},
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
                    && !path.try_exists().unwrap_or(true) => {},
                Err(_) => return Err("Could not remove unused attachments.".into()),
            }
        }
        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<AccountSummary>, String> {
        let conn = self.read_conn()?;
        let mut statement = conn.prepare(
            "SELECT id, provider, email, display_name, sync_state, error, aliases_json, auth_method, signature, signature_html, color, default_body_format, reply_to FROM accounts ORDER BY sort_order, created_at",
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
                    signature_html: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
                    reply_to: row.get::<_, Option<String>>(12)?.unwrap_or_default(),
                    color: row.get(10)?,
                    default_body_format: BodyFormat::from_db(&row.get::<_, String>(11)?),
                })
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn account(&self, id: &str) -> Result<AccountRecord, String> {
        let conn = self.read_conn()?;
        conn.query_row(
            "SELECT id, provider, email, display_name, sync_state, error,
                    imap_host, imap_port, imap_tls, imap_username,
                    smtp_host, smtp_port, smtp_tls, smtp_username,
                    aliases_json, auth_method, signature, signature_html, color, default_body_format, bridge_certificate, reply_to
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
                        signature_html: row.get::<_, Option<String>>(17)?.unwrap_or_default(),
                        reply_to: row.get::<_, Option<String>>(21)?.unwrap_or_default(),
                        color: row.get(18)?,
                        default_body_format: BodyFormat::from_db(&row.get::<_, String>(19)?),
                    },
                    imap: ServerConfig {
                        trusted_certificate: row.get(20)?,
                        host: row.get(6)?,
                        port: row.get::<_, u16>(7)?,
                        tls_mode: parse_tls(&row.get::<_, String>(8)?),
                        username: row.get(9)?,
                    },
                    smtp: ServerConfig {
                        trusted_certificate: row.get(20)?,
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
                aliases_json, auth_method, signature, signature_html, color, default_body_format, bridge_certificate, sort_order
             ) VALUES (?1, ?2, ?3, ?4, 'idle', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
                (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM accounts))",
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
                account.summary.signature,
                account.summary.signature_html,
                account.summary.color,
                account.summary.default_body_format.as_str(),
                account.imap.trusted_certificate,
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
            let mut conn = self.conn()?;
            let transaction = conn.transaction().map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE accounts SET aliases_json = ?2 WHERE id = ?1",
                    params![id, aliases_json],
                )
                .map_err(db_error)?;
            // "To me" depends on the aliases.
            super::refresh_list_columns(&transaction, "account_id=?1", [id])?;
            transaction.commit().map_err(db_error)?;
        }
        let record = self.account(id)?;
        Ok(record.summary)
    }

    pub fn update_account_reply_to(
        &self,
        id: &str,
        reply_to: &str,
    ) -> Result<AccountSummary, String> {
        let updated = self
            .conn()?
            .execute(
                "UPDATE accounts SET reply_to = ?1 WHERE id = ?2",
                params![reply_to, id],
            )
            .map_err(db_error)?;
        if updated != 1 {
            return Err("Account not found.".into());
        }
        Ok(self.account(id)?.summary)
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
        let normalized = normalized_signature(signature)?;
        {
            let conn = self.conn()?;
            let updated = conn
                .execute(
                    "UPDATE accounts SET signature = ?1, signature_html = '' WHERE id = ?2",
                    params![normalized, id],
                )
                .map_err(db_error)?;
            if updated != 1 {
                return Err("Account not found.".into());
            }
        }
        let record = self.account(id)?;
        Ok(record.summary)
    }

    pub fn update_account_signatures(
        &self,
        id: &str,
        signature: &str,
        signature_html: &str,
    ) -> Result<AccountSummary, String> {
        let normalized = normalized_signature(signature)?;
        if signature_html.chars().count() > 20_000 {
            return Err("Keep the rich signature under 20000 characters.".into());
        }
        let sanitized_html = crate::mail::send::sanitize_signature_html(signature_html);
        {
            let conn = self.conn()?;
            let updated = conn
                .execute(
                    "UPDATE accounts SET signature = ?1, signature_html = ?2 WHERE id = ?3",
                    params![normalized, sanitized_html, id],
                )
                .map_err(db_error)?;
            if updated != 1 {
                return Err("Account not found.".into());
            }
        }
        Ok(self.account(id)?.summary)
    }

    pub fn set_account_default_body_format(
        &self,
        id: &str,
        format: BodyFormat,
    ) -> Result<AccountSummary, String> {
        {
            let conn = self.conn()?;
            let updated = conn
                .execute(
                    "UPDATE accounts SET default_body_format = ?1 WHERE id = ?2",
                    params![format.as_str(), id],
                )
                .map_err(db_error)?;
            if updated != 1 {
                return Err("Account not found.".into());
            }
        }
        Ok(self.account(id)?.summary)
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

    /// Rule mark left by a failed sync pass, if any.
    pub fn rules_pending_from(&self, account_id: &str) -> Result<Option<i64>, String> {
        self.read_conn()?
            .query_row(
                "SELECT rules_pending_from FROM accounts WHERE id=?1",
                [account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)
            .map(Option::flatten)
    }

    /// Keep the oldest mark so every failed pass's mail stays covered.
    pub fn keep_rules_pending_from(&self, account_id: &str, mark: i64) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE accounts SET rules_pending_from=COALESCE(rules_pending_from, ?2) WHERE id=?1",
                params![account_id, mark],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn clear_rules_pending_from(&self, account_id: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "UPDATE accounts SET rules_pending_from=NULL WHERE id=?1",
                [account_id],
            )
            .map_err(db_error)?;
        Ok(())
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

    pub fn update_account_color(&self, id: &str, color: Option<&str>) -> Result<(), String> {
        let changed = self
            .conn()?
            .execute(
                "UPDATE accounts SET color=?2 WHERE id=?1",
                params![id, color],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("Account not found.".into());
        }
        Ok(())
    }

    /// Persist the user's account order. `ordered_ids` must list every
    /// account exactly once.
    pub fn reorder_accounts(&self, ordered_ids: &[String]) -> Result<(), String> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        let existing: std::collections::HashSet<String> = {
            let mut statement = transaction
                .prepare("SELECT id FROM accounts")
                .map_err(db_error)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<_, _>>()
                .map_err(db_error)?;
            rows
        };
        let requested: std::collections::HashSet<String> = ordered_ids.iter().cloned().collect();
        if requested.len() != ordered_ids.len() || requested != existing {
            return Err("Account order is invalid.".into());
        }
        for (position, id) in ordered_ids.iter().enumerate() {
            transaction
                .execute(
                    "UPDATE accounts SET sort_order=?2 WHERE id=?1",
                    params![id, position as i64],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    pub fn account_removal_impact(
        &self,
        account_id: &str,
    ) -> Result<crate::models::AccountRemovalImpact, String> {
        self.conn()?
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM outbox WHERE account_id=?1),
                   (SELECT COUNT(*) FROM drafts WHERE account_id=?1 AND sync_state<>'synced' AND deleted_at IS NULL),
                   (SELECT COUNT(*) FROM offline_ops WHERE account_id=?1)",
                [account_id],
                |row| {
                    Ok(crate::models::AccountRemovalImpact {
                        unsent_messages: row.get(0)?,
                        unsynced_drafts: row.get(1)?,
                        queued_changes: row.get(2)?,
                    })
                },
            )
            .map_err(db_error)
    }
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
