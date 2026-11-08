// Narrow side of each pair is inclusive; the wide side starts just above it.
export const BREAKPOINTS = {
  xs: 560,
  sm: 760,
  md: 900,
} as const;

export const SHORT_VIEWPORT_MAX_PX = 640;

// Gap between the inclusive max and the next band's min.
const WIDE_GAP_PX = 0.02;
const maxPx = (px: number) => `${px}px`;
const belowPx = (px: number) => `${(px - WIDE_GAP_PX).toFixed(2)}px`;

export const MEDIA_QUERIES = {
  narrowViewport: `(max-width: ${maxPx(BREAKPOINTS.sm)})`,
  sidebarDrawer: `(max-width: ${belowPx(BREAKPOINTS.md)})`,
  shortViewport: `(max-height: ${SHORT_VIEWPORT_MAX_PX}px)`,
} as const;
