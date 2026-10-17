import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Editor } from "@tiptap/core";
import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { ArchiveSource, BodyFormat, ComposeDraft } from "../../types";
import { announceLocalMailChanged } from "./composerSeed";
import {
  LARGE_RECIPIENT_COUNT,
  authoredText,
  firstNoreplyRecipient,
  isMailbox,
  mentionsAttachment,
  repeatedRecipient,
  splitAddresses,
  uniqueRecipientCount,
  validateRecipientFields,
  validateSubject,
} from "./composerValidate";
import type { ComposerWarningSetters } from "./useComposerWarnings";

type SaveState = "unsaved" | "saving" | "saved";

interface Options {
  accountId: string;
  editor: Editor | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  replyTo: string;
  redirecting: boolean;
  bodyFormat: BodyFormat;
  plainBody: string;
  includeSignature: boolean;
  signature?: string;
  attachmentCount: number;
  sourceArchive: ArchiveSource | undefined;
  sending: boolean;
  setSending: Dispatch<SetStateAction<boolean>>;
  saveState: SaveState;
  isSendingRef: RefObject<boolean>;
  /** Reads the discard flag without exposing a ref to render. */
  isDiscarding: () => boolean;
  pendingCloseRef: RefObject<boolean>;
  savePromiseRef: RefObject<Promise<unknown> | null>;
  draftIdRef: RefObject<string | undefined>;
  buildDraft: () => ComposeDraft;
  close: () => void;
  saveDraft: (showStatus?: boolean) => Promise<void>;
  setError: (error?: string) => void;
  warningSetters: ComposerWarningSetters;
  /** True while minimized, a warning is open, or the plain-text prompt shows. */
  shortcutsPaused: boolean;
}

/** Validation, send, schedule, and undo-send for the open composer. */
export function useComposerSend({
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
  signature,
  attachmentCount,
  sourceArchive,
  sending,
  setSending,
  saveState,
  isSendingRef,
  isDiscarding,
  pendingCloseRef,
  savePromiseRef,
  draftIdRef,
  buildDraft,
  close,
  saveDraft,
  setError,
  warningSetters,
  shortcutsPaused,
}: Options) {
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState("");
  const sendMenuRef = useRef<HTMLDivElement>(null);
  const [recipientError, setRecipientError] = useState<string>();
  const [subjectError, setSubjectError] = useState<string>();
  const [replyToError, setReplyToError] = useState<string>();

  const canSend = useMemo(
    () =>
      Boolean(
        editor &&
        !sending &&
        !isDiscarding() &&
        saveState !== "saving" &&
        [...splitAddresses(to), ...splitAddresses(cc), ...splitAddresses(bcc)]
          .length > 0 &&
        validateRecipientFields(to, cc, bcc) === undefined &&
        validateSubject(subject) === undefined,
      ),
    [bcc, cc, editor, isDiscarding, saveState, sending, subject, to],
  );

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
        isSendingRef.current ||
        isDiscarding()
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
        warningSetters.setNoreplyWarning({
          sendAt,
          archiveSource: archiveAfterSend,
          address: noreply,
        });
        return;
      }
      const repeated = repeatedRecipient(to, cc, bcc);
      if (!duplicatesChecked && repeated) {
        warningSetters.setDuplicateWarning({
          sendAt,
          archiveSource: archiveAfterSend,
          address: repeated,
        });
        return;
      }
      if (!subjectChecked && subject.trim().length === 0) {
        warningSetters.setSubjectWarning({
          sendAt,
          archiveSource: archiveAfterSend,
        });
        return;
      }
      const recipientCount = uniqueRecipientCount(to, cc, bcc);
      if (!audienceChecked && recipientCount >= LARGE_RECIPIENT_COUNT) {
        warningSetters.setAudienceWarning({
          sendAt,
          archiveSource: archiveAfterSend,
          count: recipientCount,
        });
        return;
      }
      if (
        !attachmentChecked &&
        attachmentCount === 0 &&
        mentionsAttachment(
          bodyFormat === "plain" ? plainBody : (editor?.getHTML() ?? ""),
          bodyFormat,
          includeSignature ? signature : undefined,
        )
      ) {
        warningSetters.setAttachmentWarning({
          sendAt,
          archiveSource: archiveAfterSend,
        });
        return;
      }
      if (
        !bodyChecked &&
        !redirecting &&
        !authoredText(
          bodyFormat === "plain" ? plainBody : (editor?.getHTML() ?? ""),
          bodyFormat,
          includeSignature ? signature : undefined,
        ).trim()
      ) {
        warningSetters.setBodyWarning({
          sendAt,
          archiveSource: archiveAfterSend,
        });
        return;
      }
      pendingCloseRef.current = false;
      isSendingRef.current = true;
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
        isSendingRef.current = false;
        setSending(false);
      }
    },
    [
      accountId,
      attachmentCount,
      bcc,
      bodyFormat,
      buildDraft,
      canSend,
      cc,
      close,
      draftIdRef,
      editor,
      includeSignature,
      isDiscarding,
      isSendingRef,
      pendingCloseRef,
      plainBody,
      redirecting,
      replyTo,
      savePromiseRef,
      setError,
      setSending,
      signature,
      sourceArchive,
      subject,
      to,
      warningSetters,
    ],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229) return;
      if (shortcutsPaused) return;
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
  }, [saveDraft, sendMessage, shortcutsPaused]);

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

  return {
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
  };
}
