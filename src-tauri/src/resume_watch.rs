//! Notices when the computer wakes from sleep and refreshes mail at once.
//!
//! Failure modes this guards against:
//! 1. A sleep-killed IDLE connection waits up to 5 minutes of awake time
//!    before new mail shows.
//! 2. A pooled session killed by sleep looks fresh and the next action fails.
//! 3. A Send Later time that passed during sleep waits behind a long sync
//!    pass or the IDLE timer.
//! 4. The update check waits for its next tick after wake.
//! 5. An account paused for a rejected password retries sign-in on every
//!    wake and risks a provider lockout.
//! 6. Normal timer jitter looks like a wake and causes needless resyncs.
//! 7. A clock that moves backwards panics or hides a wake.
//! 8. Windows' monotonic clock may count sleep, so comparing it with the wall
//!    clock alone would never see a gap.
//! 9. Repeated wall-clock corrections (NTP, manual changes) reconnect every
//!    account over and over. A clock jump is otherwise handled like a wake.

use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Manager};

const TICK: Duration = Duration::from_secs(30);
/// Extra time a tick may take before it counts as a wake.
const SLACK: Duration = Duration::from_secs(60);
/// Minimum awake time between two handled wakes.
const COOLDOWN: Duration = Duration::from_secs(120);

/// True when a tick took far longer than scheduled on either clock. The
/// monotonic clock catches Windows, where it may count sleep; the wall clock
/// catches macOS and Linux, where it does not.
pub fn woke_between_ticks(expected: Duration, monotonic: Duration, wall: Option<Duration>) -> bool {
    let elapsed = monotonic.max(wall.unwrap_or(Duration::ZERO));
    elapsed > expected + SLACK
}

/// A wake right after another one (such as a clock correction) is skipped.
pub fn outside_cooldown(since_last_wake: Option<Duration>) -> bool {
    since_last_wake.is_none_or(|elapsed| elapsed >= COOLDOWN)
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_mono = Instant::now();
        let mut last_wall = SystemTime::now();
        let mut last_wake: Option<(Instant, SystemTime)> = None;
        loop {
            tokio::time::sleep(TICK).await;
            let now_mono = Instant::now();
            let now_wall = SystemTime::now();
            // Err means the clock moved backwards; ignore that tick's wall gap.
            let wall = now_wall.duration_since(last_wall).ok();
            let woke = woke_between_ticks(TICK, now_mono - last_mono, wall);
            last_mono = now_mono;
            last_wall = now_wall;
            // Sleep since the last wake counts, or a quick re-sleep is missed.
            let since_last_wake = last_wake.map(|(mono, wall)| {
                (now_mono - mono).max(now_wall.duration_since(wall).unwrap_or_default())
            });
            if woke && outside_cooldown(since_last_wake) {
                last_wake = Some((now_mono, now_wall));
                on_wake(&app);
            }
        }
    });
}

fn on_wake(app: &AppHandle) {
    let state = app.state::<crate::commands::AppState>();
    let Ok(accounts) = state.db.list_accounts() else {
        return;
    };
    for account in accounts {
        // Every connection from before sleep is suspect.
        crate::mail::pool::forget(&account.id);
        // A worker paused for a rejected password ignores this wake.
        state.wake_after_sleep(&account.id);
    }
    #[cfg(all(
        feature = "direct-updater",
        not(any(feature = "flatpak", feature = "mas", feature = "msstore"))
    ))]
    crate::update_schedule::check_now(app);
}

#[cfg(test)]
mod tests {
    use super::{outside_cooldown, woke_between_ticks, COOLDOWN, SLACK, TICK};
    use std::time::Duration;

    #[allow(non_snake_case)]
    fn S(secs: u64) -> Duration {
        Duration::from_secs(secs)
    }

    #[test]
    fn macos_and_linux_sleep_shows_on_the_wall_clock() {
        // Monotonic time paused; eight hours passed on the wall clock.
        assert!(woke_between_ticks(TICK, TICK, Some(S(8 * 3600))));
    }

    #[test]
    fn windows_sleep_shows_on_the_monotonic_clock() {
        // Both clocks advanced; the timer fired hours late.
        assert!(woke_between_ticks(TICK, S(8 * 3600), Some(S(8 * 3600))));
        assert!(woke_between_ticks(TICK, S(8 * 3600), None));
    }

    #[test]
    fn timer_jitter_is_not_a_wake() {
        assert!(!woke_between_ticks(TICK, TICK, Some(TICK)));
        assert!(!woke_between_ticks(TICK, TICK + S(5), Some(TICK + S(5))));
        assert!(!woke_between_ticks(TICK, TICK + SLACK, Some(TICK + SLACK)));
    }

    #[test]
    fn backwards_clock_does_not_hide_or_fake_a_wake() {
        assert!(!woke_between_ticks(TICK, TICK, None));
        assert!(woke_between_ticks(TICK, S(3600), None));
    }

    #[test]
    fn clock_corrections_do_not_repeat_reconnects() {
        assert!(outside_cooldown(None));
        assert!(!outside_cooldown(Some(S(30))));
        assert!(outside_cooldown(Some(COOLDOWN)));
    }
}
