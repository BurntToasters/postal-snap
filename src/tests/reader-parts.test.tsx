import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import {
  MessageBody,
  PlainTextContent,
} from "../components/reader/messageBody";
import {
  buildPrintDocument,
  escapePrint,
  hydrateInlineImages,
  moveCounts,
  normalizeContentId,
} from "../components/reader/readerUtils";
import { sanitizeReceivedHtml } from "../security";
import { makeMailbox, makeMessage, messageDetail } from "./helpers/fixtures";

afterEach(() => vi.restoreAllMocks());

describe("plain message content", () => {
  it("links web addresses, mailto links, and bare email addresses", () => {
    const onOpenLink = vi.fn();
    const onOpenMailto = vi.fn();
    render(
      <PlainTextContent
        text="Visit https://example.test/path, mailto:one@example.test or two@example.test!"
        onOpenLink={onOpenLink}
        onOpenMailto={onOpenMailto}
      />,
    );
    const web = screen.getByRole("link", {
      name: "https://example.test/path",
    });
    const firstMail = screen.getByRole("link", { name: "one@example.test" });
    const secondMail = screen.getByRole("link", { name: "two@example.test" });
    fireEvent.click(web);
    fireEvent(web, new MouseEvent("auxclick", { bubbles: true }));
    fireEvent.contextMenu(web);
    fireEvent.click(firstMail);
    fireEvent(secondMail, new MouseEvent("auxclick", { bubbles: true }));
    fireEvent.contextMenu(firstMail);
    expect(onOpenLink).toHaveBeenCalledTimes(2);
    expect(onOpenMailto).toHaveBeenCalledWith("mailto:one@example.test");
    expect(onOpenMailto).toHaveBeenCalledWith("mailto:two@example.test");
  });
});

describe("message body states", () => {
  const message = messageDetail(makeMessage(), { textBody: "Plain body" });

  it("operates image banners and in-message find", () => {
    const callbacks = {
      onFindQueryChange: vi.fn(),
      onCloseFind: vi.fn(),
      onSubmitFind: vi.fn(),
      onLoadImages: vi.fn(),
      onFrameLoad: vi.fn(),
      onOpenLink: vi.fn(),
      onOpenMailto: vi.fn(),
    };
    render(
      <MessageBody
        message={message}
        sanitized={sanitizeReceivedHtml(
          '<img src="https://example.test/image.png">',
        )}
        currentLoadedHtml="previous"
        frameHtml="<p>Body</p>"
        filteredImages={2}
        threatImages={1}
        remainingBlockedImages={1}
        loadingImages={false}
        findOpen
        findQuery="needle"
        findInputRef={createRef()}
        bodyRef={createRef()}
        frameRef={createRef()}
        {...callbacks}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Retry loading images/i }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /Find in message/i }),
      {
        target: { value: "next" },
      },
    );
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(callbacks.onLoadImages).toHaveBeenCalled();
    expect(callbacks.onFindQueryChange).toHaveBeenCalledWith("next");
    expect(callbacks.onSubmitFind).toHaveBeenCalled();
    expect(callbacks.onCloseFind).toHaveBeenCalled();
  });

  it("renders loading, empty, oversized, HTML, and plain states", () => {
    const props = {
      currentLoadedHtml: undefined,
      frameHtml: "<p>HTML</p>",
      filteredImages: 0,
      threatImages: 0,
      remainingBlockedImages: 0,
      loadingImages: false,
      findOpen: false,
      findQuery: "",
      findInputRef: createRef<HTMLInputElement>(),
      bodyRef: createRef<HTMLDivElement>(),
      frameRef: createRef<HTMLIFrameElement>(),
      onFindQueryChange: vi.fn(),
      onCloseFind: vi.fn(),
      onSubmitFind: vi.fn(),
      onLoadImages: vi.fn(),
      onFrameLoad: vi.fn(),
      onOpenLink: vi.fn(),
      onOpenMailto: vi.fn(),
    };
    const { rerender } = render(
      <MessageBody
        {...props}
        message={message}
        sanitized={sanitizeReceivedHtml(
          '<img src="https://example.test/image.png">',
        )}
        remainingBlockedImages={1}
        loadingImages
      />,
    );
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();

    rerender(
      <MessageBody
        {...props}
        message={messageDetail(makeMessage(), { textBody: "", htmlBody: null })}
      />,
    );
    expect(screen.getByRole("note")).toBeVisible();
    rerender(
      <MessageBody
        {...props}
        message={messageDetail(makeMessage({ size: 60 * 1024 * 1024 }), {
          textBody: "",
          htmlBody: null,
        })}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(/too large/i);
    rerender(
      <MessageBody
        {...props}
        message={messageDetail(makeMessage(), { htmlBody: "<p>HTML</p>" })}
      />,
    );
    fireEvent.load(screen.getByTitle(/Message content/i));
    expect(props.onFrameLoad).toHaveBeenCalled();
    rerender(<MessageBody {...props} message={message} />);
    expect(screen.getByText("Plain body")).toBeVisible();
  });
});

