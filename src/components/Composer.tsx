import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
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
import { clipboardImages, readPastedImage } from "./composer/pasteImage";
import { SendBar } from "./composer/sendBar";
import {
  htmlToQuotedPlainText,
  isPlainPasteShortcut,
  plainPasteBlocks,
  plainTextToHtml,
} from "./composer/plainText";
import { useComposerPlacement } from "./composer/useComposerPlacement";
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
import {
  LARGE_RECIPIENT_COUNT,
  authoredText,
  hasDraftContent,
  mentionsAttachment,
  splitAddresses,
  isMailbox,
  firstNoreplyRecipient,
  repeatedRecipient,
  uniqueRecipientCount,
  validateRecipientFields,
  validateSubject,
} from "./composer/composerValidate";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (fontSize: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

const SafeLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      href: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-external-href") ||
          element.getAttribute("href"),
        renderHTML: (attributes) => {
          const href = String(attributes.href ?? "");
          if (/^https?:/i.test(href)) {
            return {
              href: "#",
              "data-external-href": href,
              rel: "noopener noreferrer",
            };
          }
          if (/^mailto:/i.test(href)) {
            return { href, rel: "noopener noreferrer" };
          }
          return {};
        },
      },
      target: {
        default: null,
        renderHTML: () => ({}),
      },
    };
  },
}).configure({
  openOnClick: false,
  protocols: ["http", "https", "mailto"],
  HTMLAttributes: {
    rel: "noopener noreferrer",
    target: null,
  },
});

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

