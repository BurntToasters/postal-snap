// English source catalog namespace: update section.
// Split from src/i18n.ts with zero text changes.
export const update = {
  availableTitle: "Update Available",
  availablePrompt: (version: string) =>
    `An update to Postal Snap (version ${version}) is available. Would you like to download and install it now?`,
  readyTitle: "Update Ready",
  readyPrompt: (version: string) =>
    `Postal Snap ${version ? `version ${version}` : "update"} has been downloaded. Would you like to restart now to complete the update?`,
  upToDateTitle: "Postal Snap",
  upToDateMessage:
    "You're up to date! Postal Snap is currently running the latest version.",
  checkErrorTitle: "Check for Updates",
  checkErrorMessage:
    "Postal Snap could not connect to the update service. Please check your internet connection and try again.",
  downloadErrorTitle: "Update Failed",
  downloadErrorMessage:
    "Failed to download the update. Please check your internet connection and try again.",
} as const;
