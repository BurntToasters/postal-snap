//! Download provenance for files Postal Snap writes to disk.

use std::path::Path;

// Failure modes covered here:
// 1. The stream drops CRLF or ZoneId=3, so Windows treats the file as local.
// 2. The stream adds ReferrerUrl or HostUrl, which leaks message context.
// 3. The stream lands on the wrong name, such as the base file, not Zone.Identifier.
// 4. A mark failure aborts the save, which should stay best-effort.
// 5. A non-Windows build creates a stray file or changes the saved bytes.

/// Contents of the `Zone.Identifier` stream. ZoneId 3 is the Internet zone.
#[cfg(any(windows, test))]
pub fn zone_identifier_contents() -> String {
    "[ZoneTransfer]\r\nZoneId=3\r\n".to_string()
}

/// Mark `path` as downloaded from the internet. Best-effort: FAT and exFAT have no streams.
#[cfg(windows)]
pub fn mark_downloaded(path: &Path) {
    let stream = format!("{}:Zone.Identifier", path.display());
    let _ = std::fs::write(stream, zone_identifier_contents());
}

/// Non-Windows platforms use other provenance (macOS quarantine flag, none on Linux).
#[cfg(not(windows))]
pub fn mark_downloaded(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zone_identifier_has_exact_internet_zone_stream() {
        assert_eq!(zone_identifier_contents(), "[ZoneTransfer]\r\nZoneId=3\r\n");
    }

    #[test]
    fn zone_identifier_omits_referrer_and_host_urls() {
        let contents = zone_identifier_contents();
        assert!(!contents.contains("ReferrerUrl"));
        assert!(!contents.contains("HostUrl"));
    }

    #[cfg(not(windows))]
    #[test]
    fn marking_is_a_no_op_off_windows() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.txt");
        std::fs::write(&file, b"hello").unwrap();
        mark_downloaded(&file);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1);
        assert_eq!(std::fs::read(&file).unwrap(), b"hello");
    }

    #[cfg(windows)]
    #[test]
    fn marking_writes_zone_identifier_stream() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("setup.exe");
        std::fs::write(&file, b"MZ").unwrap();
        mark_downloaded(&file);
        let stream = format!("{}:Zone.Identifier", file.display());
        assert_eq!(
            std::fs::read_to_string(stream).unwrap(),
            zone_identifier_contents()
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"MZ");
    }
}
