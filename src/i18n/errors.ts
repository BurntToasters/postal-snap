// English source catalog namespace: errors section.
// Split from src/i18n.ts with zero text changes.
export const errors = {
  accessDenied: "That item is not available for this account.",
  notFound: "That item is no longer available. Refresh mail and try again.",
  limitExceeded: "That item exceeds Postal Snap’s safety limit.",
  settingsNotFound:
    "Settings file could not be found. Choose a Postal Snap settings export.",
  settingsTooLarge:
    "That settings file is too large. Choose a file smaller than 64 KiB.",
  settingsInvalid: "That file is not a valid Postal Snap settings export.",
  settingsMigrationFailed:
    "Postal Snap could not migrate saved settings. Restart Postal Snap, or import/reset settings.",
  settingsReadFailed:
    "Postal Snap could not read that settings file. Check its permissions and try again.",
  settingsWriteFailed:
    "Postal Snap could not save settings. Check the destination and available disk space, then try again.",
  authenticationFailed: "Sign-in failed. Check the email address and password.",
  connectionFailed: "Could not reach the mail server. Check your connection.",
  localStorageFailed:
    "Postal Snap could not access local mail data on your computer.",
  invalidInput: "Check the highlighted information and try again.",
  operationFailed: "Postal Snap could not finish that action. Try again.",
} as const;
