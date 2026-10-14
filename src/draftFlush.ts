// Quit saves the open message first. The composer registers how; quitting
// bounds the wait and keeps the window open when saving fails.
type DraftFlush = () => Promise<void>;

let flush: DraftFlush | undefined;

export function registerDraftFlush(next: DraftFlush): () => void {
  flush = next;
  return () => {
    if (flush === next) flush = undefined;
  };
}

export async function flushOpenDraft(timeoutMs = 4_000): Promise<void> {
  const current = flush;
  if (!current) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      current(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Draft save timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
