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
