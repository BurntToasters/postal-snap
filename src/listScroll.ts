const positions = new Map<string, number>();

export function rememberListScroll(key: string, top: number): void {
  if (top <= 0) positions.delete(key);
  else positions.set(key, top);
}

export function rememberedListScroll(key: string): number {
  return positions.get(key) ?? 0;
}
