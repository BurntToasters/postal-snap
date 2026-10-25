import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
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
import { Maximize2, Paperclip, TriangleAlert, X } from "lucide-react";
import { api } from "../api";
import { useComposerDraftPersistence } from "./composer/useComposerDraftPersistence";
import { formatBytes, formatMessageDate } from "../format";
import {
  CONTEXT_ACTION_EVENT,
  type ContextMenuActionDetail,
} from "../contextMenu";
import { strings } from "../i18n";
import { sanitizeComposeHtml } from "../security";
import { readableMessageText } from "./reader/readerUtils";
import { rememberedComposerSize } from "../composerSize";
import {
  addressedFrom,
  rememberFromAddress,
  rememberedFromAddress,
} from "../fromAddress";
import { useAppStore } from "../store";
import type { BodyFormat, ComposeAttachment, ComposeDraft } from "../types";
import { useSettingsSave } from "./settings/useSettingsSave";
import { useDialogFocus } from "./useDialogFocus";
import { AddressFields } from "./composer/addressFields";
import { ConfirmDialog } from "./composer/confirmDialog";
import { ComposerHeader } from "./composer/composerHeader";
import { FormatToolbar } from "./composer/formatToolbar";
import { clipboardImages } from "./composer/pasteImage";
import { SendBar } from "./composer/sendBar";
import { AttachmentPreview } from "./composer/attachmentPreview";
import {
  htmlToQuotedPlainText,
  isPlainPasteShortcut,
  plainPasteBlocks,
  plainTextToHtml,
} from "./composer/plainText";
import { useComposerPlacement } from "./composer/useComposerPlacement";
import { FontSize, Indentation, SafeLink } from "./composer/extensions";
import { useComposerAttachments } from "./composer/useComposerAttachments";
import { useComposerSend } from "./composer/useComposerSend";
import { useComposerWarnings } from "./composer/useComposerWarnings";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { MEDIA_QUERIES } from "../breakpoints";
import {
  announceLocalMailChanged,
  composerTitle,
  isRedirectSeed,
  seedBody,
  bccSelfLine,
  seedRecipients,
  seedReferences,
  seedSource,
  seedSubject,
} from "./composer/composerSeed";
import { hasDraftContent, splitAddresses } from "./composer/composerValidate";

interface Props {
  accountId: string;
  onDraftSaved?: (id: string) => void;
}

