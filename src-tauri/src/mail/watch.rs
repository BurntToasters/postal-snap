//! Read-only INBOX watcher. A dedicated session EXAMINEs INBOX and IDLEs;
//! new mail only requests `wake::INBOX` from the account actor. Without a
//! usable watcher the worker keeps its in-actor IDLE, so push degrades.

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use async_imap::extensions::idle::IdleResponse;
use tokio::sync::Notify;
use zeroize::Zeroizing;

use super::{connect::ConnectError, failure::FailureKind, pool, ImapSession, IMAP_COMMAND_TIMEOUT};
use crate::{
    commands::{reconnect_delay, wake, AccountActor},
    db::Database,
    models::AccountRecord,
};

/// Longest IDLE before a fresh one; servers may log out after 30 minutes.
pub(crate) const WATCH_ROUND: Duration = Duration::from_secs(25 * 60);
/// How often an idle or parked watcher re-checks its account and password.
const CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// A session shorter than this counts toward the immediate-disconnect streak.
const SHORT_SESSION: Duration = Duration::from_secs(10);
/// Immediate disconnects in a row before the server counts as refusing us.
const SHORT_SESSION_LIMIT: u32 = 3;
const MAX_BACKOFF: u64 = 120;

/// Shared by the watcher and its worker. `active` means IDLE is running on
/// the dedicated session; `epoch` moves on sleep and credential changes.
#[derive(Debug, Default)]
pub(crate) struct WatchLink {
    active: AtomicBool,
    epoch: AtomicU64,
    restart: Notify,
}

impl WatchLink {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    pub(crate) fn signal_restart(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.restart.notify_one();
    }

    async fn restarted(&self) {
        self.restart.notified().await;
    }

    fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::SeqCst);
    }
}

/// How the server answered a refused connection attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// A connection cap, or BYE on connect. Retrying competes with the pool.
    ConnectionLimit,
    /// NO or BAD on login. Retrying would risk a lockout.
    SignInRejected,
    /// Network trouble: back off and try again.
    Ordinary,
}

/// Classify a raw IMAP error. Only the bracketed code is read; the text is
/// never logged or returned.
pub(crate) fn classify_refusal(error: &async_imap::error::Error) -> Refusal {
    // Connection-cap replies carry a response code such as `[LIMIT]`.
    let limited = match error {
        async_imap::error::Error::No(text) | async_imap::error::Error::Bad(text) => {
            let upper = text.to_ascii_uppercase();
            upper.contains("[LIMIT]") || upper.contains("[UNAVAILABLE]")
        }
        _ => false,
    };
    if limited {
        Refusal::ConnectionLimit
    } else if matches!(
        error,
        async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_)
    ) {
        Refusal::SignInRejected
    } else {
        Refusal::Ordinary
    }
}

pub(crate) fn classify_connect(error: &ConnectError) -> Refusal {
    if error.connection_limit {
        Refusal::ConnectionLimit
    } else if error.error.kind == FailureKind::SignInRejected {
        Refusal::SignInRejected
    } else {
        Refusal::Ordinary
    }
}

/// A session ends for a restart when its credentials, server, or sleep state
/// moved on since it started.
pub(crate) fn restart_required(
    session_generation: u64,
    current_generation: u64,
    session_epoch: u64,
    current_epoch: u64,
) -> bool {
    session_generation != current_generation || session_epoch != current_epoch
}

/// Counts consecutive sessions that ended almost at once.
pub(crate) fn short_session_streak(previous: u32, lived: Duration) -> u32 {
    if lived < SHORT_SESSION {
        previous.saturating_add(1)
    } else {
        0
    }
}

/// Where the watcher's password comes from. Tests pass one directly.
pub(crate) enum SecretSource {
    Vault,
    #[cfg_attr(not(test), allow(dead_code))]
    Fixed(String),
}

async fn load_secret(
    secret: &SecretSource,
    account: &AccountRecord,
) -> Result<Zeroizing<String>, String> {
    match secret {
        SecretSource::Vault => crate::oauth::session_secret(account).await,
        SecretSource::Fixed(value) => Ok(Zeroizing::new(value.clone())),
    }
}

fn account_present(db: &Database, account_id: &str) -> bool {
    db.account(account_id).is_ok()
}

fn must_end(
    db: &Database,
    account_id: &str,
    generation: u64,
    epoch: u64,
    link: &WatchLink,
) -> bool {
    !account_present(db, account_id)
        || restart_required(
            generation,
            pool::generation(account_id),
            epoch,
            link.epoch(),
        )
}

/// Hold without a session until credentials, the server, or sleep state
/// changes. Returns false once the account is removed.
async fn park(
    link: &WatchLink,
    db: &Database,
    account_id: &str,
    generation: u64,
    epoch: u64,
) -> bool {
    loop {
        if !account_present(db, account_id) {
            return false;
        }
        if restart_required(
            generation,
            pool::generation(account_id),
            epoch,
            link.epoch(),
        ) {
            return true;
        }
        tokio::select! {
            _ = link.restarted() => {}
            _ = tokio::time::sleep(CHECK_INTERVAL) => {}
        }
    }
}

