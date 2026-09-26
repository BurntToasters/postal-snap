//! Periodic update checks timed in Rust with the wall clock.
//!
//! Failure modes this guards against:
//! 1. System sleep pauses monotonic webview timers, so a 6-hour check waits
//!    6 hours of awake time after resume.
//! 2. Hidden webviews throttle their own timers while closed to the tray.
//! 3. A check right after wake fails (network not up) and then waits a full
//!    interval before trying again.
//! 4. A slow check is asked for again on every tick.
//! 5. The clock moves backwards and no check is ever due again.
//! 6. "startup" or "manual" cadences still check periodically.
//! 7. A check runs again after an update is already downloaded.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// How often Rust compares the wall clock against the cadence.
const TICK: Duration = Duration::from_secs(60);
/// Minimum wait between asks when a check has not reported success.
const RETRY_SECS: u64 = 10 * 60;

static LAST_SUCCESS: AtomicU64 = AtomicU64::new(0);
static LAST_ATTEMPT: AtomicU64 = AtomicU64::new(0);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

pub fn interval_secs(cadence: &str) -> Option<u64> {
    match cadence {
        "startupAnd6h" => Some(6 * 60 * 60),
        "startupAnd12h" => Some(12 * 60 * 60),
        "startupAnd24h" => Some(24 * 60 * 60),
        _ => None,
    }
}

pub fn is_due(
    now: u64,
    last_success: u64,
    last_attempt: u64,
    interval: Option<u64>,
    update_ready: bool,
) -> bool {
    let Some(interval) = interval else {
        return false;
    };
    if update_ready {
        return false;
    }
    // A clock that moved backwards counts as elapsed.
    let success_elapsed = last_success > now || now - last_success >= interval;
    let attempt_elapsed = last_attempt > now || now - last_attempt >= RETRY_SECS;
    success_elapsed && attempt_elapsed
}

/// The startup check counts as the first attempt.
pub fn note_attempt() {
    LAST_ATTEMPT.store(now_secs(), Ordering::Relaxed);
}

pub fn mark_checked() {
    let now = now_secs();
    LAST_SUCCESS.store(now, Ordering::Relaxed);
    LAST_ATTEMPT.store(now, Ordering::Relaxed);
}

/// Emits `update-check-due` when the cadence has elapsed on the wall clock.
pub fn check_now<R: Runtime>(app: &AppHandle<R>) {
    let cadence = app
        .try_state::<crate::commands::AppState>()
        .and_then(|state| state.settings.get().ok())
        .map(|settings| settings.update_check_interval);
    let interval = cadence.as_deref().and_then(interval_secs);
    if is_due(
        now_secs(),
        LAST_SUCCESS.load(Ordering::Relaxed),
        LAST_ATTEMPT.load(Ordering::Relaxed),
        interval,
        crate::update_relaunch::update_ready(),
    ) {
        note_attempt();
        let _ = app.emit("update-check-due", ());
    }
}

/// Checks the cadence every minute, including time spent asleep.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    note_attempt();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            check_now(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{interval_secs, is_due, RETRY_SECS};

    const H: u64 = 60 * 60;
    const SIX: Option<u64> = Some(6 * H);

    #[test]
    fn cadence_maps_only_periodic_choices() {
        assert_eq!(interval_secs("startupAnd6h"), Some(6 * H));
        assert_eq!(interval_secs("startupAnd12h"), Some(12 * H));
        assert_eq!(interval_secs("startupAnd24h"), Some(24 * H));
        assert_eq!(interval_secs("startup"), None);
        assert_eq!(interval_secs("manual"), None);
        assert_eq!(interval_secs(""), None);
    }

    #[test]
    fn wall_clock_time_asleep_counts() {
        let start = 1_000_000;
        // Checked at start, slept 8 hours: due on the first tick after wake.
        assert!(is_due(start + 8 * H, start, start, SIX, false));
        assert!(!is_due(start + 5 * H, start, start, SIX, false));
    }

    #[test]
    fn failed_check_retries_after_short_wait() {
        let start = 1_000_000;
        let wake = start + 8 * H;
        // Asked at wake, never reported success.
        assert!(!is_due(wake + 60, start, wake, SIX, false));
        assert!(!is_due(wake + RETRY_SECS - 1, start, wake, SIX, false));
        assert!(is_due(wake + RETRY_SECS, start, wake, SIX, false));
    }

    #[test]
    fn startup_failure_retries_without_waiting_an_interval() {
        let launch = 1_000_000;
        // No success yet; the startup check counts as an attempt.
        assert!(!is_due(launch + 60, 0, launch, SIX, false));
        assert!(is_due(launch + RETRY_SECS, 0, launch, SIX, false));
    }

    #[test]
    fn clock_moving_backwards_does_not_block_checks() {
        let now = 1_000_000;
        assert!(is_due(now, now + 10 * H, now + 10 * H, SIX, false));
    }

    #[test]
    fn no_periodic_check_for_startup_or_manual_or_ready_update() {
        let start = 1_000_000;
        assert!(!is_due(start + 48 * H, start, start, None, false));
        assert!(!is_due(start + 48 * H, start, start, SIX, true));
    }
}
