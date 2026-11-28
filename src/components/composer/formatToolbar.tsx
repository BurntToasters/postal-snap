import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  isProseMirrorCellSelection,
  isProseMirrorNodeSelection,
  type Editor,
} from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  TextAlignCenter,
  TextAlignStart,
  TextAlignEnd,
  Bold,
  Highlighter,
  ListIndentDecrease,
  ListIndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Minus,
  Ellipsis,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Table2,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";
import { strings } from "../../i18n";
import { moveToolbarFocus, useRovingToolbar } from "../toolbarNav";
import { highlightColor } from "./composerSeed";

function syncToolbarSelectionFromDom(editor: Editor | null) {
  if (!editor || editor.isDestroyed) return;
  const view = editor.view;
  const state = editor.state;
  if (!view?.dom || !state) return;

  const currentSelection = state.selection;
  if (
    isProseMirrorNodeSelection(currentSelection) ||
    isProseMirrorCellSelection(currentSelection)
  ) {
    return;
  }

  const domSelection = view.dom.ownerDocument.getSelection();
  const { anchorNode, anchorOffset, focusNode, focusOffset } =
    domSelection ?? {};
  if (
    !domSelection ||
    !anchorNode ||
    anchorOffset === undefined ||
    !focusNode ||
    focusOffset === undefined ||
    !view.dom.contains(anchorNode) ||
    !view.dom.contains(focusNode)
  ) {
    return;
  }

  const wholeEditorSelection =
    !domSelection.isCollapsed &&
    currentSelection.from === 0 &&
    currentSelection.to === state.doc.content.size &&
    domSelection.rangeCount > 0 &&
    (() => {
      const range = domSelection.getRangeAt(0);
      const editorRange = view.dom.ownerDocument.createRange();
      const RangeConstructor = view.dom.ownerDocument.defaultView?.Range;
      if (!RangeConstructor) return false;
      editorRange.selectNodeContents(view.dom);
      return (
        range.compareBoundaryPoints(
          RangeConstructor.START_TO_START,
          editorRange,
        ) === 0 &&
        range.compareBoundaryPoints(
          RangeConstructor.END_TO_END,
          editorRange,
        ) === 0
      );
    })();
  if (wholeEditorSelection) return;

  let anchorPosition: number;
  let focusPosition: number;
  try {
    anchorPosition = view.posAtDOM(anchorNode, anchorOffset);
    focusPosition = view.posAtDOM(focusNode, focusOffset);
  } catch {
    return;
  }
  if (
    anchorPosition < 0 ||
    anchorPosition > state.doc.content.size ||
    focusPosition < 0 ||
    focusPosition > state.doc.content.size
  ) {
    return;
  }
  if (
    currentSelection.anchor === anchorPosition &&
    currentSelection.head === focusPosition
  ) {
    return;
  }

  // Keep DOM anchor/head order so backward selections stay backward.
  editor.commands.setTextSelection({
    from: anchorPosition,
    to: focusPosition,
  });
}

export interface FormatToolbarProps {
  editor: Editor | null;
  formattingOpen: boolean;
  moreFormattingOpen: boolean;
  setMoreFormattingOpen: Dispatch<SetStateAction<boolean>>;
  adjustIndent: (delta: number) => void;
  addLink: () => void;
}

