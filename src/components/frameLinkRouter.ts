import { useEffect, type RefObject } from "react";
import { api } from "../api";
import { differentLinkAddress } from "../security";

// The sandboxed frame cannot run scripts, so WebKit reports its clicks natively.
// One app-level listener routes each click to the frame on top: the viewer, then the reader.
export interface FrameLinkSink {
  frame: RefObject<HTMLIFrameElement | null>;
  openExternal: (url: string, linkText?: string) => Promise<unknown>;
  openMailto: (url: string) => void;
}

export type FrameLinkOwner = "viewer" | "reader";

const OWNER_ORDER: FrameLinkOwner[] = ["viewer", "reader"];
const sinks = new Map<FrameLinkOwner, FrameLinkSink>();

/** Returns the unregister function. A stale unregister never removes a newer sink. */
export function registerFrameLinkSink(
  owner: FrameLinkOwner,
  sink: FrameLinkSink,
): () => void {
  sinks.set(owner, sink);
  return () => {
    if (sinks.get(owner) === sink) sinks.delete(owner);
  };
}

// Native clicks carry no link text, so take it from the matching anchor in that frame.
export function frameLinkText(
  frame: RefObject<HTMLIFrameElement | null>,
  url: string,
): string | undefined {
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
}

export function routeFrameLink(url: string): void {
  const owner = OWNER_ORDER.find((name) => sinks.has(name));
  const sink = owner ? sinks.get(owner) : undefined;
  if (!sink) return;
  if (/^https?:\/\//i.test(url)) {
    void sink.openExternal(url, frameLinkText(sink.frame, url));
  } else if (/^mailto:/i.test(url)) {
    sink.openMailto(url);
  }
}

/** Mounted once by App. Frame clicks reach the router whatever screen is up. */
export function useFrameLinkRouter(): void {
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void api.onFrameLink(routeFrameLink).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
}
