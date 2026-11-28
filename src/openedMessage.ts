import { api, inTauri } from "./api";
import { errorText } from "./errors";
import { useAppStore } from "./store";
import type { OpenedMessage } from "./types";

/** Window event carrying an OpenedMessage to the app's viewer host. */
export const OPENED_MESSAGE_EVENT = "postal:opened-message";

type Receiver = {
  id: number;
  onMessage: (opened: OpenedMessage) => void;
  onError: (message: string) => void;
};

const MAX_PENDING_OPEN_TOKENS = 16;
const MAX_REMEMBERED_OPEN_TOKENS = 32;
let receiver: Receiver | null = null;
let nextReceiverId = 1;
let nativeListenerReady = false;
let nativeListenerStart: Promise<void> | null = null;
let startupEvents: string[] = [];
const startupEventSet = new Set<string>();
const pendingTokens: string[] = [];
const rememberedTokens = new Set<string>();
const rememberedOrder: string[] = [];
let readingToken = false;

function rememberToken(token: string): boolean {
  if (!token || rememberedTokens.has(token)) return false;
  rememberedTokens.add(token);
  rememberedOrder.push(token);
  if (rememberedOrder.length > MAX_REMEMBERED_OPEN_TOKENS) {
    const expired = rememberedOrder.shift();
    if (expired) rememberedTokens.delete(expired);
  }
  return true;
}

function queuePendingToken(token: string): void {
  if (!rememberToken(token)) return;
  pendingTokens.push(token);
  if (pendingTokens.length > MAX_PENDING_OPEN_TOKENS) {
    pendingTokens.splice(readingToken ? 1 : 0, 1);
  }
  processPendingTokens();
}

function bufferStartupEvent(token: string): void {
  if (!token || startupEventSet.has(token)) return;
  startupEventSet.add(token);
  startupEvents.push(token);
  if (startupEvents.length > 8) {
    const expired = startupEvents.shift();
    if (expired) startupEventSet.delete(expired);
  }
}

async function startNativeOpenListener(): Promise<void> {
  if (nativeListenerReady || nativeListenerStart || !inTauri()) return;
  nativeListenerStart = (async () => {
    try {
      await api.onEmlOpened(({ token }) => {
        if (nativeListenerReady) queuePendingToken(token);
        else bufferStartupEvent(token);
      });
      const tokens = await api.drainOpenedMessageTokens();
      nativeListenerReady = true;
      tokens.forEach(queuePendingToken);
      startupEvents.forEach(queuePendingToken);
      startupEvents = [];
      startupEventSet.clear();
      processPendingTokens();
    } catch (cause) {
      const current = receiver;
      if (current) current.onError(errorText(cause));
      nativeListenerReady = true;
      startupEvents.forEach(queuePendingToken);
      startupEvents = [];
      startupEventSet.clear();
      processPendingTokens();
    }
  })();
  await nativeListenerStart;
}

function processPendingTokens(): void {
  if (
    !nativeListenerReady ||
    readingToken ||
    !receiver ||
    pendingTokens.length === 0
  )
    return;
  const token = pendingTokens[0];
  const current = receiver;
  readingToken = true;
  void api
    .getOpenedMessage(token)
    .then(async (opened) => {
      if (receiver?.id !== current.id) return;
      current.onMessage(opened);
      pendingTokens.shift();
      try {
        await api.acknowledgeOpenedMessageToken(token);
      } catch (cause) {
        current.onError(errorText(cause));
      }
    })
    .catch((cause: unknown) => {
      if (receiver?.id !== current.id) return;
      pendingTokens.shift();
      current.onError(errorText(cause));
      void api.acknowledgeOpenedMessageToken(token).catch(() => undefined);
    })
    .finally(() => {
      readingToken = false;
      processPendingTokens();
    });
}

/** Subscribe to OS file opens. The native queue survives React effect cleanup. */
export function subscribeOsOpenedMessages(
  onMessage: (opened: OpenedMessage) => void,
  onError: (message: string) => void,
): () => void {
  const current = { id: nextReceiverId++, onMessage, onError };
  receiver = current;
  void startNativeOpenListener();
  processPendingTokens();
  return () => {
    if (receiver?.id === current.id) receiver = null;
  };
}

export function emitOpenedMessage(opened: OpenedMessage): void {
  window.dispatchEvent(
    new CustomEvent<OpenedMessage>(OPENED_MESSAGE_EVENT, { detail: opened }),
  );
}

/** Shows the native file picker; a cancel does nothing. */
export async function openEmlFromPicker(): Promise<void> {
  try {
    const opened = await api.openEmlFile();
    if (opened) emitOpenedMessage(opened);
  } catch (cause) {
    useAppStore.getState().setError(errorText(cause));
  }
}
