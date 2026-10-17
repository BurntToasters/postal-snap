// English source catalog namespace: notice queue.
const messages = (count: number) =>
  count === 1 ? "1 message" : `${count} messages`;

export const notices = {
  dismiss: "Dismiss notice",
  actionFailed: "That action did not finish. Try again.",
  undo: "Undo",
  undoLastMove: "Undo last move",
  archived: (count: number) => `Archived ${messages(count)}.`,
  trashed: (count: number) => `Moved ${messages(count)} to Trash.`,
  junked: (count: number) => `Marked ${messages(count)} as junk.`,
  movedTo: (count: number, folder: string) =>
    `Moved ${messages(count)} to ${folder}.`,
  moveUndone: (count: number) =>
    count === 1 ? "Message restored." : `${messages(count)} restored.`,
  moveUndonePartial: (restored: number, total: number) =>
    `Restored ${restored} of ${total} messages. The rest had already moved.`,
  moveAlreadyCommitted:
    "The move already went through, so Undo cannot restore it.",
} as const;
