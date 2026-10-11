import { describe, expect, it } from "vitest";
import { rangeSelection } from "../selectionRange";

describe("range selection", () => {
  const ids = [1, 2, 3, 4, 5];

  it("selects every message from the anchor through the clicked row", () => {
    expect(rangeSelection(ids, 2, 5)).toEqual({
      ids: [2, 3, 4, 5],
      capped: false,
    });
    expect(rangeSelection(ids, 5, 2)).toEqual({
      ids: [2, 3, 4, 5],
      capped: false,
    });
    expect(rangeSelection(ids, 3, 3)).toEqual({ ids: [3], capped: false });
  });

  it("selects only the clicked row when there is no anchor in the list", () => {
    expect(rangeSelection(ids, undefined, 4)).toEqual({
      ids: [4],
      capped: false,
    });
    expect(rangeSelection(ids, 9, 4)).toEqual({ ids: [4], capped: false });
    expect(rangeSelection(ids, 1, 9)).toBeUndefined();
  });

  it("keeps the 200 messages nearest the anchor when the range is longer", () => {
    const ordered = Array.from({ length: 250 }, (_, index) => index + 1);
    const downward = rangeSelection(ordered, 10, 250);
    expect(downward?.capped).toBe(true);
    expect(downward?.ids).toHaveLength(200);
    expect(downward?.ids[0]).toBe(10);
    expect(downward?.ids.at(-1)).toBe(209);
    const upward = rangeSelection(ordered, 220, 1);
    expect(upward?.capped).toBe(true);
    expect(upward?.ids[0]).toBe(21);
    expect(upward?.ids.at(-1)).toBe(220);
  });
});
