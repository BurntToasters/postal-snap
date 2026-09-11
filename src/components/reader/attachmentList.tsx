import { Download, Eye, X } from "lucide-react";
import { formatBytes } from "../../format";
import { strings } from "../../i18n";
import type { Attachment, AttachmentPreview, MessageDetail } from "../../types";
import { useDialogFocus } from "../useDialogFocus";

export function AttachmentPreviewDialog({
  preview,
  onDownload,
  onClose,
}: {
  preview: AttachmentPreview;
  onDownload: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus(onClose);
  return (
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
      >
        <header>
          <div>
            <h2>{preview.filename}</h2>
            <small>
              {preview.contentType} · {formatBytes(preview.size)}
            </small>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={strings.common.close}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="attachment-preview-body">
          {preview.imageDataUrl ? (
            <img src={preview.imageDataUrl} alt={preview.filename} />
          ) : (
            <pre>{preview.text ?? ""}</pre>
          )}
        </div>
        <footer>
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
    </div>
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
  onPreviewDownload,
  onPreviewClose,
}: {
  message: MessageDetail;
  preview: { messageId: number; preview: AttachmentPreview } | null;
  downloadingAttachmentId?: string;
  previewAttachmentId?: string;
  isPreviewable: (attachment: Attachment) => boolean;
  onPreview: (attachmentId: string) => void;
  onDownload: (attachmentId: string, filename: string) => void;
  onPreviewDownload: () => void;
  onPreviewClose: () => void;
}) {
  return (
    <>
      {(() => {
        const regularAttachments = message.attachments.filter(
          (item) => !item.inline,
        );
        if (regularAttachments.length === 0) return null;
        return (
          <section
            className="attachment-list"
            aria-label={strings.reader.attachments}
          >
            <h2>
              {strings.reader.attachments} ({regularAttachments.length})
            </h2>
            {regularAttachments.map((attachment) => (
              <div key={attachment.id} className="attachment-row">
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
                    <small>{formatBytes(attachment.size)}</small>
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
          onDownload={onPreviewDownload}
          onClose={onPreviewClose}
        />
      ) : null}
    </>
  );
}
