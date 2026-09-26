// English source catalog namespace: update section.
// Split from src/i18n.ts with zero text changes.
export const update = {
  readyTitle: "Update Ready",
  readyPrompt: (version: string) =>
    `Postal Snap ${version ? `version ${version}` : "update"} is downloaded. Restart now to finish the update? If you choose Later, it installs quietly when you quit, or while Postal Snap is hidden in the tray or menu bar.`,
  restartNow: "Restart Now",
  later: "Later",
  upToDateTitle: "Postal Snap",
  upToDateMessage:
    "You're up to date! Postal Snap is currently running the latest version.",
  checkErrorTitle: "Check for Updates",
  checkErrorMessage:
    "Postal Snap could not connect to the update service. Please check your internet connection and try again.",
  downloadErrorTitle: "Update Failed",
  downloadErrorMessage:
    "Failed to download the update. Please check your internet connection and try again.",
  installErrorTitle: "Update Failed",
  installErrorMessage:
    "Postal Snap could not apply the downloaded update. Your mail is still open. Try Restart Postal Snap from Settings.",
} as const;
