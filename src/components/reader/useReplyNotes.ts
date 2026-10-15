import { useState } from "react";

export interface ReplyNotes {
  notes: Record<number, string>;
  remember: (id: number, text: string) => void;
  clear: (id: number) => void;
}

export function useReplyNotes(): ReplyNotes {
  const [notes, setNotes] = useState<Record<number, string>>({});

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

  return { notes, remember, clear };
}
