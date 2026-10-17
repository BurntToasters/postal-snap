import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Editor } from "@tiptap/core";
import { api } from "../../api";
import { registerDraftFlush } from "../../draftFlush";
import type { ComposeDraft, DraftSummary } from "../../types";
import { announceLocalMailChanged } from "./composerSeed";
import { hasDraftContent } from "./composerValidate";

type SaveState = "unsaved" | "saving" | "saved";
interface Options {
  accountId: string;
  onDraftSaved?: (id: string) => void;
  editor: Editor | null;
  sending: boolean;
  buildDraft: () => ComposeDraft;
  currentBodyText: () => string;
  close: () => void;
  saveState: SaveState;
  setSaveState: Dispatch<SetStateAction<SaveState>>;
  setDraftId: Dispatch<SetStateAction<string | undefined>>;
  setSavedAt: Dispatch<SetStateAction<string | undefined>>;
  setDraftSyncState: Dispatch<
    SetStateAction<DraftSummary["syncState"] | undefined>
  >;
  setDraftSyncDetail: Dispatch<SetStateAction<string | null | undefined>>;
  setError: (error?: string) => void;
  draftIdRef: RefObject<string | undefined>;
  savePromiseRef: RefObject<Promise<unknown> | null>;
  isSendingRef: RefObject<boolean>;
  isDiscardingRef: RefObject<boolean>;
  draftRevisionRef: RefObject<number>;
  saveInFlightRef: RefObject<boolean>;
  pendingCloseRef: RefObject<boolean>;
  closedByComposerRef: RefObject<boolean>;
  session: number;
}

