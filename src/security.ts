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
        attribute.name === "data-content-blocked" ||
        attribute.name === "data-threat-blocked"
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
    const markedRemote = image.getAttribute("data-remote-src")?.trim() ?? "";
    const markedCid = image.getAttribute("data-inline-cid")?.trim() ?? "";
    image.removeAttribute("data-remote-src");
    image.removeAttribute("data-inline-cid");
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
    } else if (REMOTE_IMAGE.test(markedRemote)) {
      image.dataset.remoteSrc = markedRemote.startsWith("//")
        ? `https:${markedRemote}`
        : markedRemote;
      image.removeAttribute("src");
      image.alt = image.alt || "Remote image blocked";
      image.classList.add("remote-image-blocked");
      blockedImages += 1;
    } else if (markedCid) {
      image.dataset.inlineCid = markedCid.replace(/^<|>$/g, "").slice(0, 512);
      image.removeAttribute("src");
      image.alt = image.alt || "Inline image";
    } else if (
      src &&
      !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(src)
    ) {
      image.removeAttribute("src");
    }
  }

  for (const link of doc.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = link.getAttribute("href")?.trim() ?? "";
    const marked = link.getAttribute("data-external-href")?.trim() ?? "";
    const http = REMOTE_IMAGE.test(href)
      ? href.startsWith("//")
        ? `https:${href}`
        : href
      : REMOTE_IMAGE.test(marked)
        ? marked.startsWith("//")
          ? `https:${marked}`
          : marked
        : "";
    if (http) {
      link.setAttribute("data-external-href", http);
      link.setAttribute("href", "#");
    } else if (!/^mailto:/i.test(href) && href !== "#") {
      link.removeAttribute("href");
      link.removeAttribute("data-external-href");
    }
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
      "map",
      "area",
    ],
    FORBID_ATTR: [
      "srcset",
      "ping",
      "formaction",
      "background",
      "poster",
      "usemap",
    ],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: [
      "data-remote-src",
      "data-inline-cid",
      "data-external-href",
      "class",
      "alt",
    ],
  });

  return { html: clean, blockedImages };
}

export function sanitizeComposeHtml(input: string): string {
  const { html } = sanitizeReceivedHtml(input);
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const image of doc.querySelectorAll<HTMLImageElement>(
    "img[data-inline-cid]",
  )) {
    const cid = image.getAttribute("data-inline-cid");
    if (!cid) continue;
    image.setAttribute("src", `cid:${cid}`);
    image.removeAttribute("data-inline-cid");
  }
  return doc.body.innerHTML || "<p></p>";
}

/**
 * Frame copy of sanitized mail. WebKit runs no listeners in the scriptless
 * frame, so links become target="_blank" popups that native code denies and
 * routes to the link confirmation flow. Other hrefs are dropped so a click
 * never navigates the frame itself.
 */
export function withFrameLinks(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const link of doc.querySelectorAll<HTMLAnchorElement>("a")) {
    const marked = link.getAttribute("data-external-href")?.trim() ?? "";
    const href = link.getAttribute("href")?.trim() ?? "";
    const target = /^https?:\/\//i.test(marked)
      ? marked
      : /^mailto:/i.test(href)
        ? href
        : "";
    if (target) {
      link.setAttribute("href", target);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else {
      link.removeAttribute("href");
    }
  }
  return doc.body.innerHTML;
}

/**
 * Mail that sets any color of its own was designed for a light page and
 * stays on white. Mail without colors can follow dark mode, as Apple Mail
 * does. Received HTML carries no <style> blocks, so inline colors are all.
 */
export function hasAuthorColors(html: string): boolean {
  return /\bbgcolor\s*=|\bbackground(?:-color)?\s*[:=]|(?:^|[\s;"'])color\s*:|<font\b[^>]*\bcolor\s*=/i.test(
    html,
  );
}

// A neutral picture glyph for blocked remote images instead of the browser's
// broken-image icon. The frame CSP allows data: images.
const BLOCKED_IMAGE_GLYPH =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%238e8e93' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='2'/%3E%3Ccircle cx='9' cy='9' r='2'/%3E%3Cpath d='m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'/%3E%3C/svg%3E";

const DARK_FRAME_STYLE =
  "html,body{background:#1c1c1e !important;color-scheme:dark}body{color:#e8e8ea}a{color:#6cb6ff}.remote-image-blocked{background:#2c2c2e;border-color:#48484a}";

export function messageFrameDocument(
  html: string,
  textScale = 1,
  dark = false,
): string {
  const fontSize = Math.round(16 * Math.max(1, Math.min(2, textScale)));
  const policy = [
    "default-src 'none'",
    "img-src data: cid:",
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer"><style>html,body{background:#ffffff !important;color-scheme:light}body{font:${fontSize}px/1.55 system-ui,sans-serif;color:#20252b;margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}.remote-image-blocked{display:inline-block;min-width:120px;min-height:40px;background:#eef2f6;border:1px solid #c8d2dc;border-radius:6px;object-fit:none;content:url("${BLOCKED_IMAGE_GLYPH}")}a{color:#1264a3}${dark ? DARK_FRAME_STYLE : ""}</style></head><body>${html}</body></html>`;
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
