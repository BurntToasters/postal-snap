import type { Dispatch, SetStateAction } from "react";
import type { Editor } from "@tiptap/core";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  MoreHorizontal,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Table2,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";
import { strings } from "../../i18n";
import { moveToolbarFocus } from "../toolbarNav";
import { highlightColor } from "./composerSeed";

export interface FormatToolbarProps {
  editor: Editor | null;
  formattingOpen: boolean;
  setFormattingOpen: Dispatch<SetStateAction<boolean>>;
  moreFormattingOpen: boolean;
  setMoreFormattingOpen: Dispatch<SetStateAction<boolean>>;
  adjustIndent: (delta: number) => void;
  addLink: () => void;
}

export function FormatToolbar({
  editor,
  formattingOpen,
  setFormattingOpen,
  moreFormattingOpen,
  setMoreFormattingOpen,
  adjustIndent,
  addLink,
}: FormatToolbarProps) {
  return (
    <>
      <div className="format-toggle-row">
        <button
          type="button"
          className="toolbar-button format-toggle"
          aria-expanded={formattingOpen}
          aria-controls="composer-formatting"
          onClick={() => setFormattingOpen((value) => !value)}
        >
          <span className="format-aa" aria-hidden="true">
            Aa
          </span>
          {formattingOpen
            ? strings.composer.hideFormatting
            : strings.composer.showFormatting}
        </button>
      </div>
      <div
        id="composer-formatting"
        className="format-toolbar"
        role="toolbar"
        aria-label={strings.composer.formatting}
        onKeyDown={moveToolbarFocus}
        hidden={!formattingOpen}
      >
        <div className="toolbar-group">
          <button
            type="button"
            onClick={() => editor?.chain().focus().undo().run()}
            aria-label={strings.composer.undo}
            title={strings.composer.undo}
          >
            <Undo2 />
          </button>
          <button
            type="button"
            onClick={() => editor?.chain().focus().redo().run()}
            aria-label={strings.composer.redo}
            title={strings.composer.redo}
          >
            <Redo2 />
          </button>
        </div>

        <div className="toolbar-group">
          <select
            aria-label={strings.composer.font}
            title={strings.composer.font}
            value={
              (editor?.getAttributes("textStyle").fontFamily as
                string | undefined) ?? ""
            }
            onChange={(event) =>
              event.target.value
                ? editor
                    ?.chain()
                    .focus()
                    .setFontFamily(event.target.value)
                    .run()
                : editor?.chain().focus().unsetFontFamily().run()
            }
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
            value={
              (editor?.getAttributes("textStyle").fontSize as
                string | undefined) ?? "16px"
            }
            onChange={(event) =>
              editor?.chain().focus().setFontSize(event.target.value).run()
            }
          >
            <option value="12px">{strings.composer.small}</option>
            <option value="16px">{strings.composer.normal}</option>
            <option value="20px">{strings.composer.large}</option>
            <option value="26px">{strings.composer.extraLarge}</option>
          </select>
        </div>

        <div className="toolbar-group">
          <button
            className={editor?.isActive("bold") ? "active" : ""}
            type="button"
            onClick={() => editor?.chain().focus().toggleBold().run()}
            aria-label={strings.composer.bold}
            aria-pressed={Boolean(editor?.isActive("bold"))}
            title={strings.composer.bold}
          >
            <Bold />
          </button>
          <button
            className={editor?.isActive("italic") ? "active" : ""}
            type="button"
            onClick={() => editor?.chain().focus().toggleItalic().run()}
            aria-label={strings.composer.italic}
            aria-pressed={Boolean(editor?.isActive("italic"))}
            title={strings.composer.italic}
          >
            <Italic />
          </button>
          <button
            className={editor?.isActive("underline") ? "active" : ""}
            type="button"
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
            aria-label={strings.composer.underline}
            aria-pressed={Boolean(editor?.isActive("underline"))}
            title={strings.composer.underline}
          >
            <UnderlineIcon />
          </button>
          <button
            className={editor?.isActive("strike") ? "active" : ""}
            type="button"
            onClick={() => editor?.chain().focus().toggleStrike().run()}
            aria-label={strings.composer.strike}
            aria-pressed={Boolean(editor?.isActive("strike"))}
            title={strings.composer.strike}
          >
            <Strikethrough />
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
            className={editor?.isActive("highlight") ? "active" : ""}
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .toggleHighlight({ color: highlightColor() })
                .run()
            }
            aria-label={strings.composer.highlight}
            aria-pressed={Boolean(editor?.isActive("highlight"))}
            title={strings.composer.highlight}
          >
            <Highlighter />
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
            <MoreHorizontal />
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
              className={
                editor?.isActive({ textAlign: "left" }) ? "active" : ""
              }
              onClick={() => editor?.chain().focus().setTextAlign("left").run()}
              aria-label={strings.composer.alignLeft}
              aria-pressed={Boolean(editor?.isActive({ textAlign: "left" }))}
              title={strings.composer.alignLeft}
            >
              <AlignLeft />
            </button>
            <button
              type="button"
              className={
                editor?.isActive({ textAlign: "center" }) ? "active" : ""
              }
              onClick={() =>
                editor?.chain().focus().setTextAlign("center").run()
              }
              aria-label={strings.composer.alignCenter}
              aria-pressed={Boolean(editor?.isActive({ textAlign: "center" }))}
              title={strings.composer.alignCenter}
            >
              <AlignCenter />
            </button>
            <button
              type="button"
              className={
                editor?.isActive({ textAlign: "right" }) ? "active" : ""
              }
              onClick={() =>
                editor?.chain().focus().setTextAlign("right").run()
              }
              aria-label={strings.composer.alignRight}
              aria-pressed={Boolean(editor?.isActive({ textAlign: "right" }))}
              title={strings.composer.alignRight}
            >
              <AlignRight />
            </button>
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              className={editor?.isActive("bulletList") ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
              aria-label={strings.composer.bullets}
              aria-pressed={Boolean(editor?.isActive("bulletList"))}
              title={strings.composer.bullets}
            >
              <List />
            </button>
            <button
              type="button"
              className={editor?.isActive("orderedList") ? "active" : ""}
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
              aria-label={strings.composer.numbers}
              aria-pressed={Boolean(editor?.isActive("orderedList"))}
              title={strings.composer.numbers}
            >
              <ListOrdered />
            </button>
            <button
              type="button"
              onClick={() => adjustIndent(-1)}
              aria-label={strings.composer.indentLess}
              title={strings.composer.indentLess}
            >
              <IndentDecrease />
            </button>
            <button
              type="button"
              onClick={() => adjustIndent(1)}
              aria-label={strings.composer.indentMore}
              title={strings.composer.indentMore}
            >
              <IndentIncrease />
            </button>
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              className={editor?.isActive("link") ? "active" : ""}
              onClick={addLink}
              aria-label={strings.composer.insertLink}
              aria-pressed={Boolean(editor?.isActive("link"))}
              title={strings.composer.insertLink}
            >
              <LinkIcon />
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
              <Table2 />
            </button>
            <button
              type="button"
              onClick={() => editor?.chain().focus().setHorizontalRule().run()}
              aria-label={strings.composer.insertRule}
              title={strings.composer.insertRule}
            >
              <Minus />
            </button>
            <button
              type="button"
              onClick={() =>
                editor?.chain().focus().clearNodes().unsetAllMarks().run()
              }
              aria-label={strings.composer.clearFormatting}
              title={strings.composer.clearFormatting}
            >
              <RemoveFormatting />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
