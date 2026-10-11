import { afterEach, describe, expect, it } from "vitest";
import {
  clearRecentMoveMailbox,
  hydrateRecentMoveMailbox,
  rememberMoveMailbox,
  withRecentMoveMailbox,
} from "../recentMailbox";

const boxes = [{ id: 8 }, { id: 12 }, { id: 9 }];

describe("recent move folder", () => {
  afterEach(() => {
    clearRecentMoveMailbox();
  });

  it("puts a folder saved from the last session first", () => {
    hydrateRecentMoveMailbox(12);
    expect(withRecentMoveMailbox(boxes).map((box) => box.id)).toEqual([
      12, 8, 9,
    ]);
    hydrateRecentMoveMailbox(null);
    expect(withRecentMoveMailbox(boxes).map((box) => box.id)).toEqual([
      8, 12, 9,
    ]);
  });

  it("keeps Inbox off the remembered folder and remembers another choice", () => {
    hydrateRecentMoveMailbox(12);
    rememberMoveMailbox({ id: 1, role: "inbox" });
    expect(withRecentMoveMailbox(boxes)[0]?.id).toBe(12);
    rememberMoveMailbox({ id: 9, role: "other" });
    expect(withRecentMoveMailbox(boxes).map((box) => box.id)).toEqual([
      9, 8, 12,
    ]);
  });
});
