import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { api } from "../../api";
import { sanitizeComposeHtml } from "../../security";
import { strings } from "../../i18n";
import type { BodyFormat, ComposeAttachment } from "../../types";
import { readPastedImage } from "./pasteImage";

type SaveState = "unsaved" | "saving" | "saved";

interface Options {
  accountId: string;
  initialAttachments: ComposeAttachment[];
  editor: Editor | null;
  editorRef: RefObject<Editor | null>;
  bodyFormatRef: RefObject<BodyFormat>;
  sending: boolean;
  saveState: SaveState;
  minimized: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  isSendingRef: RefObject<boolean>;
  markUnsaved: () => void;
  setError: (error?: string) => void;
}

/** Attachment list, inline images, and every path that adds or removes them. */
export function useComposerAttachments({
  accountId,
  initialAttachments,
  editor,
  editorRef,
  bodyFormatRef,
  sending,
  saveState,
  minimized,
  dialogRef,
  isSendingRef,
  markUnsaved,
  setError,
}: Options) {
  const [attachments, setAttachments] =
    useState<ComposeAttachment[]>(initialAttachments);
  const [inlineImages, setInlineImages] = useState(
    new Map<string, { dataUrl: string; contentId: string }>(),
  );
  const [dropActive, setDropActive] = useState(false);
  const [dropNote, setDropNote] = useState("");
  const [attachmentPreview, setAttachmentPreview] = useState<{
    filename: string;
    src: string;
  } | null>(null);
  const restoredInlineImages = useRef(new Set<string>());

  useEffect(() => {
    if (!editor) return;
    const inline = attachments.filter(
      (attachment) =>
        attachment.inline &&
        attachment.contentId &&
        !restoredInlineImages.current.has(attachment.token),
    );
    if (inline.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(
      inline.map(async (attachment) => ({
        attachment,
        dataUrl: await api.readComposeImage(accountId, attachment.token),
      })),
    ).then((results) => {
      if (cancelled) return;
      const loaded = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      for (const { attachment } of loaded)
        restoredInlineImages.current.add(attachment.token);
      if (loaded.length > 0) {
        let html = editor.getHTML();
        for (const { attachment, dataUrl } of loaded) {
          const contentId = attachment.contentId!;
          html = html.split(`cid:${contentId}`).join(dataUrl);
        }
        setInlineImages((items) => {
          const next = new Map(items);
          for (const { attachment, dataUrl } of loaded) {
            next.set(attachment.token, {
              dataUrl,
              contentId: attachment.contentId!,
            });
          }
          return next;
        });
        editor.commands.setContent(sanitizeComposeHtml(html), {
          emitUpdate: false,
        });
      }
      const failed = results.length - loaded.length;
      if (failed > 0) setError(strings.composer.inlineImageFailed(failed));
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, attachments, editor, setError]);

  const totalAttachmentBytes = useMemo(
    () => attachments.reduce((sum, item) => sum + (item.size ?? 0), 0),
    [attachments],
  );
  const isAttachmentSizeWarning = totalAttachmentBytes > 25 * 1024 * 1024;

  // Native drop: Rust holds the paths and reports only a position. Attach
  // only when the drop lands on this open composer.
  useEffect(() => {
    if (minimized) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const overComposer = (x: number, y: number) => {
      const box = dialogRef.current?.getBoundingClientRect();
      return Boolean(
        box &&
        !isSendingRef.current &&
        !dialogRef.current?.querySelector('[role="alertdialog"]') &&
        x >= box.left &&
        x <= box.right &&
        y >= box.top &&
        y <= box.bottom,
      );
    };
    void api
      .onComposeDrag((event) => {
        if (event.phase === "leave") {
          setDropActive(false);
          return;
        }
        const over = overComposer(event.x, event.y);
        setDropActive(event.phase === "over" && over);
        if (event.phase !== "drop" || !over) return;
        void api
          .attachDroppedFiles(accountId)
          .then((dropped) => {
            if (dropped.length === 0) return;
            setAttachments((items) => [...items, ...dropped]);
            setDropNote(strings.composer.dropAttached(dropped.length));
            markUnsaved();
          })
          .catch((cause) => setError(String(cause)));
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      });
    return () => {
      active = false;
      unlisten?.();
      setDropActive(false);
    };
  }, [accountId, dialogRef, isSendingRef, markUnsaved, minimized, setError]);

  async function addAttachments() {
    try {
      const selected = await api.chooseAttachments(accountId, false);
      setAttachments((items) => [...items, ...selected]);
      if (selected.length) markUnsaved();
    } catch (cause) {
      setError(String(cause));
    }
  }

  const pasteImage = async (files: File[], tooLarge: boolean) => {
    if (tooLarge) {
      setError(strings.composer.pastedImageTooLarge);
      if (files.length === 0) return;
    }
    for (const file of files) {
      let selectedToken: string | undefined;
      try {
        const dataUrl = await readPastedImage(file);
        const selected = await api.stagePastedImage(accountId, dataUrl);
        selectedToken = selected.token;
        if (bodyFormatRef.current === "plain") {
          setAttachments((items) => [...items, { ...selected, inline: false }]);
        } else {
          const contentId = `postal-${crypto.randomUUID()}@inline`;
          editorRef.current
            ?.chain()
            .focus()
            .setImage({ src: dataUrl, alt: strings.composer.inlineImage })
            .run();
          setInlineImages((items) =>
            new Map(items).set(selected.token, { dataUrl, contentId }),
          );
          setAttachments((items) => [
            ...items,
            { ...selected, inline: true, contentId },
          ]);
        }
        markUnsaved();
      } catch (cause) {
        if (selectedToken)
          void api
            .releaseComposeAttachments(accountId, [selectedToken])
            .catch(() => undefined);
        setError(String(cause));
      }
    }
  };

  async function addInlineImage() {
    let selectedToken: string | undefined;
    try {
      const [selected] = await api.chooseAttachments(accountId, true);
      if (!selected) return;
      selectedToken = selected.token;
      const dataUrl = await api.readComposeImage(accountId, selected.token);
      const contentId = `postal-${crypto.randomUUID()}@inline`;
      editor
        ?.chain()
        .focus()
        .setImage({ src: dataUrl, alt: strings.composer.inlineImage })
        .run();
      setInlineImages((items) =>
        new Map(items).set(selected.token, { dataUrl, contentId }),
      );
      setAttachments((items) => [
        ...items,
        { ...selected, inline: true, contentId },
      ]);
      markUnsaved();
    } catch (cause) {
      if (selectedToken)
        void api
          .releaseComposeAttachments(accountId, [selectedToken])
          .catch(() => undefined);
      setError(String(cause));
    }
  }

  function removeAllAttachments() {
    if (sending || saveState === "saving" || attachments.length < 2) return;
    const current = attachments;
    if (editor) {
      const sources = new Set(
        current
          .map((item) => inlineImages.get(item.token)?.dataUrl)
          .filter((src): src is string => Boolean(src)),
      );
      if (sources.size > 0) {
        const ranges: Array<{ from: number; to: number }> = [];
        editor.state.doc.descendants((node, position) => {
          if (
            node.type.name === "image" &&
            sources.has(String(node.attrs.src))
          ) {
            ranges.push({ from: position, to: position + node.nodeSize });
          }
        });
        const transaction = editor.state.tr;
        for (const range of ranges.reverse())
          transaction.delete(range.from, range.to);
        if (transaction.docChanged) editor.view.dispatch(transaction);
      }
    }
    setInlineImages(new Map());
    setAttachments([]);
    markUnsaved();
    void api
      .releaseComposeAttachments(
        accountId,
        current.map((item) => item.token),
      )
      .catch((cause) => setError(String(cause)));
  }

  async function previewComposeImage(item: ComposeAttachment) {
    try {
      const src = await api.readComposeImage(accountId, item.token);
      setAttachmentPreview({ filename: item.filename, src });
    } catch (cause) {
      setError(String(cause));
    }
  }

  function removeAttachment(index: number) {
    const item = attachments[index];
    const inline = item ? inlineImages.get(item.token) : undefined;
    if (inline && editor) {
      const transaction = editor.state.tr;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === "image" && node.attrs.src === inline.dataUrl)
          transaction.delete(position, position + node.nodeSize);
      });
      if (transaction.docChanged) editor.view.dispatch(transaction);
      setInlineImages((items) => {
        const next = new Map(items);
        next.delete(item.token);
        return next;
      });
    }
    setAttachments((all) => all.filter((_, itemIndex) => itemIndex !== index));
    markUnsaved();
    if (item)
      void api
        .releaseComposeAttachments(accountId, [item.token])
        .catch((cause) => setError(String(cause)));
  }

  /** Turns inline pictures into file attachments for a plain-text body. */
  function stripInlineImages() {
    // No HTML remains to show a picture, so pictures travel as files.
    setInlineImages(new Map());
    setAttachments((items) =>
      items.map((item) =>
        item.inline ? { ...item, inline: false, contentId: undefined } : item,
      ),
    );
  }

  return {
    attachments,
    inlineImages,
    dropActive,
    dropNote,
    attachmentPreview,
    setAttachmentPreview,
    totalAttachmentBytes,
    isAttachmentSizeWarning,
    addAttachments,
    addInlineImage,
    removeAttachment,
    removeAllAttachments,
    previewComposeImage,
    pasteImage,
    stripInlineImages,
  };
}
