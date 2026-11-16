import Image from "@tiptap/extension-image";

import { strings } from "../../../i18n";

/**
 * Keeps a blocked remote picture as an image node without loading it. The
 * URL round-trips as data-remote-src; Rust restores src only when sending.
 */
export const RemoteImage = Image.extend({
  parseHTML() {
    return [{ tag: "img[data-remote-src]" }, ...(this.parent?.() ?? [])];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      remoteSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-remote-src"),
        renderHTML: (attributes) =>
          attributes.remoteSrc
            ? {
                "data-remote-src": String(attributes.remoteSrc),
                class: "remote-image-blocked",
              }
            : {},
      },
    };
  },
  addNodeView() {
    // The label is display-only: it is not part of the serialized HTML, so
    // it never reaches the outgoing message.
    return ({ node, HTMLAttributes }) => {
      if (node.attrs.remoteSrc) {
        const dom = document.createElement("span");
        dom.className = "composer-remote-image";
        dom.contentEditable = "false";
        dom.setAttribute("role", "img");
        dom.setAttribute("aria-label", strings.composer.remoteImagePlaceholder);
        dom.textContent = strings.composer.remoteImagePlaceholder;
        return { dom };
      }
      const dom = document.createElement("img");
      for (const [name, value] of Object.entries(HTMLAttributes)) {
        if (value !== null && value !== undefined && value !== "") {
          dom.setAttribute(name, String(value));
        }
      }
      return { dom };
    };
  },
});
