import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneSplitter } from "../components/mail/paneSplitter";
import { moveMenuFocus, moveToolbarFocus } from "../components/toolbarNav";

const originalCheckVisibility = HTMLElement.prototype.checkVisibility;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
    configurable: true,
    value: () => true,
  });
});

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
    configurable: true,
    value: originalCheckVisibility,
  });
});

describe("toolbar keyboard navigation", () => {
  it("moves, wraps, and jumps among toolbar controls", () => {
    render(
      <div role="toolbar" onKeyDown={moveToolbarFocus}>
        <button>First</button>
        <button disabled>Disabled</button>
        <select aria-label="Choice">
          <option>Choice</option>
        </select>
        <button>Last</button>
      </div>,
    );
    const first = screen.getByRole("button", { name: "First" });
    const choice = screen.getByRole("combobox", { name: "Choice" });
    const last = screen.getByRole("button", { name: "Last" });

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "End" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(choice).toHaveFocus();
    fireEvent.keyDown(choice, { key: "Escape" });
  });

  it("ignores empty toolbars and toolbars without an active child", () => {
    const { rerender } = render(
      <div data-testid="toolbar" onKeyDown={moveToolbarFocus} />,
    );
    fireEvent.keyDown(screen.getByTestId("toolbar"), { key: "ArrowRight" });
    rerender(
      <div data-testid="toolbar" onKeyDown={moveToolbarFocus}>
        <button>Only</button>
      </div>,
    );
    document.body.focus();
    fireEvent.keyDown(screen.getByTestId("toolbar"), { key: "ArrowRight" });
  });

  it("moves and wraps through menu items", () => {
    render(
      <div role="menu" onKeyDown={moveMenuFocus}>
        <button role="menuitem">First</button>
        <button role="menuitem">Middle</button>
        <button role="menuitem">Last</button>
      </div>,
    );
    const first = screen.getByRole("menuitem", { name: "First" });
    const middle = screen.getByRole("menuitem", { name: "Middle" });
    const last = screen.getByRole("menuitem", { name: "Last" });

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "End" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(middle).toHaveFocus();
  });

  it("ignores empty menus and unrelated keys", () => {
    render(<div data-testid="menu" role="menu" onKeyDown={moveMenuFocus} />);
    fireEvent.keyDown(screen.getByTestId("menu"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("menu"), { key: "Escape" });
  });
});

describe("pane splitter", () => {
  it("supports every vertical keyboard adjustment", () => {
    const onChange = vi.fn();
    render(
      <PaneSplitter
        className="folders"
        label="Resize folders"
        controls="folders"
        orientation="vertical"
        value={200}
        min={100}
        max={400}
        onChange={onChange}
      />,
    );
    const separator = screen.getByRole("separator");
    for (const key of [
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "ArrowLeft",
      "ArrowRight",
      "Escape",
    ]) {
      fireEvent.keyDown(separator, { key });
    }
    expect(onChange.mock.calls).toEqual([
      [100, true],
      [400, true],
      [264, true],
      [136, true],
      [184, true],
      [216, true],
    ]);
  });

  it("supports reverse horizontal keys and pointer dragging", () => {
    const onChange = vi.fn();
    render(
      <PaneSplitter
        className="reader"
        label="Resize reader"
        orientation="horizontal-reverse"
        value={300}
        min={200}
        max={500}
        onChange={onChange}
      />,
    );
    const separator = screen.getByRole("separator");
    Object.assign(separator, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    fireEvent.pointerDown(separator, { pointerId: 3, clientY: 100 });
    fireEvent.pointerMove(separator, { pointerId: 3, clientY: 140 });
    fireEvent.pointerUp(separator, { pointerId: 3, clientY: 160 });

    expect(onChange).toHaveBeenCalledWith(316, true);
    expect(onChange).toHaveBeenCalledWith(284, true);
    expect(onChange).toHaveBeenCalledWith(260, false);
    expect(onChange).toHaveBeenCalledWith(240, true);
  });

  it("persists the last drag value and cleans up on pointer cancel", () => {
    const onChange = vi.fn();
    render(
      <PaneSplitter
        className="folders"
        label="Resize folders"
        orientation="vertical"
        value={200}
        min={100}
        max={400}
        onChange={onChange}
      />,
    );
    const separator = screen.getByRole("separator");
    const releasePointerCapture = vi.fn();
    Object.assign(separator, {
      setPointerCapture: vi.fn(),
      releasePointerCapture,
    });
    fireEvent.pointerDown(separator, { pointerId: 7, clientX: 100 });
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 150 });
    fireEvent.pointerCancel(separator, { pointerId: 7 });

    expect(onChange).toHaveBeenLastCalledWith(250, true);
    expect(releasePointerCapture).not.toHaveBeenCalled();

    onChange.mockClear();
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 300 });
    fireEvent.pointerUp(separator, { pointerId: 7, clientX: 300 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
