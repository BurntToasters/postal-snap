export type MessageListSort =
  | "date"
  | "dateOldest"
  | "sender"
  | "senderDesc"
  | "subject"
  | "subjectDesc"
  | "size"
  | "sizeAsc";

const sorts = new Set<string>([
  "date",
  "dateOldest",
  "sender",
  "senderDesc",
  "subject",
  "subjectDesc",
  "size",
  "sizeAsc",
]);

/** A saved mailbox order, or newest first when the value is unknown. */
export function rememberedSort(value: string | undefined): MessageListSort {
  return value && sorts.has(value) ? (value as MessageListSort) : "date";
}

export type SortFamily = "date" | "sender" | "subject" | "size";

/** The sort menu's field, ignoring which direction is selected. */
export function sortFamily(sort: MessageListSort): SortFamily {
  if (sort === "date" || sort === "dateOldest") return "date";
  if (sort === "sender" || sort === "senderDesc") return "sender";
  if (sort === "subject" || sort === "subjectDesc") return "subject";
  return "size";
}

/** True for oldest, Z to A, and smallest. */
export function sortIsReversed(sort: MessageListSort): boolean {
  return (
    sort === "dateOldest" ||
    sort === "senderDesc" ||
    sort === "subjectDesc" ||
    sort === "sizeAsc"
  );
}

/** The other direction of the same field. */
export function toggleSortDirection(sort: MessageListSort): MessageListSort {
  switch (sort) {
    case "date":
      return "dateOldest";
    case "dateOldest":
      return "date";
    case "sender":
      return "senderDesc";
    case "senderDesc":
      return "sender";
    case "subject":
      return "subjectDesc";
    case "subjectDesc":
      return "subject";
    case "size":
      return "sizeAsc";
    case "sizeAsc":
      return "size";
  }
}
