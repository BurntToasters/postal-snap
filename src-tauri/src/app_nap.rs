//! macOS App Nap suppression while background mail watchers run.

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};

    pub struct AppNapGuard {
        activity: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    }

    // NSProcessInfo activity tokens are opaque refcounted objects, and ending
    // an activity is documented as callable from any thread.
    unsafe impl Send for AppNapGuard {}
    unsafe impl Sync for AppNapGuard {}

    impl AppNapGuard {
        pub fn begin(reason: &str) -> Self {
            let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                &NSString::from_str(reason),
            );
            Self { activity }
        }
    }

    impl Drop for AppNapGuard {
        fn drop(&mut self) {
            unsafe {
                NSProcessInfo::processInfo().endActivity(&self.activity);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub struct AppNapGuard;

    impl AppNapGuard {
        pub fn begin(_reason: &str) -> Self {
            Self
        }
    }
}

pub use imp::AppNapGuard;

/// Keeps App Nap off only while some work holds it: a sync pass, a
/// delivery, or an IDLE wait with a scheduled job due. Idle IMAP waits let
/// macOS nap the app.
pub struct ActivityHolds {
    reason: &'static str,
    state: std::sync::Mutex<(usize, Option<AppNapGuard>)>,
}

pub struct ActivityHold<'a> {
    holds: &'a ActivityHolds,
}

impl ActivityHolds {
    pub fn new(reason: &'static str) -> Self {
        Self {
            reason,
            state: std::sync::Mutex::new((0, None)),
        }
    }

    pub fn hold(&self) -> ActivityHold<'_> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.0 += 1;
        if state.1.is_none() {
            state.1 = Some(AppNapGuard::begin(self.reason));
        }
        ActivityHold { holds: self }
    }

    #[cfg(test)]
    fn active(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .1
            .is_some()
    }
}

impl Drop for ActivityHold<'_> {
    fn drop(&mut self) {
        let mut state = self
            .holds
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.0 = state.0.saturating_sub(1);
        if state.0 == 0 {
            state.1 = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ActivityHolds;

    // Failure modes for App Nap suppression:
    // 1. Suppression outlives the work, so App Nap is off for the whole
    //    session and drains the battery.
    // 2. One finished job ends suppression while another still runs, so
    //    its timers are throttled.
    #[test]
    fn suppression_lasts_exactly_as_long_as_some_work_holds_it() {
        let holds = ActivityHolds::new("test");
        assert!(!holds.active());
        let first = holds.hold();
        let second = holds.hold();
        assert!(holds.active());
        drop(first);
        assert!(holds.active());
        drop(second);
        assert!(!holds.active());
        drop(holds.hold());
        assert!(!holds.active());
    }
}
