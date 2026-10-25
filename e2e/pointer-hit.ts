import type { Locator } from "@playwright/test";

/** True when the element at the target's center is the target or inside it. */
export async function receivesPointerHit(target: Locator): Promise<boolean> {
  return target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    return hit !== null && node.contains(hit);
  });
}
