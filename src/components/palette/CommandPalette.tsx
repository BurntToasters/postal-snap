import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { bestFuzzyScore } from "../../actions/fuzzy";
import { controlLabel, listActions } from "../../actions/registry";
import { palette } from "../../i18n/palette";
import { folderPathLabel } from "../../i18n/mail";
import { useAppStore } from "../../store";
import { useDialogFocus } from "../useDialogFocus";
import { useInertBackground } from "../useInertBackground";

type GroupKey = "actions" | "folders" | "accounts";

interface Option {
  key: string;
  label: string;
  detail?: string;
  hint?: string;
  keywords: readonly string[];
  run: () => void;
}

interface Group {
  key: GroupKey;
  label: string;
  options: Option[];
}

const GROUP_ORDER: GroupKey[] = ["actions", "folders", "accounts"];
const GROUP_LABELS: Record<GroupKey, string> = {
  actions: palette.actionsGroup,
  folders: palette.foldersGroup,
  accounts: palette.accountsGroup,
};

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

/** Runs a command only if it is still available at the moment of use. */
function guarded(available: (() => boolean) | undefined, run: () => void) {
  return () => {
    if (available && !available()) return;
    run();
  };
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  // Captured during render, before the dialog can move focus.
  const [invoker] = useState(() => focusedElement());
  const dismiss = () => {
    onClose();
    // The dialog restores focus before the inert background clears.
    window.setTimeout(() => invoker?.focus(), 0);
  };
  const dialogRef = useDialogFocus(dismiss);
  useInertBackground();
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-keys`;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Subscribing to the whole store keeps availability and folder lists current.
  const state = useAppStore();

  const actionOptions: Option[] = listActions().flatMap((action) => {
    if (!action.run || action.available?.() === false) return [];
    return [
      {
        key: `action:${action.id}`,
        label: action.label(),
        hint: action.hint?.(),
        keywords: action.keywords ?? [],
        run: guarded(action.available, action.run),
      },
    ];
  });

  // Folders come from the active account only, so no other account leaks in.
  const folderOptions: Option[] = state.mailboxes
    .filter((box) => box.accountId === state.activeAccountId)
    .map((box) => ({
      key: `folder:${box.id}`,
      label: folderPathLabel(box),
      keywords: [box.name],
      run: () => state.selectMailbox(box.id),
    }));

  const accountOptions: Option[] = state.accounts.flatMap((account, index) => {
    if (account.id === state.activeAccountId) return [];
    const name = account.displayName || account.email;
    return [
      {
        key: `account:${account.id}`,
        label: name,
        detail: name === account.email ? undefined : account.email,
        // Matches the Ctrl/Cmd+digit shortcut, which indexes the same list.
        hint: index < 9 ? `${controlLabel()} ${index + 1}` : undefined,
        keywords: [],
        run: () => state.selectAccount(account.id),
      },
    ];
  });

  const rawGroups: Record<GroupKey, Option[]> = {
    actions: actionOptions,
    folders: folderOptions,
    accounts: accountOptions,
  };
  const groups: Group[] = GROUP_ORDER.flatMap((key) => {
    const options = rawGroups[key]
      .map((option) => ({
        option,
        score: bestFuzzyScore(query, [
          option.label,
          option.detail ?? "",
          ...option.keywords,
        ]),
      }))
      .filter((entry) => entry.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((entry) => entry.option);
    return options.length > 0
      ? [{ key, label: GROUP_LABELS[key], options }]
      : [];
  });
  const flat = groups.flatMap((group) => group.options);
  const positions = new Map(flat.map((option, index) => [option, index]));
  const current = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    document
      .getElementById(`${baseId}-option-${current}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current, baseId]);

  function runOption(option: Option) {
    // Dismiss first so focus returns before the command moves it.
    dismiss();
    window.setTimeout(() => option.run(), 0);
  }

  function move(next: (index: number, count: number) => number) {
    if (flat.length === 0) return;
    setActive(next(current, flat.length));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move((index, count) => (index + 1) % count);
        return;
      case "ArrowUp":
        event.preventDefault();
        move((index, count) => (index - 1 + count) % count);
        return;
      case "Home":
        event.preventDefault();
        move(() => 0);
        return;
      case "End":
        event.preventDefault();
        move((_index, count) => count - 1);
        return;
      case "Enter": {
        const option = flat[current];
        if (!option) return;
        event.preventDefault();
        runOption(option);
        return;
      }
      default:
        return;
    }
  }

  // Keep focus in the input when the pointer picks an option.
  function keepInputFocus(event: MouseEvent) {
    event.preventDefault();
  }

  return createPortal(
    <div className="modal-layer palette-layer">
      <div
        className="modal-backdrop"
        aria-hidden="true"
        onMouseDown={dismiss}
      />
      <section
        className="palette-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <h2 id={titleId} className="visually-hidden">
          {palette.paletteTitle}
        </h2>
        <input
          id={inputId}
          className="palette-input"
          type="text"
          role="combobox"
          aria-label={palette.inputLabel}
          aria-autocomplete="list"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-activedescendant={
            flat.length > 0 ? optionId(current) : undefined
          }
          aria-describedby={hintId}
          placeholder={palette.placeholder}
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <p id={hintId} className="palette-keys">
          {palette.keysHint}
        </p>
        <div
          id={listId}
          className="palette-results"
          role="listbox"
          aria-label={palette.resultsLabel}
        >
          {groups.map((group) => (
            <div
              key={group.key}
              className="palette-group"
              role="group"
              aria-labelledby={`${baseId}-group-${group.key}`}
            >
              <div
                id={`${baseId}-group-${group.key}`}
                className="palette-group-label"
              >
                {group.label}
              </div>
              {group.options.map((option) => {
                const position = positions.get(option) ?? -1;
                return (
                  <div
                    key={option.key}
                    id={optionId(position)}
                    className="palette-option"
                    role="option"
                    aria-selected={position === current}
                    onMouseDown={keepInputFocus}
                    onMouseMove={() => {
                      if (position !== current) setActive(position);
                    }}
                    onClick={() => runOption(option)}
                  >
                    <span className="palette-option-label">{option.label}</span>
                    {option.detail ? (
                      <span className="palette-option-detail">
                        {option.detail}
                      </span>
                    ) : null}
                    {option.hint ? (
                      <kbd className="palette-option-hint">{option.hint}</kbd>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {flat.length === 0 ? (
          <p className="palette-empty" role="status">
            {palette.noResults}
          </p>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
