import Link from "@tiptap/extension-link";

export const SafeLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      href: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-external-href") ||
          element.getAttribute("href"),
        renderHTML: (attributes) => {
          const href = String(attributes.href ?? "");
          if (/^https?:/i.test(href)) {
            return {
              href: "#",
              "data-external-href": href,
              rel: "noopener noreferrer",
            };
          }
          if (/^mailto:/i.test(href)) {
            return { href, rel: "noopener noreferrer" };
          }
          return {};
        },
      },
      target: {
        default: null,
        renderHTML: () => ({}),
      },
    };
  },
}).configure({
  openOnClick: false,
  protocols: ["http", "https", "mailto"],
  HTMLAttributes: {
    rel: "noopener noreferrer",
    target: null,
  },
});
