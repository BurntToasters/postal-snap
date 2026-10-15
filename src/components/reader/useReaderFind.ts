import type { Dispatch, RefObject, SetStateAction } from "react";
import { strings } from "../../i18n";
import { countTextMatches, scrollRoom, selectTextMatch } from "./readerUtils";

interface Options {
  frame: RefObject<HTMLIFrameElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  neighborRef: RefObject<{ onNext?: () => void; onPrevious?: () => void }>;
  findQuery: string;
  findIndex: number;
  setFindIndex: Dispatch<SetStateAction<number>>;
  setFindStatus: Dispatch<SetStateAction<string>>;
}

export function useReaderFind({
  frame,
  bodyRef,
  neighborRef,
  findQuery,
  findIndex,
  setFindIndex,
  setFindStatus,
}: Options) {
  function scrollMessage(direction: 1 | -1) {
    const amount = Math.round(window.innerHeight * 0.85) * direction;
    const frameWindow = frame.current?.contentWindow;
    const scrolling = frameWindow
      ? (frameWindow.document.scrollingElement ??
        frameWindow.document.documentElement)
      : null;
    const body = bodyRef.current;
    const room = scrolling
      ? scrollRoom(
          frameWindow?.scrollY || scrolling.scrollTop,
          scrolling.scrollHeight,
          frameWindow?.innerHeight ?? 0,
          direction,
        )
      : body
        ? scrollRoom(
            body.scrollTop,
            body.scrollHeight,
            body.clientHeight,
            direction,
          )
        : null;
    if (room === null || room > 2) {
      if (frameWindow) frameWindow.scrollBy(0, amount);
      else body?.scrollBy?.({ top: amount, behavior: "auto" });
      return;
    }
    if (direction > 0) neighborRef.current.onNext?.();
    else neighborRef.current.onPrevious?.();
  }

  function findInMessage(direction: 1 | -1 = 1) {
    const query = findQuery.trim();
    if (!query) {
      setFindStatus("");
      return;
    }
    const liveBody = frame.current?.contentDocument?.body;
    const root =
      liveBody && liveBody.textContent?.trim()
        ? liveBody
        : frame.current?.srcdoc
          ? new DOMParser().parseFromString(frame.current.srcdoc, "text/html")
              .body
          : bodyRef.current;
    const total = root ? countTextMatches(root, query) : 0;
    if (!root || total === 0) {
      setFindIndex(0);
      setFindStatus(strings.reader.findNoMatches);
      return;
    }
    const next =
      findIndex === 0 && direction < 0
        ? total
        : findIndex === 0
          ? 1
          : ((findIndex - 1 + direction + total) % total) + 1;
    setFindIndex(next);
    setFindStatus(strings.reader.findMatchCount(next, total));
    selectTextMatch(root, query, next);
  }

  return { scrollMessage, findInMessage };
}
