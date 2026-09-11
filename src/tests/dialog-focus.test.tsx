import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "../components/useDialogFocus";

const originalCheckVisibility = HTMLElement.prototype.checkVisibility;
const originalOffsetParent = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetParent",
);

function Dialog({
  onClose,
  trapFocus = true,
  autoFocusLast = false,
  empty = false,
}: {
  onClose: () => void;
  trapFocus?: boolean;
  autoFocusLast?: boolean;
  empty?: boolean;
}) {
  const ref = useDialogFocus(onClose, { trapFocus });
  return (
    <div
      ref={ref as React.Ref<HTMLDivElement>}
      role="dialog"
      data-testid="dialog"
    >
      {empty ? null : (
        <>
          <button type="button">First</button>
          <button type="button" hidden>
            Hidden
          </button>
          <button type="button" autoFocus={autoFocusLast}>
            Last
          </button>
        </>
      )}
    </div>
  );
}

describe("dialog focus trap", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
      configurable: true,
      value: function checkVisibility(this: HTMLElement) {
        return !this.hidden;
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
      configurable: true,
      value: originalCheckVisibility,
    });
    if (originalOffsetParent) {
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetParent",
        originalOffsetParent,
      );
    }
  });

  it("moves initial focus into the dialog and restores it on close", async () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<Dialog onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "First" })).toHaveFocus(),
    );
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("leaves autofocused controls alone", async () => {
    render(<Dialog onClose={vi.fn()} autoFocusLast />);
    screen.getByRole("button", { name: "Last" }).focus();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
  });

  it("closes on Escape unless the event is already handled", () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    const ignored = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    ignored.preventDefault();
    document.dispatchEvent(ignored);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores keys when the dialog is inert or missing", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Dialog onClose={onClose} />);
    screen.getByTestId("dialog").setAttribute("inert", "");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(onClose).not.toHaveBeenCalled();
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("wraps Tab through dialog controls and native caption buttons", async () => {
    const caption = document.createElement("div");
    caption.className = "global-window-caption-controls";
    const minimize = document.createElement("button");
    minimize.textContent = "Minimize window";
    caption.append(minimize);
    document.body.append(caption);

    render(<Dialog onClose={vi.fn()} />);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    await waitFor(() => expect(first).toHaveFocus());

    fireEvent.keyDown(document, { key: "Tab" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(minimize).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(minimize).toHaveFocus();

    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    outside.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(minimize).toHaveFocus();
    outside.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    outside.remove();
    caption.remove();
  });

  it("does not trap Tab when trapping is disabled or nothing is focusable", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Dialog onClose={onClose} trapFocus={false} />);
    const first = screen.getByRole("button", { name: "First" });
    first.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
    rerender(<Dialog onClose={onClose} empty />);
    fireEvent.keyDown(document, { key: "Tab" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("falls back to offset visibility when checkVisibility is missing", async () => {
    Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get() {
        return document.body;
      },
    });
    render(<Dialog onClose={vi.fn()} />);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(document, { key: "Tab" });
    expect(last).toHaveFocus();
  });
});
