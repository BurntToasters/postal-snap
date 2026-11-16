use super::{db_error, map_message_summary, Database, MESSAGE_SUMMARY_SELECT};
use rusqlite::{params, OptionalExtension};

use crate::models::SnoozedSummary;

impl Database {
    pub fn snooze_message(
        &self,
        account_id: &str,
        message_id: i64,
        until_iso: &str,
    ) -> Result<(), String> {
        let owner: Option<String> = self
            .read_conn()?
            .query_row(
                "SELECT account_id FROM messages WHERE id=?1",
                [message_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .flatten();
        if owner.as_deref() != Some(account_id) {
            return Err("Message does not belong to this account.".into());
        }
        self.conn()?
            .execute(
                "INSERT INTO snoozed_messages(account_id,message_id,snoozed_until)
                 VALUES(?1,?2,?3)
                 ON CONFLICT(account_id,message_id) DO UPDATE SET snoozed_until=excluded.snoozed_until",
                params![account_id, message_id, until_iso],
            )
            .map_err(db_error)?;
        Ok(())
    }

    /// Snooze every id, or none of them. A missing or foreign message rolls back.
    pub fn snooze_messages(
        &self,
        account_id: &str,
        message_ids: &[i64],
        until_iso: &str,
    ) -> Result<(), String> {
        if message_ids.is_empty() {
            return Err("Choose a message to snooze.".into());
        }
        if message_ids.len() > 200 {
            return Err("Select up to 200 messages at a time.".into());
        }
        let mut unique = Vec::new();
        for id in message_ids {
            if !unique.contains(id) {
                unique.push(*id);
            }
        }
        let mut conn = self.conn()?;
        let transaction = conn.transaction().map_err(db_error)?;
        for id in unique {
            let owner: Option<String> = transaction
                .query_row("SELECT account_id FROM messages WHERE id=?1", [id], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(db_error)?;
            if owner.as_deref() != Some(account_id) {
                return Err("Message does not belong to this account.".into());
            }
            transaction
                .execute(
                    "INSERT INTO snoozed_messages(account_id,message_id,snoozed_until)
                     VALUES(?1,?2,?3)
                     ON CONFLICT(account_id,message_id) DO UPDATE SET snoozed_until=excluded.snoozed_until",
                    params![account_id, id, until_iso],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn unsnooze_message(&self, account_id: &str, message_id: i64) -> Result<(), String> {
        let changed = self
            .conn()?
            .execute(
                "DELETE FROM snoozed_messages WHERE account_id=?1 AND message_id=?2",
                params![account_id, message_id],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("That message is not snoozed.".into());
        }
        Ok(())
    }

    pub fn prune_expired_snoozes(&self, account_id: &str, now: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "DELETE FROM snoozed_messages WHERE account_id=?1 AND snoozed_until<=?2",
                params![account_id, now],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn list_snoozed(&self, account_id: &str, now: &str) -> Result<Vec<SnoozedSummary>, String> {
        self.prune_expired_snoozes(account_id, now)?;
        let conn = self.read_conn()?;
        let mut statement = conn
            .prepare(&format!(
                "{} JOIN snoozed_messages s ON s.message_id=m.id AND s.account_id=m.account_id WHERE m.account_id=?1 ORDER BY s.snoozed_until ASC",
                MESSAGE_SUMMARY_SELECT.replace(
                    "FROM messages m",
                    ",s.snoozed_until FROM messages m"
                ),
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok(SnoozedSummary {
                    message: map_message_summary(row)?,
                    snoozed_until: row.get("snoozed_until")?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(rows)
    }
}
