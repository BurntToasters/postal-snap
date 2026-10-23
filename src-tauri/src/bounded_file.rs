//! Bounded reads of regular files behind untrusted local paths.
//!
//! Attachment staging, compose-image previews, and MIME construction all
//! read files the user picked or that managed storage resolved. The size on
//! disk is checked before any buffer is allocated, and the stream itself is
//! capped at `limit + 1` bytes so a file that grows after admission is still
//! refused instead of being read without bound. Errors stay generic: paths
//! and operating-system details are never exposed.

use std::{fmt, path::Path};

use tokio::io::{AsyncRead, AsyncReadExt};

/// Why a bounded file read was refused. Neither variant carries the path
/// nor the underlying operating-system error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BoundedFileError {
    /// The file is known to exceed the limit, or more than `limit` bytes
    /// arrived on the stream.
    TooLarge,
    /// The path is missing, not a regular file, a symlink, or unreadable.
    Unavailable,
}

impl fmt::Display for BoundedFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge => write!(f, "That file is too large."),
            Self::Unavailable => write!(f, "That file is unavailable."),
        }
    }
}

impl std::error::Error for BoundedFileError {}

/// Read at most `limit` bytes from an admitted stream. `admitted_len` is the
/// size the metadata reported; anything over `limit` is refused without
/// polling the reader, and the read itself stops after `limit + 1` bytes so
/// growth past admission is still caught. No partial bytes are returned.
pub(crate) async fn read_bounded<R>(
    reader: &mut R,
    admitted_len: u64,
    limit: usize,
) -> Result<Vec<u8>, BoundedFileError>
where
    R: AsyncRead + Unpin,
{
    if admitted_len > limit as u64 {
        return Err(BoundedFileError::TooLarge);
    }
    let cap = limit.checked_add(1).ok_or(BoundedFileError::TooLarge)?;
    let mut bytes = Vec::with_capacity(admitted_len.min(cap as u64) as usize);
    reader
        .take(cap as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| BoundedFileError::Unavailable)?;
    if bytes.len() > limit {
        return Err(BoundedFileError::TooLarge);
    }
    Ok(bytes)
}

/// Read one regular file, bounded by `limit`. Symlinks, directories, and
/// missing paths are refused without disclosing the path; oversized files
/// are refused before any buffer is allocated for their contents.
pub(crate) async fn read_regular_file(
    path: &Path,
    limit: usize,
) -> Result<Vec<u8>, BoundedFileError> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| BoundedFileError::Unavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BoundedFileError::Unavailable);
    }
    if metadata.len() > limit as u64 {
        return Err(BoundedFileError::TooLarge);
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| BoundedFileError::Unavailable)?;
    read_bounded(&mut file, metadata.len(), limit).await
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        pin::Pin,
        task::{Context, Poll},
    };

    use tokio::io::{AsyncRead, ReadBuf};

    use super::{read_bounded, read_regular_file, BoundedFileError};

    struct CountingReader {
        bytes: Vec<u8>,
        offset: usize,
        delivered: usize,
        fail: bool,
    }

    impl CountingReader {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                bytes,
                offset: 0,
                delivered: 0,
                fail: false,
            }
        }

        fn failing() -> Self {
            Self {
                bytes: Vec::new(),
                offset: 0,
                delivered: 0,
                fail: true,
            }
        }
    }

    impl AsyncRead for CountingReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if self.fail {
                return Poll::Ready(Err(io::Error::other("private/path/marker")));
            }
            let remaining = &self.bytes[self.offset..];
            let count = remaining.len().min(buf.remaining());
            buf.put_slice(&remaining[..count]);
            self.offset += count;
            self.delivered += count;
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn regular_empty_and_exact_limit_files_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty.bin");
        let exact = dir.path().join("exact.bin");
        std::fs::write(&empty, []).unwrap();
        std::fs::write(&exact, b"1234").unwrap();

        assert_eq!(read_regular_file(&empty, 4).await.unwrap(), b"");
        assert_eq!(read_regular_file(&exact, 4).await.unwrap(), b"1234");
    }

    #[tokio::test]
    async fn oversized_metadata_is_rejected_without_polling_or_path_disclosure() {
        let mut reader = CountingReader::new(b"12345".to_vec());
        let error = read_bounded(&mut reader, 5, 4).await.unwrap_err();
        assert_eq!(error, BoundedFileError::TooLarge);
        assert_eq!(reader.delivered, 0);
        assert!(!error.to_string().contains("private/path/marker"));
    }

    #[tokio::test]
    async fn a_stream_that_grows_after_admission_stops_at_limit_plus_one() {
        let mut reader = CountingReader::new(vec![b'x'; 100]);
        let error = read_bounded(&mut reader, 1, 8).await.unwrap_err();
        assert_eq!(error, BoundedFileError::TooLarge);
        assert_eq!(reader.delivered, 9);
    }

    #[tokio::test]
    async fn oversized_regular_files_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.bin");
        std::fs::write(&path, b"12345").unwrap();
        assert_eq!(
            read_regular_file(&path, 4).await.unwrap_err(),
            BoundedFileError::TooLarge
        );
    }

    #[tokio::test]
    async fn directories_are_rejected_without_path_disclosure() {
        let dir = tempfile::tempdir().unwrap();
        let error = read_regular_file(dir.path(), 4).await.unwrap_err();
        assert_eq!(error, BoundedFileError::Unavailable);
        assert!(!error.to_string().contains(dir.path().to_str().unwrap()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.bin");
        let link = dir.path().join("link.bin");
        std::fs::write(&target, b"secret").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(
            read_regular_file(&link, 20).await.unwrap_err(),
            BoundedFileError::Unavailable
        );
    }

    #[tokio::test]
    async fn missing_files_are_rejected_without_path_disclosure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.bin");
        let error = read_regular_file(&path, 4).await.unwrap_err();
        assert_eq!(error, BoundedFileError::Unavailable);
        assert!(!error.to_string().contains("missing.bin"));
    }

    #[tokio::test]
    async fn read_errors_are_redacted_and_partial_bytes_are_not_returned() {
        let mut reader = CountingReader::failing();
        let error = read_bounded(&mut reader, 0, 4).await.unwrap_err();
        assert_eq!(error, BoundedFileError::Unavailable);
        assert!(!error.to_string().contains("private/path/marker"));
    }

    #[tokio::test]
    async fn limit_plus_one_overflow_is_rejected_before_polling() {
        let mut reader = CountingReader::new(vec![b'x']);
        let error = read_bounded(&mut reader, 0, usize::MAX).await.unwrap_err();
        assert_eq!(error, BoundedFileError::TooLarge);
        assert_eq!(reader.delivered, 0);
    }
}
