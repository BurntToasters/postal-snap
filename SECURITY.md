# Security

Report suspected vulnerabilities privately to `security@rosie.run`. Do not include real mailbox credentials or message content.

Postal Snap has no telemetry or cloud service. Account passwords are held by the operating-system credential vault. The local SQLite mail cache is stored in the app-private data directory and protected by the signed-in operating-system account.

Received HTML is sanitized and displayed in a scriptless, networkless iframe. Remote images are blocked until the user opts in; the native fetcher rejects non-HTTP(S), loopback, private, link-local, and unsafe redirect destinations. Logs and user-facing protocol errors omit addresses, subjects, bodies, credentials, filenames, and raw server responses.
