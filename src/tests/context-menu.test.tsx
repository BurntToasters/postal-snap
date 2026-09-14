import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { Composer } from "../components/Composer";
import { ContextMenuHost } from "../components/ContextMenu";
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
});
