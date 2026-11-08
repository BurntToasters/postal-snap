import { useEffect, useRef, type RefObject } from "react";
import { api } from "../../api";
import { parseMailto } from "../../mailto";
import { differentLinkAddress } from "../../security";
import { useAppStore } from "../../store";

// Routes links the sandboxed message frame reports natively (WebKit clicks).
export function useFrameLinks(
  frame: RefObject<HTMLIFrameElement | null>,
  onExternalLink: (url: string, linkText?: string) => Promise<void>,
): void {
  const onExternalLinkRef = useRef(onExternalLink);
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern
  onExternalLinkRef.current = onExternalLink;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    // Native clicks carry no link text, so take it from the matching anchor.
    const frameLinkText = (url: string): string | undefined => {
      const doc = frame.current?.contentDocument;
      let target: string;
      try {
        target = new URL(url).href;
      } catch {
        return undefined;
      }
      for (const link of doc?.querySelectorAll<HTMLAnchorElement>("a") ?? []) {
        const candidate =
          link.getAttribute("data-external-href")?.trim() ||
          link.getAttribute("href")?.trim() ||
          "";
        let resolved: string;
        try {
          resolved = new URL(candidate, doc?.baseURI).href;
        } catch {
          continue;
        }
        const text = link.textContent ?? "";
        if (resolved === target && differentLinkAddress(text, url)) return text;
      }
      return undefined;
    };
    void api
      .onFrameLink((url) => {
        if (/^https?:\/\//i.test(url))
          void onExternalLinkRef.current(url, frameLinkText(url));
        else if (/^mailto:/i.test(url))
          useAppStore.getState().openComposer({ prefill: parseMailto(url) });
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [frame]);
}
