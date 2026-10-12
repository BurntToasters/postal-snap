import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { AttachmentPreviewDialog } from "../components/reader/attachmentList";
import {
  MessageBody,
  PlainTextContent,
} from "../components/reader/messageBody";
import { strings } from "../i18n";
import {
  buildConversationPrintDocument,
  buildPrintDocument,
  collapseQuotedMail,
  countTextMatches,
  scrollRoom,
  escapePrint,
  htmlToPlainText,
  hydrateInlineImages,
  readableMessageText,
  recipientLines,
  moveCounts,
  normalizeContentId,
  readReceiptState,
} from "../components/reader/readerUtils";
import { sanitizeReceivedHtml } from "../security";
import { makeMailbox, makeMessage, messageDetail } from "./helpers/fixtures";

afterEach(() => vi.restoreAllMocks());

describe("reader scroll", () => {
  it("reports remaining room and stays quiet before layout", () => {
    expect(scrollRoom(0, 0, 0, 1)).toBeNull();
    expect(scrollRoom(0, 800, 0, 1)).toBeNull();
    expect(scrollRoom(100, 1000, 400, 1)).toBe(500);
    expect(scrollRoom(600, 1000, 400, 1)).toBe(0);
    expect(scrollRoom(80, 1000, 400, -1)).toBe(80);
    expect(scrollRoom(0, 1000, 400, -1)).toBe(0);
  });
});

describe("find matches", () => {
  it("counts words in the message and ignores a missing word", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>See Saturday morning. Saturday plans.</p>";
    expect(countTextMatches(root, "saturday")).toBe(2);
    expect(countTextMatches(root, "missing")).toBe(0);
    expect(countTextMatches(root, "  ")).toBe(0);
  });
});

describe("recipient lines", () => {
  it("keeps To and Cc once, in order", () => {
    expect(
      recipientLines(
        [" Sam@Example.test ", "", "sam@example.test"],
        ["Copy@Example.test", "sam@example.test"],
      ),
    ).toBe("Sam@Example.test\nCopy@Example.test");
    expect(
      recipientLines(
        ["sam@example.test"],
        [],
        ["hidden@example.test", "sam@example.test"],
      ),
    ).toBe("sam@example.test\nhidden@example.test");
    expect(recipientLines([], [])).toBe("");
  });
});

describe("plain text from HTML", () => {
  it("keeps paragraphs and drops hidden markup", () => {
    expect(htmlToPlainText("<p>Hello <b>there</b></p><p>Next</p>")).toBe(
      "Hello there\nNext",
    );
    expect(htmlToPlainText("<script>alert(1)</script><p>Ok</p>")).toBe("Ok");
  });

  it("copies the plain part, or the sanitized HTML when there is none", () => {
    expect(
      readableMessageText({
        textBody: "Hello\r\nthere",
        htmlBody: "<p>Ignored</p>",
      }),
    ).toBe("Hello\nthere");
    expect(
      readableMessageText({
        textBody: "  ",
        htmlBody: "<p>Hello <b>there</b></p><script>alert(1)</script>",
      }),
    ).toBe("Hello there");
    expect(readableMessageText({ textBody: "", htmlBody: null })).toBe("");
    expect(
      readableMessageText({
        textBody: "",
        htmlBody: "<script>alert(1)</script>",
      }),
    ).toBe("");
  });
});

