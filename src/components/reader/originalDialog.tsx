import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Download, X } from "lucide-react";
import { api } from "../../api";
import { formatBytes } from "../../format";
import { strings } from "../../i18n";
import type { MessageSource } from "../../types";
import { useDialogFocus } from "../useDialogFocus";
import { useInertBackground } from "../useInertBackground";

/** Raw message source. Always text in <pre> and table cells, never HTML. */
export function OriginalDialog({
  accountId,
  messageId,
  onClose,
  onError,
}: {
  accountId: string;
  messageId: number;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const dialogRef = useDialogFocus(onClose);
  useInertBackground();
  const [source, setSource] = useState<MessageSource>();
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .getMessageSource(accountId, messageId)
      .then((loaded) => {
        if (active) setSource(loaded);
      })
      .catch((cause) => {
        if (!active) return;
        onError(String(cause));
        onClose();
      });
    return () => {
      active = false;
    };
    // Load once per opened dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, messageId]);

  async function copySource() {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable; the text stays selectable.
    }
  }

  async function saveEml() {
    if (saving) return;
    setSaving(true);
    try {
      await api.saveMessageEml(accountId, messageId);
    } catch (cause) {
      onError(String(cause));
    } finally {
      setSaving(false);
    }
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
        className="attachment-preview-dialog original-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={strings.reader.originalTitle}
        ref={dialogRef}
      >
        <header>
          <div>
            <h2>{strings.reader.originalTitle}</h2>
            {source ? <small>{formatBytes(source.size)}</small> : null}
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
        <div className="original-body">
          {!source ? (
            <p role="status">{strings.reader.originalLoading}</p>
          ) : (
            <>
              <h3>{strings.reader.originalHeaders}</h3>
              <div className="original-headers-scroll" tabIndex={0}>
                <table className="original-headers">
                  <tbody>
                    {source.headers.map((header, index) => (
                      <tr key={`${header.name}-${index}`}>
                        <th scope="row">{header.name}</th>
                        <td>{header.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>{strings.reader.originalSource}</h3>
              {source.truncated ? (
                <p role="note">{strings.reader.originalTruncated}</p>
              ) : null}
              <pre
                className="original-source"
                tabIndex={0}
                aria-label={strings.reader.originalSource}
              >
                {source.source}
              </pre>
            </>
          )}
        </div>
        <footer>
          <span className="visually-hidden" role="status">
            {copied ? strings.reader.copied : ""}
          </span>
          <button
            type="button"
            className="secondary-button"
            disabled={!source}
            onClick={() => void copySource()}
          >
            <Copy aria-hidden="true" />{" "}
            {copied ? strings.reader.copied : strings.reader.copySource}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!source || saving}
            onClick={() => void saveEml()}
          >
            <Download aria-hidden="true" /> {strings.reader.saveEml}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
