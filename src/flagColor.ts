import { api } from "./api";
import { errorText } from "./errors";
import { useAppStore } from "./store";
import type { FlagColor, MessageSummary } from "./types";

type Snapshot = Pick<MessageSummary, "isStarred" | "flagColor">;

/** Sets or clears the color of loaded messages. Clearing also unflags them. */
export async function setFlagColorFor(
  accountId: string,
  messageIds: number[],
  color: FlagColor | null,
): Promise<void> {
  if (messageIds.length === 0) return;
  const store = useAppStore.getState();
  const ids = new Set(messageIds);
  const previous = new Map<number, Snapshot>();
  for (const item of store.messages) {
    if (ids.has(item.id))
      previous.set(item.id, {
        isStarred: item.isStarred,
        flagColor: item.flagColor,
      });
  }
  const selected = store.selectedMessage;
  const selectedBefore: Snapshot | undefined =
    selected && ids.has(selected.id)
      ? { isStarred: selected.isStarred, flagColor: selected.flagColor }
      : undefined;
  const next: Snapshot = { isStarred: color !== null, flagColor: color ?? 0 };
  store.setMessages(
    store.messages.map((item) =>
      ids.has(item.id) ? { ...item, ...next } : item,
    ),
    store.messageCursor,
    store.hasMoreMessages,
  );
  if (selected && ids.has(selected.id))
    store.selectMessage({ ...selected, ...next });
  try {
    await api.setMessagesFlagColor(accountId, messageIds, color);
  } catch (cause) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== accountId) return;
    current.setMessages(
      current.messages.map((item) => {
        const before = previous.get(item.id);
        return before ? { ...item, ...before } : item;
      }),
      current.messageCursor,
      current.hasMoreMessages,
    );
    const open = current.selectedMessage;
    if (open && selectedBefore && open.id === selected?.id)
      current.selectMessage({ ...open, ...selectedBefore });
    current.setError(errorText(cause));
  }
}

/** Opens the row menu of the selected message, where the Flag color submenu lives. */
export function openFlagMenuForSelection(): void {
  const id = useAppStore.getState().selectedMessage?.id;
  const row = document.querySelector<HTMLElement>(
    `.message-row[data-message-id="${id}"]`,
  );
  if (!row) return;
  const box = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      button: 2,
    }),
  );
}
