import { describe, expect, it } from "vitest";
import { rememberFromAddress, rememberedFromAddress } from "../fromAddress";

describe("remembered From address", () => {
  const allowed = ["sam@example.test", "work@example.test"];

  it("keeps the last address this account chose", () => {
    expect(rememberedFromAddress([], "account-1", allowed)).toBeUndefined();
    const saved = rememberFromAddress(
      [],
      "account-1",
      "work@example.test",
      allowed,
    );
    expect(saved).toEqual([
      { accountId: "account-1", address: "work@example.test" },
    ]);
    expect(rememberedFromAddress(saved ?? [], "account-1", allowed)).toBe(
      "work@example.test",
    );
    expect(
      rememberFromAddress(
        saved ?? [],
        "account-1",
        "work@example.test",
        allowed,
      ),
    ).toBeUndefined();
    expect(
      rememberFromAddress(
        saved ?? [],
        "account-1",
        "other@example.test",
        allowed,
      ),
    ).toBeUndefined();
    expect(
      rememberedFromAddress(saved ?? [], "account-1", ["sam@example.test"]),
    ).toBeUndefined();
  });
});
