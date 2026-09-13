import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import type { RecipientSuggestion } from "../../types";
import { tokenAtCaret } from "./recipientFieldUtils";

export function RecipientField({
  id,
  accountId,
  value,
  onChange,
  onBlur,
  placeholder,
  autoFocus,
  ariaInvalid,
  ariaDescribedBy,
}: {
  id: string;
  accountId: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  const [suggestions, setSuggestions] = useState<RecipientSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fetchTimer = useRef(0);
  const requestSequence = useRef(0);
  const listId = `${id}-suggestions`;

  useEffect(
    () => () => {
      window.clearTimeout(fetchTimer.current);
    },
    [],
  );

  function requestSuggestions(nextValue: string, caret: number | null) {
    window.clearTimeout(fetchTimer.current);
    const requestId = ++requestSequence.current;
    const position = caret ?? nextValue.length;
    const { token } = tokenAtCaret(
      nextValue,
      Math.min(position, nextValue.length),
    );
    if (token.length < 1) {
      setOpen(false);
      setSuggestions([]);
      return;
    }
    fetchTimer.current = window.setTimeout(() => {
      void api
        .suggestRecipients(accountId, token, 8)
        .then((results) => {
          if (requestId !== requestSequence.current) return;
          setSuggestions(results);
          setActiveIndex(0);
          setOpen(results.length > 0);
        })
        .catch(() => undefined);
    }, 150);
  }

  function acceptSuggestion(suggestion: RecipientSuggestion) {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? value.length;
    const { start } = tokenAtCaret(value, Math.min(caret, value.length));
    let end = start;
    while (end < value.length && value[end] !== "," && value[end] !== ";") {
      end += 1;
    }
    const separator = end < value.length ? value[end] : ",";
    const remainder = end < value.length ? value.slice(end + 1) : "";
    const nextValue = `${value.slice(0, start)}${suggestion.address}${separator} ${remainder.trimStart()}`;
    const nextCaret = start + suggestion.address.length + 2;
    onChange(nextValue);
    setOpen(false);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    }, 0);
  }

  return (
    <div className="recipient-combobox">
      <input
        id={id}
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        onChange={(event) => {
          onChange(event.target.value);
          requestSuggestions(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={(event) => {
          // Cmd/Ctrl+Enter sends; never swallow it as suggestion accept.
          if (event.metaKey || event.ctrlKey) return;
          if (!open) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => {
              const delta = event.key === "ArrowDown" ? 1 : -1;
              return (index + delta + suggestions.length) % suggestions.length;
            });
          } else if (event.key === "Enter" || event.key === "Tab") {
            const suggestion = suggestions[activeIndex];
            if (suggestion) {
              event.preventDefault();
              acceptSuggestion(suggestion);
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
        }}
        onBlur={() => {
          window.clearTimeout(fetchTimer.current);
          requestSequence.current += 1;
          setOpen(false);
          onBlur?.();
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={strings.composer.suggestedRecipients}
          className="recipient-suggestions"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.address}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "active" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => acceptSuggestion(suggestion)}
            >
              <span className="suggestion-name">
                {suggestion.name || suggestion.address}
              </span>
              {suggestion.name ? (
                <span className="suggestion-address">{suggestion.address}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
