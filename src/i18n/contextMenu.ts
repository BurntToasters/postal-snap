// English source catalog namespace: product context menu labels that are
// not already owned by mail, reader, or composer.
export const contextMenu = {
  menu: "Actions",
  open: "Open",
  openLink: "Open link",
  copyLink: "Copy link",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select all",
  moveTo: "Move to",
  moveToFolder: (name: string) => `Move to ${name}`,
} as const;
