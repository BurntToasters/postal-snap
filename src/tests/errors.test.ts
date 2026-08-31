import { describe, expect, it } from "vitest";
import { describeSetupError, normalizeIpcError, PostalError } from "../errors";

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

  it("adds recoverable setup hints without leaking raw failures", () => {
    const auth = new PostalError({
      code: "authenticationFailed",
      message: "ignored",
      retryable: true,
    });
    expect(describeSetupError(auth, "icloud").hint).toMatch(/app-specific/i);
    expect(describeSetupError(auth, "icloud").showAppPasswordLink).toBe(true);
    expect(describeSetupError(auth, "manual").hint).toMatch(/username/i);
    expect(describeSetupError(auth, "manual").showAppPasswordLink).toBeFalsy();
    expect(
      describeSetupError({ secret: "vault-token" }, "manual").text,
    ).not.toContain("vault-token");
  });

  it("uses actionable messages for settings file failures", () => {
    expect(
      normalizeIpcError({
        code: "settingsInvalid",
        message: "ignored",
        retryable: false,
      }).message,
    ).toMatch(/valid Postal Snap settings export/i);
    expect(
      normalizeIpcError({
        code: "settingsTooLarge",
        message: "ignored",
        retryable: false,
      }).message,
    ).toMatch(/64 KiB/i);
    expect(
      normalizeIpcError({
        code: "settingsMigrationFailed",
        message: "ignored",
        retryable: true,
      }).message,
    ).toMatch(/restart Postal Snap/i);
  });
});