const linkDialogFocusable =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function composeImageFile(item: ComposeAttachment): boolean {
  if (item.inline) return false;
  const type = item.contentType?.toLowerCase() ?? "";
  if (type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(item.filename);
}

export function Composer({ accountId }: Props) {
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
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(
    seed?.draft?.attachments ?? seed?.prefill?.attachments ?? [],
  );
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
  const [replyToError, setReplyToError] = useState<string>();
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
  const [attachmentWarning, setAttachmentWarning] = useState<{
    sendAt?: string;
    archiveSource?: boolean;
  } | null>(null);
  const [subjectWarning, setSubjectWarning] = useState<{
    sendAt?: string;
    archiveSource?: boolean;
  } | null>(null);
  const [bodyWarning, setBodyWarning] = useState<{
    sendAt?: string;
    archiveSource?: boolean;
  } | null>(null);
  const [audienceWarning, setAudienceWarning] = useState<{
    sendAt?: string;
    archiveSource?: boolean;
    count: number;
  } | null>(null);
  const [noreplyWarning, setNoreplyWarning] = useState<{
    sendAt?: string;
    archiveSource?: boolean;
    address: string;
  } | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<{
    sendAt?: string;
    archiveSource?: boolean;
    address: string;
  } | null>(null);
  const focusSubjectAfterWarning = useRef(false);
  const focusBodyAfterWarning = useRef(false);
  const focusToAfterWarning = useRef(false);
  const [dropActive, setDropActive] = useState(false);
  const [dropNote, setDropNote] = useState("");
  const plainRef = useRef<HTMLTextAreaElement>(null);
  const [inlineImages, setInlineImages] = useState(
    new Map<string, { dataUrl: string; contentId: string }>(),
  );
  const [sending, setSending] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<{
    filename: string;
    src: string;
  } | null>(null);
  const [linkValue, setLinkValue] = useState("https://");
  const [linkCanRemove, setLinkCanRemove] = useState(false);
  const [showCc, setShowCc] = useState(Boolean(cc));
  const [showBcc, setShowBcc] = useState(Boolean(bcc));
  const [formattingOpen, setFormattingOpen] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState("");
  const sendMenuRef = useRef<HTMLDivElement>(null);
  const [recipientError, setRecipientError] = useState<string>();
  const [subjectError, setSubjectError] = useState<string>();
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
  const restoredInlineImages = useRef(new Set<string>());
  const isDiscarding = useRef(false);
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
    editor.commands.focus("start");
    didFocusLetter.current = true;
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

  const canSend = useMemo(
    () =>
      Boolean(
        editor &&
        !sending &&
        !isDiscarding.current &&
        saveState !== "saving" &&
        [...splitAddresses(to), ...splitAddresses(cc), ...splitAddresses(bcc)]
          .length > 0 &&
        validateRecipientFields(to, cc, bcc) === undefined &&
        validateSubject(subject) === undefined,
      ),
    [bcc, cc, editor, saveState, sending, subject, to],
  );

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
    if (isDiscarding.current) return;
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

  const totalAttachmentBytes = useMemo(
    () => attachments.reduce((sum, item) => sum + (item.size ?? 0), 0),
    [attachments],
  );
  const isAttachmentSizeWarning = totalAttachmentBytes > 25 * 1024 * 1024;

  const sendMessage = useCallback(
    async (
      sendAt?: string,
      attachmentChecked = false,
      archiveAfterSend = false,
      subjectChecked = false,
      audienceChecked = false,
      bodyChecked = false,
      noreplyChecked = false,
      duplicatesChecked = false,
    ) => {
      const validation = validateRecipientFields(to, cc, bcc);
      const subjectValidation = validateSubject(subject);
      setRecipientError(validation);
      setSubjectError(subjectValidation);
      const replyToValidation =
        !redirecting && replyTo.trim() && !isMailbox(replyTo.trim())
          ? strings.settings.replyToAddressInvalid
          : undefined;
      setReplyToError(replyToValidation);
      if (
        !canSend ||
        validation ||
        subjectValidation ||
        replyToValidation ||
        isSending.current ||
        isDiscarding.current
      )
        return;
      if (sendAt) {
        const when = new Date(sendAt).getTime();
        const limit = Date.now() + 365 * 24 * 60 * 60 * 1000;
        if (!Number.isFinite(when) || when <= Date.now() || when > limit) {
          setError(strings.composer.invalidSchedule);
          return;
        }
      }
      const noreply = firstNoreplyRecipient(to, cc, bcc);
      if (!noreplyChecked && noreply) {
        setNoreplyWarning({
          sendAt,
          archiveSource: archiveAfterSend,
          address: noreply,
        });
        return;
      }
      const repeated = repeatedRecipient(to, cc, bcc);
      if (!duplicatesChecked && repeated) {
        setDuplicateWarning({
          sendAt,
          archiveSource: archiveAfterSend,
          address: repeated,
        });
        return;
      }
      if (!subjectChecked && subject.trim().length === 0) {
        setSubjectWarning({ sendAt, archiveSource: archiveAfterSend });
        return;
      }
      const recipientCount = uniqueRecipientCount(to, cc, bcc);
      if (!audienceChecked && recipientCount >= LARGE_RECIPIENT_COUNT) {
        setAudienceWarning({
          sendAt,
          archiveSource: archiveAfterSend,
          count: recipientCount,
        });
        return;
      }
      if (
        !attachmentChecked &&
        attachments.length === 0 &&
        mentionsAttachment(
          bodyFormat === "plain" ? plainBody : (editor?.getHTML() ?? ""),
          bodyFormat,
          includeSignature ? account?.signature : undefined,
        )
      ) {
        setAttachmentWarning({ sendAt, archiveSource: archiveAfterSend });
        return;
      }
      if (
        !bodyChecked &&
        !redirecting &&
        !authoredText(
          bodyFormat === "plain" ? plainBody : (editor?.getHTML() ?? ""),
          bodyFormat,
          includeSignature ? account?.signature : undefined,
        ).trim()
      ) {
        setBodyWarning({ sendAt, archiveSource: archiveAfterSend });
        return;
      }
      pendingClose.current = false;
      isSending.current = true;
      setSending(true);
      try {
        // An autosave may still be creating the draft. Wait so the sent
        // message carries its id and backend cleanup removes that draft.
        await savePromiseRef.current?.catch(() => undefined);
        const draft = buildDraft();
        const payload = { ...draft, id: draftIdRef.current ?? draft.id };
        const sendPayload = sendAt ? { ...payload, sendAt } : payload;
        const outcome =
          archiveAfterSend && sourceArchive
            ? await api.sendMessage(sendPayload, sourceArchive)
            : await api.sendMessage(sendPayload);
        announceLocalMailChanged(accountId);
        // Uncertain, or queued after a real attempt: never let it look sent.
        // An offline account queues on purpose and needs no warning.
        const current = useAppStore.getState();
        const offline =
          current.accounts.find((item) => item.id === accountId)?.syncState ===
            "offline" || current.sync[accountId]?.phase === "offline";
        if (
          (outcome.state === "needs_attention" ||
            (outcome.state === "queued" && !offline) ||
            outcome.state === "sent" ||
            outcome.state === "sent_copy_pending" ||
            outcome.state === "archive_pending") &&
          outcome.detail
        ) {
          setError(outcome.detail);
        }
        if (outcome.state === "scheduled") {
          useAppStore.getState().setLastSent({
            outboxId: outcome.id,
            accountId,
            scheduled: Boolean(sendAt),
            undoSeconds: sendAt
              ? undefined
              : Math.min(
                  useAppStore.getState().settings.undoSendSeconds ?? 10,
                  30,
                ),
          });
        }
        close();
      } catch (cause) {
        announceLocalMailChanged(accountId);
        setError(String(cause));
      } finally {
        isSending.current = false;
        setSending(false);
      }
    },
    [
      account?.signature,
      includeSignature,
      accountId,
      attachments.length,
      bcc,
      bodyFormat,
      buildDraft,
      canSend,
      redirecting,
      replyTo,
      cc,
      close,
      editor,
      plainBody,
      setError,
      sourceArchive,
      subject,
      to,
    ],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229) return;
      if (minimized) return;
      if (document.querySelector(".settings-window")) return;
      if (
        attachmentWarning ||
        subjectWarning ||
        audienceWarning ||
        bodyWarning ||
        noreplyWarning ||
        duplicateWarning ||
        confirmPlain
      )
        return;
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
  }, [
    attachmentWarning,
    audienceWarning,
    bodyWarning,
    noreplyWarning,
    duplicateWarning,
    confirmPlain,
    minimized,
    saveDraft,
    sendMessage,
    subjectWarning,
  ]);

  useLayoutEffect(() => {
    if (minimized) return;
    const top = composerPlace.current;
    if (top <= 0) return;
    const apply = () => {
      document
        .querySelectorAll<HTMLElement>(
          ".composer-window .tiptap, .composer-plain-editor",
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
      const scrolling = document.querySelector<HTMLElement>(
        ".composer-window .tiptap, .composer-plain-editor",
      );
      composerPlace.current = scrolling?.scrollTop ?? 0;
    }
    setMinimized(next);
  }

  useEffect(() => {
    if (subjectWarning || !focusSubjectAfterWarning.current) return;
    focusSubjectAfterWarning.current = false;
    document.getElementById("composer-subject")?.focus();
  }, [subjectWarning]);

  useEffect(() => {
    if (bodyWarning || !focusBodyAfterWarning.current) return;
    focusBodyAfterWarning.current = false;
    document
      .querySelector<HTMLElement>(".composer-plain-editor, .composer-editor")
      ?.focus();
  }, [bodyWarning]);

  useEffect(() => {
    if (
      audienceWarning ||
      noreplyWarning ||
      duplicateWarning ||
      !focusToAfterWarning.current
    )
      return;
    focusToAfterWarning.current = false;
    document.getElementById("composer-to")?.focus();
  }, [audienceWarning, noreplyWarning, duplicateWarning]);

  useEffect(() => {
    if (!sendMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!sendMenuRef.current?.contains(event.target as Node)) {
        setSendMenuOpen(false);
        setScheduleOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSendMenuOpen(false);
        setScheduleOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [sendMenuOpen]);

  function switchToPlain() {
    setPlainBody(htmlToQuotedPlainText(editor?.getHTML() ?? ""));
    // No HTML remains to show a picture, so pictures travel as files.
    setInlineImages(new Map());
    setAttachments((items) =>
      items.map((item) =>
        item.inline ? { ...item, inline: false, contentId: undefined } : item,
      ),
    );
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
        !isSending.current &&
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
  }, [accountId, dialogRef, markUnsaved, minimized, setError]);

  async function addAttachments() {
    try {
      const selected = await api.chooseAttachments(accountId, false);
      setAttachments((items) => [...items, ...selected]);
      if (selected.length) markUnsaved();
    } catch (cause) {
      setError(String(cause));
    }
  }

  pasteImageRef.current = async (files, tooLarge) => {
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

  useEffect(() => {
    const onAction = (event: Event) => {
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
  });

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
          <div data-context="composer">
            <EditorContent editor={editor} />
          </div>
        ) : (
          <div data-context="composer">
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
        {account?.signature &&
        includeSignature &&
        !seed?.draft &&
        !redirecting ? (
          <aside className="composer-signature-preview">
            <strong>{strings.composer.signaturePreview}</strong>
            <pre>{account.signature}</pre>
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
                    onClick={() => void previewComposeImage(item)}
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
                  aria-label={strings.composer.removeAttachment(item.filename)}
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
          <div
            className="settings-confirm-overlay"
            role="presentation"
            onMouseDown={() => setAttachmentPreview(null)}
          >
            <div
              className="settings-confirm-dialog compose-image-preview"
              role="dialog"
              aria-label={attachmentPreview.filename}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <img
                src={attachmentPreview.src}
                alt={attachmentPreview.filename}
              />
              <button
                type="button"
                className="toolbar-button"
                onClick={() => setAttachmentPreview(null)}
              >
                {strings.common.close}
              </button>
            </div>
          </div>
        ) : null}
        {linkDialogOpen ? (
          <div
            className="settings-confirm-overlay"
            role="dialog"
            aria-labelledby="composer-link-title"
          >
            <form
              className="settings-confirm-dialog"
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
              <label>
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
