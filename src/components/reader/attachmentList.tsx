import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { formatBytes } from "../../format";
import { strings } from "../../i18n";
import type { Attachment, AttachmentPreview, MessageDetail } from "../../types";
import { useDialogFocus } from "../useDialogFocus";
import { useInertBackground } from "../useInertBackground";

const PREVIEW_ZOOM = [1, 1.5, 2, 3];

const FILE_KINDS: Record<string, string> = {
  plain: "Text",
  html: "HTML",
  jpeg: "JPEG",
  jpg: "JPEG",
  png: "PNG",
  gif: "GIF",
  webp: "WebP",
  pdf: "PDF",
  zip: "ZIP",
  rfc822: "Message",
};

function fileKind(contentType: string): string {
  const subtype =
    contentType.split("/")[1]?.split(";")[0]?.split("+")[0]?.toLowerCase() ??
    "";
  if (FILE_KINDS[subtype]) return FILE_KINDS[subtype];
  if (subtype.length > 0 && subtype.length <= 5 && subtype !== "octet-stream")
    return subtype.toUpperCase();
  return "File";
}

function nextPreviewZoom(current: number, direction: 1 | -1): number {
  const index = PREVIEW_ZOOM.findIndex((step) => step >= current - 0.01);
  const at = index < 0 ? 0 : index;
  return PREVIEW_ZOOM[
    Math.min(PREVIEW_ZOOM.length - 1, Math.max(0, at + direction))
  ];
}