export function useComposerDraftPersistence({
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
  isSendingRef,
  isDiscardingRef,
  draftRevisionRef,
  saveInFlightRef,
  pendingCloseRef,
  closedByComposerRef,
  session,
}: Options) {
  const saveDraftRef = useRef<(showStatus?: boolean) => Promise<void>>(() =>
    Promise.resolve(),
  );
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
        !isSendingRef.current &&
        !isDiscardingRef.current &&
        saveStateRef.current === "unsaved" &&
        !saveInFlightRef.current &&
        hasDraftContent(draft, currentBodyText())
      ) {
        const revision = draftRevisionRef.current;
        saveInFlightRef.current = true;
        setSaveState("saving");
        savePromiseRef.current = api
          .saveDraft(draft)
          .then((outcome) => {
            draftIdRef.current = outcome.id;
            if (isDiscardingRef.current) return;
            onDraftSaved?.(outcome.id);
            setDraftId(outcome.id);
            if (draftRevisionRef.current === revision) {
              setSaveState("saved");
              setSavedAt(new Date().toISOString());
              setDraftSyncState(outcome.syncState);
              setDraftSyncDetail(undefined);
            } else {
              setSaveState("unsaved");
            }
            announceLocalMailChanged(accountId);
          })
          .catch((cause) => {
            if (isDiscardingRef.current) return;
            setSaveState("unsaved");
            setError(String(cause));
          })
          .finally(() => {
            saveInFlightRef.current = false;
            if (pendingCloseRef.current) {
              pendingCloseRef.current = false;
              void saveDraftRef.current(true);
            } else if (
              !isDiscardingRef.current &&
              draftRevisionRef.current !== revision
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
  }, [
    accountId,
    onDraftSaved,
    currentBodyText,
    editor,
    sending,
    setError,
    draftIdRef,
    draftRevisionRef,
    isDiscardingRef,
    isSendingRef,
    pendingCloseRef,
    saveInFlightRef,
    savePromiseRef,
    setDraftId,
    setDraftSyncDetail,
    setDraftSyncState,
    setSaveState,
    setSavedAt,
  ]);

  const saveDraft = useCallback(
    async (showStatus = true) => {
      if (
        sending ||
        isSendingRef.current ||
        isDiscardingRef.current ||
        saveInFlightRef.current
      )
        return;
      const draft = buildDraft();
      if (!hasDraftContent(draft, currentBodyText())) {
        if (showStatus) close();
        return;
      }
      const revision = draftRevisionRef.current;
      saveInFlightRef.current = true;
      setSaveState("saving");
      try {
        const savePromise = api.saveDraft(draft).then((outcome) => {
          draftIdRef.current = outcome.id;
          return outcome;
        });
        savePromiseRef.current = savePromise;
        const outcome = await savePromise;
        if (isDiscardingRef.current) return;
        onDraftSaved?.(outcome.id);
        setDraftId(outcome.id);
        if (draftRevisionRef.current === revision) {
          setSaveState("saved");
          setSavedAt(new Date().toISOString());
          setDraftSyncState(outcome.syncState);
          setDraftSyncDetail(undefined);
        } else {
          setSaveState("unsaved");
        }
        announceLocalMailChanged(accountId);
        if (showStatus && draftRevisionRef.current === revision) close();
      } catch (cause) {
        if (isDiscardingRef.current) return;
        setSaveState("unsaved");
        setError(String(cause));
      } finally {
        saveInFlightRef.current = false;
        if (pendingCloseRef.current) {
          pendingCloseRef.current = false;
          void saveDraftRef.current(true);
        } else if (
          !isDiscardingRef.current &&
          draftRevisionRef.current !== revision
        ) {
          void saveDraftRef.current(false);
        }
      }
    },
    [
      accountId,
      onDraftSaved,
      buildDraft,
      close,
      currentBodyText,
      sending,
      setError,
      draftIdRef,
      draftRevisionRef,
      isDiscardingRef,
      isSendingRef,
      pendingCloseRef,
      saveInFlightRef,
      savePromiseRef,
      setDraftId,
      setDraftSyncDetail,
      setDraftSyncState,
      setSaveState,
      setSavedAt,
    ],
  );

  useEffect(() => {
    saveDraftRef.current = saveDraft;
  }, [saveDraft]);

  // Replaced by another composer (mailto:, Reply, an opened draft): save the
  // user's edits as a draft instead of dropping them. Tiptap destroys the
  // editor after unmount, so it is still readable here.
  useEffect(
    () => () => {
      if (
        closedByComposerRef.current ||
        isDiscardingRef.current ||
        isSendingRef.current ||
        draftRevisionRef.current === 0 ||
        saveStateRef.current !== "unsaved"
      )
        return;
      const draft = buildDraftRef.current();
      if (!hasDraftContent(draft, currentBodyText())) return;
      void (savePromiseRef.current ?? Promise.resolve())
        .catch(() => undefined)
        .then(() =>
          api.saveDraft({ ...draft, id: draftIdRef.current ?? draft.id }),
        )
        .then((outcome) => {
          onDraftSaved?.(outcome.id);
          announceLocalMailChanged(draft.accountId);
        })
        .catch(() => undefined);
    },
    [
      currentBodyText,
      onDraftSaved,
      closedByComposerRef,
      draftIdRef,
      draftRevisionRef,
      isDiscardingRef,
      isSendingRef,
      pendingCloseRef,
      saveInFlightRef,
      savePromiseRef,
      setDraftId,
      setDraftSyncDetail,
      setDraftSyncState,
      setSaveState,
      setSavedAt,
    ],
  );

  // Quit and replacement save unsaved edits without closing or asking. A
  // sending or discarding composer is busy: it must not be replaced, and no
  // save may run after it, or the draft would be written back.
  useEffect(
    () =>
      registerDraftFlush(
        async () => {
          if (isSendingRef.current || isDiscardingRef.current) return;
          while (saveInFlightRef.current) {
            await savePromiseRef.current?.catch(() => undefined);
          }
          if (isSendingRef.current || isDiscardingRef.current) return;
          saveInFlightRef.current = true;
          try {
            for (;;) {
              if (isSendingRef.current || isDiscardingRef.current) return;
              const draft = buildDraftRef.current();
              if (!hasDraftContent(draft, currentBodyText())) return;
              const revision = draftRevisionRef.current;
              const save = api.saveDraft({
                ...draft,
                id: draftIdRef.current ?? draft.id,
              });
              savePromiseRef.current = save;
              const outcome = await save;
              draftIdRef.current = outcome.id;
              onDraftSaved?.(outcome.id);
              setDraftId(outcome.id);
              if (draftRevisionRef.current !== revision) continue;
              // Set now, not after render: a replacement unmounts this editor
              // before React reports "saved", and its unmount save must skip.
              saveStateRef.current = "saved";
              setSaveState("saved");
              setSavedAt(new Date().toISOString());
              setDraftSyncState(outcome.syncState);
              setDraftSyncDetail(undefined);
              return;
            }
          } finally {
            saveInFlightRef.current = false;
          }
        },
        session,
        () => isSendingRef.current || isDiscardingRef.current,
      ),
    [
      session,
      onDraftSaved,
      currentBodyText,
      closedByComposerRef,
      draftIdRef,
      draftRevisionRef,
      isDiscardingRef,
      isSendingRef,
      pendingCloseRef,
      saveInFlightRef,
      savePromiseRef,
      setDraftId,
      setDraftSyncDetail,
      setDraftSyncState,
      setSaveState,
      setSavedAt,
    ],
  );

  return { saveDraft };
}
