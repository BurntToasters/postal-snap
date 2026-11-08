import type { Dispatch, SetStateAction } from "react";
import { api } from "../../api";
import { useAppStore } from "../../store";
import type { Attachment, AttachmentPreview, MessageDetail } from "../../types";
import { errorText } from "../../errors";

interface Options {
  message: MessageDetail | undefined;
  previewAttachmentId: string | undefined;
  setPreviewAttachmentId: Dispatch<SetStateAction<string | undefined>>;
  setPreview: Dispatch<
    SetStateAction<{
      messageId: number;
      attachmentId: string;
      preview: AttachmentPreview;
    } | null>
  >;
  downloadingAttachmentId: string | undefined;
  setDownloadingAttachmentId: Dispatch<SetStateAction<string | undefined>>;
  setError: (error?: string) => void;
}

export function useReaderAttachments({
  message,
  previewAttachmentId,
  setPreviewAttachmentId,
  setPreview,
  downloadingAttachmentId,
  setDownloadingAttachmentId,
  setError,
}: Options) {
  function isPreviewable(attachment: Attachment): boolean {
    if (attachment.inline || attachment.size > 10 * 1024 * 1024) return false;
    const contentType = attachment.contentType.toLowerCase();
    // Size 0 means a partial message's attachment that is not downloaded yet.
    const isPdf =
      attachment.size > 0 &&
      (contentType === "application/pdf" ||
        attachment.filename.toLowerCase().endsWith(".pdf"));
    return (
      isPdf ||
      contentType === "text/plain" ||
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        contentType,
      )
    );
  }

  async function previewFile(attachmentId: string) {
    if (!message || previewAttachmentId !== undefined) return;
    const targetMessageId = message.id;
    setPreviewAttachmentId(attachmentId);
    try {
      const loaded = await api.previewAttachment(
        message.accountId,
        message.id,
        attachmentId,
      );
      if (targetMessageId !== useAppStore.getState().selectedMessage?.id)
        return;
      setPreview({
        messageId: targetMessageId,
        attachmentId,
        preview: loaded,
      });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPreviewAttachmentId(undefined);
    }
  }

  async function saveChosenAttachments(attachmentIds: string[]) {
    if (!message || downloadingAttachmentId !== undefined) return;
    if (attachmentIds.length === 0) return;
    setDownloadingAttachmentId("chosen");
    try {
      await api.saveChosenAttachments(
        message.accountId,
        message.id,
        attachmentIds,
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setDownloadingAttachmentId(undefined);
    }
  }

  async function saveAllAttachments() {
    if (!message || downloadingAttachmentId !== undefined) return;
    setDownloadingAttachmentId("all");
    try {
      await api.saveAllAttachments(message.accountId, message.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setDownloadingAttachmentId(undefined);
    }
  }

  async function download(attachmentId: string, filename: string) {
    if (!message || downloadingAttachmentId !== undefined) return;
    setDownloadingAttachmentId(attachmentId);
    try {
      await api.saveAttachment(
        message.accountId,
        message.id,
        attachmentId,
        filename,
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setDownloadingAttachmentId(undefined);
    }
  }

  return {
    isPreviewable,
    previewFile,
    saveChosenAttachments,
    saveAllAttachments,
    download,
  };
}
