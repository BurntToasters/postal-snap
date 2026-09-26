//! Remembers how Postal Snap should reopen after installing an update.
//! Windows relaunches through the NSIS installer, so the choice is a short-
//! lived marker file rather than a command-line argument.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Idle time in the tray or menu bar before a downloaded update installs.
/// Timed here, not in the webview: hidden webviews throttle their timers.
const BACKGROUND_UPDATE_DELAY: Duration = Duration::from_secs(60);
static BACKGROUND_ARM: AtomicU64 = AtomicU64::new(0);

const MARKER_FILE: &str = "update-relaunch";
const MARKER_MAX_AGE: Duration = Duration::from_secs(10 * 60);

static LAUNCH: OnceLock<Option<RelaunchMode>> = OnceLock::new();
static UPDATE_READY: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelaunchMode {
    /// Reopen the window, as after Restart to Update.
    Window,
    /// Start in the notification area / menu bar with no window.
    Background,
}

impl RelaunchMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "window" => Some(Self::Window),
            "background" => Some(Self::Background),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Window => "window",
            Self::Background => "background",
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

pub fn write(data_dir: &Path, mode: RelaunchMode) -> std::io::Result<()> {
    std::fs::write(
        data_dir.join(MARKER_FILE),
        format!("{} {}", mode.as_str(), now_secs()),
    )
}

pub fn clear(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(MARKER_FILE));
}

fn parse_marker(contents: &str, now: u64) -> Option<RelaunchMode> {
    let (mode, written) = contents.trim().split_once(' ')?;
    let written: u64 = written.parse().ok()?;
    // A future timestamp or an old marker means the update never relaunched.
    if written > now || now - written > MARKER_MAX_AGE.as_secs() {
        return None;
    }
    RelaunchMode::parse(mode)
}

/// Reads and removes the marker once at startup.
pub fn take(data_dir: &Path) -> Option<RelaunchMode> {
    let path = data_dir.join(MARKER_FILE);
    let contents = std::fs::read_to_string(&path).ok();
    clear(data_dir);
    let mode = contents.and_then(|contents| parse_marker(&contents, now_secs()));
    let _ = LAUNCH.set(mode);
    mode
}

pub fn launched_after_update() -> Option<RelaunchMode> {
    LAUNCH.get().copied().flatten()
}

pub fn set_update_ready(ready: bool) {
    UPDATE_READY.store(ready, Ordering::Relaxed);
}

pub fn update_ready() -> bool {
    UPDATE_READY.load(Ordering::Relaxed)
}

/// True while the window is closed into an active tray or menu bar icon.
pub fn waiting_in_tray<R: Runtime>(app: &AppHandle<R>) -> bool {
    let close_to_tray = app
        .try_state::<crate::commands::AppState>()
        .and_then(|state| state.settings.get().ok())
        .map(|settings| settings.close_to_tray)
        .unwrap_or(true);
    crate::tray::is_hidden_to_tray()
        && crate::tray::should_hide_on_close(close_to_tray, crate::tray::tray_is_active())
}

/// After the delay, asks the frontend to install if the app is still waiting
/// in the tray. The latest call wins.
pub fn arm_background_update<R: Runtime>(app: &AppHandle<R>) {
    if !update_ready() || !waiting_in_tray(app) {
        return;
    }
    let arm = BACKGROUND_ARM.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _nap = crate::app_nap::AppNapGuard::begin("Waiting to install an update");
        tokio::time::sleep(BACKGROUND_UPDATE_DELAY).await;
        if BACKGROUND_ARM.load(Ordering::Relaxed) == arm && update_ready() && waiting_in_tray(&app)
        {
            let _ = app.emit("background-update-due", ());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{parse_marker, RelaunchMode};

    #[test]
    fn marker_is_accepted_only_while_fresh() {
        assert_eq!(
            parse_marker("background 1000", 1000),
            Some(RelaunchMode::Background)
        );
        assert_eq!(
            parse_marker("window 1000\n", 1000 + 600),
            Some(RelaunchMode::Window)
        );
        assert_eq!(parse_marker("window 1000", 1000 + 601), None);
        assert_eq!(parse_marker("window 2000", 1000), None);
        assert_eq!(parse_marker("quit 1000", 1000), None);
        assert_eq!(parse_marker("background", 1000), None);
        assert_eq!(parse_marker("", 1000), None);
    }
}
