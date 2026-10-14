import {
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import type { SanitizedMail } from "../../security";
import type { Attachment, MessageDetail } from "../../types";
import { hydrateInlineImages } from "./readerUtils";

interface Options {
  message?: MessageDetail;
  sanitized?: SanitizedMail;
  currentLoadedHtml?: string;
  inlineAttachments: Attachment[];
  contentOperationRef: RefObject<number>;
  setLoadedHtml: Dispatch<
    SetStateAction<{ messageId: number; html: string } | undefined>
  >;
  setError: (error?: string) => void;
}

export function useRemoteImages({
  message,
  sanitized,
  currentLoadedHtml,
  inlineAttachments,
  contentOperationRef,
  setLoadedHtml,
  setError,
}: Options) {
  const [loadingImagesFor, setLoadingImagesFor] = useState<number>();
  const messageId = message?.id;
  const loadingImages = loadingImagesFor === messageId;

  async function loadImages() {
    if (!sanitized || loadingImages || !messageId) return;
    setLoadingImagesFor(messageId);
    const targetId = messageId;
    const operation = ++contentOperationRef.current;
    try {
      const doc = new DOMParser().parseFromString(
        currentLoadedHtml ?? sanitized.html,
        "text/html",
      );
      const images = [
        ...doc.querySelectorAll<HTMLImageElement>("img[data-remote-src]"),
      ].slice(0, 60);
      const batchSize = 4;
      for (let i = 0; i < images.length; i += batchSize) {
        if (contentOperationRef.current !== operation) break;
        const batch = images.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (image) => {
            const url = image.dataset.remoteSrc;
            if (!url) return;
            try {
              const result = await api.fetchRemoteImage(url);
              if (result.status === "blocked") {
                image.dataset.contentBlocked = "true";
                image.alt = strings.reader.filteredImage;
              } else if (result.status === "reportedThreat") {
                image.dataset.threatBlocked = "true";
                image.alt = strings.reader.threatImage;
              } else {
                image.src = result.dataUrl;
                image.classList.remove("remote-image-blocked");
              }
              image.removeAttribute("data-remote-src");
            } catch {
              // Keep placeholder on individual image error without blocking other images
            }
          }),
        );
      }
      if (message && contentOperationRef.current === operation)
        await hydrateInlineImages(
          doc,
          message.accountId,
          message.id,
          inlineAttachments,
        );
      if (message && contentOperationRef.current === operation)
        setLoadedHtml({ messageId: message.id, html: doc.body.innerHTML });
    } catch (cause) {
      if (contentOperationRef.current === operation) setError(String(cause));
    } finally {
      setLoadingImagesFor((current) =>
        current === targetId ? undefined : current,
      );
    }
  }

  return { loadImages, loadingImages };
}
