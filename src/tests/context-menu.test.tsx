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
  CONTEXT_ACTION_EVENT,
  CONTEXT_DISMISS_EVENT,
  IFRAME_CONTEXT_EVENT,
  earlierHeaderId,
  iframeTargetFromDetail,
  itemsForTarget,
  resolveContextTarget,
  senderSearchQuery,
  subjectSearchQuery,
} from "../contextMenu";
import {
  clearBlockedSenders,
  domainIsBlocked,
  rememberBlockedSenders,
  senderDomain,
} from "../blockedSenders";
import { strings } from "../i18n";
import { clearRecentMoveMailbox, rememberMoveMailbox } from "../recentMailbox";
import { useAppStore } from "../store";
import { makeAccount, makeMailbox, makeMessage } from "./helpers/fixtures";
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
    onComposeDrag: vi.fn().mockResolvedValue(() => undefined),
    attachDroppedFiles: vi.fn().mockResolvedValue([]),
    listDrafts: vi.fn().mockResolvedValue([]),
  },
}));

const account = makeAccount();

beforeEach(() => {
  vi.clearAllMocks();
  clearBlockedSenders();
  clearRecentMoveMailbox();
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

describe("sender search query", () => {
  it("quotes a usable address and drops an unusable one", () => {
    expect(senderSearchQuery(" Jane@Example.test ")).toBe(
      'from:"Jane@Example.test"',
    );
    expect(senderSearchQuery('a"b@example.test')).toBe(
      'from:"ab@example.test"',
    );
    expect(senderSearchQuery("Jane Doe <jane@example.test>")).toBe(
      'from:"jane@example.test"',
    );
    expect(senderSearchQuery("")).toBeUndefined();
    expect(senderSearchQuery("@@@")).toBeUndefined();
  });
});

describe("subject search query", () => {
  it("drops reply prefixes and unusable subjects", () => {
    expect(subjectSearchQuery(" Re: Fwd: Picnic plans ")).toBe(
      'subject:"Picnic plans"',
    );
    expect(subjectSearchQuery("FW: Re: Notes")).toBe('subject:"Notes"');
    expect(subjectSearchQuery("Re:")).toBeUndefined();
    expect(subjectSearchQuery('Say "hello"')).toBeUndefined();
    expect(subjectSearchQuery("!!!")).toBeUndefined();
    expect(subjectSearchQuery("")).toBeUndefined();
  });
});

describe("earlier message id", () => {
  it("uses the nearest reference and skips this message", () => {
    expect(
      earlierHeaderId({
        messageId: "<weekend@example.test>",
        references: [
          "<root@example.test>",
          "<parent@example.test>",
          "<weekend@example.test>",
        ],
      }),
    ).toBe("<parent@example.test>");
    expect(earlierHeaderId({ references: [] })).toBeUndefined();
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
        expect.objectContaining({
          id: "copy-message-text",
          label: strings.reader.copyMessageText,
        }),
        expect.objectContaining({
          id: "copy-subject",
          label: strings.reader.copySubject,
        }),
        expect.objectContaining({
          id: "copy-sender-address",
          label: strings.reader.copySenderAddress,
        }),
      ]),
    );
  });

  it("copies links and addresses, then opens mailto drafts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <>
        <ContextMenuHost />
        <a href="#" data-external-href="https://example.test/path">
          example
        </a>
        <span data-context="address" data-address="sam@example.test">
          Sam
        </span>
        <a href="mailto:lee@example.test?subject=Hi">mail lee</a>
      </>,
    );

    fireEvent.contextMenu(screen.getByText("example"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.copyLink }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://example.test/path"),
    );

    fireEvent.contextMenu(screen.getByText("Sam"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.copyAddress }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("sam@example.test"),
    );

    fireEvent.contextMenu(screen.getByText("mail lee"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.copyAddress }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("lee@example.test"),
    );

    fireEvent.contextMenu(screen.getByText("mail lee"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.open }),
    );
    expect(useAppStore.getState().composerOpen).toBe(true);
    expect(useAppStore.getState().composeSeed?.prefill?.to).toEqual([
      "lee@example.test",
    ]);
  });

  it("pastes, selects, and undoes in an editable field", () => {
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
      screen.getByRole("menuitem", { name: strings.contextMenu.paste }),
    );
    expect(exec).toHaveBeenCalledWith("paste");

    fireEvent.contextMenu(field);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.selectAll }),
    );
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);

    fireEvent.contextMenu(field);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.composer.undo }),
    );
    expect(exec).toHaveBeenCalledWith("undo");
    fireEvent.contextMenu(field);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.composer.redo }),
    );
    expect(exec).toHaveBeenCalledWith("redo");
  });

  it("closes on outside click and scroll, and keeps the open menu", () => {
    render(
      <>
        <ContextMenuHost />
        <a href="#" data-external-href="https://example.test/path">
          example
        </a>
        <button type="button">Away</button>
      </>,
    );
    fireEvent.contextMenu(screen.getByText("example"));
    const menu = screen.getByRole("menu", { name: strings.contextMenu.menu });
    const stay = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    menu.dispatchEvent(stay);
    expect(stay.defaultPrevented).toBe(true);
    expect(menu).toBeVisible();

    fireEvent.mouseDown(screen.getByRole("button", { name: "Away" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText("example"));
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText("example"), {
      clientX: 10_000,
      clientY: 10_000,
    });
    expect(
      screen.getByRole("menu", { name: strings.contextMenu.menu }),
    ).toBeVisible();
  });

  it("opens iframe mailto and reader menus, and ignores empty iframe events", () => {
    render(<ContextMenuHost />);
    act(() => {
      window.dispatchEvent(new CustomEvent(IFRAME_CONTEXT_EVENT));
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(IFRAME_CONTEXT_EVENT, {
          detail: { x: 8, y: 9, mailto: "mailto:sam@example.test" },
        }),
      );
    });
    expect(
      screen.getByRole("menuitem", { name: strings.contextMenu.open }),
    ).toBeVisible();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(IFRAME_CONTEXT_EVENT, {
          detail: { x: 4, y: 5 },
        }),
      );
    });
    expect(
      screen.getByRole("menuitem", { name: strings.reader.findInMessage }),
    ).toBeVisible();
  });

  it("dispatches reader copy and composer select-all to the host view", async () => {
    const listener = vi.fn();
    window.addEventListener(CONTEXT_ACTION_EVENT, listener);
    render(
      <>
        <ContextMenuHost />
        <div data-context="reader">Body</div>
        <div data-context="composer">Draft</div>
      </>,
    );
    fireEvent.contextMenu(screen.getByText("Body"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.copy }),
    );
    await waitFor(() => expect(listener).toHaveBeenCalled());
    const copyDetail = listener.mock.calls.at(-1)?.[0] as CustomEvent;
    expect(copyDetail.detail).toEqual({
      id: "copy",
      target: { kind: "reader" },
    });

    fireEvent.contextMenu(screen.getByText("Draft"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.selectAll }),
    );
    await waitFor(() =>
      expect(
        listener.mock.calls.some(
          (call) =>
            (call[0] as CustomEvent).detail?.id === "select-all" &&
            (call[0] as CustomEvent).detail?.target?.kind === "composer",
        ),
      ).toBe(true),
    );
    window.removeEventListener(CONTEXT_ACTION_EVENT, listener);
  });

  it("copies from a contenteditable selection and ignores clipboard failures", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: exec,
    });
    render(
      <>
        <ContextMenuHost />
        <div contentEditable="true" role="textbox" aria-label="Rich">
          hello
        </div>
        <a href="#" data-external-href="https://example.test/path">
          example
        </a>
      </>,
    );
    const rich = screen.getByRole("textbox", { name: "Rich" });
    rich.focus();
    const range = document.createRange();
    range.selectNodeContents(rich);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.contextMenu(rich);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.copy }),
    );
    expect(exec).toHaveBeenCalledWith("copy");

    fireEvent.contextMenu(rich);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.selectAll }),
    );
    expect(exec).toHaveBeenCalledWith("selectAll");

    fireEvent.contextMenu(screen.getByText("example"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.copyLink }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalled());
  });
});