async fn back_off(link: &WatchLink, account_id: &str, seconds: u64, attempt: u32) {
    tokio::select! {
        _ = tokio::time::sleep(reconnect_delay(account_id, seconds, attempt)) => {}
        _ = link.restarted() => {}
    }
}

enum Ending {
    /// Credentials, server, or sleep state changed: reconnect now.
    Restart,
    /// The account was removed.
    Gone,
    /// The connection failed or ended.
    Failed,
}

/// IDLE on the watcher session until something ends it. Re-IDLEs after each
/// server answer so the session never sits past the server's timeout.
async fn idle_until_end(
    mut session: ImapSession,
    link: &WatchLink,
    actor: &AccountActor,
    db: &Database,
    account_id: &str,
    generation: u64,
    epoch: u64,
) -> Ending {
    loop {
        let mut idle = session.idle();
        if !matches!(
            tokio::time::timeout(IMAP_COMMAND_TIMEOUT, idle.init()).await,
            Ok(Ok(()))
        ) {
            return Ending::Failed;
        }
        let response = {
            let (wait, interrupt) = idle.wait_with_timeout(WATCH_ROUND);
            tokio::pin!(wait);
            let mut interrupt = Some(interrupt);
            loop {
                tokio::select! {
                    result = &mut wait => break result,
                    _ = link.restarted() => {
                        interrupt.take();
                        break wait.as_mut().await;
                    }
                    _ = tokio::time::sleep(CHECK_INTERVAL) => {
                        if must_end(db, account_id, generation, epoch, link) {
                            interrupt.take();
                            break wait.as_mut().await;
                        }
                    }
                }
            }
        };
        session = match tokio::time::timeout(Duration::from_secs(5), idle.done()).await {
            Ok(Ok(session)) => session,
            _ => return Ending::Failed,
        };
        match response {
            Ok(IdleResponse::NewData(_)) => actor.request(wake::INBOX),
            Ok(IdleResponse::Timeout) => {}
            Ok(IdleResponse::ManualInterrupt) => {
                if must_end(db, account_id, generation, epoch, link) {
                    return if account_present(db, account_id) {
                        Ending::Restart
                    } else {
                        Ending::Gone
                    };
                }
            }
            Err(_) => return Ending::Failed,
        }
    }
}