export function FormatToolbar({
  editor,
  formattingOpen,
  moreFormattingOpen,
  setMoreFormattingOpen,
  adjustIndent,
  addLink,
}: FormatToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const pointerFocusPending = useRef(false);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const editorDom = editor.view.dom;
    const onPointerDown = () => {
      pointerFocusPending.current = true;
    };
    const onPointerEnd = () => {
      pointerFocusPending.current = false;
    };
    const onEditorFocus = (event: FocusEvent) => {
      if (pointerFocusPending.current) {
        pointerFocusPending.current = false;
        return;
      }
      const previousTarget = event.relatedTarget;
      if (
        previousTarget instanceof Node &&
        toolbarRef.current?.contains(previousTarget)
      ) {
        editor.view.focus();
      }
    };
    editorDom.addEventListener("pointerdown", onPointerDown, true);
    editorDom.addEventListener("focus", onEditorFocus, true);
    editorDom.ownerDocument.defaultView?.addEventListener(
      "pointerup",
      onPointerEnd,
      true,
    );
    editorDom.ownerDocument.defaultView?.addEventListener(
      "pointercancel",
      onPointerEnd,
      true,
    );
    return () => {
      editorDom.removeEventListener("pointerdown", onPointerDown, true);
      editorDom.removeEventListener("focus", onEditorFocus, true);
      editorDom.ownerDocument.defaultView?.removeEventListener(
        "pointerup",
        onPointerEnd,
        true,
      );
      editorDom.ownerDocument.defaultView?.removeEventListener(
        "pointercancel",
        onPointerEnd,
        true,
      );
    };
  }, [editor]);
  const textStyle = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      fontFamily: current?.getAttributes("textStyle").fontFamily as
        string | undefined,
      fontSize: current?.getAttributes("textStyle").fontSize as
        string | undefined,
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      underline: current?.isActive("underline") ?? false,
      strike: current?.isActive("strike") ?? false,
      highlight: current?.isActive("highlight") ?? false,
      alignLeft: current?.isActive({ textAlign: "left" }) ?? false,
      alignCenter: current?.isActive({ textAlign: "center" }) ?? false,
      alignRight: current?.isActive({ textAlign: "right" }) ?? false,
      bulletList: current?.isActive("bulletList") ?? false,
      orderedList: current?.isActive("orderedList") ?? false,
      blockquote: current?.isActive("blockquote") ?? false,
      link: current?.isActive("link") ?? false,
    }),
  });
  const selectChangeStartedByPointer = useRef(false);
  const selectPointerDown = () => {
    selectChangeStartedByPointer.current = true;
  };
  const selectKeyDown = () => {
    selectChangeStartedByPointer.current = false;
  };
  const selectBlur = () => {
    selectChangeStartedByPointer.current = false;
  };
  const selectCommandChain = () => {
    const chain = editor?.chain();
    const formatting = selectChangeStartedByPointer.current
      ? chain?.focus()
      : chain;
    selectChangeStartedByPointer.current = false;
    return formatting;
  };
  const syncBeforeToolbarAction = () => {
    if (editor?.view?.hasFocus()) syncToolbarSelectionFromDom(editor);
  };
  useRovingToolbar(toolbarRef, [
    formattingOpen,
    moreFormattingOpen,
    Boolean(editor),
  ]);
  return (
    <>
      <div
        ref={toolbarRef}
        id="composer-formatting"
        className="format-toolbar"
        role="toolbar"
        aria-label={strings.composer.formatting}
        onKeyDown={moveToolbarFocus}
        onFocusCapture={(event) => {
          const previousTarget = event.relatedTarget;
          if (
            previousTarget instanceof Node &&
            editor?.view?.dom.contains(previousTarget)
          ) {
            syncToolbarSelectionFromDom(editor);
          }
        }}
        onPointerDownCapture={syncBeforeToolbarAction}
        onClickCapture={syncBeforeToolbarAction}
        hidden={!formattingOpen}
      >
        <div className="toolbar-group">
          <button
            type="button"
            onClick={() => editor?.chain().focus().undo().run()}
            aria-label={strings.composer.undo}
            title={strings.composer.undo}
          >
            <Undo2 aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().redo().run()}
            aria-label={strings.composer.redo}
            title={strings.composer.redo}
          >
            <Redo2 aria-hidden="true" />
          </button>
        </div>

        <div className="toolbar-group">
          <select
            aria-label={strings.composer.font}
            title={strings.composer.font}
            value={textStyle?.fontFamily ?? ""}
            onPointerDown={selectPointerDown}
            onKeyDown={selectKeyDown}
            onBlur={selectBlur}
            onChange={(event) => {
              const formatting = selectCommandChain();
              if (event.target.value) {
                formatting?.setFontFamily(event.target.value).run();
              } else {
                formatting?.unsetFontFamily().run();
              }
            }}
          >
            <option value="">{strings.composer.defaultFont}</option>
            <option value="Arial">Arial</option>
            <option value="Georgia">Georgia</option>
            <option value="Verdana">Verdana</option>
            <option value="'Courier New'">Courier</option>
          </select>
          <select
            aria-label={strings.composer.fontSize}
            title={strings.composer.fontSize}
            value={textStyle?.fontSize ?? "16px"}
            onPointerDown={selectPointerDown}
            onKeyDown={selectKeyDown}
            onBlur={selectBlur}
            onChange={(event) => {
              const formatting = selectCommandChain();
              formatting?.setFontSize(event.target.value).run();
            }}
          >
            <option value="12px">{strings.composer.small}</option>
            <option value="16px">{strings.composer.normal}</option>
            <option value="20px">{strings.composer.large}</option>
            <option value="26px">{strings.composer.extraLarge}</option>
          </select>
        </div>

        <div className="toolbar-group">
          <button
            className={textStyle?.bold ? "active" : ""}
            type="button"
            onClick={() => editor?.chain().focus().toggleBold().run()}
            aria-label={strings.composer.bold}
            aria-pressed={textStyle?.bold ?? false}
            title={strings.composer.bold}
          >
            <Bold aria-hidden="true" />
          </button>
          <button
            className={textStyle?.italic ? "active" : ""}
            type="button"
            onClick={() => editor?.chain().focus().toggleItalic().run()}
            aria-label={strings.composer.italic}
            aria-pressed={textStyle?.italic ?? false}
            title={strings.composer.italic}
          >
            <Italic aria-hidden="true" />
          </button>
          <button
            className={textStyle?.underline ? "active" : ""}
            type="button"
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
            aria-label={strings.composer.underline}
            aria-pressed={textStyle?.underline ?? false}
            title={strings.composer.underline}
          >
            <UnderlineIcon aria-hidden="true" />
          </button>
          <button
            className={textStyle?.strike ? "active" : ""}
            type="button"
            onClick={() => editor?.chain().focus().toggleStrike().run()}
            aria-label={strings.composer.strike}
            aria-pressed={textStyle?.strike ?? false}
            title={strings.composer.strike}
          >
            <Strikethrough aria-hidden="true" />
          </button>
          <label className="color-control" title={strings.composer.textColor}>
            <input
              type="color"
              aria-label={strings.composer.textColor}
              defaultValue={
                typeof document !== "undefined" &&
                (document.documentElement.dataset.theme === "dark" ||
                  (document.documentElement.dataset.theme !== "light" &&
                    window.matchMedia?.("(prefers-color-scheme: dark)")
                      ?.matches))
                  ? "#e8eef3"
                  : "#20252b"
              }
              onChange={(event) =>
                editor?.chain().focus().setColor(event.target.value).run()
              }
            />
            <span>A</span>
          </label>
          <button
            type="button"
            className={textStyle?.highlight ? "active" : ""}
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .toggleHighlight({ color: highlightColor() })
                .run()
            }
            aria-label={strings.composer.highlight}
            aria-pressed={textStyle?.highlight ?? false}
            title={strings.composer.highlight}
          >
            <Highlighter aria-hidden="true" />
          </button>
        </div>

        <div className="toolbar-group format-toolbar-more">
          <button
            type="button"
            className={moreFormattingOpen ? "active" : ""}
            aria-expanded={moreFormattingOpen}
            aria-controls="composer-more-formatting"
            aria-label={strings.composer.moreFormatting}
            title={strings.composer.moreFormatting}
            onClick={() => setMoreFormattingOpen((value) => !value)}
          >
            <Ellipsis aria-hidden="true" />
          </button>
        </div>

        <div
          id="composer-more-formatting"
          className={`format-toolbar-secondary ${moreFormattingOpen ? "open" : ""}`}
          hidden={!moreFormattingOpen}
        >
          <div className="toolbar-group">
            <button
              type="button"
              className={textStyle?.alignLeft ? "active" : ""}
              onClick={() => editor?.chain().focus().setTextAlign("left").run()}
              aria-label={strings.composer.alignLeft}
              aria-pressed={textStyle?.alignLeft ?? false}
              title={strings.composer.alignLeft}
            >
              <TextAlignStart aria-hidden="true" />
            </button>
            <button
              type="button"
              className={textStyle?.alignCenter ? "active" : ""}
              onClick={() =>
                editor?.chain().focus().setTextAlign("center").run()
              }
              aria-label={strings.composer.alignCenter}
              aria-pressed={textStyle?.alignCenter ?? false}
              title={strings.composer.alignCenter}
            >
              <TextAlignCenter aria-hidden="true" />
            </button>
            <button
              type="button"
              className={textStyle?.alignRight ? "active" : ""}
              onClick={() =>
                editor?.chain().focus().setTextAlign("right").run()
              }
              aria-label={strings.composer.alignRight}
              aria-pressed={textStyle?.alignRight ?? false}
              title={strings.composer.alignRight}
            >
              <TextAlignEnd aria-hidden="true" />
            </button>
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              className={textStyle?.bulletList ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
              aria-label={strings.composer.bullets}
              aria-pressed={textStyle?.bulletList ?? false}
              title={strings.composer.bullets}
            >
              <List aria-hidden="true" />
            </button>
            <button
              type="button"
              className={textStyle?.orderedList ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
              aria-label={strings.composer.numbers}
              aria-pressed={textStyle?.orderedList ?? false}
              title={strings.composer.numbers}
            >
              <ListOrdered aria-hidden="true" />
            </button>
            <button
              type="button"
              className={textStyle?.blockquote ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleBlockquote().run()}
              aria-label={strings.composer.quote}
              aria-pressed={textStyle?.blockquote ?? false}
              title={strings.composer.quote}
            >
              <Quote aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => adjustIndent(-1)}
              aria-label={strings.composer.indentLess}
              title={strings.composer.indentLess}
            >
              <ListIndentDecrease aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => adjustIndent(1)}
              aria-label={strings.composer.indentMore}
              title={strings.composer.indentMore}
            >
              <ListIndentIncrease aria-hidden="true" />
            </button>
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              className={textStyle?.link ? "active" : ""}
              onClick={addLink}
              aria-label={strings.composer.insertLink}
              aria-pressed={textStyle?.link ?? false}
              title={strings.composer.insertLink}
            >
              <LinkIcon aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() =>
                editor
                  ?.chain()
                  .focus()
                  .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                  .run()
              }
              aria-label={strings.composer.insertTable}
              title={strings.composer.insertTable}
            >
              <Table2 aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => editor?.chain().focus().setHorizontalRule().run()}
              aria-label={strings.composer.insertRule}
              title={strings.composer.insertRule}
            >
              <Minus aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() =>
                editor?.chain().focus().clearNodes().unsetAllMarks().run()
              }
              aria-label={strings.composer.clearFormatting}
              title={strings.composer.clearFormatting}
            >
              <RemoveFormatting aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
