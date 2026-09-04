import DOMPurify from "dompurify";

const REMOTE_IMAGE = /^(?:https?:)?\/\//i;

export interface SanitizedMail {
  html: string;
  blockedImages: number;
}

export function sanitizeReceivedHtml(input: string): SanitizedMail {
  const doc = new DOMParser().parseFromString(input, "text/html");
  let blockedImages = 0;

  for (const element of doc.querySelectorAll(
    "script, iframe, frame, object, embed, form, input, button, textarea, select, meta, base, link, audio, video, source, track, picture",
  )) {
    element.remove();
  }

  for (const element of doc.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      if (attribute.name === "background")
        element.removeAttribute(attribute.name);
      if (
        attribute.name === "data-remote-src" ||
        attribute.name === "data-inline-cid"
      ) {
        element.removeAttribute(attribute.name);
      }
      if (attribute.name === "src" && element.tagName.toLowerCase() !== "img")
        element.removeAttribute(attribute.name);
      if (
        attribute.name === "style" &&
        /(?:url\s*\(|expression\s*\(|@import|-moz-binding|\\|https?:|\/\/|data:)/i.test(
          attribute.value,
        )
      ) {
        element.removeAttribute("style");
      }
    }
  }

  for (const image of doc.querySelectorAll<HTMLImageElement>("img")) {
    const src = image.getAttribute("src")?.trim() ?? "";
    if (REMOTE_IMAGE.test(src)) {
      image.dataset.remoteSrc = src.startsWith("//") ? `https:${src}` : src;
      image.removeAttribute("src");
      image.alt = image.alt || "Remote image blocked";
      image.classList.add("remote-image-blocked");
      blockedImages += 1;
    } else if (/^cid:/i.test(src)) {
      image.dataset.inlineCid = src
        .slice(4)
        .trim()
        .replace(/^<|>$/g, "")
        .slice(0, 512);
      image.removeAttribute("src");
      image.alt = image.alt || "Inline image";
    } else if (
      src &&
      !/^(?:blob:|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(src)
    ) {
      image.removeAttribute("src");
    }
  }

  for (const link of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href")?.trim() ?? "";
    if (!/^(https?:|mailto:)/i.test(href)) link.removeAttribute("href");
    link.setAttribute("rel", "noopener noreferrer");
  }

  const clean = DOMPurify.sanitize(doc.body.innerHTML, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "script",
      "iframe",
      "frame",
      "object",
      "embed",
      "form",
      "style",
      "svg",
      "math",
      "link",
      "audio",
      "video",
      "source",
      "track",
      "picture",
    ],
    FORBID_ATTR: ["srcset", "ping", "formaction", "background", "poster"],
    ALLOW_DATA_ATTR: true,
  });

  return { html: clean, blockedImages };
}

export function messageFrameDocument(html: string, textScale = 1): string {
  const fontSize = Math.round(16 * Math.max(1, Math.min(2, textScale)));
  const policy = [
    "default-src 'none'",
    "img-src data: blob: cid:",
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>body{font:${fontSize}px/1.55 system-ui,sans-serif;color:#20252b;background:transparent;margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}.remote-image-blocked{display:inline-block;min-width:120px;min-height:40px;background:#eef2f6;border:1px solid #c8d2dc}a{color:#1264a3}</style></head><body>${html}</body></html>`;
}

export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const lineBreak of doc.querySelectorAll("br"))
    lineBreak.replaceWith(doc.createTextNode("\n"));
  for (const block of doc.querySelectorAll(
    "p, div, h1, h2, h3, h4, h5, h6, li, blockquote, tr",
  ))
    block.append(doc.createTextNode("\n"));
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
