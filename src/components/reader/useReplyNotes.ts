import { useEffect, useRef, useState } from "react";
import { useAppStore, type ComposerSeed } from "../../store";

export interface ReplyNotes {
  notes: Record<number, string>;
  remember: (id: number, text: string) => void;
  /** Clears the note once the store opens `seed`, never if it is refused. */
  clearWhenOpened: (id: number, seed: ComposerSeed, text: string) => void;
}

export function useReplyNotes(): ReplyNotes {
  const [notes, setNotes] = useState<Record<number, string>>({});
  const latest = useRef(notes);
  useEffect(() => {
    latest.current = notes;
  }, [notes]);
  const watches = useRef(new Map<number, () => void>());

  useEffect(() => {
    const active = watches.current;
    return () => {
      for (const stop of active.values()) stop();
      active.clear();
    };
  }, []);

  function remember(id: number, text: string) {
    setNotes((current) => {
      const next = { ...current };
      delete next[id];
      if (text) next[id] = text;
      const ids = Object.keys(next);
      while (ids.length > 30) {
        const oldest = ids.shift();
        if (oldest !== undefined) delete next[Number(oldest)];
      }
      return next;
    });
  }

  function clear(id: number) {
    setNotes((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  function clearWhenOpened(id: number, seed: ComposerSeed, text: string) {
    watches.current.get(id)?.();
    const done = () => {
      stop();
      if (watches.current.get(id) === stop) watches.current.delete(id);
    };
    // Clears only for this seed and only if the note is still what was sent.
    const check = (): boolean => {
      if (useAppStore.getState().composeSeed !== seed) return false;
      if (latest.current[id]?.trim() === text) clear(id);
      return true;
    };
    const unsubscribe = useAppStore.subscribe(() => {
      if (check()) done();
    });
    const stop = () => unsubscribe();
    watches.current.set(id, stop);
    if (check()) done();
  }

  return { notes, remember, clearWhenOpened };
}
