import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { Bold, Italic, Underline as UnderlineIcon } from "lucide-react";
import { strings } from "../../i18n";
import { sanitizeComposeHtml } from "../../security";
import { plainTextToHtml } from "../composer/plainText";
import { SafeLink } from "../composer/extensions";

interface Props {
  accountId: string;
  plainText: string;
  html: string;
  onPlainTextChange: (value: string) => void;
  onHtmlChange: (plainText: string, html: string) => void;
}

export function SignatureEditor({
  accountId,
  plainText,
  html,
  onPlainTextChange,
  onHtmlChange,
}: Props) {
  const onHtmlChangeRef = useRef(onHtmlChange);
  const onPlainTextChangeRef = useRef(onPlainTextChange);
  const fallbackTextRef = useRef(plainText);
  const customizedFallback = useRef(false);
  useEffect(() => {
    onHtmlChangeRef.current = onHtmlChange;
    onPlainTextChangeRef.current = onPlainTextChange;
  }, [onHtmlChange, onPlainTextChange]);
  useEffect(() => {
    fallbackTextRef.current = plainText;
  }, [plainText]);

  const [initialContent] = useState(() =>
    sanitizeComposeHtml(html || plainTextToHtml(plainText)),
  );
  const extensions = useMemo(
    () => [
      StarterKit.configure({ link: false, underline: false }),
      Underline,
      SafeLink,
    ],
    [],
  );
  const editor = useEditor({
    extensions,
    content: initialContent,
    onCreate: ({ editor: current }) => {
      const richText = current.getText({ blockSeparator: "\n" });
      if (!fallbackTextRef.current.trim() && richText.trim()) {
        fallbackTextRef.current = richText;
        onPlainTextChangeRef.current(richText);
        return;
      }
      customizedFallback.current = fallbackTextRef.current !== richText;
    },
    editorProps: {
      attributes: {
        class: "signature-rich-content",
        role: "textbox",
        "aria-labelledby": `signature-label-${accountId}`,
        "aria-describedby": `signature-rich-help-${accountId}`,
        "aria-multiline": "true",
      },
      transformPastedHTML: (pasted) => sanitizeComposeHtml(pasted),
    },
    onUpdate: ({ editor: current }) => {
      if (!current.isInitialized || current.isDestroyed) return;
      const text = current.getText({ blockSeparator: "\n" });
      const fallback = customizedFallback.current
        ? fallbackTextRef.current
        : text;
      if (!customizedFallback.current) {
        fallbackTextRef.current = text;
        onPlainTextChangeRef.current(text);
      }
      onHtmlChangeRef.current(fallback, current.getHTML());
    },
  });
  useEffect(() => {
    if (!editor?.isInitialized || editor.isDestroyed) return;
    const richText = editor.getText({ blockSeparator: "\n" });
    if (!fallbackTextRef.current.trim() && richText.trim()) {
      fallbackTextRef.current = richText;
      onPlainTextChangeRef.current(richText);
      return;
    }
    customizedFallback.current = fallbackTextRef.current !== richText;
  }, [editor]);
  const activeMarks = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      underline: current?.isActive("underline") ?? false,
    }),
  });

  return (
    <section className="signature-editor">
      <div
        className="signature-editor-label"
        id={`signature-label-${accountId}`}
      >
        {strings.settings.signatureRich}
      </div>
      <p
        className="signature-rich-help"
        id={`signature-rich-help-${accountId}`}
      >
        {strings.settings.signatureEditorHelp}
      </p>
      <div
        className="signature-editor-toolbar"
        role="toolbar"
        aria-label={strings.settings.signatureFormatting}
      >
        <button
          type="button"
          aria-label={strings.settings.signatureBold}
          title={strings.settings.signatureBold}
          aria-pressed={activeMarks?.bold ?? false}
          disabled={!editor}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={strings.settings.signatureItalic}
          title={strings.settings.signatureItalic}
          aria-pressed={activeMarks?.italic ?? false}
          disabled={!editor}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={strings.settings.signatureUnderline}
          title={strings.settings.signatureUnderline}
          aria-pressed={activeMarks?.underline ?? false}
          disabled={!editor}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon aria-hidden="true" />
        </button>
      </div>
      <EditorContent editor={editor} />
      <div className="signature-fallback">
        <label htmlFor={`signature-fallback-${accountId}`}>
          {strings.settings.signature}
        </label>
        <textarea
          id={`signature-fallback-${accountId}`}
          rows={3}
          maxLength={2000}
          placeholder={strings.settings.signaturePlaceholder}
          value={plainText}
          onChange={(event) => {
            const next = event.target.value;
            if (
              !next.trim() &&
              editor?.isInitialized &&
              editor.getText().trim()
            )
              return;
            customizedFallback.current = true;
            fallbackTextRef.current = next;
            onPlainTextChange(next);
          }}
          aria-describedby={`signature-fallback-help-${accountId}`}
        />
        <p
          className="signature-rich-help-fallback"
          id={`signature-fallback-help-${accountId}`}
        >
          {strings.settings.signatureFallbackHelp}
        </p>
      </div>
    </section>
  );
}
