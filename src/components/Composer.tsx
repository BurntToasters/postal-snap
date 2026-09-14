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
import { Maximize2, TriangleAlert, X } from "lucide-react";
import { api } from "../api";
import {
  CONTEXT_ACTION_EVENT,
  type ContextMenuActionDetail,
} from "../contextMenu";
import { strings } from "../i18n";
import { htmlToPlainText, sanitizeComposeHtml } from "../security";
import { useAppStore } from "../store";
import type { ComposeAttachment, ComposeDraft } from "../types";
import { useDialogFocus } from "./useDialogFocus";
import { AddressFields } from "./composer/addressFields";
import { ComposerHeader } from "./composer/composerHeader";
import { FormatToolbar } from "./composer/formatToolbar";
import { SendBar } from "./composer/sendBar";
import {
  announceLocalMailChanged,
  composerTitle,
  seedBody,
  seedRecipients,
  seedReferences,
  seedSubject,
} from "./composer/composerSeed";
import {
  hasDraftContent,
  splitAddresses,
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
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("https://");
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
  const saveDraftRef = useRef<(showStatus?: boolean) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const markUnsaved = useCallback(() => {
    draftRevision.current += 1;
    setSaveState("unsaved");
  }, []);
  const keepSourceVisible = Boolean(seed?.composeMode && !maximized);
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
        seed?.draft?.inReplyTo ??
        (seed?.composeMode === "forward"
          ? undefined
          : (seed?.sourceMessage?.messageId ?? undefined)),
      references: seedReferences(seed),
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
        savePromiseRef.current = api
          .saveDraft(draft)
          .then((outcome) => {
            draftIdRef.current = outcome.id;
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
    const flushDraft = () => {
      void saveDraftRef.current(false);
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", flushDraft);
    window.addEventListener("beforeunload", flushDraft);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(saveTimer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", flushDraft);
      window.removeEventListener("beforeunload", flushDraft);
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
        const savePromise = api.saveDraft(draft).then((outcome) => {
          draftIdRef.current = outcome.id;
          return outcome;
        });
        savePromiseRef.current = savePromise;
        const outcome = await savePromise;
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
    if (sending || isDiscarding.current) return;
    if (hasDraftContent(buildDraft(), editor?.getText() ?? "")) {
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
    async (sendAt?: string) => {
      const validation = validateRecipientFields(to, cc, bcc);
      const subjectValidation = validateSubject(subject);
      setRecipientError(validation);
      setSubjectError(subjectValidation);
      if (
        !canSend ||
        validation ||
        subjectValidation ||
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
      pendingClose.current = false;
      isSending.current = true;
      setSending(true);
      try {
        const draft = buildDraft();
        const outcome = await api.sendMessage(
          sendAt ? { ...draft, sendAt } : draft,
        );
        announceLocalMailChanged(accountId);
        if (outcome.state === "needs_attention" && outcome.detail) {
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
    [accountId, bcc, buildDraft, canSend, cc, close, setError, subject, to],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229) return;
      if (minimized) return;
      if (document.querySelector(".settings-window")) return;
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
    setLinkValue(current ?? "https://");
    setLinkDialogOpen(true);
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

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<ContextMenuActionDetail>).detail;
      if (!detail) return;
      if (detail.target.kind === "composer") {
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
        className={`composer-window${maximized ? " composer-maximized" : ""}`}
        ref={dialogRef}
      >
        <ComposerHeader
          seed={seed}
          saveState={saveState}
          maximized={maximized}
          sending={sending}
          draftSyncState={draftSyncState}
          draftSyncDetail={draftSyncDetail}
          setMinimized={setMinimized}
          setMaximized={setMaximized}
          requestClose={requestClose}
        />
        <AddressFields
          accountId={accountId}
          availableSenders={availableSenders}
          fromAddress={fromAddress}
          fromValue={fromValue}
          setFromAddress={setFromAddress}
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
          markUnsaved={markUnsaved}
        />
        <FormatToolbar
          editor={editor}
          formattingOpen={formattingOpen}
          setFormattingOpen={setFormattingOpen}
          moreFormattingOpen={moreFormattingOpen}
          setMoreFormattingOpen={setMoreFormattingOpen}
          adjustIndent={adjustIndent}
          addLink={addLink}
        />
        <div data-context="composer">
          <EditorContent editor={editor} />
        </div>
        {account?.signature && !seed?.draft ? (
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
        <SendBar
          sendMenuRef={sendMenuRef}
          canSend={canSend}
          sendMessage={sendMessage}
          sending={sending}
          sendMenuOpen={sendMenuOpen}
          setSendMenuOpen={setSendMenuOpen}
          scheduleOpen={scheduleOpen}
          setScheduleOpen={setScheduleOpen}
          scheduleValue={scheduleValue}
          setScheduleValue={setScheduleValue}
          saveDraft={saveDraft}
          saveState={saveState}
          addAttachments={addAttachments}
          addInlineImage={addInlineImage}
          discardDraft={discardDraft}
        />
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
