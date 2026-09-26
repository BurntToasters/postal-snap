import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

export interface ComposerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_WIDTH = 480;
const MIN_HEIGHT = 360;
/** Part of the header that must stay on screen to drag it back. */
const KEEP_VISIBLE = 80;
const HEADER_FALLBACK = 56;
const KEY_STEP = 24;

function clampRect(
  rect: ComposerRect,
  layerW: number,
  layerH: number,
  headerH = HEADER_FALLBACK,
) {
  const w = Math.min(Math.max(rect.w, Math.min(MIN_WIDTH, layerW)), layerW);
  const h = Math.min(Math.max(rect.h, Math.min(MIN_HEIGHT, layerH)), layerH);
  const x = Math.min(Math.max(rect.x, KEEP_VISIBLE - w), layerW - KEEP_VISIBLE);
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, layerH - headerH));
  return { x, y, w, h };
}

function clampSize(rect: ComposerRect, layerW: number, layerH: number) {
  const maxW = Math.max(
    layerW - Math.max(rect.x, 0),
    Math.min(MIN_WIDTH, layerW),
  );
  const maxH = Math.max(
    layerH - Math.max(rect.y, 0),
    Math.min(MIN_HEIGHT, layerH),
  );
  return {
    ...rect,
    w: Math.min(Math.max(rect.w, Math.min(MIN_WIDTH, layerW)), maxW),
    h: Math.min(Math.max(rect.h, Math.min(MIN_HEIGHT, layerH)), maxH),
  };
}

const interactive = "button, input, select, textarea, a, [role='button']";

/**
 * Lets the floating composer move by its header and resize by a corner grip,
 * inside the app window. Disabled while maximized or full-window.
 */
export function useComposerPlacement(
  windowRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [rect, setRect] = useState<ComposerRect | null>(null);
  /** Last known app area; updated on window resize and gesture start. */
  const [layer, setLayer] = useState<{
    w: number;
    h: number;
    headerH: number;
  } | null>(null);
  const gesture = useRef<{
    kind: "move" | "resize";
    startX: number;
    startY: number;
    start: ComposerRect;
  } | null>(null);

  const layerSize = useCallback(() => {
    const layer = windowRef.current?.parentElement;
    const bounds = layer?.getBoundingClientRect();
    const node = windowRef.current;
    const header = node?.querySelector(":scope > header");
    // Header bottom relative to the window edge, including its border.
    const headerH =
      header && node
        ? header.getBoundingClientRect().bottom -
          node.getBoundingClientRect().top
        : HEADER_FALLBACK;
    return {
      w: bounds?.width ?? 0,
      h: bounds?.height ?? 0,
      headerH: headerH || HEADER_FALLBACK,
      bounds,
    };
  }, [windowRef]);

  // Clamped at render, so a window that shrank while maximized or narrow
  // still restores on screen.
  const placedRect =
    rect && layer && layer.w > 0 && layer.h > 0
      ? clampRect(rect, layer.w, layer.h, layer.headerH)
      : rect;

  const currentRect = useCallback((): ComposerRect | null => {
    if (placedRect) return placedRect;
    const node = windowRef.current;
    const { bounds } = layerSize();
    if (!node || !bounds) return null;
    const own = node.getBoundingClientRect();
    return {
      x: own.left - bounds.left,
      y: own.top - bounds.top,
      w: own.width,
      h: own.height,
    };
  }, [layerSize, placedRect, windowRef]);

  const begin = (kind: "move" | "resize", event: PointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0) return;
    if (kind === "move" && (event.target as Element).closest(interactive)) {
      return;
    }
    const start = currentRect();
    if (!start) return;
    event.preventDefault();
    const { w, h, headerH } = layerSize();
    setLayer({ w, h, headerH });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = {
      kind,
      startX: event.clientX,
      startY: event.clientY,
      start,
    };
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (!active) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    const { w, h, headerH } = layerSize();
    setRect(
      active.kind === "move"
        ? clampRect(
            { ...active.start, x: active.start.x + dx, y: active.start.y + dy },
            w,
            h,
            headerH,
          )
        : clampSize(
            { ...active.start, w: active.start.w + dx, h: active.start.h + dy },
            w,
            h,
          ),
    );
  };

  const end = (event: PointerEvent<HTMLElement>) => {
    if (!gesture.current) return;
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const resizeByKey = (event: KeyboardEvent<HTMLElement>) => {
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_STEP, 0],
      ArrowRight: [KEY_STEP, 0],
      ArrowUp: [0, -KEY_STEP],
      ArrowDown: [0, KEY_STEP],
    };
    const step = delta[event.key];
    const start = currentRect();
    if (!step || !start) return;
    event.preventDefault();
    const { w, h } = layerSize();
    setRect(
      clampSize({ ...start, w: start.w + step[0], h: start.h + step[1] }, w, h),
    );
  };

  // Track the app area while mounted, including while maximized.
  useEffect(() => {
    const measure = () => {
      const { w, h, headerH } = layerSize();
      setLayer({ w, h, headerH });
    };
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [layerSize]);

  const style: CSSProperties | undefined =
    enabled && placedRect
      ? {
          position: "absolute",
          left: placedRect.x,
          top: placedRect.y,
          width: placedRect.w,
          height: placedRect.h,
          maxHeight: "none",
          margin: 0,
        }
      : undefined;

  return {
    style,
    placed: enabled && rect !== null,
    headerHandlers: enabled
      ? {
          onPointerDown: (event: PointerEvent<HTMLElement>) =>
            begin("move", event),
          onPointerMove: move,
          onPointerUp: end,
          onPointerCancel: end,
        }
      : {},
    gripHandlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) =>
        begin("resize", event),
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
      onKeyDown: resizeByKey,
    },
  };
}
