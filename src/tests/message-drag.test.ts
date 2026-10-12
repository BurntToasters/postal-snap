import { describe, expect, it } from "vitest";
import {
  endMessageDrag,
  messageDragPayload,
  readMessageDrag,
} from "../messageDrag";

describe("message drag payload", () => {
  it("keeps account and message ids and rejects anything else", () => {
    endMessageDrag();
    const payload = messageDragPayload("account-1", [4, 4, 9]);
    expect(payload).toBe("account-1\n4,4,9");
    expect(payload).not.toContain("subject");
    expect(readMessageDrag(payload, "account-1")).toEqual([4, 9]);
    expect(readMessageDrag(payload, "account-2")).toBeUndefined();
    expect(readMessageDrag("account-1\n0", "account-1")).toBeUndefined();
    expect(readMessageDrag("account-1\n1,nope", "account-1")).toBeUndefined();
    expect(readMessageDrag("just-text", "account-1")).toBeUndefined();
  });
});
