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

/// Open one regular file without following its final path component, then
/// validate the opened descriptor before allocating a bounded buffer.
pub(crate) async fn read_regular_file(
    path: &Path,
    limit: usize,
) -> Result<Vec<u8>, BoundedFileError> {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(path)
        .await
        .map_err(|_| BoundedFileError::Unavailable)?;
    #[cfg(windows)]
    {
        windows_identity_matches(path, &file).await?;
    }
    let metadata = file
        .metadata()
        .await
        .map_err(|_| BoundedFileError::Unavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BoundedFileError::Unavailable);
    }
    let admitted_len = metadata.len();
    if admitted_len > limit as u64 {
        return Err(BoundedFileError::TooLarge);
    }
    read_bounded(&mut file, admitted_len, limit).await
}

#[cfg(windows)]
async fn windows_identity_matches(
    path: &Path,
    content: &tokio::fs::File,
) -> Result<(), BoundedFileError> {
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };

    let mut attr_opts = tokio::fs::OpenOptions::new();
    attr_opts.access_mode(FILE_READ_ATTRIBUTES.0);
    attr_opts.share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0);
    attr_opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0);
    let attr = attr_opts
        .open(path)
        .await
        .map_err(|_| BoundedFileError::Unavailable)?;

    let content_std = content
        .try_clone()
        .await
        .map_err(|_| BoundedFileError::Unavailable)?
        .into_std()
        .await;
    let attr_std = attr
        .try_clone()
        .await
        .map_err(|_| BoundedFileError::Unavailable)?
        .into_std()
        .await;
    let content_id =
        same_file::Handle::from_file(content_std).map_err(|_| BoundedFileError::Unavailable)?;
    let attr_id =
        same_file::Handle::from_file(attr_std).map_err(|_| BoundedFileError::Unavailable)?;
    if content_id != attr_id {
        return Err(BoundedFileError::Unavailable);
    }
    Ok(())
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

    #[cfg(unix)]
    #[test]
    fn a_final_component_replaced_with_a_symlink_is_not_followed() {
        use std::sync::mpsc;

        let dir = tempfile::tempdir().unwrap();
        let chosen = dir.path().join("chosen.bin");
        let replacement = dir.path().join("replacement.bin");
        std::fs::write(&chosen, b"public fixture").unwrap();
        std::fs::write(&replacement, b"PRIVATE FIXTURE").unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (started_tx, started_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            started_rx.recv().unwrap();

            let mut read = Box::pin(read_regular_file(&chosen, 128));
            let first_poll = std::future::poll_fn(|cx| {
                Poll::Ready(std::future::Future::poll(read.as_mut(), cx))
            })
            .await;
            assert!(first_poll.is_pending());

            release_tx.send(()).unwrap();
            blocker.await.unwrap();
            // The first file operation is ahead of this barrier in the single
            // blocking queue, placing replacement between admission and open
            // in the old implementation.
            tokio::task::spawn_blocking(|| ()).await.unwrap();
            std::fs::remove_file(&chosen).unwrap();
            std::os::unix::fs::symlink(&replacement, &chosen).unwrap();

            let result = read.await;
            assert!(
                result == Err(BoundedFileError::Unavailable)
                    || result == Ok(b"public fixture".to_vec()),
                "replacement symlink was followed: {result:?}"
            );
        });
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_fifo_is_rejected_without_waiting_for_a_writer() {
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("pipe.bin");
        nix::unistd::mkfifo(
            &fifo,
            nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
        )
        .unwrap();

        let result = tokio::time::timeout(Duration::from_secs(1), read_regular_file(&fifo, 128))
            .await
            .expect("a nonregular FIFO must not hang");
        assert_eq!(result.unwrap_err(), BoundedFileError::Unavailable);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readonly_regular_files_remain_readable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("readonly.bin");
        std::fs::write(&path, b"read only").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();

        assert_eq!(read_regular_file(&path, 16).await.unwrap(), b"read only");
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
