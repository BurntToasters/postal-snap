import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Extension } from "@tiptap/core";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import { TextStyle } from "@tiptap/extension-text-style";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Highlighter,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  Paperclip,
  Redo2,
  RemoveFormatting,
  Send,
  Strikethrough,
  Table2,
  TriangleAlert,
  Underline as UnderlineIcon,
  Undo2,
  X,
} from "lucide-react";
import { api } from "../api";
import { shortcutMod } from "../format";
import { strings } from "../i18n";
import { htmlToPlainText, sanitizeReceivedHtml } from "../security";
import { useAppStore, type ComposerSeed } from "../store";
import type {
  ComposeAttachment,
  ComposeDraft,
  RecipientSuggestion,
} from "../types";
import { moveToolbarFocus } from "./toolbarNav";
import { useDialogFocus } from "./useDialogFocus";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (fontSize: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) =>
              attributes.fontSize
                ? { style: `font-size: ${attributes.fontSize}` }
                : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (fontSize) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain()
            .setMark("textStyle", { fontSize: null })
            .removeEmptyTextStyle()
            .run(),
    };
  },
});

const Indentation = Extension.create({
  name: "indentation",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const rem = Number.parseFloat(element.style.marginLeft);
              return Number.isFinite(rem)
                ? Math.min(6, Math.round(rem / 2))
                : 0;
            },
            renderHTML: (attributes) =>
              attributes.indent
                ? { style: `margin-left: ${attributes.indent * 2}rem` }
                : {},
          },
        },
      },
    ];
  },
});

interface Props {
  accountId: string;
}

