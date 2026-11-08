// Rendered PDF pages must be inline raster data; anything else is dropped.
const PAGE_IMAGE =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/i;

export function isPageImage(url: string): boolean {
  return PAGE_IMAGE.test(url);
}

export function isMessageAttachment(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("message/rfc822");
}
