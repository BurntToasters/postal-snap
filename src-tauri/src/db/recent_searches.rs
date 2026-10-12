use std::sync::atomic::{AtomicU64, Ordering};

use super::{db_error, Database};
use rusqlite::params;

const MAX_RECENT_SEARCHES: usize = 8;
const MAX_QUERY_CHARS: usize = 200;

fn recent_stamp() -> String {
    static TICK: AtomicU64 = AtomicU64::new(0);
    let tick = TICK.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}.{:06}",
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        tick % 1_000_000
    )
}

fn normalize_recent_query(query: &str) -> Result<String, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err("Enter a search.".into());
    }
    let clipped: String = trimmed.chars().take(MAX_QUERY_CHARS).collect();
    if clipped.is_empty() {
        return Err("Enter a search.".into());
    }
    Ok(clipped)
}

impl Database {
    pub fn list_recent_searches(&self, account_id: &str) -> Result<Vec<String>, String> {
        self.account(account_id)?;
        let connection = self.conn()?;
        let mut statement = connection
            .prepare(
                "SELECT query FROM recent_searches WHERE account_id=?1 ORDER BY used_at DESC LIMIT 8",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![account_id], |row| row.get(0))
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub fn remember_search(&self, account_id: &str, query: &str) -> Result<Vec<String>, String> {
        self.account(account_id)?;
        let query = normalize_recent_query(query)?;
        let folded = query.to_lowercase();
        {
            let mut connection = self.conn()?;
            let transaction = connection.transaction().map_err(db_error)?;
            let existing: Vec<String> = {
                let mut statement = transaction
                    .prepare("SELECT query FROM recent_searches WHERE account_id=?1")
                    .map_err(db_error)?;
                let rows = statement
                    .query_map(params![account_id], |row| row.get(0))
                    .map_err(db_error)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?
            };
            for previous in existing {
                if previous.to_lowercase() == folded {
                    transaction
                        .execute(
                            "DELETE FROM recent_searches WHERE account_id=?1 AND query=?2",
                            params![account_id, previous],
                        )
                        .map_err(db_error)?;
                }
            }
            let used_at = recent_stamp();
            transaction
                .execute(
                    "INSERT INTO recent_searches(account_id, query, used_at) VALUES(?1,?2,?3)",
                    params![account_id, query, used_at],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "DELETE FROM recent_searches WHERE account_id=?1 AND rowid NOT IN (
                    SELECT rowid FROM recent_searches WHERE account_id=?1
                    ORDER BY used_at DESC LIMIT ?2
                )",
                    params![account_id, MAX_RECENT_SEARCHES as i64],
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
        }
        self.list_recent_searches(account_id)
    }

    pub fn forget_recent_search(
        &self,
        account_id: &str,
        query: &str,
    ) -> Result<Vec<String>, String> {
        self.account(account_id)?;
        let query = normalize_recent_query(query)?;
        let folded = query.to_lowercase();
        {
            let mut connection = self.conn()?;
            let transaction = connection.transaction().map_err(db_error)?;
            let existing: Vec<String> = {
                let mut statement = transaction
                    .prepare("SELECT query FROM recent_searches WHERE account_id=?1")
                    .map_err(db_error)?;
                let rows = statement
                    .query_map(params![account_id], |row| row.get(0))
                    .map_err(db_error)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?
            };
            for previous in existing {
                if previous.to_lowercase() == folded {
                    transaction
                        .execute(
                            "DELETE FROM recent_searches WHERE account_id=?1 AND query=?2",
                            params![account_id, previous],
                        )
                        .map_err(db_error)?;
                }
            }
            transaction.commit().map_err(db_error)?;
        }
        self.list_recent_searches(account_id)
    }

    pub fn forget_recent_searches(&self, account_id: &str) -> Result<(), String> {
        self.account(account_id)?;
        self.conn()?
            .execute(
                "DELETE FROM recent_searches WHERE account_id=?1",
                params![account_id],
            )
            .map_err(db_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        AccountRecord, AccountSummary, BodyFormat, ProviderKind, ServerConfig, TlsMode,
    };

    fn account(id: &str, email: &str) -> AccountRecord {
        AccountRecord {
            summary: AccountSummary {
                id: id.into(),
                provider: ProviderKind::Manual,
                email: email.into(),
                display_name: "Sam".into(),
                sync_state: "idle".into(),
                error: None,
                aliases: vec![],
                auth_method: "password".into(),
                signature: String::new(),
                reply_to: String::new(),
                color: None,
                default_body_format: BodyFormat::Html,
            },
            imap: ServerConfig {
                host: "imap.example.com".into(),
                port: 993,
                tls_mode: TlsMode::Tls,
                username: email.into(),
                trusted_certificate: None,
            },
            smtp: ServerConfig {
                host: "smtp.example.com".into(),
                port: 587,
                tls_mode: TlsMode::StartTls,
                username: email.into(),
                trusted_certificate: None,
            },
        }
    }

    #[test]
    fn recent_searches_stay_newest_first_and_leave_with_the_account() {
        let db = Database::memory();
        db.insert_account(&account("account-1", "sam@example.com"))
            .unwrap();
        db.insert_account(&account("account-2", "ada@example.com"))
            .unwrap();

        assert!(db.remember_search("account-1", "  ").is_err());
        assert!(db.remember_search("account-1", "pic\nnic").is_err());
        assert!(db.list_recent_searches("account-1").unwrap().is_empty());

        let first = db.remember_search("account-1", "  Picnic  ").unwrap();
        assert_eq!(first, vec!["Picnic".to_string()]);
        let renamed = db.remember_search("account-1", "picnic").unwrap();
        assert_eq!(renamed, vec!["picnic".to_string()]);

        for index in 0..8 {
            db.remember_search("account-1", &format!("note {index}"))
                .unwrap();
        }
        let listed = db.list_recent_searches("account-1").unwrap();
        assert_eq!(listed.len(), 8);
        assert_eq!(listed[0], "note 7");
        assert!(!listed.iter().any(|query| query == "picnic"));

        db.remember_search("account-2", "other").unwrap();
        assert_eq!(
            db.list_recent_searches("account-2").unwrap(),
            vec!["other".to_string()]
        );

        let long = "a".repeat(201);
        let stored = db.remember_search("account-2", &long).unwrap();
        assert_eq!(stored[0].chars().count(), 200);

        db.forget_recent_searches("account-2").unwrap();
        db.remember_search("account-2", "Picnic").unwrap();
        db.remember_search("account-2", "Budget").unwrap();
        assert!(db.forget_recent_search("account-2", "  ").is_err());
        assert_eq!(
            db.forget_recent_search("account-2", "PICNIC").unwrap(),
            vec!["Budget".to_string()]
        );
        assert_eq!(
            db.forget_recent_search("account-2", "missing").unwrap(),
            vec!["Budget".to_string()]
        );
        db.forget_recent_searches("account-2").unwrap();
        assert!(db.list_recent_searches("account-2").unwrap().is_empty());

        db.remove_account("account-1").unwrap();
        assert!(db.list_recent_searches("account-1").is_err());
    }
}
