import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { FormatToolbar } from "../components/composer/formatToolbar";
import {
  announceLocalMailChanged,
  composerTitle,
  escapeHtml,
  highlightColor,
  seedBody,
  seedRecipients,
  seedReferences,
  seedSubject,
} from "../components/composer/composerSeed";
import {
  hasControlCharacter,
  hasDraftContent,
  isMailbox,
  splitAddresses,
  validateRecipientFields,
  validateSubject,
} from "../components/composer/composerValidate";
import {
  RecipientField,
  tokenAtCaret,
} from "../components/composer/recipientField";
import {
  tonightAtNine,
  tomorrowAtEight,
} from "../components/composer/schedule";
import { strings } from "../i18n";
import type { ComposeDraft } from "../types";
import { makeMessage, messageDetail } from "./helpers/fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete document.documentElement.dataset.theme;
});

function draft(overrides: Partial<ComposeDraft> = {}): ComposeDraft {
  return {
    accountId: "account-1",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    htmlBody: "",
    textBody: "",
    attachments: [],
    ...overrides,
  };
}

describe("composer seed helpers", () => {
  const source = messageDetail(makeMessage(), {
    to: ["sam@example.test", "friend@example.test"],
    cc: ["copy@example.test"],
    replyTo: "reply@example.test",
    textBody: "Hello <there>\nAgain",
    references: ["<prior@example.test>", ""],
  });

  it("selects recipients for drafts, prefill, replies, and forwards", () => {
    expect(seedRecipients(undefined, "to", "sam@example.test")).toBe("");
    expect(
      seedRecipients(
        { draft: draft({ to: ["draft@example.test"] }) },
        "to",
        "sam@example.test",
      ),
    ).toBe("draft@example.test");
    expect(
      seedRecipients(
        { prefill: { cc: ["prefill@example.test"] } },
        "cc",
        "sam@example.test",
      ),
    ).toBe("prefill@example.test");
    expect(seedRecipients({}, "to", "sam@example.test")).toBe("");
    expect(
      seedRecipients(
        { sourceMessage: source, composeMode: "forward" },
        "to",
        "sam@example.test",
      ),
    ).toBe("");
    expect(
      seedRecipients(
        { sourceMessage: source, composeMode: "reply" },
        "to",
        "sam@example.test",
      ),
    ).toBe("reply@example.test");
    expect(
      seedRecipients(
        { sourceMessage: source, composeMode: "replyAll" },
        "cc",
        "sam@example.test",
        ["alias@example.test"],
      ),
    ).toBe("friend@example.test, copy@example.test");
    expect(
      seedRecipients(
        { sourceMessage: { ...source, replyTo: null }, composeMode: "reply" },
        "to",
        "sam@example.test",
      ),
    ).toBe("jane@example.test");
  });

  it("builds subjects, bodies, references, and titles", () => {
    expect(seedSubject()).toBe("");
    expect(seedSubject({ prefill: { subject: "Topic" } })).toBe("Topic");
    expect(seedSubject({ sourceMessage: source, composeMode: "reply" })).toBe(
      `${strings.composer.replyPrefix} ${source.subject}`,
    );
    expect(
      seedSubject({
        sourceMessage: { ...source, subject: "Re: Existing" },
        composeMode: "replyAll",
      }),
    ).toBe("Re: Existing");
    expect(seedSubject({ sourceMessage: source, composeMode: "forward" })).toBe(
      `${strings.composer.forwardPrefix} ${source.subject}`,
    );

    expect(seedBody()).toBe("<p></p>");
    expect(seedBody({ prefill: { textBody: "<hello>\nworld" } })).toBe(
      "<p>&lt;hello&gt;<br>world</p>",
    );
    expect(
      seedBody({ prefill: { htmlBody: '<p onclick="bad()">Safe</p>' } }),
    ).toBe("<p>Safe</p>");
    expect(seedBody({ sourceMessage: source, composeMode: "reply" })).toContain(
      "Hello &lt;there&gt;<br>Again",
    );
    expect(
      seedBody({
        sourceMessage: { ...source, htmlBody: "<p>Rich</p>" },
        composeMode: "forward",
      }),
    ).toContain("<p>Rich</p>");

    expect(seedReferences()).toBeUndefined();
    expect(
      seedReferences({ draft: draft({ references: ["draft-ref"] }) }),
    ).toEqual(["draft-ref"]);
    expect(seedReferences({ sourceMessage: source })).toEqual([
      "<prior@example.test>",
      source.messageId,
    ]);
    expect(
      seedReferences({
        draft: draft({ references: [] }),
        sourceMessage: { ...source, messageId: "" },
      }),
    ).toEqual([]);

    expect(composerTitle()).toBe(strings.composer.newMessage);
    expect(composerTitle({ draft: draft() })).toBe(strings.composer.editDraft);
    expect(composerTitle({ composeMode: "reply" })).toBe(
      strings.composer.reply,
    );
    expect(composerTitle({ composeMode: "replyAll" })).toBe(
      strings.composer.reply,
    );
    expect(composerTitle({ composeMode: "forward" })).toBe(
      strings.composer.forward,
    );
  });

  it("escapes HTML, chooses theme highlight, and announces local changes", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    document.documentElement.dataset.theme = "light";
    expect(highlightColor()).toBe("#fff1a8");
    document.documentElement.dataset.theme = "dark";
    expect(highlightColor()).toBe("#7a6200");

    const handler = vi.fn();
    window.addEventListener("postal:local-mail-changed", handler);
    announceLocalMailChanged("account-1");
    expect(handler.mock.calls[0]?.[0]).toHaveProperty("detail", "account-1");
    window.removeEventListener("postal:local-mail-changed", handler);
  });
});

