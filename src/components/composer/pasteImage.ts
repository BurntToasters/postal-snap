export function readPastedImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string" && result.startsWith("data:image/"))
        resolve(result);
      else reject(new Error("Could not read that image."));
    };
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.readAsDataURL(file);
  });
}

/** Clipboard pictures larger than this stay out of the composer. */
export const MAX_PASTED_IMAGE_BYTES = 8 * 1024 * 1024;

interface ClipboardFileItem {
  kind: string;
  getAsFile: () => File | null;
}

/** The clipboard fields this check reads. A test can pass a stand-in. */
export interface ClipboardImageSource {
  types?: ArrayLike<string>;
  items?: ArrayLike<ClipboardFileItem>;
  files?: ArrayLike<File>;
}

/** Image files from a paste that has no letter text beside them. */
export function clipboardImages(data: ClipboardImageSource | null): {
  files: File[];
  tooLarge: boolean;
} {
  if (!data) return { files: [], tooLarge: false };
  const types = Array.from(data.types ?? []);
  if (types.includes("text/plain") || types.includes("text/html")) {
    return { files: [], tooLarge: false };
  }
  const fromItems = data.items
    ? Array.from(data.items).flatMap((item) => {
        if (item.kind !== "file") return [];
        const file = item.getAsFile();
        return file ? [file] : [];
      })
    : [];
  const sources =
    fromItems.length > 0 ? fromItems : Array.from(data.files ?? []);
  const files: File[] = [];
  let tooLarge = false;
  for (const file of sources) {
    if (!file.type.startsWith("image/")) continue;
    if (file.size > MAX_PASTED_IMAGE_BYTES) tooLarge = true;
    else if (file.size > 0) files.push(file);
  }
  return { files, tooLarge };
}