describe("reader utilities", () => {
  it("updates source and destination counts without going negative", () => {
    const mailboxes = [
      makeMailbox({ unreadCount: 0, totalCount: 0 }),
      makeMailbox({ id: 2, role: "archive", unreadCount: 1, totalCount: 3 }),
    ];
    const unread = makeMessage({ mailboxId: 1, isRead: false });
    expect(moveCounts(mailboxes, messageDetail(unread), 2)).toEqual([
      expect.objectContaining({ totalCount: 0, unreadCount: 0 }),
      expect.objectContaining({ totalCount: 4, unreadCount: 2 }),
    ]);
    expect(
      moveCounts(mailboxes, messageDetail({ ...unread, isRead: true })),
    ).toEqual([
      expect.objectContaining({ totalCount: 0, unreadCount: 0 }),
      mailboxes[1],
    ]);
  });

  it("hydrates matching CID images and tolerates failures", async () => {
    const document = new DOMParser().parseFromString(
      '<img data-inline-cid="cid:&lt;one&gt;"><img data-inline-cid="two"><img data-inline-cid="missing">',
      "text/html",
    );
    vi.spyOn(api, "readMessageInlineImage")
      .mockResolvedValueOnce("data:image/png;base64,one")
      .mockRejectedValueOnce(new Error("broken"));
    await hydrateInlineImages(document, "account-1", 1, [
      {
        id: "first",
        filename: "one.png",
        contentType: "image/png",
        size: 1,
        inline: true,
        contentId: "<one>",
      },
      {
        id: "second",
        filename: "two.png",
        contentType: "image/png",
        size: 1,
        inline: true,
        contentId: "two",
      },
    ]);
    const images = [...document.querySelectorAll("img")];
    expect(images[0].src).toContain("data:image/png");
    expect(images[0].hasAttribute("data-inline-cid")).toBe(false);
    expect(images[1].getAttribute("data-inline-cid")).toBe("two");
    expect(images[2].getAttribute("data-inline-cid")).toBe("missing");
  });

  it("escapes headers, normalizes CIDs, and builds both print bodies", () => {
    expect(escapePrint('<&">')).toBe("&lt;&amp;&quot;&gt;");
    expect(normalizeContentId(" CID:<One> ")).toBe("One");
    const named = messageDetail(makeMessage(), {
      senderName: "Jane & Co",
      to: [],
      cc: ["copy@example.test"],
      subject: "",
      textBody: "<plain>",
    });
    const plain = buildPrintDocument(named, undefined, 1.5);
    expect(plain).toContain("Jane &amp; Co");
    expect(plain).toContain("&lt;plain&gt;");
    const html = buildPrintDocument(
      { ...named, senderName: "", senderAddress: "sender@example.test" },
      { messageId: named.id, html: "<p>Loaded</p>" },
      1,
    );
    expect(html).toContain("<p>Loaded</p>");
    expect(html).toContain("sender@example.test");
  });
});
