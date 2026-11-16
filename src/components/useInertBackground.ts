import { useLayoutEffect, type RefObject } from "react";

interface ModalEntry {
  id: symbol;
  dialogRef?: RefObject<HTMLElement | null>;
}

const modalStack: ModalEntry[] = [];
const managedInert = new WeakSet<HTMLElement>();

function setManagedInert(el: HTMLElement, inert: boolean) {
  if (inert) {
    if (!el.hasAttribute("inert")) {
      el.setAttribute("inert", "");
      managedInert.add(el);
    }
  } else if (managedInert.has(el)) {
    el.removeAttribute("inert");
    managedInert.delete(el);
  }
}

function syncInertStack() {
  const viewport = document.querySelector<HTMLElement>(".app-viewport");
  if (viewport) {
    setManagedInert(viewport, modalStack.length > 0);
  }
  const top = [...modalStack]
    .reverse()
    .find((entry) => entry.dialogRef?.current);
  const topNode = top?.dialogRef?.current ?? null;
  const topLayer =
    topNode?.closest<HTMLElement>(".modal-layer, .compose-preview-layer") ??
    topNode ??
    null;

  for (const layer of document.querySelectorAll<HTMLElement>(
    ".modal-layer, .compose-preview-layer, .settings-window",
  )) {
    const keepActive =
      modalStack.length === 0 ||
      !topLayer ||
      layer === topLayer ||
      layer.contains(topLayer) ||
      topLayer.contains(layer);
    setManagedInert(layer, !keepActive);
  }
}

export function useInertBackground(
  dialogRef?: RefObject<HTMLElement | null>,
  active = true,
) {
  useLayoutEffect(() => {
    if (!active) return;
    const entry: ModalEntry = { id: Symbol("modal"), dialogRef };
    modalStack.push(entry);
    syncInertStack();
    return () => {
      const index = modalStack.indexOf(entry);
      if (index >= 0) modalStack.splice(index, 1);
      syncInertStack();
    };
  }, [active, dialogRef]);
}
