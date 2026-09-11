// English source catalog namespace: top-level, common, window, and app copy.
// Split from src/i18n.ts with zero text changes.
export const appName = "Postal Snap" as const;

export const common = {
  close: "Close",
  back: "Back",
  cancel: "Cancel",
  save: "Save",
  remove: "Remove",
  discard: "Discard",
  noSubject: "(No subject)",
  saving: "Saving…",
  loading: "Loading…",
  on: "On",
  off: "Off",
} as const;

export const window = {
  controls: "Window controls",
  minimize: "Minimize",
  maximize: "Maximize",
  restore: "Restore",
  close: "Close",
  actionFailed: "The window action could not finish. Try again.",
} as const;

export const app = {
  starting: "Opening Postal Snap…",
  preview: "Run npm run tauri:dev to connect native mail services.",
  openingEditor: "Opening editor…",
  dismissError: "Dismiss error",
  startupRecoveryTitle: "Postal Snap could not open your mail data",
  startupRecoveryHelp:
    "Your saved mail was not deleted. Restart Postal Snap and try again.",
} as const;
