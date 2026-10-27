# Postal Snap patch: async-imap 0.11.3

This is the crates.io `async-imap` 0.11.3 source with one local change in
`src/parse.rs`.

Upstream `parse_fetches` and `parse_expunge` stopped reading at the tagged
completion without checking its status. A tagged `NO`, `BAD`, or a connection
that ended before the tag produced an empty stream, so `UID STORE`,
`UID EXPUNGE`, `STORE`, and `EXPUNGE` callers saw success. Postal Snap then
discarded queued flag/keyword work and could report a delete that the server
refused.

The patch yields the tagged status as `Error::No`, `Error::Bad`, or
`Error::Io`, and yields `Error::ConnectionLost` when the stream ends without a
tagged completion.

Keep this patch limited to those two parsers. Remove it when an upstream
release checks the tagged status, and rerun the mail integration suite.
