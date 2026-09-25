export const BREAKPOINTS = {
  sidebarDrawerMax: 1049,
  narrowViewportMax: 760,
  shortViewportMax: 640,
} as const;

export const MEDIA_QUERIES = {
  sidebarDrawer: `(max-width: ${BREAKPOINTS.sidebarDrawerMax}px)`,
  narrowViewport: `(max-width: ${BREAKPOINTS.narrowViewportMax}px)`,
  shortViewport: `(max-height: ${BREAKPOINTS.shortViewportMax}px)`,
} as const;