/// Watch INBOX for the account until it is removed. Restarts when the
/// password, server, or sleep state changes.
pub(crate) async fn run_with_secret(
    account_id: String,
    db: Database,
    actor: Arc<AccountActor>,
    secret: SecretSource,
) {
    let link = actor.watch();
    let mut backoff = 2u64;
    let mut attempt = 0u32;
    let mut short_sessions = 0u32;
    while let Ok(account) = db.account(&account_id) {
        let generation = pool::generation(&account_id);
        let epoch = link.epoch();
        let Ok(password) = load_secret(&secret, &account).await else {
            back_off(link, &account_id, backoff, attempt).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            attempt = attempt.wrapping_add(1);
            continue;
        };
        let (session, capabilities) = match pool::connect_dedicated(&account, &password).await {
            Ok(connected) => connected,
            Err(error) => {
                match classify_connect(&error) {
                    Refusal::ConnectionLimit | Refusal::SignInRejected => {
                        // Retrying now would be refused again, or risk a lockout.
                        if !park(link, &db, &account_id, generation, epoch).await {
                            break;
                        }
                    }
                    Refusal::Ordinary => {
                        back_off(link, &account_id, backoff, attempt).await;
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                        attempt = attempt.wrapping_add(1);
                    }
                }
                continue;
            }
        };
        if !capabilities.idle {
            // Without IDLE the worker keeps its polling path.
            if !park(link, &db, &account_id, generation, epoch).await {
                break;
            }
            continue;
        }
        let mut session = session;
        let started = Instant::now();
        let examined = tokio::time::timeout(IMAP_COMMAND_TIMEOUT, session.examine("INBOX")).await;
        if !matches!(examined, Ok(Ok(_))) {
            drop(session);
            back_off(link, &account_id, backoff, attempt).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            attempt = attempt.wrapping_add(1);
            continue;
        }
        link.set_active(true);
        // Catch up on mail that arrived while the watcher was not running.
        actor.request(wake::INBOX);
        let ending =
            idle_until_end(session, link, &actor, &db, &account_id, generation, epoch).await;
        if link.active() {
            link.set_active(false);
            // Let a worker in watch mode fall back to in-actor IDLE.
            actor.nudge();
        }
        match ending {
            Ending::Gone => break,
            Ending::Restart => {
                backoff = 2;
                attempt = 0;
                short_sessions = 0;
            }
            Ending::Failed => {
                short_sessions = short_session_streak(short_sessions, started.elapsed());
                if short_sessions >= SHORT_SESSION_LIMIT {
                    // The server keeps dropping us: stop until a change.
                    short_sessions = 0;
                    if !park(link, &db, &account_id, generation, epoch).await {
                        break;
                    }
                    continue;
                }
                if started.elapsed() >= SHORT_SESSION {
                    backoff = 2;
                    attempt = 0;
                }
                back_off(link, &account_id, backoff, attempt).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                attempt = attempt.wrapping_add(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_connect, classify_refusal, restart_required, short_session_streak, Refusal,
        WatchLink, WATCH_ROUND,
    };
    use crate::mail::connect::{is_bye, ConnectError};
    use crate::mail::failure::{FailureKind, MailError};
    use std::time::Duration;

    fn no(text: &str) -> async_imap::error::Error {
        async_imap::error::Error::No(text.into())
    }

    fn bad(text: &str) -> async_imap::error::Error {
        async_imap::error::Error::Bad(text.into())
    }

    // Refusal failure modes (D1, D14):
    // 1. A connection cap reads as a rejected password and pauses the account.
    // 2. A wrong password is treated as a cap, so the watcher probes forever.
    // 3. A dropped network is mistaken for a cap, so push stays off.
    // 4. A BYE on connect is ignored, so the watcher hangs.
    #[test]
    fn connection_caps_are_refusals_not_sign_in_failures() {
        assert_eq!(
            classify_refusal(&no("[LIMIT] Too many connections")),
            Refusal::ConnectionLimit
        );
        assert_eq!(
            classify_refusal(&bad("[UNAVAILABLE] Try later")),
            Refusal::ConnectionLimit
        );
        assert_eq!(
            classify_refusal(&no("[limit] too many")),
            Refusal::ConnectionLimit
        );
        assert_eq!(
            classify_refusal(&no("[AUTHENTICATIONFAILED] Invalid credentials")),
            Refusal::SignInRejected
        );
        assert_eq!(
            classify_refusal(&bad("Command not valid")),
            Refusal::SignInRejected
        );
        assert_eq!(
            classify_refusal(&async_imap::error::Error::Io(std::io::Error::other(
                "reset"
            ))),
            Refusal::Ordinary
        );
        assert_eq!(
            classify_refusal(&async_imap::error::Error::ConnectionLost),
            Refusal::Ordinary
        );
    }

    #[test]
    fn bye_on_connect_is_a_connection_refusal() {
        let bye = imap_proto::Response::Data {
            status: imap_proto::Status::Bye,
            code: None,
            information: Some("Too many connections".into()),
        };
        assert!(is_bye(&bye));
        let greeting = imap_proto::Response::Data {
            status: imap_proto::Status::Ok,
            code: None,
            information: Some("ready".into()),
        };
        assert!(!is_bye(&greeting));
        let limited = ConnectError {
            error: MailError::connection("Incoming connection failed."),
            connection_limit: true,
        };
        assert_eq!(classify_connect(&limited), Refusal::ConnectionLimit);
        let rejected = ConnectError {
            error: MailError::new(FailureKind::SignInRejected, "Incoming sign-in failed."),
            connection_limit: false,
        };
        assert_eq!(classify_connect(&rejected), Refusal::SignInRejected);
        let dropped = ConnectError {
            error: MailError::connection("Incoming connection failed."),
            connection_limit: false,
        };
        assert_eq!(classify_connect(&dropped), Refusal::Ordinary);
    }

    // Restart failure modes (D3, D4):
    // 1. A password or server edit leaves the watcher on the old session.
    // 2. Waking from sleep keeps a dead IDLE socket that never reports mail.
    // 3. An ordinary INBOX or outbox wake tears down a healthy session.
    #[test]
    fn generation_or_credential_signals_restart_the_watcher() {
        assert!(restart_required(1, 2, 0, 0), "server or password edit");
        assert!(restart_required(1, 1, 0, 1), "sleep or credentials wake");
        assert!(!restart_required(1, 1, 0, 0), "ordinary wakes keep IDLE");
    }

    #[test]
    fn repeated_immediate_disconnects_reach_the_refusal_threshold() {
        let mut streak = 0;
        for _ in 0..3 {
            streak = short_session_streak(streak, Duration::from_secs(2));
        }
        assert_eq!(streak, 3);
        assert_eq!(
            short_session_streak(streak, Duration::from_secs(600)),
            0,
            "a long session resets the streak"
        );
    }

    #[test]
    fn restart_signal_moves_the_epoch_without_marking_active() {
        let link = WatchLink::new();
        let before = link.epoch();
        link.signal_restart();
        assert_eq!(link.epoch(), before + 1);
        assert!(!link.active());
    }

    #[test]
    fn idle_rounds_stay_under_the_server_timeout() {
        assert!(WATCH_ROUND <= Duration::from_secs(25 * 60));
    }

    // Read-only failure mode (D2): the watcher never selects read-write or
    // changes flags, folders, or messages. Only production code is scanned.
    #[test]
    fn watcher_never_mutates_or_selects_read_write() {
        let production = include_str!("watch.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for forbidden in [
            "session.select(",
            "session.store(",
            "session.uid_store(",
            "session.expunge(",
            "session.uid_expunge(",
            "session.append(",
            "session.mv(",
            "session.uid_mv(",
            "session.copy(",
            "session.uid_copy(",
            "session.create(",
            "session.delete(",
            "session.rename(",
        ] {
            assert!(
                !production.contains(forbidden),
                "watcher must not call {forbidden}"
            );
        }
    }
}
