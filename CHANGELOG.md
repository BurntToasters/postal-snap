> [!IMPORTANT]
> Unstable releases (like this one) are released rapidly one after another to test new features. You should never install the unstable releases unless you know what you're doing.

# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                                                                                                      | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS                           | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux                                                                                                                                                                       |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.0/Postal-Snap-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.0/Postal-Snap-Windows-arm64.exe)                                                                   | **[Universal DMG](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.0/Postal-Snap-macOS.dmg)**                  | **AppImage:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.0/Postal-Snap-Linux-x64.AppImage)                                                                                                                                                     |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/<MS_STORE_ID>?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div> -->                                                                                           | **[Universal ZIP](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.0/Postal-Snap-macOS.zip)**                  | **Flatpak:** [x64](https://github.com/BurntToasters/postal-snap/releases/download/v0.4.0/Postal-Snap-Linux-x64.flatpak)                                                                                                                                                          |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
>

### ℹ️ Enjoying Postal Snap? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Postal Snap is a calm, accessible desktop email client. Mail stays on your computer. There is no Postal Snap cloud, telemetry, or account of mine to log into.

## Changes in `v0.4.0:`

- **NEW - Conversation actions:** Archive, move, copy, star, pin, snooze, mark as junk, delete, print, forward, select, or save files from a whole conversation at once. Actions apply to every loaded message in the conversation. Expand or collapse a conversation, and it stays that way when you come back.
- **NEW - Pin messages and mailboxes:** Pin a message to keep it at the top of the list, or pin a mailbox to keep it at the top of the folder list. Pins stay on this computer. **Pinned** lists only pinned mail.
- **NEW - Mute conversations:** Mute a noisy conversation to file it away. Muted conversations, including later replies, are labeled in the list and the message.
- **NEW - Block sender or domain:** Block a sender or their whole domain from the message menu. Postal Snap moves the message to Junk and saves a mail rule you can undo with **Unblock**. Shared providers (such as Gmail or iCloud) only offer **Block sender**.
- **NEW - Mail rules:** Rules can now match the sender's domain or the To line. A full address matches only that address. Reorder rules, and see which unread Inbox messages a rule would file before you save it. Start a rule from a sender, an address, or a subject.
- **NEW - Read receipts:** Ask for a read receipt when you send. When a message asks you for one, Postal Snap asks before sending it, and you can decline. Junk mail never asks.
- **NEW - Importance:** Mark a message high or low importance. Received high- and low-importance mail is labeled in the list and the message.
- **NEW - Redirect and forward as attachment:** Redirect sends a message on unchanged, marked as passed on by you. Forward as attachment includes the original as an `.eml` file.
- **NEW - Reply options:** Reply with attachments, reply without quoting the original, and see the message you are answering while you write. Replies use the address the message was sent to, including your aliases. A note typed under the message starts a reply.
- **NEW - Reply-To per account:** Set a Reply-To address for an account in Settings > Accounts, and leave it off any single message.
- **NEW - Safer sending:** Postal Snap asks before sending to 10 or more people, to an automated (no-reply) address, to the same person twice, or with no subject or no text. Optionally send a Bcc copy to yourself.
- **NEW - Writing:** Paste pictures and lists of addresses. **Paste without formatting** keeps text plain. Preview attached pictures, see each file's size and the total, remove all files at once, and remove a link while keeping its words. The message window keeps its size, and drafts keep your place.
- **NEW - Save files and messages:** Save chosen files, all files, or every file in a conversation or selection into one folder. Save one or more messages as `.eml` files.
- **NEW - Search:** New filters `cc:`, `body:`, `filename:`, `in:`, `on:`, `larger:`, `smaller:`, `is:pinned`, and `is:important`, plus `from:me` and `to:me`. Matching words are highlighted in the list and the open message. Recent searches can be chosen again or removed. An empty search result can search all mailboxes. Drafts and Outbox are searchable too.
- **NEW - Find in message:** Find words in the open message, with a match count and next and previous.
- **NEW - Print conversations and selections:** Print every loaded message in a conversation, or the checked messages, oldest first. Printed messages list their files.
- **NEW - Mailbox views:** **Invitations**, **Pinned**, **To me**, and **Unread folders** views. Sort oldest first or by subject. Each folder keeps its own filter and scroll position, and reopens the message you left open.
- **NEW - Folders:** Create a folder inside another, move a folder under another or to the top level, collapse nested folders, hide a mailbox from the list, and find a folder in a long list. In Trash, **Delete** permanently removes the chosen messages after you confirm.
- **NEW - Message details:** The reader shows Cc, Bcc, a different Reply-To address, the mailing list name, message size, file kinds and sizes, and when a late message actually arrived. Copy the sender, recipients, subject, or readable text. Open the message a reply answers.
- **NEW - Keyboard:** `e` archives, `x` checks, `!` marks as junk, `r` replies, and Delete moves to Trash, all without opening the message. `j` and `k` move between messages, Space at the end of a message opens the next one, `i` goes to Inbox, and `[` and `]` open the previous or next mailbox with unread mail.
- **NEW - Accounts:** Give each account a color, reorder accounts, and choose how long each account keeps downloaded mail. The unread count shows in the window title and on the Dock or taskbar icon.
- **NEW - Alerts:** Play a sound for new mail, and set quiet hours when alerts stay silent.
- **NEW - Pictures from known senders:** Choose senders whose pictures load without a click. This never applies in Junk, or when the sender's name shows a different address.
- **UI - Full-screen reading:** Full-screen reading now covers the mailbox. Toolbars, the list, and the message line up at every text size up to 200%.
- **FIX - Very large messages:** A very large message no longer slows down or stalls mail checking for its account.
- **FIX - Sending later:** A message scheduled weeks ahead no longer makes Postal Snap reload the Outbox over and over.
- **FIX - No leftover draft after sending:** Sending right after typing no longer leaves a copy of the sent message in Drafts.
- **FIX - Saving many messages:** Saving many messages or files now asks where to save first, and uses far less memory.
- **FIX - Saved files are marked as downloaded:** Files saved from mail are now marked as coming from the internet, so Windows and macOS warn before opening a downloaded program.
- **FIX - Windows mail folder move:** Moving mail data out of the roaming profile is now all-or-nothing. If it cannot finish, Postal Snap keeps using the previous folder. Files attached to unsent drafts and queued messages still work after the move.
- **FIX - Proton Bridge:** Large messages sent through Proton Bridge no longer show as uncertain when Bridge takes a while to accept them.
- **FIX - Folders:** Moving a folder inside itself now shows a clear message instead of a server error.

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)
- **Code Signing:** macOS releases are signed and notarized. Windows binaries are Authenticode-signed with Azure Artifact Signing. Linux release files include GPG signatures.
- **Windows Binaries:** Windows installers are published separately for x64 and arm64; choose the installer matching your system architecture.

### This changelog is made using the BCLS standard: https://github.com/BurntToasters/BCLS
