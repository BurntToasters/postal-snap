# Register Postal Snap for OAuth

Do this when Postal Snap is ready to offer Gmail and Outlook sign-in. User-facing OAuth is deferred to 0.6.0. The Rust wiring stays in the tree until then: loopback PKCE, token refresh, the keychain, and XOAUTH2. The setup screen does not offer it yet.

Postal Snap uses a public client, PKCE, and a loopback redirect on `http://127.0.0.1:<port>/oauth/callback`. It does not use a client secret and it does not use `run.rosie.snap://oauth/callback`.

A release build reads the client id from the environment at compile time, or from the same variable when the app starts:

- `POSTAL_SNAP_GMAIL_CLIENT_ID`
- `POSTAL_SNAP_OUTLOOK_CLIENT_ID`

Set `POSTAL_SNAP_OAUTH_LOOPBACK_PORT` only when a provider demands one exact port. Leave it unset to use an ephemeral port.

The internal command is `connect_oauth_account` with `{ "provider": "gmail" }` or `{ "provider": "outlook" }`. Nothing in the setup UI calls it.

## Google (Gmail)

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or choose a project for Postal Snap.
2. Configure the OAuth consent screen. Add the scopes `openid`, `email`, and `https://mail.google.com/`. `https://mail.google.com/` is a restricted scope. Until Google verifies the app, sign-in works only for accounts you list as test users.
3. Create an OAuth client of type **Desktop app**. Do not create a Web client and do not put a client secret in Postal Snap.
4. Desktop clients accept `http://127.0.0.1` with any port. The live redirect is `http://127.0.0.1:<port>/oauth/callback`.
5. Put the client id in `POSTAL_SNAP_GMAIL_CLIENT_ID` for the build you ship.
6. For a public release, submit the restricted-scope verification and the security assessment Google requires for `https://mail.google.com/`. Until that finishes, keep the app in testing and only add the mailboxes you use yourself.

Google returns a refresh token only when the request asks for offline access and shows the consent screen. Postal Snap already sends `access_type=offline` and `prompt=consent`.

## Microsoft (Outlook and Microsoft 365)

1. Open [Microsoft Entra admin center](https://entra.microsoft.com/) → App registrations → New registration.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**, if both work and personal Outlook.com mailboxes should work.
3. Add a **Mobile and desktop applications** redirect URI. Microsoft accepts a loopback address with any port. The live redirect is `http://127.0.0.1:<port>/oauth/callback`. If a tenant rejects the ephemeral port, set `POSTAL_SNAP_OAUTH_LOOPBACK_PORT` and register that exact URI.
4. Under Authentication, set **Allow public client flows** to Yes. Do not create a client secret.
5. Add delegated permissions `openid`, `email`, `offline_access`, `IMAP.AccessAsUser.All`, and `SMTP.Send` (Office 365 Exchange Online). Grant admin consent for organizational tenants that require it. Personal Microsoft accounts consent for themselves.
6. Put the Application (client) id in `POSTAL_SNAP_OUTLOOK_CLIENT_ID`.

IMAP and SMTP for the signed-in user must stay enabled on the mailbox. Microsoft can turn IMAP off for a tenant even after OAuth succeeds.

## Other providers

Add a provider only after its own docs confirm all of the following:

- Authorization-code flow with PKCE and a public client id
- A refresh token
- A loopback redirect on `127.0.0.1`
- IMAP and SMTP `AUTH XOAUTH2`

Then add an `OAuthProvider` entry, the hosts in `allow_xoauth2_server`, and a client-id variable. Do not invent endpoints.

These do not fit that pattern today:

- **Yahoo and AOL** — IMAP OAuth is not an open public PKCE desktop registration.
- **Fastmail** — use an app password for IMAP. Their OAuth is for other protocols.
- **iCloud** — stay on the app-specific password setup already in the app.
- **Proton** — stay on Proton Bridge.

## What stays out of the app

- No client secret in the binary, the repo, or logs
- No custom URL scheme for the callback
- No Gmail or Outlook button on the setup screen until that UI is intentionally added
- Access tokens go only to `imap.gmail.com:993`, `smtp.gmail.com:587`, `outlook.office365.com:993`, and `smtp.office365.com:587`