describe("composer validation and schedule helpers", () => {
  it("splits display-address lists without splitting quoted names", () => {
    expect(
      splitAddresses('"Last, First" <first@example.test>; two@example.test'),
    ).toEqual(['"Last, First" <first@example.test>', "two@example.test"]);
    expect(tokenAtCaret("first@example.test, sec; third", 22)).toEqual({
      token: "sec",
      start: 19,
    });
  });

  it("validates recipients, subjects, and draft content", () => {
    expect(validateRecipientFields("", "", "")).toBe(
      strings.composer.recipientRequired,
    );
    expect(validateRecipientFields("bad\n@example.test", "", "")).toBe(
      strings.composer.invalidHeader,
    );
    expect(validateRecipientFields("missing-at", "", "")).toBe(
      strings.composer.invalidRecipient,
    );
    expect(validateRecipientFields("Jane <jane@example.test>", "", "")).toBe(
      undefined,
    );
    expect(isMailbox("jane@example.test")).toBe(true);
    expect(isMailbox("Jane <jane@example.test>")).toBe(true);
    expect(isMailbox(`a@${"x".repeat(319)}`)).toBe(false);
    expect(isMailbox("bad address@example.test")).toBe(false);
    expect(hasControlCharacter("bad\u007f")).toBe(true);
    expect(hasControlCharacter("clean")).toBe(false);
    expect(validateSubject("bad\rsubject")).toBe(
      strings.composer.invalidSubject,
    );
    expect(validateSubject("Good subject")).toBeUndefined();

    expect(hasDraftContent(draft(), "   ")).toBe(false);
    expect(hasDraftContent(draft({ to: ["one@example.test"] }), "")).toBe(true);
    expect(hasDraftContent(draft({ subject: "Subject" }), "")).toBe(true);
    expect(hasDraftContent(draft(), "body")).toBe(true);
    expect(
      hasDraftContent(
        draft({
          attachments: [
            { token: "attachment", filename: "file.txt", inline: false },
          ],
        }),
        "",
      ),
    ).toBe(true);
  });

  it("schedules tonight or next day at stable local times", () => {
    expect(tonightAtNine(new Date(2026, 0, 1, 12)).getHours()).toBe(21);
    const afterNine = tonightAtNine(new Date(2026, 0, 1, 22));
    expect(afterNine.getDate()).toBe(2);
    expect(afterNine.getHours()).toBe(21);
    const tomorrow = tomorrowAtEight(new Date(2026, 0, 1, 22));
    expect(tomorrow.getDate()).toBe(2);
    expect(tomorrow.getHours()).toBe(8);
  });
});