export function Composer({ accountId }: Props) {
  const seed = useAppStore((state) => state.composeSeed);
  const account = useAppStore((state) =>
    state.accounts.find((item) => item.id === accountId),
  );
  const accountEmail = account?.email ?? "";
  const fromValue = account
    ? account.displayName
      ? `${account.displayName} <${account.email}>`
      : account.email
    : "";
  const availableSenders = useMemo(() => {
    if (!account) return [];
    const set = new Set([account.email.toLowerCase()]);
    const list = [
      {
        email: account.email,
        label: account.displayName
          ? `${account.displayName} <${account.email}>`
          : account.email,
      },
    ];
    for (const alias of account.aliases ?? []) {
      const lower = alias.toLowerCase();
      if (!set.has(lower)) {
        set.add(lower);
        list.push({
          email: alias,
          label: account.displayName
            ? `${account.displayName} <${alias}>`
            : alias,
        });
      }
    }
    return list;
  }, [account]);

  const [fromAddress, setFromAddress] = useState(() => {
    if (seed?.draft?.from) return seed.draft.from;
    if (seed?.sourceMessage) {
      const rec = seed.sourceMessage.recipients.toLowerCase();
      for (const alias of account?.aliases ?? []) {
        if (rec.includes(alias.toLowerCase())) {
          return alias;
        }
      }
    }
    return account?.email ?? "";
  });

  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [moreFormattingOpen, setMoreFormattingOpen] = useState(false);
  const close = useAppStore((state) => state.closeComposer);
  const setError = useAppStore((state) => state.setError);
  const [to, setTo] = useState(
    seedRecipients(seed, "to", accountEmail, account?.aliases),
  );
  const [cc, setCc] = useState(
    seedRecipients(seed, "cc", accountEmail, account?.aliases),
  );
  const [bcc, setBcc] = useState(
    seed?.draft?.bcc.join(", ") ?? seed?.prefill?.bcc?.join(", ") ?? "",
  );
  const [subject, setSubject] = useState(seedSubject(seed));
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(
    seed?.draft?.attachments ?? seed?.prefill?.attachments ?? [],
  );
  const [draftId, setDraftId] = useState<string | undefined>(seed?.draft?.id);
  const [inlineImages, setInlineImages] = useState(
    new Map<string, { dataUrl: string; contentId: string }>(),
  );
  const [sending, setSending] = useState(false);
  const [showCc, setShowCc] = useState(Boolean(cc));
  const [recipientError, setRecipientError] = useState<string>();
  const [subjectError, setSubjectError] = useState<string>();
  const [saveState, setSaveState] = useState<"unsaved" | "saving" | "saved">(
    seed?.draft ? "saved" : "unsaved",
  );
  const [draftSyncState, setDraftSyncState] = useState(
    seed?.draftSummary?.syncState,
  );
  const [draftSyncDetail, setDraftSyncDetail] = useState(
    seed?.draftSummary?.syncDetail,
  );
  const restoredInlineImages = useRef(false);
  const isDiscarding = useRef(false);
  const draftRevision = useRef(0);
  const saveInFlight = useRef(false);
  const pendingClose = useRef(false);
  const saveDraftRef = useRef<(showStatus?: boolean) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const markUnsaved = useCallback(() => {
    draftRevision.current += 1;
    setSaveState("unsaved");
  }, []);
  const dialogRef = useDialogFocus(requestClose);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false, underline: false }),
      Underline,
      Link.configure({ openOnClick: false }),
      Image.configure({ allowBase64: true }),
      TextStyle,
      FontSize,
      Indentation,
      Color,
      FontFamily,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: seedBody(seed),
    editorProps: {
      attributes: {
        class: "composer-editor",
        "aria-label": strings.composer.messageBody,
      },
      transformPastedHTML: (html) => sanitizeReceivedHtml(html).html,
    },
    onUpdate: markUnsaved,
  });

  const canSend = useMemo(
    () =>
      Boolean(
        editor &&
        !sending &&
        saveState !== "saving" &&
        [...splitAddresses(to), ...splitAddresses(cc), ...splitAddresses(bcc)]
          .length > 0 &&
        validateRecipientFields(to, cc, bcc) === undefined &&
        validateSubject(subject) === undefined,
      ),
    [bcc, cc, editor, saveState, sending, subject, to],
  );

  useEffect(() => {
    if (!editor || restoredInlineImages.current) return;
    restoredInlineImages.current = true;
    const inline = attachments.filter(
      (attachment) => attachment.inline && attachment.contentId,
    );
    if (inline.length === 0) return;
    let cancelled = false;
    void Promise.all(
      inline.map(async (attachment) => ({
        attachment,
        dataUrl: await api.readComposeImage(accountId, attachment.token),
      })),
    )
      .then((loaded) => {
        if (cancelled) return;
        let html = editor.getHTML();
        const next = new Map<string, { dataUrl: string; contentId: string }>();
        for (const { attachment, dataUrl } of loaded) {
          const contentId = attachment.contentId!;
          html = html.split(`cid:${contentId}`).join(dataUrl);
          next.set(attachment.token, { dataUrl, contentId });
        }
        setInlineImages(next);
        editor.commands.setContent(html, { emitUpdate: false });
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      cancelled = true;
    };
  }, [accountId, attachments, editor, setError]);

  const buildDraft = useCallback((): ComposeDraft => {
    let htmlBody = editor?.getHTML() ?? "";
    for (const { dataUrl, contentId } of inlineImages.values())
      htmlBody = htmlBody.split(dataUrl).join(`cid:${contentId}`);
    return {
      id: draftId,
      accountId,
      from: fromAddress.trim() || undefined,
      to: splitAddresses(to),
      cc: splitAddresses(cc),
      bcc: splitAddresses(bcc),
      subject: subject.trim(),
      htmlBody,
      textBody: htmlToPlainText(htmlBody),
      attachments,
      inReplyTo:
        seed?.draft?.inReplyTo ?? seed?.sourceMessage?.messageId ?? undefined,
      references:
        seed?.draft?.references ??
        (seed?.sourceMessage?.messageId
          ? [seed.sourceMessage.messageId]
          : undefined),
    };
  }, [
    accountId,
    attachments,
    bcc,
    cc,
    draftId,
    editor,
    fromAddress,
    inlineImages,
    seed,
    subject,
    to,
  ]);

  const buildDraftRef = useRef(buildDraft);
  const saveStateRef = useRef(saveState);

  useEffect(() => {
    buildDraftRef.current = buildDraft;
    saveStateRef.current = saveState;
  }, [buildDraft, saveState]);

  useEffect(() => {
    if (!editor) return;
    const tryAutosave = () => {
      const draft = buildDraftRef.current();
      if (
        !sending &&
        !isDiscarding.current &&
        saveStateRef.current === "unsaved" &&
        !saveInFlight.current &&
        hasDraftContent(draft, editor.getText())
      ) {
        const revision = draftRevision.current;
        saveInFlight.current = true;
        setSaveState("saving");
        void api
          .saveDraft(draft)
          .then((outcome) => {
            if (isDiscarding.current) return;
            setDraftId(outcome.id);
            if (draftRevision.current === revision) {
              setSaveState("saved");
              setDraftSyncState(outcome.syncState);
              setDraftSyncDetail(undefined);
            } else {
              setSaveState("unsaved");
            }
            announceLocalMailChanged(accountId);
          })
          .catch((cause) => {
            if (isDiscarding.current) return;
            setSaveState("unsaved");
            setError(String(cause));
          })
          .finally(() => {
            saveInFlight.current = false;
            if (pendingClose.current) {
              pendingClose.current = false;
              void saveDraftRef.current(true);
            } else if (
              !isDiscarding.current &&
              draftRevision.current !== revision
            ) {
              void saveDraftRef.current(false);
            }
          });
      }
    };
    const saveTimer = window.setInterval(tryAutosave, 6_000);
    const onBlur = () => tryAutosave();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") tryAutosave();
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(saveTimer);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [accountId, editor, sending, setError]);

  const saveDraft = useCallback(
    async (showStatus = true) => {
      if (sending || isDiscarding.current || saveInFlight.current) return;
      const draft = buildDraft();
      if (!hasDraftContent(draft, editor?.getText() ?? "")) {
        if (showStatus) close();
        return;
      }
      const revision = draftRevision.current;
      saveInFlight.current = true;
      setSaveState("saving");
      try {
        const outcome = await api.saveDraft(draft);
        if (isDiscarding.current) return;
        setDraftId(outcome.id);
        if (draftRevision.current === revision) {
          setSaveState("saved");
          setDraftSyncState(outcome.syncState);
          setDraftSyncDetail(undefined);
        } else {
          setSaveState("unsaved");
        }
        announceLocalMailChanged(accountId);
        if (showStatus && draftRevision.current === revision) close();
      } catch (cause) {
        if (isDiscarding.current) return;
        setSaveState("unsaved");
        setError(String(cause));
      } finally {
        saveInFlight.current = false;
        if (pendingClose.current) {
          pendingClose.current = false;
          void saveDraftRef.current(true);
        } else if (
          !isDiscarding.current &&
          draftRevision.current !== revision
        ) {
          void saveDraftRef.current(false);
        }
      }
    },
    [accountId, buildDraft, close, editor, sending, setError],
  );

  useEffect(() => {
    saveDraftRef.current = saveDraft;
  }, [saveDraft]);

  async function requestClose() {
    if (isDiscarding.current) return;
    if (sending || saveInFlight.current) {
      pendingClose.current = true;
      return;
    }
    const draft = buildDraft();
    if (!hasDraftContent(draft, editor?.getText() ?? "")) {
      close();
      return;
    }
    if (saveState === "saved") {
      close();
      return;
    }
    if (saveState === "unsaved") {
      const confirmed = await api.showNativeConfirm(
        strings.appName,
        strings.composer.saveCloseQuestion,
      );
      if (!confirmed) return;
    }
    void saveDraft(true);
  }

  async function discardDraft() {
    if (sending || isDiscarding.current || saveInFlight.current) return;
    if (hasDraftContent(buildDraft(), editor?.getText() ?? "")) {
      const confirmed = await api.showNativeConfirm(
        strings.composer.discard,
        strings.composer.discardQuestion,
      );
      if (!confirmed) return;
    }
    isDiscarding.current = true;
    try {
      if (draftId) await api.deleteDraft(draftId, accountId);
      await api.releaseComposeAttachments(
        accountId,
        attachments.map((attachment) => attachment.token),
      );
      announceLocalMailChanged(accountId);
      close();
    } catch (cause) {
      isDiscarding.current = false;
      setError(String(cause));
    }
  }

  const totalAttachmentBytes = useMemo(
    () => attachments.reduce((sum, item) => sum + (item.size ?? 0), 0),
    [attachments],
  );
  const isAttachmentSizeWarning = totalAttachmentBytes > 25 * 1024 * 1024;

  const sendMessage = useCallback(async () => {
    const validation = validateRecipientFields(to, cc, bcc);
    const subjectValidation = validateSubject(subject);
    setRecipientError(validation);
    setSubjectError(subjectValidation);
    if (!canSend || validation || subjectValidation) return;
    pendingClose.current = false;
    setSending(true);
    try {
      const outcome = await api.sendMessage(buildDraft());
      announceLocalMailChanged(accountId);
      if (outcome.detail) setError(outcome.detail);
      if (outcome.state === "scheduled") {
        useAppStore.getState().selectLocalView("outbox");
      }
      close();
    } catch (cause) {
      announceLocalMailChanged(accountId);
      setError(String(cause));
    } finally {
      setSending(false);
    }
  }, [accountId, bcc, buildDraft, canSend, cc, close, setError, subject, to]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (minimized) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void sendMessage();
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveDraft(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [minimized, saveDraft, sendMessage]);

  async function addAttachments() {
    try {
      const selected = await api.chooseAttachments(accountId, false);
      setAttachments((items) => [...items, ...selected]);
      if (selected.length) markUnsaved();
    } catch (cause) {
      setError(String(cause));
    }
  }

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

  function addLink() {
    const current = editor?.getAttributes("link").href as string | undefined;
    const raw = window.prompt(
      strings.composer.webAddress,
      current ?? "https://",
    );
    if (raw === null) return;
    const href = raw.trim().slice(0, 2000);
    if (!/^(https?|mailto):/i.test(href) || /\s/.test(href)) {
      setError(strings.composer.unsafeLink);
      return;
    }
    editor?.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }

  function adjustIndent(delta: number) {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const transaction = editor.state.tr;
    editor.state.doc.nodesBetween(from, to, (node, position) => {
      if (!["paragraph", "heading"].includes(node.type.name)) return;
      const current = Number(node.attrs.indent ?? 0);
      const indent = Math.max(0, Math.min(6, current + delta));
      transaction.setNodeMarkup(position, undefined, { ...node.attrs, indent });
    });
    if (transaction.docChanged) editor.view.dispatch(transaction);
    editor.commands.focus();
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

  if (minimized) {
    return (
      <div
        className="composer-docked-pill"
        role="region"
        aria-label={composerTitle(seed)}
      >
        <button
          type="button"
          className="docked-pill-restore"
          onClick={() => setMinimized(false)}
          aria-label={`${strings.composer.restore}: ${subject.trim() || strings.common.noSubject}`}
        >
          <span className="docked-pill-title">
            {subject.trim() || strings.common.noSubject}
          </span>
          <span className="docked-pill-status">
            {saveState === "saving"
              ? strings.common.saving
              : saveState === "saved"
                ? strings.composer.draftSaved
                : ""}
          </span>
        </button>
        <div className="docked-pill-actions">
          <button
            className="icon-button"
            type="button"
            onClick={() => setMinimized(false)}
            aria-label={strings.composer.maximize}
            title={strings.composer.maximize}
          >
            <Maximize2 size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => void requestClose()}
            aria-label={strings.composer.saveClose}
            title={strings.composer.saveClose}
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`modal-layer composer-layer${maximized ? " composer-layer-maximized" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="composer-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => void requestClose()}
        disabled={sending || saveState === "saving"}
      />
      <section
        className={`composer-window${maximized ? " composer-maximized" : ""}`}
        ref={dialogRef}
      >
        <header>
          <span>
            <h1 id="composer-title">{composerTitle(seed)}</h1>
            <small aria-live="polite">
              {saveState === "saving"
                ? strings.common.saving
                : saveState === "saved"
                  ? strings.composer.draftSaved
                  : ""}
            </small>
          </span>
          <div className="composer-window-controls">
            <button
              className="icon-button"
              type="button"
              onClick={() => setMinimized(true)}
              disabled={sending}
              aria-label={strings.composer.minimize}
              title={strings.composer.minimize}
            >
              <Minus />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => setMaximized((v) => !v)}
              disabled={sending}
              aria-label={
                maximized ? strings.composer.restore : strings.composer.maximize
              }
              title={
                maximized ? strings.composer.restore : strings.composer.maximize
              }
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => void requestClose()}
              disabled={sending || saveState === "saving"}
              aria-label={strings.composer.saveClose}
              title={strings.composer.saveClose}
            >
              <X />
            </button>
          </div>
        </header>
        {draftSyncState && draftSyncState !== "synced" ? (
          <div
            className={`draft-sync-banner ${draftSyncState}`}
            role={draftSyncState === "conflict" ? "alert" : "status"}
          >
            <TriangleAlert aria-hidden="true" />
            <span>
              <strong>
                {draftSyncState === "conflict"
                  ? strings.composer.recoveredTitle
                  : draftSyncState === "localOnly"
                    ? strings.composer.localTitle
                    : strings.composer.syncingTitle}
              </strong>
              <small>
                {draftSyncDetail ??
                  (draftSyncState === "conflict"
                    ? strings.composer.recoveredDetail
                    : draftSyncState === "localOnly"
                      ? strings.composer.localDetail
                      : strings.composer.syncingDetail)}
              </small>
            </span>
          </div>
        ) : null}
        <div className="address-fields">
          <label className="from-field">
            <span>{strings.composer.from}</span>
            {availableSenders.length > 1 ? (
              <select
                className="composer-from-select"
                value={fromAddress}
                onChange={(event) => {
                  setFromAddress(event.target.value);
                  markUnsaved();
                }}
                aria-label={strings.composer.fromAlias}
              >
                {availableSenders.map((item) => (
                  <option key={item.email} value={item.email}>
                    {item.label}
                  </option>
                ))}
              </select>
            ) : (
              <input readOnly value={fromValue} aria-readonly="true" />
            )}
          </label>
          <div className="to-field-row">
            <label className="to-field">
              <span>{strings.composer.to}</span>
              <RecipientField
                id="composer-to"
                accountId={accountId}
                value={to}
                onChange={(value) => {
                  setTo(value);
                  markUnsaved();
                }}
                onBlur={() =>
                  setRecipientError(validateRecipientFields(to, cc, bcc))
                }
                placeholder={strings.composer.addressPlaceholder}
                autoFocus
                ariaInvalid={Boolean(recipientError)}
                ariaDescribedBy={recipientError ? "recipient-error" : undefined}
              />
            </label>
            <button
              type="button"
              className="cc-toggle"
              aria-expanded={showCc}
              onClick={(event) => {
                event.preventDefault();
                setShowCc((value) => !value);
              }}
            >
              {strings.composer.ccBcc}
            </button>
          </div>
          {showCc ? (
            <>
              <label>
                <span>{strings.composer.cc}</span>
                <RecipientField
                  id="composer-cc"
                  accountId={accountId}
                  value={cc}
                  onChange={(value) => {
                    setCc(value);
                    markUnsaved();
                  }}
                  onBlur={() =>
                    setRecipientError(validateRecipientFields(to, cc, bcc))
                  }
                  ariaInvalid={Boolean(recipientError)}
                />
              </label>
              <label>
                <span>{strings.composer.bcc}</span>
                <RecipientField
                  id="composer-bcc"
                  accountId={accountId}
                  value={bcc}
                  onChange={(value) => {
                    setBcc(value);
                    markUnsaved();
                  }}
                  onBlur={() =>
                    setRecipientError(validateRecipientFields(to, cc, bcc))
                  }
                  ariaInvalid={Boolean(recipientError)}
                />
              </label>
            </>
          ) : null}
          {recipientError ? (
            <p id="recipient-error" className="field-error" role="alert">
              {recipientError}
            </p>
          ) : null}
          <label>
            <span>{strings.composer.subject}</span>
            <input
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
                markUnsaved();
              }}
              onBlur={() => setSubjectError(validateSubject(subject))}
              maxLength={998}
              aria-invalid={Boolean(subjectError)}
              aria-describedby={subjectError ? "subject-error" : undefined}
            />
          </label>
          {subjectError ? (
            <p id="subject-error" className="field-error" role="alert">
              {subjectError}
            </p>
          ) : null}
        </div>
        <div
          className="format-toolbar"
          role="toolbar"
          aria-label={strings.composer.formatting}
          onKeyDown={moveToolbarFocus}
        >
          <div className="toolbar-group">
            <button
              type="button"
              onClick={() => editor?.chain().focus().undo().run()}
              aria-label={strings.composer.undo}
              title={strings.composer.undo}
            >
              <Undo2 />
            </button>
            <button
              type="button"
              onClick={() => editor?.chain().focus().redo().run()}
              aria-label={strings.composer.redo}
              title={strings.composer.redo}
            >
              <Redo2 />
            </button>
          </div>

          <div className="toolbar-group">
            <select
              aria-label={strings.composer.font}
              title={strings.composer.font}
              defaultValue=""
              onChange={(event) =>
                event.target.value
                  ? editor
                      ?.chain()
                      .focus()
                      .setFontFamily(event.target.value)
                      .run()
                  : editor?.chain().focus().unsetFontFamily().run()
              }
            >
              <option value="">{strings.composer.defaultFont}</option>
              <option value="Arial">Arial</option>
              <option value="Georgia">Georgia</option>
              <option value="Verdana">Verdana</option>
              <option value="'Courier New'">Courier</option>
            </select>
            <select
              aria-label={strings.composer.fontSize}
              title={strings.composer.fontSize}
              defaultValue="16px"
              onChange={(event) =>
                editor?.chain().focus().setFontSize(event.target.value).run()
              }
            >
              <option value="12px">{strings.composer.small}</option>
              <option value="16px">{strings.composer.normal}</option>
              <option value="20px">{strings.composer.large}</option>
              <option value="26px">{strings.composer.extraLarge}</option>
            </select>
          </div>

          <div className="toolbar-group">
            <button
              className={editor?.isActive("bold") ? "active" : ""}
              type="button"
              onClick={() => editor?.chain().focus().toggleBold().run()}
              aria-label={strings.composer.bold}
              aria-pressed={Boolean(editor?.isActive("bold"))}
              title={strings.composer.bold}
            >
              <Bold />
            </button>
            <button
              className={editor?.isActive("italic") ? "active" : ""}
              type="button"
              onClick={() => editor?.chain().focus().toggleItalic().run()}
              aria-label={strings.composer.italic}
              aria-pressed={Boolean(editor?.isActive("italic"))}
              title={strings.composer.italic}
            >
              <Italic />
            </button>
            <button
              className={editor?.isActive("underline") ? "active" : ""}
              type="button"
              onClick={() => editor?.chain().focus().toggleUnderline().run()}
              aria-label={strings.composer.underline}
              aria-pressed={Boolean(editor?.isActive("underline"))}
              title={strings.composer.underline}
            >
              <UnderlineIcon />
            </button>
            <button
              className={editor?.isActive("strike") ? "active" : ""}
              type="button"
              onClick={() => editor?.chain().focus().toggleStrike().run()}
              aria-label={strings.composer.strike}
              aria-pressed={Boolean(editor?.isActive("strike"))}
              title={strings.composer.strike}
            >
              <Strikethrough />
            </button>
            <label className="color-control" title={strings.composer.textColor}>
              <input
                type="color"
                aria-label={strings.composer.textColor}
                defaultValue={
                  typeof document !== "undefined" &&
                  (document.documentElement.dataset.theme === "dark" ||
                    (document.documentElement.dataset.theme !== "light" &&
                      window.matchMedia?.("(prefers-color-scheme: dark)")
                        ?.matches))
                    ? "#e8eef3"
                    : "#20252b"
                }
                onChange={(event) =>
                  editor?.chain().focus().setColor(event.target.value).run()
                }
              />
              <span>A</span>
            </label>
            <button
              type="button"
              className={editor?.isActive("highlight") ? "active" : ""}
              onClick={() =>
                editor
                  ?.chain()
                  .focus()
                  .toggleHighlight({ color: highlightColor() })
                  .run()
              }
              aria-label={strings.composer.highlight}
              aria-pressed={Boolean(editor?.isActive("highlight"))}
              title={strings.composer.highlight}
            >
              <Highlighter />
            </button>
          </div>

          <div className="toolbar-group format-toolbar-more">
            <button
              type="button"
              className={moreFormattingOpen ? "active" : ""}
              aria-expanded={moreFormattingOpen}
              aria-controls="composer-more-formatting"
              aria-label={strings.composer.moreFormatting}
              title={strings.composer.moreFormatting}
              onClick={() => setMoreFormattingOpen((value) => !value)}
            >
              <MoreHorizontal />
            </button>
          </div>

          <div
            id="composer-more-formatting"
            className={`format-toolbar-secondary ${moreFormattingOpen ? "open" : ""}`}
            hidden={!moreFormattingOpen}
          >
            <div className="toolbar-group">
              <button
                type="button"
                className={
                  editor?.isActive({ textAlign: "left" }) ? "active" : ""
                }
                onClick={() =>
                  editor?.chain().focus().setTextAlign("left").run()
                }
                aria-label={strings.composer.alignLeft}
                aria-pressed={Boolean(editor?.isActive({ textAlign: "left" }))}
                title={strings.composer.alignLeft}
              >
                <AlignLeft />
              </button>
              <button
                type="button"
                className={
                  editor?.isActive({ textAlign: "center" }) ? "active" : ""
                }
                onClick={() =>
                  editor?.chain().focus().setTextAlign("center").run()
                }
                aria-label={strings.composer.alignCenter}
                aria-pressed={Boolean(
                  editor?.isActive({ textAlign: "center" }),
                )}
                title={strings.composer.alignCenter}
              >
                <AlignCenter />
              </button>
              <button
                type="button"
                className={
                  editor?.isActive({ textAlign: "right" }) ? "active" : ""
                }
                onClick={() =>
                  editor?.chain().focus().setTextAlign("right").run()
                }
                aria-label={strings.composer.alignRight}
                aria-pressed={Boolean(editor?.isActive({ textAlign: "right" }))}
                title={strings.composer.alignRight}
              >
                <AlignRight />
              </button>
            </div>

            <div className="toolbar-group">
              <button
                type="button"
                className={editor?.isActive("bulletList") ? "active" : ""}
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
                aria-label={strings.composer.bullets}
                aria-pressed={Boolean(editor?.isActive("bulletList"))}
                title={strings.composer.bullets}
              >
                <List />
              </button>
              <button
                type="button"
                className={editor?.isActive("orderedList") ? "active" : ""}
                onClick={() =>
                  editor?.chain().focus().toggleOrderedList().run()
                }
                aria-label={strings.composer.numbers}
                aria-pressed={Boolean(editor?.isActive("orderedList"))}
                title={strings.composer.numbers}
              >
                <ListOrdered />
              </button>
              <button
                type="button"
                onClick={() => adjustIndent(-1)}
                aria-label={strings.composer.indentLess}
                title={strings.composer.indentLess}
              >
                <IndentDecrease />
              </button>
              <button
                type="button"
                onClick={() => adjustIndent(1)}
                aria-label={strings.composer.indentMore}
                title={strings.composer.indentMore}
              >
                <IndentIncrease />
              </button>
            </div>

            <div className="toolbar-group">
              <button
                type="button"
                className={editor?.isActive("link") ? "active" : ""}
                onClick={addLink}
                aria-label={strings.composer.insertLink}
                aria-pressed={Boolean(editor?.isActive("link"))}
                title={strings.composer.insertLink}
              >
                <LinkIcon />
              </button>
              <button
                type="button"
                onClick={() =>
                  editor
                    ?.chain()
                    .focus()
                    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                    .run()
                }
                aria-label={strings.composer.insertTable}
                title={strings.composer.insertTable}
              >
                <Table2 />
              </button>
              <button
                type="button"
                onClick={() =>
                  editor?.chain().focus().setHorizontalRule().run()
                }
                aria-label={strings.composer.insertRule}
                title={strings.composer.insertRule}
              >
                <Minus />
              </button>
              <button
                type="button"
                onClick={() =>
                  editor?.chain().focus().clearNodes().unsetAllMarks().run()
                }
                aria-label={strings.composer.clearFormatting}
                title={strings.composer.clearFormatting}
              >
                <RemoveFormatting />
              </button>
            </div>
          </div>
        </div>
        <EditorContent editor={editor} />
        {attachments.length > 0 ? (
          <div className="compose-attachments">
            {attachments.map((item, index) => (
              <span key={`${item.token}-${index}`}>
                {item.inline ? strings.composer.imagePrefix : ""}
                {item.filename}
                <button
                  type="button"
                  onClick={() => removeAttachment(index)}
                  disabled={sending || saveState === "saving"}
                  aria-label={strings.composer.removeAttachment(item.filename)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {isAttachmentSizeWarning ? (
          <div className="draft-sync-banner localOnly" role="alert">
            <TriangleAlert aria-hidden="true" />
            <span>
              <strong>{strings.composer.attachmentSizeWarning}</strong>
            </span>
          </div>
        ) : null}
        <footer>
          <button
            className="primary-button send-button"
            type="button"
            disabled={!canSend}
            onClick={() => void sendMessage()}
            aria-label={
              sending ? strings.composer.sending : strings.composer.send
            }
            title={`${sending ? strings.composer.sending : strings.composer.send} (${shortcutMod()}↵)`}
          >
            <Send />
            <span>
              {sending ? strings.composer.sending : strings.composer.send}
            </span>
            <kbd className="send-kbd-hint">{`${shortcutMod()}↵`}</kbd>
          </button>
          <button
            className="toolbar-button"
            type="button"
            onClick={() => void addAttachments()}
            disabled={sending}
          >
            <Paperclip />
            {strings.composer.attach}
          </button>
          <button
            className="toolbar-button"
            type="button"
            onClick={() => void addInlineImage()}
            disabled={sending}
          >
            <ImagePlus />
            {strings.composer.picture}
          </button>
          <button
            className="discard-button"
            type="button"
            onClick={() => void discardDraft()}
            disabled={sending || saveState === "saving"}
          >
            {strings.composer.discard}
          </button>
        </footer>
      </section>
    </div>
  );
}

function splitAddresses(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"' && (i === 0 || value[i - 1] !== "\\")) {
      inQuotes = !inQuotes;
      current += char;
    } else if ((char === "," || char === ";") && !inQuotes) {
      const trimmed = current.trim();
      if (trimmed) result.push(trimmed);
      current = "";
    } else {
      current += char;
    }
  }
  const last = current.trim();
  if (last) result.push(last);
  return result;
}

function validateRecipientFields(
  to: string,
  cc: string,
  bcc: string,
): string | undefined {
  const addresses = [to, cc, bcc].flatMap(splitAddresses);
  if (addresses.length === 0) return strings.composer.recipientRequired;
  if (addresses.some(hasControlCharacter))
    return strings.composer.invalidHeader;
  if (addresses.some((value) => !isMailbox(value)))
    return strings.composer.invalidRecipient;
  return undefined;
}

function isMailbox(value: string): boolean {
  if (hasControlCharacter(value)) return false;
  const bracketed = value.match(/<([^<>]+)>$/)?.[1];
  const address = (bracketed ?? value).trim();
  return /^[^\s@<>]+@[^\s@<>]+$/.test(address) && address.length <= 320;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function validateSubject(value: string): string | undefined {
  return hasControlCharacter(value)
    ? strings.composer.invalidSubject
    : undefined;
}

function hasDraftContent(draft: ComposeDraft, editorText: string): boolean {
  return Boolean(
    draft.to.length ||
    draft.cc.length ||
    draft.bcc.length ||
    draft.subject ||
    editorText.trim() ||
    draft.attachments.length,
  );
}
function tokenAtCaret(
  value: string,
  caret: number,
): { token: string; start: number } {
  let start = caret;
  while (start > 0 && value[start - 1] !== "," && value[start - 1] !== ";") {
    start -= 1;
  }
  let end = caret;
  while (end < value.length && value[end] !== "," && value[end] !== ";") {
    end += 1;
  }
  return { token: value.slice(start, end).trim(), start };
}

function RecipientField({
  id,
  accountId,
  value,
  onChange,
  onBlur,
  placeholder,
  autoFocus,
  ariaInvalid,
  ariaDescribedBy,
}: {
  id: string;
  accountId: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  const [suggestions, setSuggestions] = useState<RecipientSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fetchTimer = useRef(0);
  const listId = `${id}-suggestions`;

  useEffect(
    () => () => {
      window.clearTimeout(fetchTimer.current);
    },
    [],
  );

  function requestSuggestions(nextValue: string, caret: number | null) {
    window.clearTimeout(fetchTimer.current);
    const position = caret ?? nextValue.length;
    const { token } = tokenAtCaret(
      nextValue,
      Math.min(position, nextValue.length),
    );
    if (token.length < 1) {
      setOpen(false);
      setSuggestions([]);
      return;
    }
    fetchTimer.current = window.setTimeout(() => {
      void api
        .suggestRecipients(accountId, token, 8)
        .then((results) => {
          setSuggestions(results);
          setActiveIndex(0);
          setOpen(results.length > 0);
        })
        .catch(() => undefined);
    }, 150);
  }

  function acceptSuggestion(suggestion: RecipientSuggestion) {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? value.length;
    const { start } = tokenAtCaret(value, Math.min(caret, value.length));
    let end = start;
    while (end < value.length && value[end] !== "," && value[end] !== ";") {
      end += 1;
    }
    const separator = end < value.length ? value[end] : ",";
    const remainder = end < value.length ? value.slice(end + 1) : "";
    const nextValue = `${value.slice(0, start)}${suggestion.address}${separator} ${remainder.trimStart()}`;
    const nextCaret = start + suggestion.address.length + 2;
    onChange(nextValue);
    setOpen(false);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    }, 0);
  }

  return (
    <div className="recipient-combobox">
      <input
        id={id}
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        onChange={(event) => {
          onChange(event.target.value);
          requestSuggestions(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => {
              const delta = event.key === "ArrowDown" ? 1 : -1;
              return (index + delta + suggestions.length) % suggestions.length;
            });
          } else if (event.key === "Enter" || event.key === "Tab") {
            const suggestion = suggestions[activeIndex];
            if (suggestion) {
              event.preventDefault();
              acceptSuggestion(suggestion);
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
        }}
        onBlur={() => {
          window.clearTimeout(fetchTimer.current);
          setOpen(false);
          onBlur?.();
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={strings.composer.suggestedRecipients}
          className="recipient-suggestions"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.address}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "active" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => acceptSuggestion(suggestion)}
            >
              <span className="suggestion-name">
                {suggestion.name || suggestion.address}
              </span>
              {suggestion.name ? (
                <span className="suggestion-address">{suggestion.address}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function seedRecipients(
  seed: ComposerSeed | undefined,
  field: "to" | "cc",
  accountEmail: string,
  aliases: string[] = [],
): string {
  if (!seed) return "";
  if (seed.draft) return seed.draft[field].join(", ");
  if (seed.prefill?.[field]) return seed.prefill[field]?.join(", ") ?? "";
  const message = seed.sourceMessage;
  if (!message) return "";
  if (seed.composeMode === "forward") return "";
  const replyAddress = message.replyTo ?? message.senderAddress;
  if (field === "to") return replyAddress ?? message.to.join(", ");
  const ownAddresses = [accountEmail, ...aliases];
  return seed.composeMode === "replyAll"
    ? [...message.to, ...message.cc]
        .filter(
          (address) =>
            ![...ownAddresses, message.senderAddress, replyAddress].some(
              (excluded) => excluded?.toLowerCase() === address.toLowerCase(),
            ),
        )
        .join(", ")
    : "";
}
function seedSubject(seed?: ComposerSeed): string {
  const subject =
    seed?.draft?.subject ??
    seed?.prefill?.subject ??
    seed?.sourceMessage?.subject;
  if (!subject) return "";
  if (!seed?.composeMode) return subject;
  const prefix =
    seed.composeMode === "forward"
      ? strings.composer.forwardPrefix
      : strings.composer.replyPrefix;
  return new RegExp(`^(${prefix}|re|fwd):`, "i").test(subject)
    ? subject
    : `${prefix} ${subject}`;
}
function seedBody(seed?: ComposerSeed): string {
  const draftHtml = seed?.draft?.htmlBody ?? seed?.prefill?.htmlBody;
  const draftText = seed?.draft?.textBody ?? seed?.prefill?.textBody;
  if (!seed?.sourceMessage) {
    if (!draftHtml && !draftText) return "<p></p>";
    return (
      draftHtml ??
      `<p>${escapeHtml(draftText ?? "").replace(/\n/g, "<br>")}</p>`
    );
  }
  const message = seed.sourceMessage;
  const intro =
    seed.composeMode === "forward"
      ? strings.composer.forwardedMessage
      : strings.composer.wrote(
          message.receivedAt,
          message.senderName ||
            message.senderAddress ||
            strings.composer.sender,
        );
  return `<p></p><p><br></p><blockquote><p><strong>${escapeHtml(intro)}</strong></p>${message.htmlBody ? sanitizeReceivedHtml(message.htmlBody).html : `<p>${escapeHtml(message.textBody).replace(/\n/g, "<br>")}</p>`}</blockquote>`;
}

function composerTitle(seed?: ComposerSeed): string {
  if (seed?.draft) return strings.composer.editDraft;
  if (seed?.composeMode === "reply" || seed?.composeMode === "replyAll")
    return strings.composer.reply;
  if (seed?.composeMode === "forward") return strings.composer.forward;
  return strings.composer.newMessage;
}
function highlightColor(): string {
  if (typeof document === "undefined") return "#fff1a8";
  const theme = document.documentElement.dataset.theme;
  const dark =
    theme === "dark" ||
    (theme !== "light" &&
      window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
  return dark ? "#7a6200" : "#fff1a8";
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

function announceLocalMailChanged(accountId: string) {
  window.dispatchEvent(
    new CustomEvent("postal:local-mail-changed", { detail: accountId }),
  );
}
