/* eslint-disable react-hooks/immutability, react-hooks/exhaustive-deps -- refs arrive as params; code moved verbatim. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  IFRAME_CONTEXT_EVENT,
  type IframeContextMenuDetail,
} from "../../contextMenu";
import { strings } from "../../i18n";
import {
  rememberedLetterScroll,
  rememberLetterScroll,
} from "../../letterScroll";
import { parseMailto } from "../../mailto";
import { markHtmlText, textHighlightTerms } from "../../searchHighlight";
import {
  differentLinkAddress,
  hasAuthorColors,
  messageFrameDocument,
  withFrameLinks,
  type SanitizedMail,
} from "../../security";
import type { AppSettings, Attachment, MessageDetail } from "../../types";
import { collapseQuotedMail, hydrateInlineImages } from "./readerUtils";

/** Smallest shrink-to-fit scale before wide mail scrolls sideways. */
const MIN_FIT_ZOOM = 0.6;

interface Options {
  frame: RefObject<HTMLIFrameElement | null>;
  contentOperation: RefObject<number>;
  message: MessageDetail | undefined;
  messageId: number | undefined;
  messageAccountId: string | undefined;
  sanitized: SanitizedMail | undefined;
  currentLoadedHtml: string | undefined;
  inlineAttachments: Attachment[];
  setLoadedHtml: Dispatch<
    SetStateAction<{ messageId: number; html: string } | undefined>
  >;
  searchQuery: string | undefined;
  settings: AppSettings;
  isDark: boolean;
  handleExternalLink: (url: string, linkText?: string) => Promise<void>;
  openComposer: (seed?: { prefill?: ReturnType<typeof parseMailto> }) => void;
}

