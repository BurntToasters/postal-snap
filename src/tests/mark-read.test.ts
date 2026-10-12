import { afterEach, describe, expect, it, vi } from "vitest";
import { markReadDelayMs, waitToMarkRead } from "../markRead";

describe("mark read timing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks as soon as a message is opened", async () => {
    expect(markReadDelayMs("open")).toBe(0);
    expect(markReadDelayMs(undefined)).toBe(0);
    await expect(waitToMarkRead("open", () => true)).resolves.toBe(true);
    await expect(waitToMarkRead("open", () => false)).resolves.toBe(false);
  });

  it("leaves the message unread until the reader marks it", async () => {
    expect(markReadDelayMs("manual")).toBeNull();
    await expect(waitToMarkRead("manual", () => true)).resolves.toBe(false);
  });

  it("marks after two seconds while the same message stays open", async () => {
    vi.useFakeTimers();
    const pending = waitToMarkRead("after2s", () => true);
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(true);
  });

  it("skips the mark when the message closes during the wait", async () => {
    vi.useFakeTimers();
    let open = true;
    const pending = waitToMarkRead("after2s", () => open);
    await vi.advanceTimersByTimeAsync(1_000);
    open = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(false);
  });
});
