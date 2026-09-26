//! Reuse one authenticated IMAP session per account.
//!
//! Every mail operation used to open TCP, negotiate TLS and log in. The
//! account actor already serializes work per account, so at most one lease is
//! normally out at a time; the pool hands that caller the parked session and
//! takes it back when the caller finished cleanly. Sessions that failed
//! mid-command are discarded, never returned, because their protocol state is
//! unknown.

use std::{
    collections::HashMap,
    ops::{Deref, DerefMut},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant, SystemTime},
};

use super::{send::connect_imap, ImapSession, IMAP_COMMAND_TIMEOUT};
use crate::{models::AccountRecord, security::redact_error};

/// A parked session idle longer than this is probed with NOOP before reuse.
const REVALIDATE_AFTER: Duration = Duration::from_secs(60);
/// Servers may autologout after 30 minutes; never hand out anything older.
const MAX_PARKED: Duration = Duration::from_secs(25 * 60);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub condstore: bool,
    pub idle: bool,
    /// RFC 6851 MOVE.
    pub mv: bool,
    pub uidplus: bool,
}

struct Parked {
    session: ImapSession,
    capabilities: Capabilities,
    server: String,
    parked_at: Instant,
    /// Wall-clock park time; the monotonic clock pauses during sleep on
    /// macOS and Linux.
    parked_wall: SystemTime,
}

struct Pool {
    parked: HashMap<String, Parked>,
    generation: HashMap<String, u64>,
}

static POOL: LazyLock<Mutex<Pool>> = LazyLock::new(|| {
    Mutex::new(Pool {
        parked: HashMap::new(),
        generation: HashMap::new(),
    })
});

#[cfg(test)]
fn generation_of(account_id: &str) -> u64 {
    POOL.lock()
        .ok()
        .and_then(|pool| pool.generation.get(account_id).copied())
        .unwrap_or(0)
}

#[cfg(test)]
fn can_repark(account_id: &str, generation: u64) -> bool {
    generation_of(account_id) == generation
}

/// Exclusive use of an account's IMAP session. Call [`Lease::release`] after
/// a successful operation to park it for the next caller; dropping the lease
/// closes the connection instead.
pub struct Lease {
    account_id: String,
    server: String,
    session: Option<ImapSession>,
    generation: u64,
    pub capabilities: Capabilities,
}

impl Lease {
    pub fn release(mut self) {
        let Some(session) = self.session.take() else {
            return;
        };
        if let Ok(mut pool) = POOL.lock() {
            let current = pool.generation.get(&self.account_id).copied().unwrap_or(0);
            if current != self.generation {
                return;
            }
            pool.parked.insert(
                self.account_id.clone(),
                Parked {
                    session,
                    capabilities: self.capabilities,
                    server: self.server.clone(),
                    parked_at: Instant::now(),
                    parked_wall: SystemTime::now(),
                },
            );
        }
    }

    /// Close the connection instead of parking it (unknown protocol state).
    pub fn discard(mut self) {
        self.session.take();
    }

    /// Move the session out for APIs that consume it (IDLE).
    pub(crate) fn take_session(&mut self) -> Option<ImapSession> {
        self.session.take()
    }

    pub(crate) fn restore_session(&mut self, session: ImapSession) {
        self.session = Some(session);
    }
}

impl Deref for Lease {
    type Target = ImapSession;

    fn deref(&self) -> &ImapSession {
        self.session
            .as_ref()
            .expect("IMAP lease used after its session was taken")
    }
}

impl DerefMut for Lease {
    fn deref_mut(&mut self) -> &mut ImapSession {
        self.session
            .as_mut()
            .expect("IMAP lease used after its session was taken")
    }
}

fn server_key(account: &AccountRecord) -> String {
    format!(
        "{}:{}:{}:{}",
        account.imap.host,
        account.imap.port,
        account.imap.tls_mode.as_str(),
        account.imap.username
    )
}

/// Borrow the account's session, reconnecting when none is parked, the
/// parked one belongs to different server settings, or it fails a NOOP.
pub async fn checkout(account: &AccountRecord, password: &str) -> Result<Lease, String> {
    let account_id = account.summary.id.clone();
    let server = server_key(account);
    let (parked, generation) = match POOL.lock() {
        Ok(mut pool) => {
            let generation = pool.generation.get(&account_id).copied().unwrap_or(0);
            (pool.parked.remove(&account_id), generation)
        }
        Err(_) => (None, 0),
    };
    if let Some(mut parked) = parked {
        let age = parked_age(
            parked.parked_at.elapsed(),
            SystemTime::now().duration_since(parked.parked_wall).ok(),
        );
        if parked.server == server && age < MAX_PARKED {
            let healthy = age < REVALIDATE_AFTER
                || matches!(
                    tokio::time::timeout(IMAP_COMMAND_TIMEOUT, parked.session.noop()).await,
                    Ok(Ok(()))
                );
            if healthy {
                return Ok(Lease {
                    account_id,
                    server,
                    session: Some(parked.session),
                    generation,
                    capabilities: parked.capabilities,
                });
            }
        }
    }
    let mut session = connect_imap(&account.imap, password).await?;
    let capabilities = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.capabilities())
        .await
        .map_err(|_| "IMAP capability check timed out.".to_string())?
        .map_err(|error| redact_error(&error, "IMAP capability check"))?;
    let capabilities = Capabilities {
        condstore: capabilities.has_str("CONDSTORE") || capabilities.has_str("QRESYNC"),
        idle: capabilities.has_str("IDLE"),
        mv: capabilities.has_str("MOVE"),
        uidplus: capabilities.has_str("UIDPLUS"),
    };
    Ok(Lease {
        account_id,
        server,
        session: Some(session),
        generation,
        capabilities,
    })
}

/// Time since parking, counting system sleep. `wall` is None when the clock
/// moved backwards.
fn parked_age(monotonic: Duration, wall: Option<Duration>) -> Duration {
    monotonic.max(wall.unwrap_or(Duration::ZERO))
}

/// Drop any parked session for an account: its password changed, it was
/// removed, or its server settings were edited.
pub fn forget(account_id: &str) {
    if let Ok(mut pool) = POOL.lock() {
        pool.parked.remove(account_id);
        let generation = pool.generation.entry(account_id.to_string()).or_insert(0);
        *generation = generation.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{forget, parked_age, MAX_PARKED, REVALIDATE_AFTER};
    use std::time::Duration;

    #[test]
    fn sleep_ages_a_parked_session() {
        // macOS and Linux: monotonic time paused during 8 hours of sleep.
        // The session must not look fresh, or a dead socket is reused.
        let age = parked_age(Duration::from_secs(5), Some(Duration::from_secs(8 * 3600)));
        assert!(age >= MAX_PARKED);
        // Awake and recent: still skips the NOOP probe.
        let age = parked_age(Duration::from_secs(5), Some(Duration::from_secs(5)));
        assert!(age < REVALIDATE_AFTER);
        // A clock moved backwards falls back to monotonic time.
        assert_eq!(
            parked_age(Duration::from_secs(90), None),
            Duration::from_secs(90)
        );
    }

    #[test]
    fn forget_invalidates_outstanding_lease_generation() {
        // W10: an in-flight lease must not re-park after forget, and a later
        // checkout must be allowed to park under the new generation.
        let id = "acc-forget-generation";
        let gen = super::generation_of(id);
        assert!(super::can_repark(id, gen));
        forget(id);
        assert!(!super::can_repark(id, gen));
        assert!(super::can_repark(id, super::generation_of(id)));
    }
}
