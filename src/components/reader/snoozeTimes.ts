/** 6 PM local time, when that is still at least an hour away. */
export function laterTodayIso(now = new Date()): string | undefined {
  const target = new Date(now);
  target.setHours(18, 0, 0, 0);
  if (target.getTime() - now.getTime() < 60 * 60 * 1000) return undefined;
  return target.toISOString();
}
