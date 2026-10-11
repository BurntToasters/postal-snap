export interface HighlightTerms {
  correspondent: string[];
  subject: string[];
  preview: string[];
}

export interface HighlightPart {
  text: string;
  mark: boolean;
}

/** Every text needle from a search, for the open message. */
export function textHighlightTerms(query: string): string[] {
  const terms = highlightTerms(query);
  return [
    ...new Set([...terms.correspondent, ...terms.subject, ...terms.preview]),
  ];
}

/** Wrap matching text nodes in mark elements. The query is never inserted as HTML. */
export function markHtmlText(html: string, terms: string[]): string {
  const needles = textNeedles(terms);
  if (!html || needles.length === 0) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const parts = highlightParts(node.data, needles);
    if (parts.every((part) => !part.mark)) continue;
    const fragment = doc.createDocumentFragment();
    for (const part of parts) {
      if (!part.text) continue;
      if (part.mark) {
        const mark = doc.createElement("mark");
        mark.textContent = part.text;
        fragment.append(mark);
      } else {
        fragment.append(doc.createTextNode(part.text));
      }
    }
    node.replaceWith(fragment);
  }
  return doc.body.innerHTML;
}

function textNeedles(terms: string[]): string[] {
  return [
    ...new Set(
      terms
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= 2),
    ),
  ];
}

const FIELD =
  /^(from|to|cc|subject|body|filename|in|is|has|before|after|on|larger|smaller):(.*)$/i;

/** Words a mailbox search should mark. Operators that are not text stay out. */
export function highlightTerms(query: string): HighlightTerms {
  const correspondent: string[] = [];
  const subject: string[] = [];
  const preview: string[] = [];
  for (const token of searchTokens(query)) {
    const field = FIELD.exec(token);
    if (field) {
      const name = field[1].toLowerCase();
      const value = field[2].trim();
      if (value.length < 2 || value.toLowerCase() === "me") continue;
      if (name === "from" || name === "to" || name === "cc")
        correspondent.push(value);
      else if (name === "subject") subject.push(value);
      else if (name === "body") preview.push(value);
      continue;
    }
    if (token.length < 2) continue;
    correspondent.push(token);
    subject.push(token);
    preview.push(token);
  }
  return { correspondent, subject, preview };
}

/** Split text around case-insensitive matches. Longer matches win ties. */
export function highlightParts(text: string, terms: string[]): HighlightPart[] {
  const needles = [
    ...new Set(
      terms
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= 2),
    ),
  ];
  if (!text || needles.length === 0) return [{ text, mark: false }];
  const lower = text.toLowerCase();
  const parts: HighlightPart[] = [];
  let index = 0;
  while (index < text.length) {
    let bestStart = -1;
    let bestEnd = -1;
    for (const term of needles) {
      const found = lower.indexOf(term, index);
      if (found < 0) continue;
      const end = found + term.length;
      if (
        bestStart < 0 ||
        found < bestStart ||
        (found === bestStart && end > bestEnd)
      ) {
        bestStart = found;
        bestEnd = end;
      }
    }
    if (bestStart < 0) break;
    if (bestStart > index)
      parts.push({ text: text.slice(index, bestStart), mark: false });
    parts.push({ text: text.slice(bestStart, bestEnd), mark: true });
    index = bestEnd;
  }
  if (index < text.length) parts.push({ text: text.slice(index), mark: false });
  return parts.length > 0 ? parts : [{ text, mark: false }];
}

function searchTokens(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of query.slice(0, 200)) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}
