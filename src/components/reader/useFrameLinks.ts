import { useEffect, useRef, type RefObject } from "react";
import { parseMailto } from "../../mailto";
import { useAppStore } from "../../store";
import { registerFrameLinkSink } from "../frameLinkRouter";

// Registers the reader as the target for native frame clicks when no viewer is open.
export function useFrameLinks(
  frame: RefObject<HTMLIFrameElement | null>,
  onExternalLink: (url: string, linkText?: string) => Promise<void>,
): void {
  const onExternalLinkRef = useRef(onExternalLink);
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern
  onExternalLinkRef.current = onExternalLink;

  useEffect(
    () =>
      registerFrameLinkSink("reader", {
        frame,
        openExternal: (url, linkText) =>
          onExternalLinkRef.current(url, linkText),
        openMailto: (url) =>
          useAppStore.getState().openComposer({ prefill: parseMailto(url) }),
      }),
    [frame],
  );
}
