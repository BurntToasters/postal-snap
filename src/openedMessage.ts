import { api } from "./api";
import { errorText } from "./errors";
import { useAppStore } from "./store";
import type { OpenedMessage } from "./types";

/** Window event carrying an OpenedMessage to the app's viewer host. */
export const OPENED_MESSAGE_EVENT = "postal:opened-message";

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