describe("context target resolution", () => {
  function resolveFromHtml(html: string, pick?: string) {
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    const start = pick ? wrap.querySelector(pick) : wrap.firstElementChild;
    const target = resolveContextTarget(start);
    wrap.remove();
    return target;
  }

  it("maps marked nodes, links, editors, and unknown chrome", () => {
    expect(resolveContextTarget(null)).toEqual({ kind: "suppress" });
    expect(
      resolveFromHtml('<div data-context="chrome">Get Mail</div>'),
    ).toEqual({ kind: "suppress" });
    expect(
      resolveFromHtml(
        '<div data-context="message" data-message-id="12">row</div>',
      ),
    ).toEqual({ kind: "message", messageId: 12 });
    expect(
      resolveFromHtml(
        '<div data-context="folder" data-mailbox-id="4">Inbox</div>',
      ),
    ).toEqual({ kind: "folder", mailboxId: 4 });
    expect(
      resolveFromHtml(
        '<div data-context="local-nav" data-local-view="drafts">Drafts</div>',
      ),
    ).toEqual({ kind: "local-nav", view: "drafts" });
    expect(
      resolveFromHtml(
        '<div data-context="local-nav" data-local-view="inbox">Inbox</div>',
      ),
    ).toEqual({ kind: "suppress" });
    expect(
      resolveFromHtml(
        '<div data-context="draft" data-draft-id="d1">Draft</div>',
      ),
    ).toEqual({ kind: "draft", draftId: "d1" });
    expect(
      resolveFromHtml(
        '<div data-context="outbox" data-outbox-id="o1">Outbox</div>',
      ),
    ).toEqual({ kind: "outbox", outboxId: "o1" });
    expect(
      resolveFromHtml(
        '<div data-context="snoozed" data-message-id="9">Snoozed</div>',
      ),
    ).toEqual({ kind: "snoozed", messageId: 9 });
    expect(resolveFromHtml('<div data-context="reader">Body</div>')).toEqual({
      kind: "reader",
    });
    expect(
      resolveFromHtml(
        '<div data-context="attachment" data-attachment-id="a1" data-previewable="true" data-filename="photo.png">file</div>',
      ),
    ).toEqual({
      kind: "attachment",
      attachmentId: "a1",
      previewable: true,
      filename: "photo.png",
    });
    expect(
      resolveFromHtml(
        '<div data-context="address" data-address="sam@example.test">Sam</div>',
      ),
    ).toEqual({ kind: "address", address: "sam@example.test" });
    expect(resolveFromHtml('<div data-context="composer">Draft</div>')).toEqual(
      {
        kind: "composer",
      },
    );
    expect(
      resolveFromHtml(
        '<div data-context="composer-attachment" data-attachment-index="2">chip</div>',
      ),
    ).toEqual({ kind: "composer-attachment", index: 2 });
    expect(resolveFromHtml('<div data-context="editable">Notes</div>')).toEqual(
      {
        kind: "editable",
      },
    );
    expect(
      resolveFromHtml(
        '<div data-context="message" data-message-id="nope">bad</div>',
      ),
    ).toEqual({ kind: "suppress" });
    expect(
      resolveFromHtml(
        '<a href="/local" data-external-href="https://example.test/x"><span data-start>t</span></a>',
        "[data-start]",
      ),
    ).toEqual({ kind: "link", href: "https://example.test/x" });
    expect(
      resolveFromHtml('<a href="https://cdn.example.test/x">cdn</a>'),
    ).toEqual({ kind: "link", href: "https://cdn.example.test/x" });
    expect(
      resolveFromHtml(
        '<a href="https://cdn.example.test/x" data-external-href="mailto:sam@example.test">mixed</a>',
      ),
    ).toEqual({ kind: "link", href: "https://cdn.example.test/x" });
    expect(
      resolveFromHtml(
        '<a href="#local" data-external-href="mailto:sam@example.test">mail</a>',
      ),
    ).toEqual({ kind: "mailto", href: "mailto:sam@example.test" });
    expect(
      resolveFromHtml('<a href="mailto:lee@example.test">lee</a>'),
    ).toEqual({ kind: "mailto", href: "mailto:lee@example.test" });
    expect(resolveFromHtml('<a href="#local">skip</a>')).toEqual({
      kind: "suppress",
    });
    expect(resolveFromHtml('<area href="https://area.example.test/">')).toEqual(
      {
        kind: "link",
        href: "https://area.example.test/",
      },
    );
    expect(resolveFromHtml('<div class="ProseMirror">body</div>')).toEqual({
      kind: "composer",
    });
    expect(resolveFromHtml('<div class="composer-editor">body</div>')).toEqual({
      kind: "composer",
    });
    expect(resolveFromHtml("<textarea>notes</textarea>")).toEqual({
      kind: "editable",
    });
    expect(resolveFromHtml("<p>plain</p>")).toEqual({ kind: "suppress" });
  });

  it("builds iframe targets from href, mailto, or the reader", () => {
    expect(
      iframeTargetFromDetail({ x: 1, y: 2, href: "https://example.test" }),
    ).toEqual({ kind: "link", href: "https://example.test" });
    expect(
      iframeTargetFromDetail({
        x: 1,
        y: 2,
        mailto: "mailto:sam@example.test",
      }),
    ).toEqual({ kind: "mailto", href: "mailto:sam@example.test" });
    expect(iframeTargetFromDetail({ x: 1, y: 2 })).toEqual({ kind: "reader" });
  });
});

