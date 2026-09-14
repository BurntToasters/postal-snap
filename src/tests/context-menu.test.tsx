import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { Composer } from "../components/Composer";
import { ContextMenuHost } from "../components/ContextMenu";
import {
  CONTEXT_DISMISS_EVENT,
  IFRAME_CONTEXT_EVENT,
  itemsForTarget,
} from "../contextMenu";
import { strings } from "../i18n";
import { makeAccount } from "./helpers/fixtures";
import { resetStore } from "./helpers/store";

vi.mock("../api", () => ({
  api: {
    saveDraft: vi.fn(),
    sendMessage: vi.fn(),
    deleteDraft: vi.fn(),
    releaseComposeAttachments: vi.fn(),
    readComposeImage: vi.fn(),
    chooseAttachments: vi.fn(),
    suggestRecipients: vi.fn().mockResolvedValue([]),
    showNativeConfirm: vi.fn().mockResolvedValue(true),
    inspectExternalUrl: vi.fn(),
    openExternalUrl: vi.fn(),
    onDraftSyncChanged: vi.fn().mockResolvedValue(() => undefined),
    listDrafts: vi.fn().mockResolvedValue([]),
  },
}));

const account = makeAccount();

beforeEach(() => {
  vi.clearAllMocks();
  resetStore({
    accounts: [account],
    activeAccountId: account.id,
  });
  vi.mocked(api.inspectExternalUrl).mockResolvedValue({
    url: "https://example.test/path",
    hostname: "example.test",
    reportedThreat: false,
  });
  vi.mocked(api.openExternalUrl).mockResolvedValue(undefined);
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("product context menu", () => {
  it("suppresses the WebView menu on empty chrome", () => {
    render(
      <>
        <ContextMenuHost />
        <button type="button" data-context="chrome">
          Get Mail
        </button>
      </>,
    );
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    screen.getByRole("button", { name: "Get Mail" }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens a link through native confirm instead of the WebView opener", async () => {
    render(
      <>
        <ContextMenuHost />
        <a href="#" data-external-href="https://example.test/path">
          example
        </a>
      </>,
    );
    fireEvent.contextMenu(screen.getByText("example"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.openLink }),
    );
    await waitFor(() =>
      expect(api.inspectExternalUrl).toHaveBeenCalledWith(
        "https://example.test/path",
      ),
    );
    expect(api.openExternalUrl).toHaveBeenCalledWith(
      "https://example.test/path",
      false,
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes with Escape", () => {
    render(
      <>
        <ContextMenuHost />
        <a href="#" data-external-href="https://example.test/path">
          example
        </a>
      </>,
    );
    fireEvent.contextMenu(screen.getByText("example"));
    expect(
      screen.getByRole("menu", { name: strings.contextMenu.menu }),
    ).toBeVisible();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers composer cut and copy", async () => {
    render(
      <>
        <ContextMenuHost />
        <Composer accountId={account.id} />
      </>,
    );
    const editor = await screen.findByRole("textbox", {
      name: strings.composer.messageBody,
    });
    fireEvent.contextMenu(editor);
    expect(
      screen.getByRole("menuitem", { name: strings.contextMenu.cut }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: strings.contextMenu.copy }),
    ).toBeVisible();
  });

  it("restores a field selection before copy", () => {
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: exec,
    });
    render(
      <>
        <ContextMenuHost />
        <textarea defaultValue="hello world" aria-label="Notes" />
      </>,
    );
    const field = screen.getByRole("textbox", {
      name: "Notes",
    }) as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(0, 5);
    fireEvent.contextMenu(field);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.copy }),
    );
    expect(exec).toHaveBeenCalledWith("copy");
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(5);
  });

  it("opens an iframe link through native confirm", async () => {
    render(<ContextMenuHost />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(IFRAME_CONTEXT_EVENT, {
          detail: { x: 12, y: 20, href: "https://example.test/path" },
        }),
      );
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.openLink }),
    );
    await waitFor(() =>
      expect(api.inspectExternalUrl).toHaveBeenCalledWith(
        "https://example.test/path",
      ),
    );
    expect(api.openExternalUrl).toHaveBeenCalledWith(
      "https://example.test/path",
      false,
    );
  });

  it("closes when Settings opens", () => {
    render(
      <>
        <ContextMenuHost />
        <a href="#" data-external-href="https://example.test/path">
          example
        </a>
      </>,
    );
    fireEvent.contextMenu(screen.getByText("example"));
    expect(screen.getByRole("menu")).toBeVisible();
    act(() => {
      window.dispatchEvent(new Event(CONTEXT_DISMISS_EVENT));
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("disables outbox discard while a send is in flight", () => {
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      outbox: [
        {
          id: "outbox-1",
          accountId: account.id,
          recipients: "lee@example.test",
          subject: "Busy send",
          state: "sending",
          createdAt: "2026-08-18T11:00:00Z",
        },
      ],
    });
    expect(itemsForTarget({ kind: "outbox", outboxId: "outbox-1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "discard",
          disabled: true,
        }),
      ]),
    );
  });

  it("offers copy on the reader", () => {
    expect(itemsForTarget({ kind: "reader" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "copy",
          label: strings.contextMenu.copy,
        }),
      ]),
    );
  });
});
