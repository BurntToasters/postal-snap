import { describe, expect, it } from "vitest";
import { normalizeIpcError, PostalError } from "../errors";

describe("structured IPC errors", () => {
  it("maps backend codes through the centralized safe catalog", () => {
    const error = normalizeIpcError({
      code: "connectionFailed",
      message: "Could not connect securely.",
      retryable: true,
    });
    expect(error).toBeInstanceOf(PostalError);
    expect(error.code).toBe("connectionFailed");
    expect(String(error)).toBe(
      "Could not reach the mail server. Check your connection.",
    );
  });

  it("maps malformed failures to a stable fallback", () => {
    const error = normalizeIpcError({ secret: "do-not-display" });
    expect(error.code).toBe("operationFailed");
    expect(error.message).not.toContain("do-not-display");
  });
});
