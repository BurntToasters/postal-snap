import type { Attachment } from "../../types";

// Rendered PDF pages must be inline raster data; anything else is dropped.
const PAGE_IMAGE =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/i;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isPageImage(url: string): boolean {
  return PAGE_IMAGE.test(url);
}

export function isMessageAttachment(
  attachment: Pick<Attachment, "contentType" | "filename">,
): boolean {
  return (
    attachment.contentType.toLowerCase().startsWith("message/rfc822") ||
    attachment.filename.toLowerCase().endsWith(".eml")
  );
}

export function isPreviewableAttachment(
  attachment: Pick<Attachment, "contentType" | "filename" | "inline" | "size">,
): boolean {
  if (attachment.inline || attachment.size > MAX_PREVIEW_BYTES) return false;
  const contentType = attachment.contentType.toLowerCase();
  // Size 0 means a partial message's attachment that is not downloaded yet.
  const isPdf =
    attachment.size > 0 &&
    (contentType === "application/pdf" ||
      attachment.filename.toLowerCase().endsWith(".pdf"));
  return (
    isPdf ||
    contentType === "text/plain" ||
    PREVIEWABLE_IMAGE_TYPES.has(contentType)
  );
}
