import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Deep audit for the sidebar findings: nested labels keep width at the
// default 248 px pane, center clicks open each depth, only depth-0 rows show
// inline Rename/Delete, expand chevrons keep a 32 px layout box with a
// >=44 px pointer target, and every folder button carries a title.
test.beforeEach(async ({ page }) => installMockIpc(page));

const DENSITIES = [
  { label: "comfortable", query: "" },
  { label: "compact", query: "&density=compact" },
] as const;
const SCALES = [
  { label: "100%", query: "" },
  { label: "200%", query: "&scale=2" },
] as const;
const VIEWPORTS = [
  { label: "1280", width: 1280, drawer: false },
  { label: "620-drawer", width: 620, drawer: true },
] as const;

const FOLDERS = [
  { key: "Projects", name: "Projects" as const, exact: true as const },
  {
    key: "2026",
    name: "Projects / 2026, 1 unread" as const,
    exact: true as const,
  },
  {
    key: "Launch",
    name: "Projects / 2026 / Launch, 1 unread" as const,
    exact: true as const,
  },
] as const;

for (const viewport of VIEWPORTS) {
  for (const density of DENSITIES) {
    for (const scale of SCALES) {
      test(`sidebar deep audit ${viewport.label} ${density.label} ${scale.label}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: viewport.width, height: 800 });
        await page.goto(`/?nestedFolders=1${density.query}${scale.query}`);

        const ensureDrawerOpen = async () => {
          if (!viewport.drawer) return;
          const toggle = page.getByRole("button", {
            name: /^(Show|Hide) mailboxes$/,
          });
          await expect(toggle).toBeVisible();
          if ((await toggle.getAttribute("aria-label")) === "Show mailboxes") {
            await toggle.click();
          }
          await expect(page.locator(".mail-shell.sidebar-open")).toBeVisible();
        };

        await ensureDrawerOpen();
        await expect(
          page.getByRole("button", { name: "Projects", exact: true }),
        ).toBeVisible();

        // 1. Every visible folder label keeps non-zero width.
        const labelWidths = await page
          .locator(".folder-list .folder > span")
          .evaluateAll((nodes) =>
            nodes.map((node) => {
              const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return {
                text: (node.textContent ?? "").slice(0, 24),
                width: rect.width,
                height: rect.height,
                display: style.display,
                visible: rect.width > 0 && rect.height > 0,
              };
            }),
          );
        expect(labelWidths.length).toBeGreaterThanOrEqual(3);
        for (const entry of labelWidths) {
          expect(
            entry,
            `label "${entry.text}" must keep non-zero width`,
          ).toMatchObject({ visible: true });
          expect(entry.width).toBeGreaterThan(0);
        }

        // 2. Center click of Projects, 2026, and Launch opens each folder.
        for (const folder of FOLDERS) {
          await ensureDrawerOpen();
          const button = page.getByRole("button", {
            name: folder.name,
            exact: folder.exact,
          });
          await expect(button).toBeVisible();
          await button.scrollIntoViewIfNeeded();
          const geometry = await button.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            const folderHit = hit?.closest("button.folder");
            return {
              rect: { left: rect.left, width: rect.width },
              point: { x, y },
              hitFolder: folderHit === node,
              hitAction:
                hit
                  ?.closest("button.folder-action")
                  ?.getAttribute("aria-label") ?? null,
            };
          });
          expect(
            geometry.hitFolder,
            `${folder.key} center must hit its folder button`,
          ).toBe(true);
          expect(geometry.hitAction).toBeNull();
          await page.mouse.click(geometry.point.x, geometry.point.y);
          await expect(button).toHaveAttribute("aria-current", "page");
        }

        // 3a. Depth-0 hover/focus reveals inline Rename/Delete.
        await ensureDrawerOpen();
        const projectsButton = page.getByRole("button", {
          name: "Projects",
          exact: true,
        });
        const projectsRow = page.locator(".folder-tree-row", {
          has: projectsButton,
        });
        await projectsRow.hover();
        const renameProjects = page.getByRole("button", {
          name: "Rename folder Projects",
        });
        const deleteProjects = page.getByRole("button", {
          name: "Delete folder Projects",
        });
        await expect(renameProjects).toHaveCount(1);
        await expect(deleteProjects).toHaveCount(1);
        await expect
          .poll(() =>
            renameProjects.evaluate((node) => getComputedStyle(node).opacity),
          )
          .toBe("1");
        await expect
          .poll(() =>
            deleteProjects.evaluate((node) => getComputedStyle(node).opacity),
          )
          .toBe("1");
        await renameProjects.focus();
        await expect(renameProjects).toBeFocused();

        // 3b. Depth 1+ renders no inline Rename/Delete (context menu covers it).
        for (const name of [
          "Rename folder 2026",
          "Delete folder 2026",
          "Rename folder Launch",
          "Delete folder Launch",
        ]) {
          await expect(page.getByRole("button", { name })).toHaveCount(0);
        }
        await page
          .getByRole("button", {
            name: "Projects / 2026, 1 unread",
            exact: true,
          })
          .click({ button: "right" });
        await expect(
          page.getByRole("menuitem", { name: "Rename", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("menuitem", { name: "Delete folder", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");

        // 4. Expand chevrons: 32 px layout box, >=44 px pointer target,
        // absolutely positioned, clear of the folder button.
        const chevrons = await page
          .locator("button.folder-expand")
          .evaluateAll((nodes) =>
            nodes.map((node) => {
              const rect = node.getBoundingClientRect();
              const pseudo = getComputedStyle(node, "::after");
              const row = node.closest(".folder-tree-row");
              const folder = row?.querySelector("button.folder");
              const folderRect = folder?.getBoundingClientRect();
              const parse = (value: string) => {
                const parsed = Number.parseFloat(value);
                return Number.isFinite(parsed) ? parsed : 0;
              };
              const left = parse(pseudo.left);
              const right = parse(pseudo.right);
              const top = parse(pseudo.top);
              const bottom = parse(pseudo.bottom);
              const hitWidth =
                rect.width + (left < 0 ? -left : 0) + (right < 0 ? -right : 0);
              const hitHeight =
                rect.height + (top < 0 ? -top : 0) + (bottom < 0 ? -bottom : 0);
              const pseudoRight = rect.right + (right < 0 ? -right : 0);
              return {
                label: node.getAttribute("aria-label") ?? "",
                expanded: node.getAttribute("aria-expanded"),
                layoutWidth: rect.width,
                hitWidth,
                hitHeight,
                position: pseudo.position,
                content: pseudo.content,
                pseudoRight,
                folderLeft: folderRect?.left ?? null,
              };
            }),
          );
        expect(chevrons.length).toBeGreaterThanOrEqual(1);
        for (const chevron of chevrons) {
          expect(chevron.label.length).toBeGreaterThan(0);
          expect(
            chevron.expanded === "true" || chevron.expanded === "false",
          ).toBe(true);
          // Layout box stays narrow; the ::after overlay adds the target.
          // (At 200% text 2rem clamps to 44px; the overlay still extends it.)
          expect(chevron.layoutWidth).toBeLessThanOrEqual(44.5);
          expect(chevron.position).toBe("absolute");
          expect(chevron.content).not.toBe("none");
          expect(chevron.hitWidth).toBeGreaterThanOrEqual(44);
          expect(chevron.hitHeight).toBeGreaterThanOrEqual(44);
          if (chevron.folderLeft != null) {
            expect(chevron.pseudoRight).toBeLessThanOrEqual(
              chevron.folderLeft + 1,
            );
          }
        }

        // 5. Every folder button carries a title with the full path.
        const titles = await page
          .locator(".folder-list button.folder")
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              name: node.getAttribute("aria-label") ?? node.textContent ?? "",
              title: node.getAttribute("title") ?? "",
            })),
          );
        expect(titles.length).toBeGreaterThanOrEqual(3);
        for (const entry of titles) {
          expect(
            entry.title.length,
            `folder "${entry.name}" needs a title`,
          ).toBeGreaterThan(0);
        }
        const byTitle = titles.map((entry) => entry.title);
        expect(byTitle.some((title) => title.includes("Projects"))).toBe(true);
        expect(byTitle.some((title) => title.includes("Projects / 2026"))).toBe(
          true,
        );
        expect(
          byTitle.some((title) => title.includes("Projects / 2026 / Launch")),
        ).toBe(true);
      });
    }
  }
}
