import { htmlToPlainText, sanitizeComposeHtml } from "../../security";
import { escapeHtml } from "./composerSeed";

/** Rich body to plain text. Quoted blocks become "> " lines. */
export function htmlToQuotedPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Deepest first, so nested quotes gain one "> " per level.
  for (const quote of [...doc.querySelectorAll("blockquote")].reverse()) {
    const paragraph = doc.createElement("p");
    htmlToPlainText(quote.innerHTML)
      .split("\n")
      .forEach((line, index) => {
        if (index) paragraph.append(doc.createElement("br"));
        paragraph.append(doc.createTextNode(line ? `> ${line}` : ">"));
      });
    quote.replaceWith(paragraph);
  }
  return htmlToPlainText(doc.body.innerHTML);
}

/** Clipboard text as paragraphs. Tags stay as text. */
export function plainPasteBlocks(text: string): Array<{
  type: "paragraph";
  content?: Array<{ type: "text"; text: string }>;
}> {
  let normalized = "";
  for (const character of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")) {
    const code = character.charCodeAt(0);
    if (code === 10 || code === 9 || (code >= 32 && code !== 127)) {
      normalized += character;
    }
  }
  if (!normalized) return [];
  return normalized
    .split("\n")
    .map((line) =>
      line.length > 0
        ? { type: "paragraph", content: [{ type: "text", text: line }] }
        : { type: "paragraph" },
    );
}

export function isPlainPasteShortcut(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "v"
  );
}

/** Plain text to editor HTML: escaped, blank lines split paragraphs. */
export function plainTextToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`);
  return sanitizeComposeHtml(paragraphs.join("") || "<p></p>");
}
