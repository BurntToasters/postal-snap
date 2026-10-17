//! User-facing text shown by native code (menus, tray, notifications,
//! dialogs), kept in one place for later localization.

// Windows has no native menubar; its mail shortcuts live in the frontend.
#[cfg_attr(all(target_os = "windows", not(test)), allow(dead_code))]
pub mod menu {
    pub const SETTINGS: &str = "Settings…";
    pub const NEW_MESSAGE: &str = "New Message";
    pub const GET_MAIL: &str = "Get Mail";
    pub const REPLY: &str = "Reply";
    pub const REPLY_ALL: &str = "Reply All";
    pub const FORWARD: &str = "Forward";
    pub const REDIRECT: &str = "Redirect";
    pub const ARCHIVE: &str = "Archive";
    pub const MOVE_TO_TRASH: &str = "Move to Trash";
    pub const FLAG: &str = "Flag";
    pub const MOVE_TO_JUNK: &str = "Move to Junk";
    pub const MARK_AS_READ: &str = "Mark as Read";
    pub const PRINT: &str = "Print…";
    pub const FIND_IN_MESSAGE: &str = "Find in Message";
    pub const READING_PANE_ON_RIGHT: &str = "Reading Pane on Right";
    pub const READING_PANE_BELOW: &str = "Reading Pane Below";
    pub const HIDE_READING_PANE: &str = "Hide Reading Pane";
    pub const MAKE_TEXT_LARGER: &str = "Make Text Larger";
    pub const MAKE_TEXT_SMALLER: &str = "Make Text Smaller";
    pub const CHECK_FOR_UPDATES: &str = "Check for Updates…";
    pub const POSTAL_SNAP: &str = "Postal Snap";
    pub const QUIT_POSTAL_SNAP: &str = "Quit Postal Snap";
    pub const FILE: &str = "File";
    pub const EDIT: &str = "Edit";
    pub const MESSAGE: &str = "Message";
    pub const VIEW: &str = "View";
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub const WINDOW: &str = "Window";
}

// Close-to-tray exists on Windows and macOS only.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub mod tray {
    pub const OPEN_POSTAL_SNAP: &str = "Open Postal Snap";
    pub const QUIT_POSTAL_SNAP: &str = "Quit Postal Snap";
    pub const TOOLTIP: &str = "Postal Snap";
}

pub mod notify {
    pub const NEW_MAIL: &str = "New mail";
    pub const OPEN_TO_READ: &str = "Open Postal Snap to read it.";

    pub fn new_mail_for(account: &str) -> String {
        format!("New mail for {account}")
    }
}

pub mod warnings {
    pub const TRAY_ICON_UNAVAILABLE: &str = "Postal Snap could not show the background icon.";
    pub const MENU_COMMANDS_STALE: &str =
        "Postal Snap could not update menu commands. Restart Postal Snap to restore them.";
}

pub mod files {
    pub const RISKY_TITLE: &str = "These files can run programs";
    pub const RISKY_SAVE: &str = "Save Anyway";
    pub const CANCEL: &str = "Cancel";

    /// Names are shown one per line; at most a few, then a count.
    pub fn risky_message(names: &[String], total: usize) -> String {
        let more = total.saturating_sub(names.len());
        let list = names.join("\n");
        let tail = if more > 0 {
            format!("\nand {more} more")
        } else {
            String::new()
        };
        format!(
            "{list}{tail}\n\nOpening a file like this can install harmful software or show a fake sign-in page. Save only if you expected it from someone you trust."
        )
    }
}
