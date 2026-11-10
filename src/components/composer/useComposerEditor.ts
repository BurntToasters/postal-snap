import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type SetStateAction,
} from "react";
import { useEditor, type UseEditorOptions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import { TextStyle } from "@tiptap/extension-text-style";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import { strings } from "../../i18n";
import { sanitizeComposeHtml } from "../../security";
import type { ComposerSeed } from "../../store";
import type { BodyFormat } from "../../types";
import { clipboardImages } from "./pasteImage";
import { seedBody } from "./composerSeed";
import { isPlainPasteShortcut, plainPasteBlocks } from "./plainText";
import { FontSize, Indentation, RemoteImage, SafeLink } from "./extensions";

export type PasteImages = (files: File[], tooLarge: boolean) => Promise<void>;

export interface ComposerEditorInput {
  seed: ComposerSeed | undefined;
  markUnsaved: () => void;
  setError: (error?: string) => void;
  plainRef: RefObject<HTMLTextAreaElement | null>;
  bodyFormatRef: RefObject<BodyFormat>;
  setPlainBody: (value: string) => void;
  minimized: boolean;
  setMinimized: (value: boolean) => void;
}

/**
 * Compose editor. Extensions and the seed body are built once per seed, so
 * unrelated renders (typing in To or Subject) neither re-sanitize nor rebuild.
 * useEditor only reads options at creation, so the editor is not recreated.
 */
export function useComposerEditor({
  seed,
  markUnsaved,
  setError,
  plainRef,
  bodyFormatRef,
  setPlainBody,
  minimized,
  setMinimized,
}: ComposerEditorInput) {
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("https://");
  const [linkCanRemove, setLinkCanRemove] = useState(false);

  const composerPlace = useRef(0);
  const pastePlainRef = useRef<() => Promise<void>>(async () => undefined);
  const pasteImageRef = useRef<PasteImages>(async () => undefined);

  const takePastedImages = useCallback((event: Event) => {
    const { files, tooLarge } = clipboardImages(
      (event as ClipboardEvent).clipboardData,
    );
    if (files.length === 0 && !tooLarge) return false;
    event.preventDefault();
    void pasteImageRef.current(files, tooLarge);
    return true;
  }, []);

  const extensions = useMemo(
    () => [
      StarterKit.configure({ link: false, underline: false }),
      Underline,
      SafeLink,
      RemoteImage.configure({ allowBase64: true }),
      TextStyle,
      FontSize,
      Indentation,
      Color,
      FontFamily,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    [],
  );

  const content = useMemo(() => seedBody(seed), [seed]);

  const options = useMemo<UseEditorOptions>(
    () => ({
      extensions,
      content,
      editorProps: {
        attributes: {
          class: "composer-editor",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": strings.composer.messageBody,
        },
        transformPastedHTML: (html) => sanitizeComposeHtml(html),
        handleDOMEvents: {
          keydown: (_view, event) => {
            if (!isPlainPasteShortcut(event)) return false;
            event.preventDefault();
            void pastePlainRef.current();
            return true;
          },
          paste: (_view, event) => takePastedImages(event),
          contextmenu: (_view, event) => {
            event.preventDefault();
            return true;
          },
          auxclick: (_view, event) => {
            if (
              event.button === 1 &&
              (event.target as HTMLElement | null)?.closest("a")
            ) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
      },
      immediatelyRender: false,
      onUpdate: markUnsaved,
    }),
    [extensions, content, markUnsaved, takePastedImages],
  );

  const editor = useEditor(options);

  function addLink() {
    const current = editor?.getAttributes("link").href as string | undefined;
    setLinkCanRemove(Boolean(current));
    setLinkValue(current ?? "https://");
    setLinkDialogOpen(true);
  }

  function removeLink() {
    editor?.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkDialogOpen(false);
  }

  function applyLink() {
    const href = linkValue.trim().slice(0, 2000);
    if (!/^(https?|mailto):/i.test(href) || /\s/.test(href)) {
      setError(strings.composer.unsafeLink);
      return;
    }
    editor?.chain().focus().extendMarkRange("link").setLink({ href }).run();
    setLinkDialogOpen(false);
  }

  function adjustIndent(delta: number) {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const transaction = editor.state.tr;
    editor.state.doc.nodesBetween(from, to, (node, position) => {
      if (!["paragraph", "heading"].includes(node.type.name)) return;
      const current = Number(node.attrs.indent ?? 0);
      const indent = Math.max(0, Math.min(6, current + delta));
      transaction.setNodeMarkup(position, undefined, { ...node.attrs, indent });
    });
    if (transaction.docChanged) editor.view.dispatch(transaction);
    editor.commands.focus();
  }

  async function pastePlainText() {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setError(strings.composer.clipboardUnavailable);
      return;
    }
    const blocks = plainPasteBlocks(text);
    if (blocks.length === 0) return;
    if (bodyFormatRef.current === "plain") {
      const field = plainRef.current;
      if (!field) return;
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      const plain = blocks
        .map((block) => block.content?.[0]?.text ?? "")
        .join("\n");
      setPlainBody(
        field.value.slice(0, start) + plain + field.value.slice(end),
      );
      markUnsaved();
      const cursor = start + plain.length;
      window.requestAnimationFrame(() => {
        field.focus();
        field.setSelectionRange(cursor, cursor);
      });
      return;
    }
    editor?.chain().focus().insertContent(blocks).run();
  }

  useLayoutEffect(() => {
    pastePlainRef.current = pastePlainText;
  });

  useLayoutEffect(() => {
    if (minimized) return;
    const top = composerPlace.current;
    if (top <= 0) return;
    const apply = () => {
      document
        .querySelectorAll<HTMLElement>(
          ".composer-window .composer-body, .composer-window .tiptap, .composer-plain-editor",
        )
        .forEach((node) => {
          node.scrollTop = top;
        });
    };
    apply();
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [minimized]);

  function setComposerMinimized(value: SetStateAction<boolean>) {
    const next = typeof value === "function" ? value(minimized) : value;
    if (next) {
      let top = 0;
      document
        .querySelectorAll<HTMLElement>(
          ".composer-window .composer-body, .composer-window .tiptap, .composer-plain-editor",
        )
        .forEach((node) => {
          top = Math.max(top, node.scrollTop);
        });
      composerPlace.current = top;
    }
    setMinimized(next);
  }

  return {
    setComposerMinimized,
    editor,
    pastePlainRef,
    pasteImageRef,
    takePastedImages,
    linkDialogOpen,
    setLinkDialogOpen,
    linkValue,
    setLinkValue,
    linkCanRemove,
    setLinkCanRemove,
    addLink,
    removeLink,
    applyLink,
    adjustIndent,
  };
}
