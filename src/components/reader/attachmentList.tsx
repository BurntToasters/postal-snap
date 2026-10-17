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
import { api } from "../../api";
import { accountSyncPhase } from "../../accountStatus";
import { formatBytes } from "../../format";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { Attachment, AttachmentPreview, MessageDetail } from "../../types";
import { useDialogFocus } from "../useDialogFocus";
import { useInertBackground } from "../useInertBackground";

const PREVIEW_ZOOM = [1, 1.5, 2, 3];

const FILE_KINDS: Record<string, string> = {
  html: "HTML",
  jpeg: "JPEG",
  jpg: "JPEG",
  png: "PNG",
  gif: "GIF",
  webp: "WebP",
  pdf: "PDF",
  zip: "ZIP",
};

function fileKind(contentType: string): string {
  const subtype =
    contentType.split("/")[1]?.split(";")[0]?.split("+")[0]?.toLowerCase() ??
    "";
  if (subtype === "plain") return strings.reader.fileKindText;
  if (subtype === "rfc822") return strings.reader.fileKindMessage;
  if (FILE_KINDS[subtype]) return FILE_KINDS[subtype];
  if (subtype.length > 0 && subtype.length <= 5 && subtype !== "octet-stream")
    return subtype.toUpperCase();
  return strings.reader.fileKindFile;
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
            <h2 title={preview.filename}>{preview.filename}</h2>
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

  const account = useAppStore((state) =>
    state.accounts.find((item) => item.id === message.accountId),
  );
  const liveSync = useAppStore((state) => state.sync[message.accountId]);
  const setError = useAppStore((state) => state.setError);
  const offline = accountSyncPhase(account, liveSync) === "offline";
  // Partial attachments need the server, so they stay disabled offline.
  const partialOffline = message.bodyPartial === true && offline;
  const [fullDownload, setFullDownload] = useState<{
    messageId: number;
    busy: boolean;
  }>();
  const fullBusy = fullDownload?.messageId === message.id && fullDownload.busy;

  async function downloadFull() {
    const { id, accountId } = message;
    setFullDownload({ messageId: id, busy: true });
    try {
      const detail = await api.downloadFullMessage(accountId, id);
      const store = useAppStore.getState();
      const current = store.selectedMessage;
      if (current?.id === id && current.accountId === accountId) {
        store.selectMessage(detail);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setFullDownload(undefined);
    }
  }

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
        const partial = message.bodyPartial === true;
        if (regularAttachments.length === 0 && !partial) return null;
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
                  disabled={
                    downloadingAttachmentId !== undefined || partialOffline
                  }
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
                  disabled={
                    downloadingAttachmentId !== undefined || partialOffline
                  }
                  onClick={() => onSaveChosen(chosenIds)}
                >
                  <Download aria-hidden="true" />
                  {strings.reader.saveChosenFiles(chosenIds.length)}
                </button>
              ) : null}
            </div>
            {partial ? (
              <div className="attachment-partial">
                <p>
                  {strings.reader.attachmentsNotDownloaded(
                    formatBytes(message.size),
                  )}
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={offline || fullBusy}
                  aria-busy={fullBusy}
                  onClick={() => void downloadFull()}
                >
                  <Download aria-hidden="true" />
                  {fullBusy
                    ? strings.reader.downloadingFullMessage
                    : strings.reader.downloadFullMessage}
                </button>
                {offline ? <p>{strings.reader.attachmentsOnlineOnly}</p> : null}
              </div>
            ) : null}
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
                      previewAttachmentId !== undefined ||
                      partialOffline
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
                  disabled={
                    downloadingAttachmentId !== undefined || partialOffline
                  }
                  onClick={() =>
                    void onDownload(attachment.id, attachment.filename)
                  }
                  aria-label={`${strings.reader.downloadFile}: ${attachment.filename}`}
                >
                  <Download aria-hidden="true" />
                  <span>
                    <strong>{attachment.filename}</strong>
                    <small>
                      {fileKind(attachment.contentType)}
                      {partial && attachment.size === 0
                        ? ""
                        : ` · ${formatBytes(attachment.size)}`}
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