describe("format toolbar", () => {
  function makeEditor() {
    const commandNames = [
      "focus",
      "undo",
      "redo",
      "setFontFamily",
      "unsetFontFamily",
      "setFontSize",
      "toggleBold",
      "toggleItalic",
      "toggleUnderline",
      "toggleStrike",
      "setColor",
      "toggleHighlight",
      "setTextAlign",
      "toggleBulletList",
      "toggleOrderedList",
      "insertTable",
      "setHorizontalRule",
      "clearNodes",
      "unsetAllMarks",
      "run",
    ] as const;
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of commandNames) chain[name] = vi.fn(() => chain);
    const editor = {
      chain: vi.fn(() => chain),
      getAttributes: vi.fn(() => ({ fontFamily: "Arial", fontSize: "16px" })),
      isActive: vi.fn((value: unknown) => value === "bold"),
    } as unknown as Editor;
    return { chain, editor };
  }

  it("dispatches every visible formatting action", () => {
    const { chain, editor } = makeEditor();
    const adjustIndent = vi.fn();
    const addLink = vi.fn();
    const formattingValues: boolean[] = [];
    const moreValues: boolean[] = [];
    render(
      <FormatToolbar
        editor={editor}
        formattingOpen
        setFormattingOpen={(update) =>
          formattingValues.push(
            typeof update === "function" ? update(true) : update,
          )
        }
        moreFormattingOpen
        setMoreFormattingOpen={(update) =>
          moreValues.push(typeof update === "function" ? update(true) : update)
        }
        adjustIndent={adjustIndent}
        addLink={addLink}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.hideFormatting }),
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: strings.composer.font }),
      {
        target: { value: "Georgia" },
      },
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: strings.composer.font }),
      {
        target: { value: "" },
      },
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: strings.composer.fontSize }),
      { target: { value: "20px" } },
    );
    fireEvent.change(screen.getByLabelText(strings.composer.textColor), {
      target: { value: "#123456" },
    });

    for (const label of [
      strings.composer.undo,
      strings.composer.redo,
      strings.composer.bold,
      strings.composer.italic,
      strings.composer.underline,
      strings.composer.strike,
      strings.composer.highlight,
      strings.composer.moreFormatting,
      strings.composer.alignLeft,
      strings.composer.alignCenter,
      strings.composer.alignRight,
      strings.composer.bullets,
      strings.composer.numbers,
      strings.composer.indentLess,
      strings.composer.indentMore,
      strings.composer.insertLink,
      strings.composer.insertTable,
      strings.composer.insertRule,
      strings.composer.clearFormatting,
    ]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }

    expect(formattingValues).toEqual([false]);
    expect(moreValues).toEqual([false]);
    expect(chain.setFontFamily).toHaveBeenCalledWith("Georgia");
    expect(chain.unsetFontFamily).toHaveBeenCalled();
    expect(chain.setFontSize).toHaveBeenCalledWith("20px");
    expect(chain.setColor).toHaveBeenCalledWith("#123456");
    expect(chain.toggleHighlight).toHaveBeenCalledWith({ color: "#fff1a8" });
    expect(chain.setTextAlign.mock.calls.map((call) => call[0])).toEqual([
      "left",
      "center",
      "right",
    ]);
    expect(adjustIndent.mock.calls).toEqual([[-1], [1]]);
    expect(addLink).toHaveBeenCalled();
    expect(chain.insertTable).toHaveBeenCalledWith({
      rows: 3,
      cols: 3,
      withHeaderRow: true,
    });
    expect(chain.unsetAllMarks).toHaveBeenCalled();
  });

  it("renders closed while editor initializes", () => {
    render(
      <FormatToolbar
        editor={null}
        formattingOpen={false}
        setFormattingOpen={vi.fn()}
        moreFormattingOpen={false}
        setMoreFormattingOpen={vi.fn()}
        adjustIndent={vi.fn()}
        addLink={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: strings.composer.showFormatting }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("toolbar", { hidden: true })).not.toBeVisible();
  });
});

describe("recipient suggestions", () => {
  function RecipientHarness() {
    const [value, setValue] = useState("");
    return (
      <RecipientField
        id="recipient"
        accountId="account-1"
        value={value}
        onChange={setValue}
        onBlur={vi.fn()}
      />
    );
  }

  it("loads, navigates, and accepts suggestions", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "suggestRecipients").mockResolvedValue([
      { name: "Jane", address: "jane@example.test", useCount: 2 },
      { name: "", address: "john@example.test", useCount: 1 },
    ]);
    render(<RecipientHarness />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "ja", selectionStart: 2 } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(api.suggestRecipients).toHaveBeenCalledWith("account-1", "ja", 8);
    expect(screen.getByRole("listbox")).toBeVisible();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(
      screen.getByRole("option", { name: "john@example.test" }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("jane@example.test, ");
    fireEvent.change(input, { target: { value: "j" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    fireEvent.mouseDown(
      screen.getByRole("option", { name: /john@example.test/i }),
    );
    fireEvent.click(screen.getByRole("option", { name: /john@example.test/i }));
    expect(input).toHaveValue("john@example.test, ");
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
  });

  it("closes suggestions for empty input, Escape, blur, and failed lookup", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "suggestRecipients")
      .mockResolvedValueOnce([
        { name: "Jane", address: "jane@example.test", useCount: 1 },
      ])
      .mockRejectedValueOnce(new Error("offline"));
    render(<RecipientHarness />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "j" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "x" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    fireEvent.blur(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
