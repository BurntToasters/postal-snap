import { highlightParts } from "../searchHighlight";

export function HighlightedText({
  text,
  terms,
}: {
  text: string;
  terms: string[];
}) {
  const parts = highlightParts(text, terms);
  if (parts.every((part) => !part.mark)) return text;
  return parts.map((part, index) =>
    part.mark ? (
      <mark key={index}>{part.text}</mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}
