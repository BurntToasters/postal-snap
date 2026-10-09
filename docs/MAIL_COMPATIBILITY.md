# Mail compatibility in 0.3.2

Postal Snap connects through verified IMAP and SMTP using implicit TLS or required STARTTLS. Accounts remain isolated. OAuth-only configurations, POP, and plaintext connections are unsupported.

## Proton Bridge — experimental

Choose **Proton Bridge** during account setup. Install and configure Bridge first, then copy the username, Bridge password, incoming/outgoing ports, and TLS modes shown by Bridge. The Bridge password is separate from your Proton account password. Bridge must remain running while Postal Snap connects.

The default host is `127.0.0.1`. Bridge connections accept literal loopback addresses only. Both incoming and outgoing connections must pass before the account is saved.

Postal Snap tries ordinary operating-system certificate trust during setup. If verification fails, import Bridge's exported **public PEM certificate**, inspect its fingerprint and expiry, and approve it explicitly. Private keys, invalid certificates, and expired certificates are rejected. Imported trust applies to this account's Bridge endpoints; certificate hostname verification remains enabled. Postal Snap checks the actual server certificate against the approved certificate before sending credentials. Certificate replacement requires another explicit import and approval. Remove imported trust to return to ordinary operating-system trust.

Bridge's combined-address mode works as one configured mailbox account. For split-address mode, configure each address separately using the connection details shown for that address. Custom-domain email addresses can use the Bridge setup choice. Automatic Proton alias discovery is deferred. Labels and All Mail retain their server hierarchy.

Proton documents manual certificate installation in its [Apple Mail guide](https://proton.me/support/protonmail-bridge-clients-apple-mail) and certificate export, editable ports, and TLS modes in its [Bridge settings guide](https://proton.me/support/comprehensive-guide-to-bridge-settings). The export includes a private key; import only the public certificate into Postal Snap.

## IMAP mailbox-name encoding

Postal Snap uses modified UTF-7 mailbox names for IMAP4rev1 commands and responses, including when a server advertises `UTF8=ACCEPT`. It does not send `ENABLE UTF8=ACCEPT`: the pinned `async-imap` response parser does not support RFC 6855's UTF-8 quoted mailbox responses. RFC 6855 section 3 requires the client to enable the extension before the server sends UTF-8 in quoted strings. UTF-8-only servers and quoted UTF-8 responses remain unsupported until the parser supports them. See [RFC 6855 section 3](https://www.rfc-editor.org/rfc/rfc6855.html#section-3).

On upgrade, schema version 23 transactionally decodes legacy modified-UTF-7 cache names and references. Mailbox and message IDs, UID state, explicit folder assignments, remote draft tracking, filter targets, and queued flag, keyword, and move destinations remain attached to their existing records. A name collision aborts the migration without committing partial changes.

## Connections and folder assignments

Each account has connection settings and Sent, Drafts, Archive, Junk, and Trash assignments. **Automatic** uses server SPECIAL-USE information and conservative folder-name fallbacks. Explicit assignments take precedence. An unavailable assigned folder requires reassignment or an explicit return to Automatic.

Connection edits use **Test and save** and retain existing settings if testing fails. IMAP and SMTP failures identify the failing endpoint and give provider-specific next steps. Connection and folder settings show loading and retry states when their data cannot be read. Changing incoming host or username changes mailbox identity: confirmation is required, queued changes and unsent mail must be resolved, and server-derived cache is rebuilt while local drafts and their managed attachments are preserved. The blocker message reports queued-change and unsent-mail counts; queued changes must sync, while unsent mail can be opened in that account's Outbox. Password replacement remains a separate action.

## Repeatable verification

Run the synthetic native Bridge checks without Docker:

```sh
npm run test:bridge-integration
```

Run Bridge checks followed by pinned GreenMail 2.1.11 integration:

```sh
npm run test:mail-integration
```

Both require OpenSSL and the Rust build environment. The full command also requires Docker with Compose. The runner starts loopback-only fixtures, generates temporary TLS material, and removes it afterward. It writes `artifacts/mail-integration/results.json` with commit, dirty-worktree flag, commands, fixture versions, redacted counters, results, and failures. `POSTAL_SNAP_COMPAT_FIXTURE_PROBE=1` additionally validates fixture transport mechanics.

The native Bridge scenarios reject expired certificates and private keys, exercise pooled capability fallback after rejected QRESYNC, and cover matching imported certificates in both TLS modes, rejected credentials, missing STARTTLS, a replacement certificate signed by the approved root, wrong hostname, nested folders, extension rejection, SMTP submission, and controlled restart/reconnect. Compatibility fixture version 6 adds populated nested and non-ASCII folders, a literal ampersand name, advertised-but-disabled `UTF8=ACCEPT`, hierarchical rename, server search, interrupted non-ASCII move and draft operations, and UIDVALIDITY changes during reconnect. Negative TLS fixtures verify that neither authentication nor message submission occurred. These fixtures do not reproduce every Bridge feature or certify provider compatibility.

## Pending evidence

Real Proton Bridge smoke tests remain pending on Windows, macOS, and Linux, including Flatpak loopback access. Bridge support stays experimental until those checks are recorded. Automated protocol evidence does not replace live iCloud checks, signed packages, native accessibility, installation/update/uninstall tests, online dependency audits, or the remaining gates in [the release checklist](RELEASE_CHECKLIST.md).

Capability combinations involving MOVE, UIDPLUS, CONDSTORE/QRESYNC, UIDVALIDITY changes, server search, drafts, and Sent-copy deduplication require their own scenario evidence. The minimal Bridge fixture is not a complete IMAP server.
