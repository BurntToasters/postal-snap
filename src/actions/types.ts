// Typed action vocabulary shared by shortcuts, native menus, and the bus.
// Each id is the string sent over the "postal:menu-action" window event.

export type ActionScope = "global" | "list" | "reader" | "composer";

export type ActionId =
  // Native menu and menu-action details.
  | "archive"
  | "check-for-updates"
  | "compose"
  | "file-print"
  | "find-in-message"
  | "forward"
  | "get-mail"
  | "junk"
  | "print"
  | "redirect"
  | "reading-pane-bottom"
  | "reading-pane-hidden"
  | "reading-pane-right"
  | "reply"
  | "reply-all"
  | "settings"
  | "text-larger"
  | "text-smaller"
  | "text-size-larger"
  | "text-size-smaller"
  | "toggle-read"
  | "toggle-star"
  | "tray-open"
  | "trash"
  // Reader and message menu handlers.
  | "block-domain"
  | "block-sender"
  | "copy-recipients"
  | "create-rule"
  | "create-subject-rule"
  | "delete-forever"
  | "edit-as-new"
  | "forward-attachment"
  | "forward-conversation"
  | "move-to-inbox"
  | "mute-conversation"
  | "not-junk"
  | "reply-all-bare"
  | "reply-all-with-attachments"
  | "reply-bare"
  | "reply-list"
  | "reply-preferred"
  | "reply-with-attachments"
  | "save-eml"
  | "unblock-domain"
  | "unblock-sender"
  // Shortcut-only ids (keyboard hints and handlers).
  | "archive-focused"
  | "check-focused"
  | "delete-msg"
  | "first-last"
  | "get-mail-all"
  | "go-to-inbox"
  | "junk-focused"
  | "new-message"
  | "open-command-palette"
  | "next-message"
  | "next-unread"
  | "next-unread-mailbox"
  | "prev-message"
  | "previous-unread"
  | "previous-unread-mailbox"
  | "read-focused"
  | "reply-all-focused"
  | "reply-focused"
  | "save-draft"
  | "scroll-reader"
  | "search"
  | "select-account"
  | "send"
  | "show-shortcuts"
  | "star-focused"
  | "text-size"
  | "trash-focused"
  | "undo";

/** Modifier flags are exact when set and ignored when undefined. */
export interface ShortcutSpec {
  /** Event key or keys, compared case-insensitively. */
  key: string | readonly string[];
  /** Physical key fallback, for keys whose event.key varies (Space). */
  code?: string;
  /** Command on macOS; Command or Control elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  /**
   * Where the shortcut fires. "idle" (default) skips text fields and
   * chrome controls; "not-editing" skips text fields only; "any" always fires.
   */
  focus?: "any" | "not-editing" | "idle";
}

export interface ActionDefinition {
  id: ActionId;
  label: () => string;
  scope: ActionScope;
  shortcut?: ShortcutSpec[];
  /** Display text for the shortcut list. Omit to keep the action out of it. */
  hint?: () => string;
  keywords?: readonly string[];
  /** Runs the action from the command palette. Omit to keep it out of the palette. */
  run?: () => void;
  /** False hides the action from the palette, so it can never run. */
  available?: () => boolean;
}
