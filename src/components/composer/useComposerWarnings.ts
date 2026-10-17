import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

interface PendingSend {
  sendAt?: string;
  archiveSource?: boolean;
}

type Setter<T> = Dispatch<SetStateAction<T>>;

/** Opens a pre-send warning. Each call keeps the send options to replay. */
export interface ComposerWarningSetters {
  setAttachmentWarning: Setter<PendingSend | null>;
  setSubjectWarning: Setter<PendingSend | null>;
  setBodyWarning: Setter<PendingSend | null>;
  setAudienceWarning: Setter<(PendingSend & { count: number }) | null>;
  setNoreplyWarning: Setter<(PendingSend & { address: string }) | null>;
  setDuplicateWarning: Setter<(PendingSend & { address: string }) | null>;
}

/** Pre-send confirmations shown before a send continues. */
export function useComposerWarnings() {
  const [attachmentWarning, setAttachmentWarning] =
    useState<PendingSend | null>(null);
  const [subjectWarning, setSubjectWarning] = useState<PendingSend | null>(
    null,
  );
  const [bodyWarning, setBodyWarning] = useState<PendingSend | null>(null);
  const [audienceWarning, setAudienceWarning] = useState<
    (PendingSend & { count: number }) | null
  >(null);
  const [noreplyWarning, setNoreplyWarning] = useState<
    (PendingSend & { address: string }) | null
  >(null);
  const [duplicateWarning, setDuplicateWarning] = useState<
    (PendingSend & { address: string }) | null
  >(null);
  const focusSubjectAfterWarning = useRef(false);
  const focusBodyAfterWarning = useRef(false);
  const focusToAfterWarning = useRef(false);
  const setters = useMemo<ComposerWarningSetters>(
    () => ({
      setAttachmentWarning,
      setSubjectWarning,
      setBodyWarning,
      setAudienceWarning,
      setNoreplyWarning,
      setDuplicateWarning,
    }),
    [],
  );

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

  const warningOpen = Boolean(
    attachmentWarning ||
    subjectWarning ||
    bodyWarning ||
    audienceWarning ||
    noreplyWarning ||
    duplicateWarning,
  );

  return {
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
    setters,
  };
}
