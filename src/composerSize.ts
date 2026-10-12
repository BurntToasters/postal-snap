/** Matches the floating composer's minimum grip size. */
export const COMPOSER_MIN_WIDTH = 480;
export const COMPOSER_MIN_HEIGHT = 360;
export const COMPOSER_MAX_WIDTH = 4000;
export const COMPOSER_MAX_HEIGHT = 3000;

/** A saved compose-window size, or nothing when the default layout should be used. */
export function rememberedComposerSize(
  width: number,
  height: number,
): { width: number; height: number } | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  const next = { width: Math.round(width), height: Math.round(height) };
  if (
    next.width < COMPOSER_MIN_WIDTH ||
    next.width > COMPOSER_MAX_WIDTH ||
    next.height < COMPOSER_MIN_HEIGHT ||
    next.height > COMPOSER_MAX_HEIGHT
  ) {
    return undefined;
  }
  return next;
}
