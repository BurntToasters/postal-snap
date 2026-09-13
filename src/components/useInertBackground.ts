import { useEffect } from "react";

let modalBackgrounds = 0;
let restoreInert = false;

export function useInertBackground() {
  useEffect(() => {
    const viewport = document.querySelector<HTMLElement>(".app-viewport");
    if (!viewport) return;
    if (modalBackgrounds === 0) restoreInert = viewport.hasAttribute("inert");
    modalBackgrounds += 1;
    viewport.setAttribute("inert", "");
    return () => {
      modalBackgrounds -= 1;
      if (modalBackgrounds === 0 && !restoreInert)
        viewport.removeAttribute("inert");
    };
  }, []);
}
