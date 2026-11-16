import type { Page } from "@playwright/test";

/**
 * Opens popup submenus from the keyboard until the named menu item is
 * visible, as a keyboard user would. Items grouped into submenus (Reply
 * options, Copy, Move to, Conversation, Sender and rules, Sort by, Print)
 * need their submenu open first.
 */
export async function revealMenuItem(
  page: Page,
  name: string,
  role: "menuitem" | "menuitemradio" | "menuitemcheckbox" = "menuitem",
): Promise<void> {
  const item = page.getByRole(role, { name });
  if (
    await item
      .first()
      .isVisible()
      .catch(() => false)
  )
    return;
  const triggers = page.locator(
    '.app-menu [role="menuitem"][aria-haspopup="menu"]',
  );
  const total = await triggers.count();
  for (let index = 0; index < total; index += 1) {
    const trigger = triggers.nth(index);
    if (!(await trigger.isVisible().catch(() => false))) continue;
    await trigger.focus();
    await page.keyboard.press("ArrowRight");
    if (
      await item
        .first()
        .isVisible()
        .catch(() => false)
    )
      return;
    await page.keyboard.press("ArrowLeft");
  }
}
