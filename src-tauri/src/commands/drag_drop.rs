//! Drop-in attachments. The webview reports dropped files to Rust only.
//! The UI learns the drop position and file count, never a path; it then
//! asks to attach them if the drop landed on an open composer.

use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{DragDropEvent, Emitter, State, Window};

use super::attachments::stage_attachment_paths;
use super::{AppState, CommandResult};
use crate::models::ComposeAttachment;

const DROP_TTL: Duration = Duration::from_secs(15);
const MAX_DROPPED_FILES: usize = 100;
const DRAG_EVENT: &str = "compose-drag";

/// The most recent drop, held until the composer claims it or it expires.
#[derive(Default)]
struct DropStash {
    pending: Option<(Vec<PathBuf>, Instant)>,
}

impl DropStash {
    /// Replace the pending drop. Returns how many files were kept; an empty
    /// or oversized drop keeps none.
    fn store(&mut self, paths: Vec<PathBuf>, now: Instant) -> usize {
        self.pending = None;
        if paths.is_empty() || paths.len() > MAX_DROPPED_FILES {
            return 0;
        }
        let count = paths.len();
        self.pending = Some((paths, now));
        count
    }

    fn take(&mut self, now: Instant) -> Vec<PathBuf> {
        match self.pending.take() {
            Some((paths, at)) if now.saturating_duration_since(at) <= DROP_TTL => paths,
            _ => Vec::new(),
        }
    }

    fn clear(&mut self) {
        self.pending = None;
    }
}

static STASH: Mutex<DropStash> = Mutex::new(DropStash { pending: None });

fn with_stash<T>(action: impl FnOnce(&mut DropStash) -> T) -> T {
    let mut guard = STASH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    action(&mut guard)
}

/// Position and count only. Logical pixels match the page's coordinates.
#[derive(Clone, Serialize)]
struct DragPayload {
    phase: &'static str,
    x: f64,
    y: f64,
    count: usize,
}

impl DragPayload {
    fn new(phase: &'static str, x: f64, y: f64, count: usize, scale: f64) -> Self {
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        Self {
            phase,
            x: x / scale,
            y: y / scale,
            count,
        }
    }
}

/// Window drag-drop events from the main webview.
pub(crate) fn on_drag_drop(window: &Window, event: &DragDropEvent) {
    if window.label() != "main" {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let payload = match event {
        DragDropEvent::Enter { position, paths } => {
            with_stash(DropStash::clear);
            DragPayload::new("over", position.x, position.y, paths.len(), scale)
        }
        DragDropEvent::Over { position } => {
            DragPayload::new("over", position.x, position.y, 0, scale)
        }
        DragDropEvent::Drop { paths, position } => {
            let count = with_stash(|stash| stash.store(paths.clone(), Instant::now()));
            DragPayload::new("drop", position.x, position.y, count, scale)
        }
        _ => {
            with_stash(DropStash::clear);
            DragPayload::new("leave", 0.0, 0.0, 0, scale)
        }
    };
    let _ = window.emit(DRAG_EVENT, payload);
}

/// Attach the files just dropped on the window. Empty when nothing is
/// pending. The UI cannot name files; it can only claim the last drop.
#[tauri::command]
pub async fn attach_dropped_files(
    account_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ComposeAttachment>> {
    state.db.account(&account_id)?;
    let paths = with_stash(|stash| stash.take(Instant::now()));
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    stage_attachment_paths(&state, &account_id, paths, false).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Failure modes for dropped-file handling:
    // 1. Paths are taken twice, so one drop attaches twice.
    // 2. An expired drop is still taken.
    // 3. A new drop does not replace the previous one (two drops mix).
    // 4. A drop over the limit is kept in part.
    // 5. Leave or clear leaves paths behind.
    // 6. An empty drop counts as pending.
    // 7. The event payload carries a path or file name.
    // 8. Physical positions are not converted to logical ones.

    fn paths(count: usize) -> Vec<std::path::PathBuf> {
        (0..count)
            .map(|index| std::path::PathBuf::from(format!("/tmp/file-{index}")))
            .collect()
    }

    #[test]
    fn a_drop_is_taken_once() {
        let now = Instant::now();
        let mut stash = DropStash::default();
        assert_eq!(stash.store(paths(2), now), 2);
        assert_eq!(stash.take(now).len(), 2);
        assert!(stash.take(now).is_empty());
    }

    #[test]
    fn expired_drops_are_not_taken() {
        let now = Instant::now();
        let mut stash = DropStash::default();
        stash.store(paths(1), now);
        assert!(stash
            .take(now + DROP_TTL + Duration::from_millis(1))
            .is_empty());
        stash.store(paths(1), now);
        assert_eq!(stash.take(now + DROP_TTL).len(), 1);
    }

    #[test]
    fn a_new_drop_replaces_the_old_one() {
        let now = Instant::now();
        let mut stash = DropStash::default();
        stash.store(paths(3), now);
        stash.store(paths(1), now);
        assert_eq!(stash.take(now), paths(1));
    }

    #[test]
    fn oversized_drops_are_refused_whole() {
        let now = Instant::now();
        let mut stash = DropStash::default();
        stash.store(paths(2), now);
        assert_eq!(stash.store(paths(MAX_DROPPED_FILES + 1), now), 0);
        assert!(stash.take(now).is_empty());
        assert_eq!(
            stash.store(paths(MAX_DROPPED_FILES), now),
            MAX_DROPPED_FILES
        );
    }

    #[test]
    fn clear_and_empty_drops_leave_nothing() {
        let now = Instant::now();
        let mut stash = DropStash::default();
        stash.store(paths(2), now);
        stash.clear();
        assert!(stash.take(now).is_empty());
        assert_eq!(stash.store(Vec::new(), now), 0);
        assert!(stash.take(now).is_empty());
    }

    #[test]
    fn event_payload_has_no_paths() {
        let payload = DragPayload::new("drop", 96.0, 48.0, 2, 2.0);
        let json = serde_json::to_value(&payload).unwrap();
        let keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(json["phase"], "drop");
        assert_eq!(json["x"], 48.0);
        assert_eq!(json["y"], 24.0);
        assert_eq!(json["count"], 2);
        assert!(keys
            .iter()
            .all(|key| ["phase", "x", "y", "count"].contains(key)));
    }
}