const linkDialogFocusable =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function composeImageFile(item: ComposeAttachment): boolean {
  if (item.inline) return false;
  const type = item.contentType?.toLowerCase() ?? "";
  if (type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(item.filename);
}

function signaturePreviewHtml(input: string): string {
  const doc = new DOMParser().parseFromString(
    sanitizeComposeHtml(input),
    "text/html",
  );
  for (const image of doc.querySelectorAll("img")) image.remove();
  for (const link of doc.querySelectorAll("a")) {
    link.removeAttribute("href");
    link.removeAttribute("data-external-href");
  }
  return doc.body.innerHTML;
}

export function Composer({ accountId, onDraftSaved }: Props) {
  const seed = useAppStore((state) => state.composeSeed);
  const mailboxes = useAppStore((state) => state.mailboxes);
  const account = useAppStore((state) =>
    state.accounts.find((item) => item.id === accountId),
  );
  const accountEmail = account?.email ?? "";
  const redirecting = isRedirectSeed(seed);
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
  // Only a reply opened from the message knows which folder to restore.
  const sourceArchive = useMemo(() => {
    const source = seed?.sourceMessage;
    const kind = seedSource(seed).sourceKind;
    if (!source || (kind !== "reply" && kind !== "reply_all")) return undefined;
    const mailbox = mailboxes.find((item) => item.id === source.mailboxId);
    if (mailbox?.role === "archive") return undefined;
    return { messageId: source.id, mailboxId: source.mailboxId };
  }, [mailboxes, seed]);

  const [fromAddress, setFromAddress] = useState(() => {
    if (seed?.draft?.from) return seed.draft.from;
    if (seed?.sourceMessage) {
      const addressed = addressedFrom(
        seed.sourceMessage,
        account?.email ?? "",
        account?.aliases ?? [],
      );
      if (addressed) return addressed;
    }
    const allowed = [account?.email, ...(account?.aliases ?? [])].filter(
      (address): address is string => Boolean(address),
    );
    return (
      rememberedFromAddress(
        useAppStore.getState().settings.lastFromAddresses,
        accountId,
        allowed,
      ) ??
      account?.email ??
      ""
    );
  });
  function chooseFromAddress(value: string) {
    setFromAddress(value);
    const next = rememberFromAddress(
      useAppStore.getState().settings.lastFromAddresses,
      accountId,
      value,
      availableSenders.map((sender) => sender.email),
    );
    if (next) void updateSettings({ lastFromAddresses: next });
  }

  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [moreFormattingOpen, setMoreFormattingOpen] = useState(false);
  const closeComposer = useAppStore((state) => state.closeComposer);
  // Set when this composer closes itself (send, save, discard). Any other
  // unmount means a new composer replaced it and unsaved work must be kept.
  const closedByComposer = useRef(false);
  // Keyed by composeNonce in App, so a stale close must not end a newer one.
  const [composeSession] = useState(() => useAppStore.getState().composeNonce);
  const close = useCallback(() => {
    if (useAppStore.getState().composeNonce !== composeSession) return;
    closedByComposer.current = true;
    closeComposer();
  }, [closeComposer, composeSession]);
  const setError = useAppStore((state) => state.setError);
  const seededTo = seedRecipients(seed, "to", accountEmail, account?.aliases);
  const seededCc = seedRecipients(seed, "cc", accountEmail, account?.aliases);
  const seededBcc =
    seed?.draft?.bcc.join(", ") ?? seed?.prefill?.bcc?.join(", ") ?? "";
  const [to, setTo] = useState(seededTo);
  const [focusLetter] = useState(() => seededTo.trim().length > 0);
  const [cc, setCc] = useState(seededCc);
  const [bcc, setBcc] = useState(
    seed?.draft
      ? seededBcc
      : bccSelfLine(
          seededTo,
          seededCc,
          seededBcc,
          accountEmail,
          useAppStore.getState().settings.bccSelf,
        ),
  );
  const [subject, setSubject] = useState(seedSubject(seed));
  const [draftId, setDraftId] = useState<string | undefined>(seed?.draft?.id);
  // A saved draft keeps its own format; new messages use the account default.
  const [includeSignature, setIncludeSignature] = useState(
    () => !isRedirectSeed(seed) && seed?.draft?.includeSignature !== false,
  );
  const [importance, setImportance] = useState<"" | "high" | "low">(() =>
    seed?.draft?.importance === "high" || seed?.draft?.importance === "low"
      ? seed.draft.importance
      : "",
  );
  const [requestReceipt, setRequestReceipt] = useState(
    () => seed?.draft?.requestReceipt === true,
  );
  const [replyTo, setReplyTo] = useState(() =>
    seed?.draft?.replyTo !== undefined
      ? (seed.draft.replyTo ?? "")
      : (account?.replyTo ?? ""),
  );
  const [bodyFormat, setBodyFormat] = useState<BodyFormat>(
    seed?.draft
      ? (seed.draft.bodyFormat ?? "html")
      : (account?.defaultBodyFormat ?? "html"),
  );
  const [plainBody, setPlainBody] = useState(() =>
    bodyFormat === "plain"
      ? seed?.draft
        ? seed.draft.textBody
        : htmlToQuotedPlainText(seedBody(seed))
      : "",
  );
  const [confirmPlain, setConfirmPlain] = useState(false);
  const {
    attachmentWarning,
    subjectWarning,
    bodyWarning,
    audienceWarning,
    noreplyWarning,
    duplicateWarning,
    setAttachmentWarning,
    setSubjectWarning,
    setBodyWarning,
    setAudienceWarning,
    setNoreplyWarning,
    setDuplicateWarning,
    focusSubjectAfterWarning,
    focusBodyAfterWarning,
    focusToAfterWarning,
    warningOpen,
    setters: warningSetters,
  } = useComposerWarnings();
  const plainRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("https://");
  const [linkCanRemove, setLinkCanRemove] = useState(false);
  const [showCc, setShowCc] = useState(Boolean(cc));
  const [showBcc, setShowBcc] = useState(Boolean(bcc));
  const [formattingOpen, setFormattingOpen] = useState(false);
  const [saveState, setSaveState] = useState<"unsaved" | "saving" | "saved">(
    seed?.draft ? "saved" : "unsaved",
  );
  const [savedAt, setSavedAt] = useState<string | undefined>(
    seed?.draft ? seed.draftSummary?.updatedAt : undefined,
  );
  const [draftSyncState, setDraftSyncState] = useState(
    seed?.draftSummary?.syncState,
  );
  const [draftSyncDetail, setDraftSyncDetail] = useState(
    seed?.draftSummary?.syncDetail,
  );
  const isDiscarding = useRef(false);
  const isDiscardingNow = useCallback(() => isDiscarding.current, []);
  const isSending = useRef(false);
  const draftRevision = useRef(0);
  const saveInFlight = useRef(false);
  const pendingClose = useRef(false);
  const draftIdRef = useRef<string | undefined>(
    seed?.draft?.id ?? seed?.draftSummary?.id,
  );
  const savePromiseRef = useRef<Promise<unknown> | null>(null);
  const markUnsaved = useCallback(() => {
    draftRevision.current += 1;
    setSaveState("unsaved");
  }, []);
  const keepSourceVisible = Boolean(
    seed?.composeMode && seed.composeMode !== "editAsNew" && !maximized,
  );
  const dialogRef = useDialogFocus(
    () => {
      if (linkDialogOpen) {
        setLinkDialogOpen(false);
        return;
      }
      void requestClose();
    },
    { trapFocus: !keepSourceVisible },
  );

  const narrowViewport = useMediaQuery(MEDIA_QUERIES.narrowViewport);
  const { update: updateSettings } = useSettingsSave();
  const composerWidth = useAppStore((state) => state.settings.composerWidth);
  const composerHeight = useAppStore((state) => state.settings.composerHeight);
  const remembered = rememberedComposerSize(composerWidth, composerHeight);
  const placement = useComposerPlacement(
    dialogRef,
    !maximized && !narrowViewport,
    (width, height) => {
      const size = rememberedComposerSize(width, height);
      if (!size) return;
      const current = useAppStore.getState().settings;
      if (
        current.composerWidth === size.width &&
        current.composerHeight === size.height
      ) {
        return;
      }
      void updateSettings({
        composerWidth: size.width,
        composerHeight: size.height,
      });
    },
  );

  const pastePlainRef = useRef<() => Promise<void>>(async () => undefined);
  const pasteImageRef = useRef<
    (files: File[], tooLarge: boolean) => Promise<void>
  >(async () => undefined);
  const takePastedImages = (event: Event) => {
    const { files, tooLarge } = clipboardImages(
      (event as ClipboardEvent).clipboardData,
    );
    if (files.length === 0 && !tooLarge) return false;
    event.preventDefault();
    void pasteImageRef.current(files, tooLarge);
    return true;
  };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false, underline: false }),
      Underline,
      SafeLink,
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
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": strings.composer.messageBody,
      },
      transformPastedHTML: (html) => sanitizeComposeHtml(html),
      handleDOMEvents: {
        keydown: (_view, event) => {
          if (!isPlainPasteShortcut(event)) return false;
          event.preventDefault();
          void pastePlainRef.current();
          return true;
        },
        paste: (_view, event) => takePastedImages(event),
        contextmenu: (_view, event) => {
          event.preventDefault();
          return true;
        },
        auxclick: (_view, event) => {
          if (
            event.button === 1 &&
            (event.target as HTMLElement | null)?.closest("a")
          ) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
    immediatelyRender: false,
    onUpdate: markUnsaved,
  });

  const editorRef = useRef(editor);
  const composerPlace = useRef(0);
  const didFocusLetter = useRef(false);
  useEffect(() => {
    if (!focusLetter || didFocusLetter.current) return;
    if (bodyFormat === "plain") {
      if (!plainRef.current) return;
      plainRef.current.focus();
      didFocusLetter.current = true;
      return;
    }
    if (!editor) return;
    const focusFrame = window.requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      // Commit selection before WebKit focus can change the editor state.
      editor.commands.setTextSelection(0);
      editor.view.focus();
      didFocusLetter.current = true;
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [bodyFormat, editor, focusLetter]);
  const bodyFormatRef = useRef(bodyFormat);
  const plainBodyRef = useRef(plainBody);
  useEffect(() => {
    editorRef.current = editor;
    bodyFormatRef.current = bodyFormat;
    plainBodyRef.current = plainBody;
  }, [bodyFormat, editor, plainBody]);
  /** Text of whichever editor is showing, for empty-draft checks. */
  const currentBodyText = useCallback(
    () =>
      bodyFormatRef.current === "plain"
        ? plainBodyRef.current
        : (editorRef.current?.getText() ?? ""),
    [],
  );

  const {
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
  } = useComposerAttachments({
    accountId,
    initialAttachments:
      seed?.draft?.attachments ?? seed?.prefill?.attachments ?? [],
    editor,
    editorRef,
    bodyFormatRef,
    sending,
    saveState,
    minimized,
    dialogRef,
    isSendingRef: isSending,
    markUnsaved,
    setError,
  });
  pasteImageRef.current = pasteImage;
  // The Preview button that opened the picture preview gets focus back on close.
  const previewTriggerRef = useRef<HTMLButtonElement>(null);

  const buildDraft = useCallback((): ComposeDraft => {
    const plain = bodyFormat === "plain";
    // A plain draft carries text only; the editor keeps the last rich copy.
    let htmlBody = plain ? "" : (editor?.getHTML() ?? "");
    if (!plain)
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
      htmlBody: redirecting ? "" : htmlBody,
      textBody: redirecting
        ? ""
        : plain
          ? plainBody
          : htmlToQuotedPlainText(htmlBody),
      bodyFormat,
      attachments: redirecting ? [] : attachments,
      inReplyTo: redirecting
        ? undefined
        : (seed?.draft?.inReplyTo ??
          (seed?.composeMode === "forward" ||
          seed?.composeMode === "forwardAttachment" ||
          seed?.composeMode === "editAsNew"
            ? undefined
            : (seed?.sourceMessage?.messageId ?? undefined))),
      references: redirecting ? undefined : seedReferences(seed),
      includeSignature: redirecting ? false : includeSignature,
      importance: redirecting ? "" : importance,
      requestReceipt: !redirecting && requestReceipt,
      replyTo: redirecting ? undefined : replyTo.trim(),
      ...seedSource(seed),
    };
  }, [
    accountId,
    attachments,
    bcc,
    bodyFormat,
    cc,
    draftId,
    editor,
    fromAddress,
    importance,
    includeSignature,
    requestReceipt,
    replyTo,
    inlineImages,
    plainBody,
    redirecting,
    seed,
    subject,
    to,
  ]);

  const { saveDraft } = useComposerDraftPersistence({
    accountId,
    onDraftSaved,
    editor,
    sending,
    buildDraft,
    currentBodyText,
    close,
    saveState,
    setSaveState,
    setDraftId,
    setSavedAt,
    setDraftSyncState,
    setDraftSyncDetail,
    setError,
    draftIdRef,
    savePromiseRef,
    isSendingRef: isSending,
    isDiscardingRef: isDiscarding,
    draftRevisionRef: draftRevision,
    saveInFlightRef: saveInFlight,
    pendingCloseRef: pendingClose,
    closedByComposerRef: closedByComposer,
    session: composeSession,
  });

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void api
      .onDraftSyncChanged((event) => {
        if (event.accountId !== accountId) return;
        const currentId = draftIdRef.current;
        if (!currentId) return;
        if (event.draftId && event.draftId !== currentId) return;
        if (
          event.syncState === "synced" ||
          event.syncState === "localPending" ||
          event.syncState === "localOnly" ||
          event.syncState === "conflict"
        ) {
          setDraftSyncState(event.syncState);
          if (event.syncState === "synced") setDraftSyncDetail(undefined);
          return;
        }
        // A sync pass emits one event without a draft id or state. Reload
        // the saved summary so the banner reflects the real server state.
        void api
          .listDrafts(accountId)
          .then((drafts) => {
            if (!active) return;
            const summary = drafts.find(
              (item) => item.id === draftIdRef.current,
            );
            if (!summary) return;
            setDraftSyncState(summary.syncState);
            setDraftSyncDetail(summary.syncDetail ?? undefined);
          })
          .catch(() => undefined);
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [accountId]);

  async function requestClose() {
    // The picture preview owns Escape and close while it is open.
    if (attachmentPreview || isDiscarding.current) return;
    if (sending || saveInFlight.current) {
      pendingClose.current = true;
      return;
    }
    const draft = buildDraft();
    if (!hasDraftContent(draft, currentBodyText())) {
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
    if (sending || isDiscarding.current) return;
    if (hasDraftContent(buildDraft(), currentBodyText())) {
      const confirmed = await api.showNativeConfirm(
        strings.composer.discard,
        strings.composer.discardQuestion,
      );
      if (!confirmed) return;
    }
    isDiscarding.current = true;
    pendingClose.current = false;
    try {
      // A save may have started while the confirmation was open. Let it
      // settle so its id is known, then delete the latest saved draft.
      if (savePromiseRef.current) {
        await savePromiseRef.current.catch(() => undefined);
      }
      const id = draftIdRef.current;
      if (id) await api.deleteDraft(id, accountId);
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

  const {
    canSend,
    sendMessage,
    sendMenuRef,
    sendMenuOpen,
    setSendMenuOpen,
    scheduleOpen,
    setScheduleOpen,
    scheduleValue,
    setScheduleValue,
    recipientError,
    setRecipientError,
    subjectError,
    setSubjectError,
    replyToError,
    setReplyToError,
  } = useComposerSend({
    accountId,
    editor,
    to,
    cc,
    bcc,
    subject,
    replyTo,
    redirecting,
    bodyFormat,
    plainBody,
    includeSignature,
    signature: account?.signature,
    attachmentCount: attachments.length,
    sourceArchive,
    sending,
    setSending,
    saveState,
    isSendingRef: isSending,
    isDiscarding: isDiscardingNow,
    pendingCloseRef: pendingClose,
    savePromiseRef,
    draftIdRef,
    buildDraft,
    close,
    saveDraft,
    setError,
    warningSetters,
    shortcutsPaused:
      minimized ||
      warningOpen ||
      confirmPlain ||
      linkDialogOpen ||
      attachmentPreview !== null,
  });

  useLayoutEffect(() => {
    if (minimized) return;
    const top = composerPlace.current;
    if (top <= 0) return;
    const apply = () => {
      document
        .querySelectorAll<HTMLElement>(
          ".composer-window .composer-body, .composer-window .tiptap, .composer-plain-editor",
        )
        .forEach((node) => {
          node.scrollTop = top;
        });
    };
    apply();
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [minimized]);

  function setComposerMinimized(value: SetStateAction<boolean>) {
    const next = typeof value === "function" ? value(minimized) : value;
    if (next) {
      let top = 0;
      document
        .querySelectorAll<HTMLElement>(
          ".composer-window .composer-body, .composer-window .tiptap, .composer-plain-editor",
        )
        .forEach((node) => {
          top = Math.max(top, node.scrollTop);
        });
      composerPlace.current = top;
    }
    setMinimized(next);
  }

  function switchToPlain() {
    setPlainBody(htmlToQuotedPlainText(editor?.getHTML() ?? ""));
    stripInlineImages();
    setBodyFormat("plain");
    setConfirmPlain(false);
    markUnsaved();
  }

  function switchToRich() {
    editor?.commands.setContent(plainTextToHtml(plainBody), {
      emitUpdate: false,
    });
    setBodyFormat("html");
    markUnsaved();
  }

  function toggleBodyFormat() {
    if (bodyFormat === "plain") {
      switchToRich();
      return;
    }
    const hasContent = Boolean(editor?.getText().trim()) || inlineImages.size;
    if (hasContent) setConfirmPlain(true);
    else switchToPlain();
  }

  const shownFormat = useRef(bodyFormat);
  useEffect(() => {
    if (shownFormat.current === bodyFormat) return;
    shownFormat.current = bodyFormat;
    if (bodyFormat === "plain") plainRef.current?.focus();
    else editorRef.current?.commands.focus();
  }, [bodyFormat]);

  function addLink() {
    const current = editor?.getAttributes("link").href as string | undefined;
    setLinkCanRemove(Boolean(current));
    setLinkValue(current ?? "https://");
    setLinkDialogOpen(true);
  }

  function removeLink() {
    editor?.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkDialogOpen(false);
  }

  function applyLink() {
    const href = linkValue.trim().slice(0, 2000);
    if (!/^(https?|mailto):/i.test(href) || /\s/.test(href)) {
      setError(strings.composer.unsafeLink);
      return;
    }
    editor?.chain().focus().extendMarkRange("link").setLink({ href }).run();
    setLinkDialogOpen(false);
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

  async function pastePlainText() {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setError(strings.composer.clipboardUnavailable);
      return;
    }
    const blocks = plainPasteBlocks(text);
    if (blocks.length === 0) return;
    if (bodyFormatRef.current === "plain") {
      const field = plainRef.current;
      if (!field) return;
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      const plain = blocks
        .map((block) => block.content?.[0]?.text ?? "")
        .join("\n");
      setPlainBody(
        field.value.slice(0, start) + plain + field.value.slice(end),
      );
      markUnsaved();
      const cursor = start + plain.length;
      window.requestAnimationFrame(() => {
        field.focus();
        field.setSelectionRange(cursor, cursor);
      });
      return;
    }
    editorRef.current?.chain().focus().insertContent(blocks).run();
  }
  pastePlainRef.current = pastePlainText;

  // One listener for the composer's life; editor state stays fresh via a ref.
  const composerActionRef = useRef({
    bodyFormat,
    editor,
    removeAttachment,
  });
  useEffect(() => {
    composerActionRef.current = { bodyFormat, editor, removeAttachment };
  });

  useEffect(() => {
    const onAction = (event: Event) => {
      const { bodyFormat, editor, removeAttachment } =
        composerActionRef.current;
      const detail = (event as CustomEvent<ContextMenuActionDetail>).detail;
      if (!detail) return;
      if (detail.target.kind === "composer" && bodyFormat === "plain") {
        plainRef.current?.focus();
        if (detail.id === "undo") document.execCommand("undo");
        if (detail.id === "redo") document.execCommand("redo");
        if (detail.id === "select-all") plainRef.current?.select();
        if (detail.id === "paste-plain") void pastePlainRef.current();
        return;
      }
      if (detail.target.kind === "composer") {
        if (detail.id === "paste-plain") void pastePlainRef.current();
        if (detail.id === "undo") editor?.chain().focus().undo().run();
        if (detail.id === "redo") editor?.chain().focus().redo().run();
        if (detail.id === "select-all")
          editor?.chain().focus().selectAll().run();
        return;
      }
      if (
        detail.target.kind === "composer-attachment" &&
        detail.id === "remove-attachment"
      ) {
        removeAttachment(detail.target.index);
      }
    };
    window.addEventListener(CONTEXT_ACTION_EVENT, onAction);
    return () => window.removeEventListener(CONTEXT_ACTION_EVENT, onAction);
  }, []);

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
          <span
            className="docked-pill-title"
            title={subject.trim() || strings.common.noSubject}
          >
            {subject.trim() || strings.common.noSubject}
          </span>
          <span className="docked-pill-status">
            {saveState === "saving"
              ? strings.common.saving
              : saveState === "saved"
                ? savedAt
                  ? strings.composer.draftSavedAt(formatMessageDate(savedAt))
                  : strings.composer.draftSaved
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

  const optionToggles = (
    <>
      {redirecting ? null : (
        <label
          className="composer-signature-toggle"
          title={strings.composer.highImportanceHelp}
        >
          <input
            type="checkbox"
            checked={importance === "high"}
            onChange={(event) => {
              setImportance(event.target.checked ? "high" : "");
              markUnsaved();
            }}
          />
          {strings.composer.highImportance}
        </label>
      )}
      {redirecting ? null : (
        <label
          className="composer-signature-toggle"
          title={strings.composer.lowImportanceHelp}
        >
          <input
            type="checkbox"
            checked={importance === "low"}
            onChange={(event) => {
              setImportance(event.target.checked ? "low" : "");
              markUnsaved();
            }}
          />
          {strings.composer.lowImportance}
        </label>
      )}
      {redirecting ? null : (
        <label
          className="composer-signature-toggle"
          title={strings.composer.requestReceiptHelp}
        >
          <input
            type="checkbox"
            checked={requestReceipt}
            onChange={(event) => {
              setRequestReceipt(event.target.checked);
              markUnsaved();
            }}
          />
          {strings.composer.requestReceipt}
        </label>
      )}
      {account?.signature && !redirecting ? (
        <label className="composer-signature-toggle">
          <input
            type="checkbox"
            checked={includeSignature}
            onChange={(event) => {
              setIncludeSignature(event.target.checked);
              markUnsaved();
            }}
          />
          {strings.composer.includeSignature}
        </label>
      ) : null}
    </>
  );

  return (
    <div
      className={`modal-layer composer-layer${maximized ? " composer-layer-maximized" : ""}${keepSourceVisible ? " composer-layer-followup" : ""}`}
      role="dialog"
      aria-modal={keepSourceVisible ? "false" : "true"}
      aria-labelledby="composer-title"
      inert={attachmentPreview ? true : undefined}
    >
      {keepSourceVisible ? null : (
        <button
          className="modal-backdrop"
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => void requestClose()}
          disabled={sending || saveState === "saving"}
        />
      )}
      <section
        className={`composer-window${maximized ? " composer-maximized" : ""}${placement.placed ? " composer-placed" : ""}${!maximized && !narrowViewport ? " composer-movable" : ""}`}
        ref={dialogRef}
        style={{
          ...(!placement.placed && !maximized && !narrowViewport && remembered
            ? {
                width: remembered.width,
                height: remembered.height,
                maxWidth: "100%",
                maxHeight: "100%",
              }
            : {}),
          ...placement.style,
        }}
      >
        <ComposerHeader
          dragHandlers={placement.headerHandlers}
          seed={seed}
          saveState={saveState}
          savedAt={savedAt}
          maximized={maximized}
          sending={sending}
          draftSyncState={draftSyncState}
          draftSyncDetail={draftSyncDetail}
          bodyFormat={bodyFormat}
          onToggleBodyFormat={toggleBodyFormat}
          hideFormat={redirecting}
          setMinimized={setComposerMinimized}
          setMaximized={setMaximized}
          requestClose={requestClose}
        />
        {/* section (not div): keeps `.composer-window > div:has(.composer-editor)`
            resolving to the editor wrap for existing metric assertions. */}
        <section className="composer-body">
          <AddressFields
            accountId={accountId}
            availableSenders={availableSenders}
            fromAddress={fromAddress}
            fromValue={fromValue}
            setFromAddress={chooseFromAddress}
            to={to}
            setTo={setTo}
            cc={cc}
            setCc={setCc}
            bcc={bcc}
            setBcc={setBcc}
            showCc={showCc}
            setShowCc={setShowCc}
            showBcc={showBcc}
            setShowBcc={setShowBcc}
            subject={subject}
            setSubject={setSubject}
            recipientError={recipientError}
            setRecipientError={setRecipientError}
            subjectError={subjectError}
            setSubjectError={setSubjectError}
            subjectLocked={redirecting}
            replyTo={redirecting ? undefined : replyTo}
            setReplyTo={setReplyTo}
            replyToError={replyToError}
            setReplyToError={setReplyToError}
            markUnsaved={markUnsaved}
            focusTo={!focusLetter}
          />
          {seed?.sourceMessage ? (
            <details className="compose-original">
              <summary>{strings.composer.originalMessage}</summary>
              <p>
                {seed.sourceMessage.senderName ||
                  seed.sourceMessage.senderAddress}
                {" — "}
                {seed.sourceMessage.subject || strings.common.noSubject}
              </p>
              <pre>
                {readableMessageText(seed.sourceMessage) ||
                  strings.composer.originalEmpty}
              </pre>
            </details>
          ) : null}
          {redirecting ? (
            <p className="composer-redirect-note">
              {strings.composer.redirectNote}
            </p>
          ) : null}
          {redirecting ? null : bodyFormat === "html" ? (
            <FormatToolbar
              editor={editor}
              formattingOpen={formattingOpen}
              setFormattingOpen={setFormattingOpen}
              moreFormattingOpen={moreFormattingOpen}
              setMoreFormattingOpen={setMoreFormattingOpen}
              adjustIndent={adjustIndent}
              addLink={addLink}
            >
              {optionToggles}
            </FormatToolbar>
          ) : (
            <div className="composer-toggle-row">{optionToggles}</div>
          )}
          {redirecting ? null : bodyFormat === "html" ? (
            <div data-context="composer" className="composer-editor-wrap">
              <EditorContent editor={editor} />
            </div>
          ) : (
            <div data-context="composer" className="composer-editor-wrap">
              <textarea
                ref={plainRef}
                className="composer-plain-editor"
                aria-label={strings.composer.plainBodyLabel}
                value={plainBody}
                onKeyDown={(event) => {
                  if (!isPlainPasteShortcut(event)) return;
                  event.preventDefault();
                  void pastePlainRef.current();
                }}
                onPaste={(event) => {
                  takePastedImages(event.nativeEvent);
                }}
                onChange={(event) => {
                  setPlainBody(event.target.value);
                  markUnsaved();
                }}
              />
            </div>
          )}
          {((bodyFormat === "html" &&
            (account?.signatureHtml || account?.signature)) ||
            (bodyFormat === "plain" && account?.signature)) &&
          includeSignature &&
          !seed?.draft &&
          !redirecting ? (
            <aside className="composer-signature-preview">
              <strong>{strings.composer.signaturePreview}</strong>
              {bodyFormat === "html" && account.signatureHtml ? (
                <div
                  className="composer-signature-html"
                  dangerouslySetInnerHTML={{
                    __html: signaturePreviewHtml(account.signatureHtml),
                  }}
                />
              ) : (
                <pre>{account.signature}</pre>
              )}
            </aside>
          ) : null}
          {attachments.length > 0 ? (
            <div className="compose-attachments">
              {attachments.map((item, index) => (
                <span
                  key={`${item.token}-${index}`}
                  data-context="composer-attachment"
                  data-attachment-index={index}
                >
                  {item.inline ? strings.composer.imagePrefix : ""}
                  {item.filename}
                  {typeof item.size === "number" ? (
                    <small className="compose-attachment-size">
                      {formatBytes(item.size)}
                    </small>
                  ) : null}
                  {composeImageFile(item) ? (
                    <button
                      type="button"
                      className="compose-attachment-preview"
                      onClick={(event) => {
                        previewTriggerRef.current = event.currentTarget;
                        void previewComposeImage(item);
                      }}
                      disabled={sending || saveState === "saving"}
                      aria-label={strings.composer.previewAttachment(
                        item.filename,
                      )}
                    >
                      {strings.reader.preview}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    disabled={sending || saveState === "saving"}
                    aria-label={strings.composer.removeAttachment(
                      item.filename,
                    )}
                  >
                    ×
                  </button>
                </span>
              ))}
              {attachments.length > 1 ? (
                <button
                  type="button"
                  className="compose-remove-all"
                  onClick={removeAllAttachments}
                  disabled={sending || saveState === "saving"}
                >
                  {strings.composer.removeAllAttachments}
                </button>
              ) : null}
              {attachments.every((item) => typeof item.size === "number") ? (
                <p className="compose-attachment-total">
                  {strings.composer.attachmentTotal(
                    formatBytes(totalAttachmentBytes),
                  )}
                </p>
              ) : null}
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
        </section>
        <SendBar
          sendMenuRef={sendMenuRef}
          canSend={canSend}
          sendMessage={sendMessage}
          sendAndArchive={
            sourceArchive
              ? () => void sendMessage(undefined, false, true)
              : undefined
          }
          sending={sending}
          sendMenuOpen={sendMenuOpen}
          setSendMenuOpen={setSendMenuOpen}
          scheduleOpen={scheduleOpen}
          setScheduleOpen={setScheduleOpen}
          scheduleValue={scheduleValue}
          setScheduleValue={setScheduleValue}
          saveDraft={saveDraft}
          saveState={saveState}
          savedAt={savedAt}
          showAttachments={!redirecting}
          addAttachments={addAttachments}
          addInlineImage={addInlineImage}
          discardDraft={discardDraft}
        >
          {!maximized && !narrowViewport ? (
            <button
              type="button"
              className="composer-resize-grip"
              aria-label={strings.composer.resizeWindow}
              title={strings.composer.resizeHint}
              {...placement.gripHandlers}
            />
          ) : null}
        </SendBar>
        <div
          className="composer-drop-overlay"
          data-active={dropActive}
          aria-hidden="true"
        >
          <Paperclip aria-hidden="true" />
          <strong>{strings.composer.dropOverlay}</strong>
        </div>
        <div className="visually-hidden" aria-live="polite">
          {dropActive ? strings.composer.dropOverlay : dropNote}
        </div>
        {bodyWarning ? (
          <ConfirmDialog
            title={strings.composer.noMessageTitle}
            detail={strings.composer.noMessageDetail}
            primaryLabel={strings.composer.writeMessage}
            secondaryLabel={strings.composer.sendAnyway}
            onPrimary={() => {
              focusBodyAfterWarning.current = true;
              setBodyWarning(null);
            }}
            onSecondary={() => {
              const { sendAt, archiveSource } = bodyWarning;
              setBodyWarning(null);
              void sendMessage(
                sendAt,
                true,
                Boolean(archiveSource),
                true,
                true,
                true,
                true,
                true,
              );
            }}
            onCancel={() => setBodyWarning(null)}
          />
        ) : null}
        {subjectWarning ? (
          <ConfirmDialog
            title={strings.composer.noSubjectTitle}
            detail={strings.composer.noSubjectDetail}
            primaryLabel={strings.composer.addSubject}
            secondaryLabel={strings.composer.sendAnyway}
            onPrimary={() => {
              focusSubjectAfterWarning.current = true;
              setSubjectWarning(null);
            }}
            onSecondary={() => {
              const { sendAt, archiveSource } = subjectWarning;
              setSubjectWarning(null);
              void sendMessage(
                sendAt,
                false,
                Boolean(archiveSource),
                true,
                false,
                false,
                true,
                true,
              );
            }}
            onCancel={() => setSubjectWarning(null)}
          />
        ) : null}
        {attachmentWarning ? (
          <ConfirmDialog
            title={strings.composer.noAttachmentTitle}
            detail={strings.composer.noAttachmentDetail}
            primaryLabel={strings.composer.addAttachment}
            secondaryLabel={strings.composer.sendAnyway}
            onPrimary={() => {
              setAttachmentWarning(null);
              void addAttachments();
            }}
            onSecondary={() => {
              const { sendAt, archiveSource } = attachmentWarning;
              setAttachmentWarning(null);
              void sendMessage(
                sendAt,
                true,
                Boolean(archiveSource),
                true,
                true,
                false,
                true,
                true,
              );
            }}
            onCancel={() => setAttachmentWarning(null)}
          />
        ) : null}
        {duplicateWarning ? (
          <ConfirmDialog
            title={strings.composer.duplicateTitle}
            detail={strings.composer.duplicateDetail(duplicateWarning.address)}
            primaryLabel={strings.composer.reviewRecipients}
            secondaryLabel={strings.composer.sendAnyway}
            onPrimary={() => {
              focusToAfterWarning.current = true;
              setDuplicateWarning(null);
            }}
            onSecondary={() => {
              const { sendAt, archiveSource } = duplicateWarning;
              setDuplicateWarning(null);
              void sendMessage(
                sendAt,
                false,
                Boolean(archiveSource),
                false,
                false,
                false,
                true,
                true,
              );
            }}
            onCancel={() => setDuplicateWarning(null)}
          />
        ) : null}
        {noreplyWarning ? (
          <ConfirmDialog
            title={strings.composer.noreplyTitle}
            detail={strings.composer.noreplyDetail(noreplyWarning.address)}
            primaryLabel={strings.composer.reviewRecipients}
            secondaryLabel={strings.composer.sendAnyway}
            onPrimary={() => {
              focusToAfterWarning.current = true;
              setNoreplyWarning(null);
            }}
            onSecondary={() => {
              const { sendAt, archiveSource } = noreplyWarning;
              setNoreplyWarning(null);
              void sendMessage(
                sendAt,
                false,
                Boolean(archiveSource),
                false,
                false,
                false,
                true,
              );
            }}
            onCancel={() => setNoreplyWarning(null)}
          />
        ) : null}
        {audienceWarning ? (
          <ConfirmDialog
            title={strings.composer.largeAudienceTitle}
            detail={strings.composer.largeAudienceDetail(audienceWarning.count)}
            primaryLabel={strings.composer.reviewRecipients}
            secondaryLabel={strings.composer.sendAnyway}
            onPrimary={() => {
              focusToAfterWarning.current = true;
              setAudienceWarning(null);
            }}
            onSecondary={() => {
              const { sendAt, archiveSource } = audienceWarning;
              setAudienceWarning(null);
              void sendMessage(
                sendAt,
                false,
                Boolean(archiveSource),
                true,
                true,
                false,
                true,
                true,
              );
            }}
            onCancel={() => setAudienceWarning(null)}
          />
        ) : null}
        {confirmPlain ? (
          <ConfirmDialog
            title={strings.composer.plainSwitchTitle}
            detail={strings.composer.plainSwitchDetail}
            primaryLabel={strings.composer.keepRichText}
            secondaryLabel={strings.composer.plainSwitchConfirm}
            onPrimary={() => setConfirmPlain(false)}
            onSecondary={switchToPlain}
            onCancel={() => setConfirmPlain(false)}
          />
        ) : null}
        {attachmentPreview ? (
          <AttachmentPreview
            preview={attachmentPreview}
            onClose={() => setAttachmentPreview(null)}
            triggerRef={previewTriggerRef}
          />
        ) : null}
        {linkDialogOpen ? (
          <div
            className="settings-confirm-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="composer-link-title"
          >
            <form
              className="settings-confirm-card"
              onSubmit={(event) => {
                event.preventDefault();
                applyLink();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setLinkDialogOpen(false);
                  return;
                }
                if (event.key !== "Tab") return;
                const form = event.currentTarget;
                const controls = [
                  ...form.querySelectorAll<HTMLElement>(linkDialogFocusable),
                ];
                if (controls.length === 0) return;
                const first = controls[0];
                const last = controls[controls.length - 1];
                const active = document.activeElement as HTMLElement | null;
                const inside = active ? form.contains(active) : false;
                if (event.shiftKey) {
                  if (!inside || active === first) {
                    event.preventDefault();
                    last.focus();
                  }
                } else if (!inside || active === last) {
                  event.preventDefault();
                  first.focus();
                }
                // The composer-wide trap listens on document. Keep this Tab
                // inside the aria-modal link dialog instead.
                event.stopPropagation();
              }}
            >
              <h2 id="composer-link-title">{strings.composer.insertLink}</h2>
              <label className="settings-confirm-field">
                <span>{strings.composer.webAddress}</span>
                <input
                  autoFocus
                  value={linkValue}
                  onChange={(event) => setLinkValue(event.target.value)}
                  placeholder="https://"
                />
              </label>
              <div className="settings-confirm-actions">
                {linkCanRemove ? (
                  <button
                    className="secondary-button composer-remove-link"
                    type="button"
                    onClick={removeLink}
                  >
                    {strings.composer.removeLink}
                  </button>
                ) : null}
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setLinkDialogOpen(false)}
                >
                  {strings.common.cancel}
                </button>
                <button className="primary-button" type="submit">
                  {strings.composer.insertLink}
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </section>
    </div>
  );
}