describe("quoted replies", () => {
  it("tucks a trailing reply away and leaves the new text visible", () => {
    const html = collapseQuotedMail(
      "<p>Thanks, I will send it tomorrow.</p><p>On Tuesday, Jane wrote:</p><blockquote><p>Can you send the notes before Friday morning?</p></blockquote>",
      "Quoted text",
    );
    expect(html).toContain("Thanks, I will send it tomorrow.");
    expect(html).toContain("<details");
    expect(html).toContain("Quoted text");
    expect(html.indexOf("Thanks, I will send it tomorrow.")).toBeLessThan(
      html.indexOf("<details"),
    );
    expect(html).toContain("On Tuesday, Jane wrote:");
    expect(html).toContain("Can you send the notes before Friday morning?");
  });

  it("leaves a message that is only a quote, a short quote, and a middle quote alone", () => {
    const only =
      "<blockquote><p>The whole forwarded note stays on screen for the reader.</p></blockquote>";
    expect(collapseQuotedMail(only, "Quoted text")).toBe(only);
    const short = "<p>See this.</p><blockquote>Yes</blockquote>";
    expect(collapseQuotedMail(short, "Quoted text")).toBe(short);
    const middle =
      "<p>Intro</p><blockquote>A pull quote that sits in the middle of the letter.</blockquote><p>The letter continues after it.</p>";
    expect(collapseQuotedMail(middle, "Quoted text")).toBe(middle);
  });

  it("collapses a Gmail quote wrapped around the reply", () => {
    const html = collapseQuotedMail(
      '<div><div>Here is my reply to the thread.</div><div class="gmail_quote"><blockquote>The earlier discussion was much longer than this line.</blockquote></div></div>',
      "Quoted text",
    );
    expect(html).toContain("Here is my reply to the thread.");
    expect(html).toContain("gmail_quote");
    expect(html).toContain("<details");
  });
});

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
      onFindPrevious: vi.fn(),
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
      onFindPrevious: vi.fn(),
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
    rerender(
      <MessageBody
        {...props}
        showHtml={false}
        plainText="Only the selection"
        message={messageDetail(makeMessage(), {
          textBody: "",
          htmlBody: "<p>HTML</p>",
        })}
      />,
    );
    expect(screen.getByText("Only the selection")).toBeVisible();
    expect(screen.queryByTitle(/Message content/i)).not.toBeInTheDocument();
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

  it("prints a conversation oldest first, one message per page", () => {
    const older = messageDetail(
      makeMessage({
        id: 2,
        subject: "Older note",
        receivedAt: "2026-08-17T12:00:00Z",
      }),
      { textBody: "Earlier" },
    );
    const newer = messageDetail(makeMessage({ id: 1, subject: "Newer note" }), {
      textBody: "Later",
    });
    const html = buildConversationPrintDocument(
      [
        { message: older, htmlBody: "<p>Earlier letter</p>" },
        { message: newer },
      ],
      1,
    );
    expect(html.indexOf("Older note")).toBeLessThan(html.indexOf("Newer note"));
    expect(html).toContain("<p>Earlier letter</p>");
    expect(html).toContain("Later");
    expect(html).toContain("break-before:page");
    expect(html).toContain("Content-Security-Policy");
  });
});

describe("read receipt prompt", () => {
  const account = {
    email: "sam@example.test",
    aliases: ["alias@example.test"],
  };
  const message = {
    dispositionTo: "jane@example.com",
    senderAddress: "jane@example.com",
    receiptChoice: "",
  };

  it("asks, remembers a sent receipt, and stays quiet for your own mail", () => {
    expect(readReceiptState(message, account, "inbox")).toBe("ask");
    expect(
      readReceiptState({ ...message, receiptChoice: "sent" }, account, "inbox"),
    ).toBe("sent");
    expect(
      readReceiptState(
        { ...message, receiptChoice: "declined" },
        account,
        "inbox",
      ),
    ).toBeNull();
    expect(
      readReceiptState(
        { ...message, senderAddress: "sam@example.test" },
        account,
        "inbox",
      ),
    ).toBeNull();
    expect(
      readReceiptState(
        { ...message, dispositionTo: "alias@example.test" },
        account,
        "inbox",
      ),
    ).toBeNull();
    expect(readReceiptState(message, account, "sent")).toBeNull();
  });
});

describe("file preview zoom", () => {
  const image = {
    filename: "family.png",
    contentType: "image/png",
    size: 128,
    text: null,
    imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
  };

  it("enlarges a picture and leaves a text file at its own size", () => {
    const view = render(
      <AttachmentPreviewDialog
        preview={image}
        onDownload={() => undefined}
        onClose={() => undefined}
      />,
    );
    const picture = screen.getByRole("img", { name: "family.png" });
    expect(picture).toHaveAttribute("data-zoom", "1");
    expect(
      screen.getByRole("button", { name: strings.reader.zoomOut }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.zoomIn }),
    );
    expect(picture).toHaveAttribute("data-zoom", "1.5");
    expect(picture).toHaveStyle({ width: "150%" });
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.zoomOut }),
    );
    expect(picture).toHaveAttribute("data-zoom", "1");

    view.rerender(
      <AttachmentPreviewDialog
        preview={{
          filename: "notes.txt",
          contentType: "text/plain",
          size: 64,
          text: "Bring the salad.",
          imageDataUrl: null,
        }}
        onDownload={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: strings.reader.zoomIn }),
    ).toBeNull();
  });
});