export function useMessageFrame({
  frame,
  contentOperation,
  message,
  messageId,
  messageAccountId,
  sanitized,
  currentLoadedHtml,
  inlineAttachments,
  setLoadedHtml,
  searchQuery,
  settings,
  isDark,
  handleExternalLink,
  openComposer,
}: Options) {
  const frameSource = currentLoadedHtml ?? sanitized?.html ?? "";
  const frameHtml = useMemo(
    () =>
      messageFrameDocument(
        collapseQuotedMail(
          markHtmlText(
            withFrameLinks(frameSource),
            textHighlightTerms(searchQuery ?? ""),
          ),
          strings.reader.quotedText,
        ),
        settings.textScale,
        // Colorless mail follows dark mode; designed mail keeps its page.
        isDark && !hasAuthorColors(frameSource),
      ) +
      // Identical bodies must still reload, so the frame gets its link wiring.
      `<!-- ${messageId ?? ""} -->`,
    [frameSource, isDark, messageId, searchQuery, settings.textScale],
  );

  useEffect(() => {
    contentOperation.current += 1;
  }, [messageId]);

  useEffect(() => {
    const operation = ++contentOperation.current;
    if (
      !messageId ||
      !messageAccountId ||
      !sanitized ||
      inlineAttachments.length === 0
    )
      return;
    const doc = new DOMParser().parseFromString(sanitized.html, "text/html");
    void hydrateInlineImages(
      doc,
      messageAccountId,
      messageId,
      inlineAttachments,
    ).then(() => {
      if (contentOperation.current === operation)
        setLoadedHtml({ messageId, html: doc.body.innerHTML });
    });
    return () => {
      if (contentOperation.current === operation) contentOperation.current += 1;
    };
  }, [inlineAttachments, messageAccountId, messageId, sanitized]);

  const frameLinkCleanup = useRef<(() => void) | undefined>(undefined);

  // Shrink fixed-width mail to the pane, like other mail apps, but never
  // below a readable size; past that it scrolls sideways.
  const fitFrameContent = useCallback(() => {
    const iframe = frame.current;
    const doc = iframe?.contentDocument;
    if (!doc?.body || !iframe) return;
    doc.body.style.zoom = "";
    const header = iframe
      .closest(".reader-pane")
      ?.querySelector(".message-header");
    if (header instanceof HTMLElement) {
      const style = getComputedStyle(header);
      doc.body.style.marginLeft = style.paddingLeft;
      doc.body.style.marginRight = style.paddingRight;
    }
    const root = doc.documentElement;
    const available = root.clientWidth;
    const needed = root.scrollWidth;
    if (available > 0 && needed > available + 1) {
      const zoom = Math.max(MIN_FIT_ZOOM, available / needed);
      doc.body.style.zoom = String(Math.floor(zoom * 100) / 100);
    }
  }, []);

  useEffect(() => {
    const node = frame.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitFrameContent());
    observer.observe(node);
    return () => observer.disconnect();
  }, [fitFrameContent, frameHtml]);

  function wireFrameLinks() {
    frameLinkCleanup.current?.();
    frameLinkCleanup.current = undefined;
    const doc = frame.current?.contentDocument;
    const body = doc?.body;
    if (!doc || !body) return;
    body.querySelectorAll("[usemap]").forEach((element) => {
      element.removeAttribute("usemap");
    });
    const linkSelector = "a[href], a[data-external-href], area[href]";
    const handleLink = (event: MouseEvent) => {
      if (event.button > 1) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        linkSelector,
      );
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const marked = target.getAttribute("data-external-href")?.trim() ?? "";
      const href = target.getAttribute("href")?.trim() ?? "";
      const url = /^https?:/i.test(marked)
        ? marked
        : /^https?:/i.test(href)
          ? href
          : /^mailto:/i.test(href)
            ? href
            : "";
      if (/^https?:/i.test(url)) {
        void handleExternalLink(url, target.textContent ?? "");
        return;
      }
      if (/^mailto:/i.test(url)) openComposer({ prefill: parseMailto(url) });
    };
    const blockNativeOpen = (event: MouseEvent) => {
      event.preventDefault();
      const iframe = frame.current;
      if (!iframe) return;
      const rect = iframe.getBoundingClientRect();
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        linkSelector,
      );
      const marked = target?.getAttribute("data-external-href")?.trim() ?? "";
      const href = target?.getAttribute("href")?.trim() ?? "";
      const url = /^https?:/i.test(marked)
        ? marked
        : /^https?:/i.test(href)
          ? href
          : /^mailto:/i.test(href)
            ? href
            : /^mailto:/i.test(marked)
              ? marked
              : "";
      const detail: IframeContextMenuDetail = {
        x: event.clientX + rect.left,
        y: event.clientY + rect.top,
      };
      if (/^https?:/i.test(url)) {
        detail.href = url;
        const text = differentLinkAddress(target?.textContent ?? "", url);
        if (text) detail.text = text;
      } else if (/^mailto:/i.test(url)) detail.mailto = url;
      window.dispatchEvent(
        new CustomEvent<IframeContextMenuDetail>(IFRAME_CONTEXT_EVENT, {
          detail,
        }),
      );
    };
    const forwardKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const key = event.key;
      const readingKey =
        key === "j" ||
        key === "k" ||
        key === "n" ||
        key === "p" ||
        key === "r" ||
        key === "a" ||
        key === "i" ||
        key === "]" ||
        key === "[" ||
        key === "ArrowDown" ||
        key === "ArrowUp" ||
        key === "Home" ||
        key === "End" ||
        key === "Delete" ||
        key === " ";
      if (!readingKey) return;
      event.preventDefault();
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: event.key,
          code: event.code,
          shiftKey: event.shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    body.addEventListener("click", handleLink);
    body.addEventListener("auxclick", handleLink);
    doc.addEventListener("contextmenu", blockNativeOpen, true);
    doc.addEventListener("keydown", forwardKey);
    const scrolling = doc.scrollingElement ?? doc.documentElement;
    const letterId = message?.id;
    const onLetterScroll = (event: Event) => {
      if (letterId == null) return;
      const top = scrolling.scrollTop;
      if (top <= 0 && !event.isTrusted) return;
      rememberLetterScroll(letterId, top);
    };
    if (letterId != null) {
      const top = rememberedLetterScroll(letterId);
      if (top > 0) scrolling.scrollTop = top;
    }
    scrolling.addEventListener("scroll", onLetterScroll);
    frameLinkCleanup.current = () => {
      body.removeEventListener("click", handleLink);
      body.removeEventListener("auxclick", handleLink);
      doc.removeEventListener("contextmenu", blockNativeOpen, true);
      doc.removeEventListener("keydown", forwardKey);
      scrolling.removeEventListener("scroll", onLetterScroll);
    };
  }

  useEffect(
    () => () => {
      frameLinkCleanup.current?.();
    },
    [],
  );

  useLayoutEffect(() => {
    const letterId = message?.id;
    return () => {
      // Read at cleanup on purpose: the frame may mount after this effect runs.
      const doc = frame.current?.contentDocument;
      const scrolling = doc?.scrollingElement ?? doc?.documentElement;
      if (letterId != null && scrolling && scrolling.scrollTop > 0) {
        rememberLetterScroll(letterId, scrolling.scrollTop);
      }
      frameLinkCleanup.current?.();
      frameLinkCleanup.current = undefined;
    };
  }, [message?.id]);

  return { frameSource, frameHtml, fitFrameContent, wireFrameLinks };
}
