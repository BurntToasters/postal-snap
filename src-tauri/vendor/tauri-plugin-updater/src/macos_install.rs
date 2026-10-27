// Copyright 2026 Postal Snap contributors
// SPDX-License-Identifier: Apache-2.0 OR MIT

use std::ffi::CString;
use std::fs::OpenOptions;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::Path;

fn directory(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a directory",
        ));
    }
    Ok(())
}

/// Remove quarantine only from the authenticated staging tree, without following links.
pub fn clear_staged_quarantine(stage: &Path) -> io::Result<()> {
    directory(stage)?;
    let contents = stage.join("Contents");
    directory(&contents)?;
    clear_quarantine(&contents)
}

fn clear_quarantine(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    let name = CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: both strings are NUL terminated and remain valid during the call.
    let result = unsafe {
        libc::removexattr(
            name.as_ptr(),
            c"com.apple.quarantine".as_ptr(),
            libc::XATTR_NOFOLLOW,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::PermissionDenied
            && !metadata.file_type().is_symlink()
            && metadata.permissions().mode() & 0o200 == 0
        {
            clear_readonly_quarantine(path)?;
        } else if error.raw_os_error() != Some(libc::ENOATTR) {
            return Err(error);
        }
    }
    if metadata.file_type().is_dir() {
        for entry in std::fs::read_dir(path)? {
            clear_quarantine(&entry?.path())?;
        }
    }
    Ok(())
}

fn clear_readonly_quarantine(path: &Path) -> io::Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let original = file.metadata()?.permissions();
    let mut writable = original.clone();
    writable.set_mode(original.mode() | 0o200);
    file.set_permissions(writable)?;
    // SAFETY: the descriptor and attribute name remain valid during the call.
    let result =
        unsafe { libc::fremovexattr(file.as_raw_fd(), c"com.apple.quarantine".as_ptr(), 0) };
    let error = (result != 0).then(io::Error::last_os_error);
    file.set_permissions(original)?;
    match error {
        Some(error) if error.raw_os_error() != Some(libc::ENOATTR) => Err(error),
        _ => Ok(()),
    }
}

/// Replace Contents while keeping the installed app's outer directory intact.
pub fn install_contents(stage: &Path, app: &Path, backup: &Path) -> io::Result<()> {
    directory(stage)?;
    directory(app)?;
    let live = app.join("Contents");
    let new = stage.join("Contents");
    directory(&live)?;
    directory(&new)?;
    match swap_contents(&live, &new) {
        Err(error) if error.kind() != io::ErrorKind::PermissionDenied => {
            replace_contents(&live, &new, backup)
        }
        result => result,
    }
}

pub(crate) fn swap_contents(live: &Path, new: &Path) -> io::Result<()> {
    let live = CString::new(live.as_os_str().as_bytes())?;
    let new = CString::new(new.as_os_str().as_bytes())?;
    // SAFETY: both strings are NUL terminated and remain valid during the call.
    if unsafe { libc::renamex_np(live.as_ptr(), new.as_ptr(), libc::RENAME_SWAP) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Restore the old Contents if the fallback's second rename fails.
pub fn replace_contents(live: &Path, new: &Path, backup: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(backup) {
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "backup already exists",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    std::fs::rename(live, backup)?;
    if let Err(error) = std::fs::rename(new, live) {
        let _ = std::fs::rename(backup, live);
        return Err(error);
    }
    Ok(())
}
