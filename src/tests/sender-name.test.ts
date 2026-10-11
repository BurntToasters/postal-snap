import { describe, expect, it } from "vitest";
import { messagePrintSection } from "../components/reader/readerUtils";
import { strings } from "../i18n";
import { conflictingNameAddress } from "../senderName";
import { makeMessage, messageDetail } from "./helpers/fixtures";

describe("conflicting display-name addresses", () => {
  it("ignores a plain name and the same address", () => {
    expect(conflictingNameAddress("Jane", "jane@example.com")).toBeNull();
    expect(
      conflictingNameAddress("Jane <jane@example.com>", "jane@example.com"),
    ).toBeNull();
    expect(
      conflictingNameAddress("JANE@EXAMPLE.COM", "jane@example.com"),
    ).toBeNull();
    expect(conflictingNameAddress("", "jane@example.com")).toBeNull();
    expect(conflictingNameAddress("Jane <jane@example.com>", "")).toBeNull();
  });

  it("returns the first address in the name that is not the sender", () => {
    expect(
      conflictingNameAddress("PayPal <service@paypal.com>", "jane@example.com"),
    ).toBe("service@paypal.com");
    expect(
      conflictingNameAddress(
        "jane@example.com and billing@paypal.com",
        "jane@example.com",
      ),
    ).toBe("billing@paypal.com");
  });

  it("includes the mismatch when the message is printed", () => {
    const message = messageDetail(
      makeMessage({
        senderName: "PayPal <service@paypal.com>",
        senderAddress: "jane@example.com",
      }),
    );
    const printed = messagePrintSection(message);
    expect(printed).toContain(
      strings.reader.nameIncludesDifferentAddress("service@paypal.com"),
    );
    expect(messagePrintSection(messageDetail(makeMessage()))).not.toContain(
      "different address",
    );
  });

  it("includes a mailing list address when the message is printed", () => {
    const printed = messagePrintSection(
      messageDetail(makeMessage(), { listPost: "list@example.test" }),
    );
    expect(printed).toContain(strings.reader.mailingList("list@example.test"));
    expect(
      messagePrintSection(
        messageDetail(makeMessage(), { listPost: "not-a-list" }),
      ),
    ).not.toContain("Mailing list");
  });
});
