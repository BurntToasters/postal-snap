# Postal Snap architecture

The React/Vite frontend owns presentation only. Every mail, cache, credential, and network operation crosses a narrow typed Tauri command boundary into Rust.

Each account has a serialized actor lock. IMAP uses verified TLS (or mandatory STARTTLS), UID/UIDVALIDITY synchronization, SPECIAL-USE folder discovery, and a two-minute background fallback. SMTP submission uses `lettre`; any failed or uncertain result stays in `outbox` as `needs_attention` and is never automatically resent.

SQLite stores account server configuration, folders, envelopes, decoded bodies, FTS5 indexes, sync cursors, drafts, outbox state, and offline operations. Passwords never enter SQLite. Schema changes use transactional `PRAGMA user_version` migrations; v1 attachment grants referenced by drafts or outbox rows are preserved during migration, while orphan grants are discarded. The default cache policy is 90 days/1 GB with LRU eviction, while drafts and unsent records are protected.

Mailbox totals and unread counts come from IMAP `STATUS` and remain separate from cached-envelope counts. Small local deltas keep the UI immediate until the next authoritative status refresh. Message lists use stable date/UID cursors. Cached UID reconciliation runs in bounded chunks across the complete cache, and missing server folders are removed only after a complete successful discovery pass.

Drafts are committed locally before remote work. Compatible Drafts folders receive revisioned Message-IDs; a new revision is confirmed before the old UID is deleted. Server conflicts become separate recovered drafts. Outgoing MIME and Message-ID are persisted before SMTP starts. Only never-attempted `queued` rows replay automatically; uncertain attempts become `needs_attention`, while a failed Sent-folder copy becomes `sent_copy_pending` and can retry without resending SMTP.

Received HTML is sanitized before entering a sandboxed iframe. Its CSP allows no scripts or network requests. Consent-based remote image requests are proxied through Rust after DNS/IP/redirect validation; the WebView never contacts sender-controlled image servers directly.

Distribution features are compile-time/runtime detected. Direct packages use signed GitHub updater manifests. Microsoft Store, Mac App Store, and Flatpak editions report store-managed updates and do not expose the Tauri updater UI.

The typed event boundary includes sync state, folder-count, message-change, draft-sync, outbox, notification-candidate, and send progress/result events. Event payloads contain opaque IDs and safe states, never message content or credentials.
