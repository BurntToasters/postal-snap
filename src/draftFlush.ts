// Quit and replacement save the open message first. The composer registers how
// and whether it is busy (sending or discarding). Quitting bounds the wait and
// keeps the window open when saving fails.
type DraftFlush = () => Promise<void>;

interface Registration {
  flush: DraftFlush;
  isBusy: () => boolean;
  session: number;
}

let current: Registration | undefined;
let waiters: Array<() => void> = [];

export function registerDraftFlush(
  flush: DraftFlush,
  session: number,
  isBusy: () => boolean = () => false,
): () => void {
  const next = { flush, isBusy, session };
  current = next;
  for (const wake of waiters.splice(0)) wake();
  return () => {
    if (current === next) current = undefined;
  };
}

// Resolves true once the composer for this session has registered its flush.
// A new composer registers only after React commits it, so a replacement must
// wait here before it saves and replaces that editor.
export function waitForDraftFlush(session: number, timeoutMs = 2_000) {
  return new Promise<boolean>((resolve) => {
    const check = () => {
      if (current?.session !== session) {
        waiters.push(check);
        return;
      }
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters = waiters.filter((wake) => wake !== check);
      resolve(false);
    }, timeoutMs);
    check();
  });
}

// Session (composeNonce) of the composer whose editor is registered, if any.
export function openDraftSession(): number | undefined {
  return current?.session;
}

export function isOpenDraftBusy(): boolean {
  return current?.isBusy() ?? false;
}

export async function flushOpenDraft(timeoutMs = 4_000): Promise<void> {
  const registration = current;
  if (!registration) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      registration.flush(),
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
