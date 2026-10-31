# Postal Snap patch: async-imap 0.11.3

This is the crates.io `async-imap` 0.11.3 source with local response handling
changes in `src/parse.rs` and requested-field forwarding in `src/client.rs`.

The pre-existing `parse_fetches` and `parse_expunge` patch checks the tagged
completion status. Upstream stopped reading at the tagged completion without
checking it, so a tagged `NO`, `BAD`, or connection end before the tag looked
successful to `UID STORE`, `UID EXPUNGE`, `STORE`, and `EXPUNGE` callers.
Postal Snap could then discard queued flag/keyword work or report a delete
that the server refused. The patch yields `Error::No`, `Error::Bad`, or
`Error::Io`, and yields `Error::ConnectionLost` when the stream ends without
the matching completion.

`LIST` now succeeds only after its matching tagged `OK`. Tagged `NO`/`BAD`,
other terminal statuses, I/O errors, and EOF before the matching completion
are returned as errors. Partial names received before a refusal are discarded
by `try_collect` instead of becoming an authoritative folder set.

`STATUS` now requires matching mailbox data and matching tagged `OK`. It
returns an error for missing requested fields, refusals, and EOF before
completion. It tracks requested standard items so valid partial queries such
as `(MESSAGES)` remain supported; `HIGHESTMODSEQ` stays optional. This prevents
an omitted requested `MESSAGES` value from being mistaken for the mailbox's
default zero count.

`SEARCH`/`UID SEARCH`, `CAPABILITY`, `NOOP`, and `GETMETADATA` share one
completion check: success only after the matching tagged `OK`; `NO`/`BAD`,
other statuses, and EOF before completion are errors. Before this, a refused
`UID SEARCH` looked like an empty mailbox to expunge reconciliation, backfill,
and Empty Folder, and a closed connection passed the `NOOP` health check.
The upstream parser test fixtures now end with their tagged completion.

Postal Snap's sync layer additionally validates the required counts and UID
identity before writes, and confirms a changed mailbox generation or empty
mailbox against `EXAMINE` before replacing or clearing cached state.

Keep the local changes limited to these confirmed response-handling issues.
Remove each patch when an upstream release provides equivalent behavior, then
rerun the canonical mail integration suite.
