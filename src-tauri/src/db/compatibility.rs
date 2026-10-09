use super::{db_error, Database};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

pub const ASSIGNABLE_ROLES: [&str; 5] = ["sent", "drafts", "archive", "junk", "trash"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAssignment {
    pub role: String,
    pub mailbox_id: Option<i64>,
    pub missing: bool,
}

impl Database {
    pub fn server_folder_role(
        &self,
        mailbox_id: i64,
    ) -> Result<crate::models::MailboxRole, String> {
        self.conn()?
            .query_row(
                "SELECT role FROM mailboxes WHERE id=?1",
                [mailbox_id],
                |row| row.get::<_, String>(0),
            )
            .map(|role| super::parse_role(&role))
            .map_err(db_error)
    }

    pub fn folder_assignments(&self, account_id: &str) -> Result<Vec<FolderAssignment>, String> {
        self.account(account_id)?;
        let conn = self.conn()?;
        ASSIGNABLE_ROLES.into_iter().map(|role| {
            let selected: Option<(i64, bool)> = conn.query_row(
                "SELECT a.mailbox_id, NOT EXISTS(SELECT 1 FROM mailboxes m WHERE m.id=a.mailbox_id AND m.account_id=a.account_id AND m.server_available=1) FROM folder_assignments a WHERE a.account_id=?1 AND a.role=?2",
                params![account_id, role], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional().map_err(db_error)?;
            Ok(FolderAssignment { role: role.into(), mailbox_id: selected.map(|item| item.0), missing: selected.is_some_and(|item| item.1) })
        }).collect()
    }

    pub fn set_folder_assignment(
        &self,
        account_id: &str,
        role: &str,
        mailbox_id: Option<i64>,
    ) -> Result<(), String> {
        self.account(account_id)?;
        if !ASSIGNABLE_ROLES.contains(&role) {
            return Err("Choose a supported folder role.".into());
        }
        let conn = self.conn()?;
        if let Some(id) = mailbox_id {
            let owned: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM mailboxes WHERE id=?1 AND account_id=?2 AND server_available=1)",
                    params![id, account_id],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            if !owned {
                return Err("That folder does not belong to this account.".into());
            }
            let conflict: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM folder_assignments WHERE account_id=?1 AND mailbox_id=?2 AND role<>?3)", params![account_id,id,role], |row| row.get(0)).map_err(db_error)?;
            if conflict {
                return Err("Choose a different folder for each role.".into());
            }
            conn.execute("INSERT INTO folder_assignments(account_id,role,mailbox_id) VALUES(?1,?2,?3) ON CONFLICT(account_id,role) DO UPDATE SET mailbox_id=excluded.mailbox_id", params![account_id,role,id]).map_err(db_error)?;
        } else {
            conn.execute(
                "DELETE FROM folder_assignments WHERE account_id=?1 AND role=?2",
                params![account_id, role],
            )
            .map_err(db_error)?;
        }
        Ok(())
    }

    pub fn save_bridge_certificate(
        &self,
        account_id: &str,
        pem: Option<&str>,
    ) -> Result<(), String> {
        let account = self.account(account_id)?;
        if account.summary.provider != crate::models::ProviderKind::ProtonBridge {
            return Err("Only Proton Bridge accounts can trust a local certificate.".into());
        }
        self.conn()?
            .execute(
                "UPDATE accounts SET bridge_certificate=?2 WHERE id=?1",
                params![account_id, pem],
            )
            .map_err(db_error)?;
        Ok(())
    }

    #[cfg(test)]
    pub fn reset_remote_identity(&self, account_id: &str) -> Result<(), String> {
        let account = self.account(account_id)?;
        self.save_account_connection(account_id, &account.imap, &account.smtp, true)
    }

    pub fn identity_change_blocked(&self, account_id: &str) -> Result<bool, String> {
        self.conn()?.query_row("SELECT EXISTS(SELECT 1 FROM offline_ops WHERE account_id=?1) OR EXISTS(SELECT 1 FROM outbox WHERE account_id=?1 AND state NOT IN ('sent','cancelled'))", [account_id], |row| row.get(0)).map_err(db_error)
    }

    pub fn connection_blockers(
        &self,
        account_id: &str,
    ) -> Result<crate::models::ConnectionBlockers, String> {
        self.conn()?
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM offline_ops WHERE account_id=?1),
                   (SELECT COUNT(*) FROM outbox WHERE account_id=?1 AND state NOT IN ('sent','cancelled'))",
                [account_id],
                |row| {
                    Ok(crate::models::ConnectionBlockers {
                        queued_changes: row.get(0)?,
                        unsent_messages: row.get(1)?,
                    })
                },
            )
            .map_err(db_error)
    }

    pub fn save_account_connection(
        &self,
        account_id: &str,
        imap: &crate::models::ServerConfig,
        smtp: &crate::models::ServerConfig,
        reset: bool,
    ) -> Result<(), String> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(db_error)?;
        if reset {
            let blocked: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM offline_ops WHERE account_id=?1) OR EXISTS(SELECT 1 FROM outbox WHERE account_id=?1 AND state NOT IN ('sent','cancelled'))", [account_id], |row| row.get(0)).map_err(db_error)?;
            if blocked {
                return Err("Resolve queued changes and unsent mail before changing the incoming server identity.".into());
            }
            tx.execute("DELETE FROM message_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id=?1)", [account_id]).map_err(db_error)?;
            tx.execute("DELETE FROM messages WHERE account_id=?1", [account_id])
                .map_err(db_error)?;
            tx.execute("DELETE FROM mailboxes WHERE account_id=?1", [account_id])
                .map_err(db_error)?;
            tx.execute("UPDATE drafts SET remote_mailbox=NULL,remote_uid=NULL,remote_uid_validity=NULL,source_message_id=NULL,source_kind=NULL,draft_json=json_remove(draft_json,'$.sourceMessageId','$.sourceKind'),sync_state='localOnly',sync_detail='Incoming server changed. Review this saved draft before sending.' WHERE account_id=?1", [account_id]).map_err(db_error)?;
        }
        let updated = tx.execute("UPDATE accounts SET imap_host=?2,imap_port=?3,imap_tls=?4,imap_username=?5,smtp_host=?6,smtp_port=?7,smtp_tls=?8,smtp_username=?9 WHERE id=?1", params![account_id,imap.host,imap.port,imap.tls_mode.as_str(),imap.username,smtp.host,smtp.port,smtp.tls_mode.as_str(),smtp.username]).map_err(db_error)?;
        if updated == 0 {
            return Err("Account not found.".into());
        }
        tx.commit().map_err(db_error)
    }
}