describe("context menu items", () => {
  it("lists the last chosen folder first", () => {
    const inbox = makeMailbox();
    const receipts = makeMailbox({
      id: 5,
      name: "Receipts",
      displayName: "Receipts",
      role: "other",
    });
    const travel = makeMailbox({
      id: 6,
      name: "Travel",
      displayName: "Travel",
      role: "other",
    });
    const message = makeMessage({ id: 1, mailboxId: inbox.id });
    resetStore({
      mailboxes: [inbox, receipts, travel],
      messages: [message],
    });
    rememberMoveMailbox(travel);
    const ids = itemsForTarget({ kind: "message", messageId: 1 }).flatMap(
      (entry) =>
        entry.type === "item" && entry.id.startsWith("move-mailbox:")
          ? [entry.id]
          : [],
    );
    expect(ids).toEqual(["move-mailbox:6", "move-mailbox:5"]);
    rememberMoveMailbox(inbox);
    const afterInbox = itemsForTarget({
      kind: "message",
      messageId: 1,
    }).flatMap((entry) =>
      entry.type === "item" && entry.id.startsWith("move-mailbox:")
        ? [entry.id]
        : [],
    );
    expect(afterInbox).toEqual(["move-mailbox:6", "move-mailbox:5"]);
  });

  it("builds message, folder, outbox, and attachment actions", () => {
    const inbox = makeMailbox();
    const archive = makeMailbox({
      id: 2,
      name: "Archive",
      displayName: "Archive",
      role: "archive",
    });
    const junk = makeMailbox({
      id: 4,
      name: "Junk",
      displayName: "Junk",
      role: "junk",
      totalCount: 3,
    });
    const trash = makeMailbox({
      id: 3,
      name: "Trash",
      displayName: "Trash",
      role: "trash",
      totalCount: 2,
    });
    const other = makeMailbox({
      id: 5,
      name: "Projects",
      displayName: "Projects",
      role: "other",
    });
    const unread = makeMessage({ id: 1, mailboxId: inbox.id, isRead: false });
    const starred = makeMessage({
      id: 2,
      mailboxId: archive.id,
      isRead: true,
      isStarred: true,
    });
    const junked = makeMessage({ id: 3, mailboxId: junk.id, isRead: true });
    const trashed = makeMessage({ id: 4, mailboxId: trash.id, isRead: true });
    resetStore({
      mailboxes: [inbox, archive, junk, trash, other],
      messages: [unread, starred, junked, trashed],
      outbox: [
        {
          id: "queued-1",
          accountId: account.id,
          recipients: "lee@example.test",
          subject: "Queued",
          state: "queued",
          createdAt: "2026-08-18T11:00:00Z",
        },
        {
          id: "retry-1",
          accountId: account.id,
          recipients: "lee@example.test",
          subject: "Retry",
          state: "needs_attention",
          createdAt: "2026-08-18T11:00:00Z",
        },
        {
          id: "copy-1",
          accountId: account.id,
          recipients: "lee@example.test",
          subject: "Copy",
          state: "sent_copy_pending",
          createdAt: "2026-08-18T11:00:00Z",
        },
        {
          id: "later-1",
          accountId: account.id,
          recipients: "lee@example.test",
          subject: "Later",
          state: "scheduled",
          createdAt: "2026-08-18T11:00:00Z",
        },
      ],
    });

    expect(itemsForTarget({ kind: "suppress" })).toEqual([]);
    expect(itemsForTarget({ kind: "message", messageId: 99 })).toEqual([]);
    expect(itemsForTarget({ kind: "folder", mailboxId: 99 })).toEqual([]);
    expect(itemsForTarget({ kind: "outbox", outboxId: "missing" })).toEqual([]);

    const unreadItems = itemsForTarget({ kind: "message", messageId: 1 });
    expect(unreadItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "toggle-read",
          label: strings.reader.markRead,
        }),
        expect.objectContaining({
          id: "edit-as-new",
          label: strings.reader.editAsNew,
        }),
        expect.objectContaining({
          id: "copy-message-text",
          label: strings.reader.copyMessageText,
        }),
        expect.objectContaining({
          id: "copy-subject",
          label: strings.reader.copySubject,
        }),
        expect.objectContaining({
          id: "copy-sender-address",
          label: strings.reader.copySenderAddress,
        }),
        expect.objectContaining({
          id: "forward-attachment",
          label: strings.reader.forwardAsAttachment,
        }),
        expect.objectContaining({
          id: "redirect",
          label: strings.reader.redirect,
        }),
        expect.objectContaining({
          id: "toggle-star",
          label: strings.reader.addStar,
        }),
        expect.objectContaining({ id: "move-mailbox:5" }),
        expect.objectContaining({
          id: "copy-mailbox:5",
          ariaLabel: strings.contextMenu.copyToFolder("Projects"),
        }),
        expect.objectContaining({
          id: "create-rule",
          label: strings.reader.createRuleFromSender,
        }),
        expect.objectContaining({
          id: "create-subject-rule",
          label: strings.reader.createRuleFromSubject,
        }),
        expect.objectContaining({
          id: "block-sender",
          label: strings.reader.blockSender,
        }),
        expect.objectContaining({
          id: "mute-conversation",
          label: strings.reader.muteConversation,
        }),
      ]),
    );
    const muted = makeMessage({
      id: 8,
      conversationMuted: true,
    });
    const unnamed = makeMessage({ id: 9, messageId: "" });
    useAppStore.setState({
      messages: [unread, starred, junked, trashed, muted, unnamed],
    });
    expect(itemsForTarget({ kind: "message", messageId: 8 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mute-conversation",
          label: strings.reader.unmuteConversation,
        }),
      ]),
    );
    expect(
      itemsForTarget({ kind: "message", messageId: 9 }).some(
        (item) => item.type === "item" && item.id === "mute-conversation",
      ),
    ).toBe(false);
    expect(unreadItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "messages-from-sender",
          label: strings.reader.messagesFromSender,
        }),
        expect.objectContaining({
          id: "messages-with-subject",
          label: strings.reader.messagesWithSubject,
        }),
      ]),
    );

    const archiveItems = itemsForTarget({ kind: "message", messageId: 2 });
    expect(archiveItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "toggle-read",
          label: strings.reader.markUnread,
        }),
        expect.objectContaining({
          id: "toggle-star",
          label: strings.reader.removeStar,
        }),
        expect.objectContaining({
          id: "move-to-inbox",
          label: strings.reader.moveToInbox,
        }),
      ]),
    );
    expect(itemsForTarget({ kind: "message", messageId: 3 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "not-junk",
          label: strings.reader.notJunk,
        }),
      ]),
    );
    const threaded = makeMessage({
      id: 6,
      mailboxId: inbox.id,
      isRead: false,
      threadRoot: "<thread@example.test>",
      subject: "Threaded",
    });
    const threadedReply = makeMessage({
      id: 7,
      mailboxId: inbox.id,
      isRead: true,
      threadRoot: "<thread@example.test>",
      subject: "Threaded reply",
    });
    useAppStore.setState({
      messages: [unread, starred, junked, trashed, threaded, threadedReply],
    });
    expect(itemsForTarget({ kind: "message", messageId: 6 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mark-conversation-read",
          label: strings.reader.markConversationRead,
        }),
        expect.objectContaining({
          id: "mark-conversation-unread",
          label: strings.reader.markConversationUnread,
        }),
        expect.objectContaining({
          id: "archive-conversation",
          label: strings.reader.archiveConversation,
        }),
        expect.objectContaining({
          id: "trash-conversation",
          label: strings.reader.trashConversation,
        }),
        expect.objectContaining({
          id: "star-conversation",
          label: strings.reader.starConversation,
        }),
        expect.objectContaining({
          id: "select-conversation",
          label: strings.reader.selectConversation,
        }),
        expect.objectContaining({
          id: "select-from-sender",
          label: strings.reader.selectFromSender,
        }),
        expect.objectContaining({
          id: "snooze-conversation",
          label: strings.reader.snoozeConversation,
        }),
        expect.objectContaining({
          id: "junk-conversation",
          label: strings.reader.junkConversation,
        }),
        expect.objectContaining({
          id: "move-conversation:5",
          label: "Projects",
          ariaLabel: strings.contextMenu.moveConversationToFolder("Projects"),
        }),
        expect.objectContaining({
          id: "copy-conversation:5",
          label: "Projects",
          ariaLabel: strings.contextMenu.copyConversationToFolder("Projects"),
        }),
        expect.objectContaining({
          id: "print-conversation",
          label: strings.reader.printConversation,
        }),
        expect.objectContaining({
          id: "copy-conversation-text",
          label: strings.reader.copyConversationText,
        }),
        expect.objectContaining({
          id: "forward-conversation",
          label: strings.reader.forwardConversation,
        }),
        expect.objectContaining({
          id: "pin",
          label: strings.reader.pin,
        }),
        expect.objectContaining({
          id: "pin-conversation",
          label: strings.reader.pinConversation,
        }),
      ]),
    );
    expect(
      itemsForTarget({ kind: "message", messageId: 6 }).some(
        (entry) => entry.type === "item" && entry.id === "unstar-conversation",
      ),
    ).toBe(false);
    expect(
      itemsForTarget({ kind: "message", messageId: 1 }).some(
        (entry) => entry.type === "item" && entry.id === "forward-conversation",
      ),
    ).toBe(false);
    expect(
      itemsForTarget({ kind: "message", messageId: 6 }).some(
        (entry) =>
          entry.type === "item" && entry.id === "save-conversation-files",
      ),
    ).toBe(false);
    useAppStore.setState({
      messages: [
        unread,
        starred,
        junked,
        trashed,
        threaded,
        { ...threadedReply, hasAttachments: true },
      ],
    });
    expect(itemsForTarget({ kind: "message", messageId: 6 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "save-conversation-files",
          label: strings.reader.saveConversationFiles,
        }),
      ]),
    );
    expect(itemsForTarget({ kind: "message", messageId: 1 })).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "archive-conversation" }),
      ]),
    );
    expect(itemsForTarget({ kind: "message", messageId: 1 })).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "copy-conversation:5" }),
      ]),
    );
    expect(itemsForTarget({ kind: "message", messageId: 1 })).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "print-conversation" }),
        expect.objectContaining({ id: "copy-conversation-text" }),
        expect.objectContaining({ id: "move-conversation:5" }),
      ]),
    );
    expect(itemsForTarget({ kind: "message", messageId: 1 })).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mark-conversation-read" }),
      ]),
    );

    expect(itemsForTarget({ kind: "message", messageId: 4 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "delete-forever",
          label: strings.mail.deleteForever,
          danger: true,
        }),
      ]),
    );
    expect(unreadItems).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "delete-forever" }),
      ]),
    );
    const trashNewer = makeMessage({
      id: 8,
      mailboxId: trash.id,
      threadRoot: "<trash@example.test>",
      subject: "Old receipt",
    });
    const trashOlder = makeMessage({
      id: 9,
      mailboxId: trash.id,
      threadRoot: "<trash@example.test>",
      subject: "Older receipt",
    });
    useAppStore.setState((state) => ({
      messages: [...state.messages, trashNewer, trashOlder],
    }));
    expect(itemsForTarget({ kind: "message", messageId: 8 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "delete-conversation",
          label: strings.reader.deleteConversation,
          danger: true,
        }),
      ]),
    );
    expect(itemsForTarget({ kind: "message", messageId: 4 })).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "delete-conversation" }),
      ]),
    );
    expect(itemsForTarget({ kind: "message", messageId: 6 })).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "delete-conversation" }),
      ]),
    );

    expect(itemsForTarget({ kind: "folder", mailboxId: inbox.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "open" }),
        expect.objectContaining({
          id: "pin-folder",
          label: strings.contextMenu.pinMailbox,
        }),
      ]),
    );
    expect(itemsForTarget({ kind: "folder", mailboxId: inbox.id })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "hide-folder" })]),
    );
    expect(itemsForTarget({ kind: "folder", mailboxId: other.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "hide-folder",
          label: strings.contextMenu.hideMailbox,
        }),
      ]),
    );
    expect(itemsForTarget({ kind: "folder", mailboxId: trash.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "empty-trash", danger: true }),
      ]),
    );
    expect(itemsForTarget({ kind: "folder", mailboxId: junk.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "empty-junk", danger: true }),
      ]),
    );
    expect(itemsForTarget({ kind: "folder", mailboxId: other.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "rename-folder" }),
        expect.objectContaining({ id: "delete-folder", danger: true }),
      ]),
    );

    expect(itemsForTarget({ kind: "local-nav", view: "drafts" })).toEqual([
      expect.objectContaining({ id: "open" }),
    ]);
    expect(itemsForTarget({ kind: "draft", draftId: "d1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "open" }),
        expect.objectContaining({ id: "duplicate-draft", label: "Duplicate" }),
      ]),
    );
    expect(itemsForTarget({ kind: "snoozed", messageId: 1 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "open" }),
        expect.objectContaining({ id: "unsnooze" }),
      ]),
    );
    expect(itemsForTarget({ kind: "outbox", outboxId: "queued-1" })).toEqual([
      expect.objectContaining({ id: "open", label: strings.contextMenu.open }),
      expect.objectContaining({ id: "edit", label: strings.mail.editQueued }),
      expect.objectContaining({ id: "discard", danger: true }),
    ]);
    expect(itemsForTarget({ kind: "outbox", outboxId: "retry-1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "edit", label: strings.mail.editQueued }),
        expect.objectContaining({ id: "retry" }),
        expect.objectContaining({ id: "discard", danger: true }),
      ]),
    );
    expect(itemsForTarget({ kind: "outbox", outboxId: "copy-1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "retry-copy" }),
        expect.objectContaining({
          id: "discard",
          label: strings.mail.dismissWarning,
          danger: false,
        }),
      ]),
    );
    expect(itemsForTarget({ kind: "outbox", outboxId: "later-1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "send-now" }),
        expect.objectContaining({
          id: "discard",
          label: strings.mail.undoSend,
        }),
      ]),
    );
    expect(
      itemsForTarget({ kind: "link", href: "https://example.test" }),
    ).toEqual([
      expect.objectContaining({ id: "open-link" }),
      expect.objectContaining({ id: "copy-link" }),
    ]);
    expect(
      itemsForTarget({ kind: "mailto", href: "mailto:sam@example.test" }),
    ).toEqual([
      expect.objectContaining({ id: "open" }),
      expect.objectContaining({ id: "copy-address" }),
    ]);
    expect(
      itemsForTarget({
        kind: "attachment",
        attachmentId: "a1",
        previewable: true,
        filename: "photo.png",
      }),
    ).toEqual([
      expect.objectContaining({ id: "preview" }),
      expect.objectContaining({ id: "download" }),
    ]);
    expect(
      itemsForTarget({
        kind: "attachment",
        attachmentId: "a1",
        previewable: false,
        filename: "note.txt",
      }),
    ).toEqual([expect.objectContaining({ id: "download" })]);
    expect(
      itemsForTarget({ kind: "address", address: "sam@example.test" }),
    ).toEqual([
      expect.objectContaining({
        id: "compose-to-address",
        label: strings.reader.newMessageToAddress,
      }),
      expect.objectContaining({
        id: "messages-from-sender",
        label: strings.reader.messagesFromSender,
      }),
      expect.objectContaining({
        id: "messages-to-address",
        label: strings.reader.messagesToAddress,
      }),
      expect.objectContaining({
        id: "create-address-rule",
        label: strings.reader.createRuleForAddress,
      }),
      { type: "separator" },
      expect.objectContaining({ id: "copy-address" }),
    ]);
    expect(itemsForTarget({ kind: "address", address: "@@@" })).toEqual([
      expect.objectContaining({ id: "copy-address" }),
    ]);
    expect(itemsForTarget({ kind: "composer" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cut" }),
        expect.objectContaining({ id: "paste" }),
        expect.objectContaining({
          id: "paste-plain",
          label: strings.composer.pasteWithoutFormatting,
        }),
      ]),
    );
    expect(itemsForTarget({ kind: "editable" })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "paste-plain" })]),
    );
    expect(itemsForTarget({ kind: "composer-attachment", index: 0 })).toEqual([
      expect.objectContaining({ id: "remove-attachment" }),
    ]);
  });

  it("offers reply with attachments only when the message has a file", () => {
    const inbox = makeMailbox();
    const withFile = makeMessage({ hasAttachments: true });
    resetStore({ mailboxes: [inbox], messages: [withFile] });
    const fileIds = itemsForTarget({
      kind: "message",
      messageId: withFile.id,
    }).flatMap((item) => (item.type === "item" ? [item.id] : []));
    expect(fileIds).toContain("reply-with-attachments");
    expect(fileIds).toContain("reply-all-with-attachments");

    // Another domain: Block domain is hidden for the account's own domain.
    const plain = makeMessage({
      id: 2,
      hasAttachments: false,
      senderAddress: "jane@other.test",
    });
    resetStore({ mailboxes: [inbox], messages: [plain] });
    const plainIds = itemsForTarget({
      kind: "message",
      messageId: plain.id,
    }).flatMap((item) => (item.type === "item" ? [item.id] : []));
    expect(plainIds).toContain("copy-recipients");
    expect(plainIds).toContain("block-domain");
    expect(plainIds).toContain("save-eml");
    expect(plainIds).toContain("reply-bare");
    expect(plainIds).toContain("reply-all-bare");
    expect(plainIds).not.toContain("reply-with-attachments");
    expect(plainIds).not.toContain("reply-all-with-attachments");
  });

  it("offers unblock when this sender is already blocked", () => {
    const inbox = makeMailbox();
    const message = makeMessage({ senderAddress: "Jane@Example.test" });
    resetStore({ mailboxes: [inbox], messages: [message] });
    rememberBlockedSenders(message.accountId, [
      {
        id: "rule-1",
        accountId: message.accountId,
        name: "Block sender",
        field: "from",
        contains: "jane@example.test",
        action: "move_junk",
        enabled: true,
      },
    ]);
    const blocked = itemsForTarget({
      kind: "message",
      messageId: message.id,
    }).flatMap((item) => (item.type === "item" ? [item.id] : []));
    expect(blocked).toContain("unblock-sender");
    expect(blocked).not.toContain("block-sender");
    expect(senderDomain("Jane <Jane@Mail.Example.com>")).toBe(
      "mail.example.com",
    );
    expect(senderDomain("not-an-address")).toBeUndefined();
    rememberBlockedSenders(message.accountId, [
      {
        id: "rule-2",
        accountId: message.accountId,
        name: "Block example.com",
        field: "domain",
        contains: "example.com",
        action: "move_junk",
        enabled: true,
      },
    ]);
    expect(domainIsBlocked(message.accountId, "a@mail.example.com")).toBe(true);
    expect(domainIsBlocked(message.accountId, "a@example.com.evil.test")).toBe(
      false,
    );
    const covered = makeMessage({
      id: 3,
      senderAddress: "jane@mail.example.com",
    });
    resetStore({ mailboxes: [inbox], messages: [covered] });
    rememberBlockedSenders(covered.accountId, [
      {
        id: "rule-2",
        accountId: covered.accountId,
        name: "Block example.com",
        field: "domain",
        contains: "example.com",
        action: "move_junk",
        enabled: true,
      },
    ]);
    const domainBlocked = itemsForTarget({
      kind: "message",
      messageId: covered.id,
    }).flatMap((item) => (item.type === "item" ? [item.id] : []));
    expect(domainBlocked).toContain("unblock-domain");
    expect(domainBlocked).not.toContain("block-domain");

    resetStore({ mailboxes: [inbox], messages: [message] });
    clearBlockedSenders();
    const open = itemsForTarget({
      kind: "message",
      messageId: message.id,
    }).flatMap((item) => (item.type === "item" ? [item.id] : []));
    expect(open).toContain("block-sender");
    expect(open).not.toContain("unblock-sender");
  });

  it("treats a busy outbox row as disabled even without CSS.escape", () => {
    const css = globalThis.CSS;
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: undefined,
    });
    const node = document.createElement("button");
    node.dataset.context = "outbox";
    node.dataset.outboxId = "busy-1";
    node.dataset.busy = "true";
    document.body.appendChild(node);
    resetStore({
      outbox: [
        {
          id: "busy-1",
          accountId: account.id,
          recipients: "lee@example.test",
          subject: "Busy",
          state: "queued",
          createdAt: "2026-08-18T11:00:00Z",
        },
      ],
    });
    expect(itemsForTarget({ kind: "outbox", outboxId: "busy-1" })).toEqual([
      expect.objectContaining({ id: "open" }),
      expect.objectContaining({ id: "edit", disabled: true }),
      expect.objectContaining({ id: "discard", disabled: true }),
    ]);
    node.remove();
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: css,
    });
  });
});
