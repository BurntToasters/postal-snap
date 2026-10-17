// Dependency-free subsequence scorer for the command palette.

const WORD_BREAK = /[\s\-_/.:@(]/;

/**
 * Case-insensitive subsequence match. Returns null when a query character
 * is missing or out of order; higher scores mean tighter matches.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let score = haystack.startsWith(needle) ? 10 : 0;
  let position = 0;
  let previous = -2;
  for (const char of needle) {
    const found = haystack.indexOf(char, position);
    if (found === -1) return null;
    score += 1;
    if (found === previous + 1) score += 4;
    if (found === 0 || WORD_BREAK.test(haystack[found - 1])) score += 3;
    score -= Math.min(found - position, 5);
    previous = found;
    position = found + 1;
  }
  return score;
}

/** Best score across a label and its alternative keywords. */
export function bestFuzzyScore(
  query: string,
  texts: readonly string[],
): number | null {
  let best: number | null = null;
  for (const text of texts) {
    const score = fuzzyScore(query, text);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}