export function AttachmentPreviewDialog({
  preview,
  onPrevious,
  onNext,
  onDownload,
  onClose,
}: {
  preview: AttachmentPreview;
  onPrevious?: () => void;
  onNext?: () => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus(onClose);
  useInertBackground();
  const previewKey = `${preview.filename}\0${preview.imageDataUrl ?? ""}`;
  const [zoomState, setZoomState] = useState({ key: previewKey, zoom: 1 });
  if (zoomState.key !== previewKey) {
    setZoomState({ key: previewKey, zoom: 1 });
  }
  const zoom = zoomState.key === previewKey ? zoomState.zoom : 1;
  function setZoom(next: number) {
    setZoomState({ key: previewKey, zoom: next });
  }
  return createPortal(
    <div className="modal-layer attachment-preview-layer">
      <button
        type="button"
        className="modal-backdrop"
        aria-label={strings.common.close}
        onClick={onClose}
      />
      <section
        className="attachment-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={strings.reader.previewTitle(preview.filename)}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && onPrevious) {
            event.preventDefault();
            onPrevious();
          }
          if (event.key === "ArrowRight" && onNext) {
            event.preventDefault();
            onNext();
          }
          if (
            preview.imageDataUrl &&
            (event.key === "+" || event.key === "=")
          ) {
            event.preventDefault();
            setZoom(nextPreviewZoom(zoom, 1));
          }
          if (preview.imageDataUrl && event.key === "-") {
            event.preventDefault();
            setZoom(nextPreviewZoom(zoom, -1));
          }
        }}
      >
        <header>
          <div>
            <h2>{preview.filename}</h2>
            <small>
              {fileKind(preview.contentType)} · {formatBytes(preview.size)}
            </small>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={strings.common.close}
            title={strings.common.close}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="attachment-preview-body">
          {preview.imageDataUrl ? (
            <img
              src={preview.imageDataUrl}
              alt={preview.filename}
              data-zoom={zoom}
              style={
                zoom > 1
                  ? { width: `${zoom * 100}%`, maxWidth: "none" }
                  : undefined
              }
            />
          ) : (
            <pre>{preview.text ?? ""}</pre>
          )}
        </div>
        <footer>
          {preview.imageDataUrl ? (
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={zoom <= 1}
                onClick={() => setZoom(nextPreviewZoom(zoom, -1))}
              >
                <ZoomOut aria-hidden="true" /> {strings.reader.zoomOut}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={zoom >= PREVIEW_ZOOM[PREVIEW_ZOOM.length - 1]}
                onClick={() => setZoom(nextPreviewZoom(zoom, 1))}
              >
                <ZoomIn aria-hidden="true" /> {strings.reader.zoomIn}
              </button>
            </>
          ) : null}
          {onPrevious ? (
            <button
              type="button"
              className="secondary-button"
              onClick={onPrevious}
            >
              <ChevronLeft aria-hidden="true" /> {strings.reader.previousFile}
            </button>
          ) : null}
          {onNext ? (
            <button type="button" className="secondary-button" onClick={onNext}>
              {strings.reader.nextFile} <ChevronRight aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              onDownload();
              onClose();
            }}
          >
            <Download aria-hidden="true" /> {strings.reader.downloadFile}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function AttachmentList({
  message,
  preview,
  downloadingAttachmentId,
  previewAttachmentId,
  isPreviewable,
  onPreview,
  onDownload,
  onSaveAll,
  onSaveChosen,
  onPreviewDownload,
  onPreviewClose,
}: {
  message: MessageDetail;
  preview: {
    messageId: number;
    attachmentId: string;
    preview: AttachmentPreview;
  } | null;
  downloadingAttachmentId?: string;
  previewAttachmentId?: string;
  isPreviewable: (attachment: Attachment) => boolean;
  onPreview: (attachmentId: string) => void;
  onDownload: (attachmentId: string, filename: string) => void;
  onSaveAll: () => void;
  onSaveChosen?: (attachmentIds: string[]) => void;
  onPreviewDownload: () => void;
  onPreviewClose: () => void;
}) {
  function neighborPreview(
    current: MessageDetail,
    attachmentId: string,
    direction: 1 | -1,
  ) {
    const files = current.attachments.filter(
      (item) => !item.inline && isPreviewable(item),
    );
    const index = files.findIndex((item) => item.id === attachmentId);
    const neighbor = index < 0 ? undefined : files[index + direction];
    if (!neighbor || previewAttachmentId !== undefined) return undefined;
    return () => onPreview(neighbor.id);
  }

  const [chosen, setChosen] = useState<{
    messageId: number;
    ids: string[];
  }>({ messageId: message.id, ids: [] });
  const chosenIds = chosen.messageId === message.id ? chosen.ids : [];

  function toggleChosen(attachmentId: string) {
    const current = chosen.messageId === message.id ? chosen.ids : [];
    const ids = current.includes(attachmentId)
      ? current.filter((id) => id !== attachmentId)
      : [...current, attachmentId];
    setChosen({ messageId: message.id, ids });
  }

  return (
    <>
      {(() => {
        const regularAttachments = message.attachments.filter(
          (item) => !item.inline,
        );
        if (regularAttachments.length === 0) return null;
        const fileBytes = regularAttachments.reduce(
          (total, item) => total + item.size,
          0,
        );
        return (
          <section
            id="message-attachments"
            tabIndex={-1}
            className="attachment-list"
            aria-label={strings.reader.attachments}
          >
            <div className="attachment-list-header">
              <h2>
                {strings.reader.attachments} ({regularAttachments.length},{" "}
                {formatBytes(fileBytes)})
              </h2>
              {regularAttachments.length > 1 ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={downloadingAttachmentId !== undefined}
                  onClick={onSaveAll}
                >
                  <Download aria-hidden="true" />
                  {strings.reader.saveAllFiles}
                </button>
              ) : null}
              {onSaveChosen && chosenIds.length > 0 ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={downloadingAttachmentId !== undefined}
                  onClick={() => onSaveChosen(chosenIds)}
                >
                  <Download aria-hidden="true" />
                  {strings.reader.saveChosenFiles(chosenIds.length)}
                </button>
              ) : null}
            </div>
            {regularAttachments.map((attachment) => (
              <div
                key={attachment.id}
                className="attachment-row"
                data-context="attachment"
                data-attachment-id={attachment.id}
                data-previewable={String(isPreviewable(attachment))}
                data-filename={attachment.filename}
              >
                {onSaveChosen && regularAttachments.length > 1 ? (
                  <label className="attachment-choose">
                    <input
                      type="checkbox"
                      checked={chosenIds.includes(attachment.id)}
                      onChange={() => toggleChosen(attachment.id)}
                      aria-label={strings.reader.chooseFile(
                        attachment.filename,
                      )}
                    />
                  </label>
                ) : null}
                {isPreviewable(attachment) ? (
                  <button
                    type="button"
                    className="attachment-preview-button"
                    disabled={
                      downloadingAttachmentId !== undefined ||
                      previewAttachmentId !== undefined
                    }
                    onClick={() => void onPreview(attachment.id)}
                    aria-label={`${strings.reader.preview}: ${attachment.filename}`}
                    title={strings.reader.previewTitle(attachment.filename)}
                  >
                    <Eye aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="attachment-download-button"
                  disabled={downloadingAttachmentId !== undefined}
                  onClick={() =>
                    void onDownload(attachment.id, attachment.filename)
                  }
                  aria-label={`${strings.reader.downloadFile}: ${attachment.filename}`}
                >
                  <Download aria-hidden="true" />
                  <span>
                    <strong>{attachment.filename}</strong>
                    <small>
                      {fileKind(attachment.contentType)} ·{" "}
                      {formatBytes(attachment.size)}
                    </small>
                  </span>
                </button>
              </div>
            ))}
          </section>
        );
      })()}
      {preview && message && preview.messageId === message.id ? (
        <AttachmentPreviewDialog
          preview={preview.preview}
          onPrevious={neighborPreview(message, preview.attachmentId, -1)}
          onNext={neighborPreview(message, preview.attachmentId, 1)}
          onDownload={onPreviewDownload}
          onClose={onPreviewClose}
        />
      ) : null}
    </>
  );
}
