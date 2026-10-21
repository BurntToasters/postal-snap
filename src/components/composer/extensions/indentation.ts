import { Extension } from "@tiptap/core";

export const Indentation = Extension.create({
  name: "indentation",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const rem = Number.parseFloat(element.style.marginLeft);
              return Number.isFinite(rem)
                ? Math.min(6, Math.round(rem / 2))
                : 0;
            },
            renderHTML: (attributes) =>
              attributes.indent
                ? { style: `margin-left: ${attributes.indent * 2}rem` }
                : {},
          },
        },
      },
    ];
  },
});
