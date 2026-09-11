export function tonightAtNine(now = new Date()): Date {
  const next = new Date(now);
  next.setHours(21, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export function tomorrowAtEight(now = new Date()): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(8, 0, 0, 0);
  return next;
}
