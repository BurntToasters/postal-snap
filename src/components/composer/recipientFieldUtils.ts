export function tokenAtCaret(
  value: string,
  caret: number,
): { token: string; start: number } {
  let start = caret;
  while (start > 0 && value[start - 1] !== "," && value[start - 1] !== ";") {
    start -= 1;
  }
  let end = caret;
  while (end < value.length && value[end] !== "," && value[end] !== ";") {
    end += 1;
  }
  return { token: value.slice(start, end).trim(), start };
}
