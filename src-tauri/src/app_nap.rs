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
