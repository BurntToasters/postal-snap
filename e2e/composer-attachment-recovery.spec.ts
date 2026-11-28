import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { emitTauriEvent, ipcCalls } from "./ipc";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Removing a copied inline image throws, removes nearby text, or drops files.
// 2. A rejected image read leaves its opaque token staged or exposes raw details.
// 3. Switching to plain text discards an inline image or other draft attachments.

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.beforeEach(async ({ page }) => installMockIpc(page));

async function openComposer(page: Page, query = "") {
  await page.goto(`/${query ? `?${query}` : ""}`);
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await expect(composer).toBeVisible();
  return composer;
}

async function pasteImageFile(editor: Locator) {
  await editor.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) =>
      character.charCodeAt(0),
    );
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "small.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "clipboardData", { value: clipboard });
    element.dispatchEvent(event);
  }, PIXEL_PNG);
}

async function copyPasteImage(page: Page, editor: Locator) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const image = editor.locator("img");
  await image.click();
  await expect(image).toHaveClass(/ProseMirror-selectednode/);
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ControlOrMeta+v");
}

async function dropFiles(page: Page, composer: Locator) {
  const bounds = await composer.boundingBox();
  if (!bounds) throw new Error("The composer is not visible.");
  const point = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  await emitTauriEvent(page, "compose-drag", {
    phase: "over",
    ...point,
    count: 2,
  });
  await emitTauriEvent(page, "compose-drag", {
    phase: "drop",
    ...point,
    count: 2,
  });
  await expect(composer.locator(".compose-attachments")).toContainText(
    "family-photo.jpg",
  );
  await expect(composer.locator(".compose-attachments")).toContainText(
    "notes.txt",
  );
}

async function saveDraft(page: Page, composer: Locator) {
  await composer
    .getByRole("button", { name: "Save draft", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await ipcCalls(page)).filter((call) => call.command === "save_draft")
          .length,
    )
    .toBeGreaterThan(0);
  const call = (await ipcCalls(page))
    .filter((item) => item.command === "save_draft")
    .at(-1);
  const args = call?.args;
  if (!args || typeof args !== "object" || !("draft" in args))
    throw new Error("Draft save did not include a draft.");
  return args.draft as {
    bodyFormat: string;
    htmlBody: string;
    textBody: string;
    attachments: Array<{
      token: string;
      filename: string;
      inline?: boolean;
      contentId?: string | null;
    }>;
  };
}

test("removing a copied inline image keeps text, dropped files, and the saved draft", async ({
  page,
}) => {
  const composer = await openComposer(page, "pickPair=1");
  const editor = composer.locator(".composer-editor");
  await editor.click();
  await editor.pressSequentially("Keep this paragraph before the image. ");
  await pasteImageFile(editor);
  await expect(editor.locator("img")).toHaveCount(1);
  await editor.pressSequentially(" Keep this trailing text.");
  await copyPasteImage(page, editor);
  await expect(editor.locator("img")).toHaveCount(2);
  const imageOwners = await editor
    .locator("img")
    .evaluateAll((images) =>
      images.map((image) => image.getAttribute("data-inline-content-id")),
    );
  expect(new Set(imageOwners).size).toBe(1);
  expect(
    (await ipcCalls(page)).filter(
      (call) => call.command === "stage_pasted_image",
    ),
  ).toHaveLength(1);
  await dropFiles(page, composer);

  const initialDraft = await saveDraft(page, composer);
  expect(initialDraft.attachments.map((item) => item.token)).toEqual([
    "pasted-token",
    "dropped-token-1",
    "dropped-token-2",
  ]);
  const inlineContentId = initialDraft.attachments[0]?.contentId;
  expect(inlineContentId).toBeTruthy();
  expect(initialDraft.htmlBody.split(`cid:${inlineContentId}`).length - 1).toBe(
    2,
  );

  await composer
    .getByRole("button", { name: /Remove .*Pasted image\.png/i })
    .click();
  await expect(editor.locator("img")).toHaveCount(0);
  await expect(editor).toContainText("Keep this paragraph before the image.");
  await expect(editor).toContainText("Keep this trailing text.");
  await expect(composer.locator(".compose-attachments")).toContainText(
    "family-photo.jpg",
  );
  await expect(composer.locator(".compose-attachments")).toContainText(
    "notes.txt",
  );

  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator("img")).toHaveCount(0);
  await expect(
    composer.getByRole("button", { name: /Remove .*Pasted image\.png/i }),
  ).toHaveCount(0);

  const draft = await saveDraft(page, composer);
  expect(draft.bodyFormat).toBe("html");
  expect(draft.htmlBody).toContain("Keep this paragraph before the image.");
  expect(draft.htmlBody).toContain("Keep this trailing text.");
  expect(draft.htmlBody).not.toContain("data:image/");
  expect(draft.attachments.map((item) => item.token)).toEqual([
    "dropped-token-1",
    "dropped-token-2",
  ]);
  expect(
    (await ipcCalls(page))
      .filter((call) => call.command === "release_compose_attachments")
      .map((call) => call.args),
  ).toContainEqual({ accountId: "account-1", tokens: ["pasted-token"] });
});

test("removing one of two identical inline files preserves the other token and its CID", async ({
  page,
}) => {
  const composer = await openComposer(page, "uniquePastedImageTokens=1");
  const editor = composer.locator(".composer-editor");
  await editor.click();
  await pasteImageFile(editor);
  await expect(editor.locator("img")).toHaveCount(1);
  const firstImage = editor.locator("img");
  await firstImage.click();
  await expect(firstImage).toHaveClass(/ProseMirror-selectednode/);
  await page.keyboard.press("ArrowRight");
  await editor.pressSequentially(" Keep independent image.");
  await pasteImageFile(editor);
  await expect(editor.locator("img")).toHaveCount(2);
  await expect(
    composer.getByRole("button", { name: /Remove .*Pasted image\.png/i }),
  ).toHaveCount(2);

  const initialDraft = await saveDraft(page, composer);
  expect(initialDraft.attachments.map((item) => item.token)).toEqual([
    "pasted-token-1",
    "pasted-token-2",
  ]);
  const firstContentId = initialDraft.attachments[0]?.contentId;
  const secondContentId = initialDraft.attachments[1]?.contentId;
  expect(firstContentId).toBeTruthy();
  expect(secondContentId).toBeTruthy();
  expect(firstContentId).not.toBe(secondContentId);
  expect(initialDraft.htmlBody).toContain(`cid:${firstContentId}`);
  expect(initialDraft.htmlBody).toContain(`cid:${secondContentId}`);

  await composer
    .getByRole("button", { name: /Remove .*Pasted image\.png/i })
    .first()
    .click();
  await expect(editor.locator("img")).toHaveCount(1);
  await expect(
    composer.getByRole("button", { name: /Remove .*Pasted image\.png/i }),
  ).toHaveCount(1);

  const draft = await saveDraft(page, composer);
  expect(draft.attachments.map((item) => item.token)).toEqual([
    "pasted-token-2",
  ]);
  expect(draft.htmlBody).toContain(`cid:${secondContentId}`);
  expect(draft.htmlBody).not.toContain(`cid:${firstContentId}`);
  expect(
    (await ipcCalls(page))
      .filter((call) => call.command === "release_compose_attachments")
      .map((call) => call.args),
  ).toContainEqual({ accountId: "account-1", tokens: ["pasted-token-1"] });
});

test("restored inline CIDs keep their distinct ownership after save and reopen", async ({
  page,
}) => {
  await page.goto("/?localMail=1&draftDuplicateInline=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByRole("button", { name: /Family update/i }).click();
  const composer = page.locator(".composer-window");
  const editor = composer.locator(".composer-editor");
  await expect(editor.locator("img")).toHaveCount(2);
  await expect(
    composer.getByRole("button", { name: /Remove first\.png/i }),
  ).toBeVisible();
  await expect(
    composer.getByRole("button", { name: /Remove second\.png/i }),
  ).toBeVisible();

  await composer.getByRole("button", { name: /Remove first\.png/i }).click();
  await expect(editor.locator("img")).toHaveCount(1);
  const draft = await saveDraft(page, composer);
  expect(draft.attachments.map((item) => item.token)).toEqual([
    "draft-inline-second",
  ]);
  expect(draft.htmlBody).toContain("cid:draft-second@example.test");
  expect(draft.htmlBody).not.toContain("cid:draft-first@example.test");

  await composer.getByRole("button", { name: "Save draft and close" }).click();
  await expect(composer).toHaveCount(0);
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByRole("button", { name: /Family update/i }).click();
  const reopened = page.locator(".composer-window");
  const reopenedEditor = reopened.locator(".composer-editor");
  await expect(reopenedEditor.locator("img")).toHaveCount(1);
  await expect(
    reopened.getByRole("button", { name: /Remove second\.png/i }),
  ).toBeVisible();
  expect(
    (await ipcCalls(page))
      .filter((call) => call.command === "read_compose_image")
      .map((call) => call.args),
  ).toContainEqual({
    accountId: "account-1",
    token: "draft-inline-second",
  });
});

test("a rejected inline image read releases its token and preserves existing files and draft text", async ({
  page,
}) => {
  const composer = await openComposer(
    page,
    "pickImage=1&composeImageReadReject=1",
  );
  const editor = composer.locator(".composer-editor");
  await editor.click();
  await editor.pressSequentially("Keep the existing draft body.");
  await dropFiles(page, composer);

  await composer.getByRole("button", { name: "Picture", exact: true }).click();
  await expect(page.locator(".error-toast")).toContainText(
    "That item is no longer available. Refresh mail and try again.",
  );
  await expect(page.locator(".error-toast")).not.toContainText(
    /\/Users\/tester|lease-photo/,
  );

  const calls = await ipcCalls(page);
  expect(
    calls
      .filter((call) => call.command === "read_compose_image")
      .map((call) => call.args),
  ).toEqual([{ accountId: "account-1", token: "picked-image" }]);
  expect(
    calls
      .filter((call) => call.command === "release_compose_attachments")
      .map((call) => call.args),
  ).toEqual([{ accountId: "account-1", tokens: ["picked-image"] }]);
  await expect(
    composer.getByRole("button", { name: /Remove .*family-photo\.jpg/i }),
  ).toHaveCount(1);
  await expect(composer.locator(".compose-attachments")).toContainText(
    "notes.txt",
  );
  await expect(editor).toContainText("Keep the existing draft body.");

  const draft = await saveDraft(page, composer);
  expect(draft.htmlBody).toContain("Keep the existing draft body.");
  expect(draft.attachments.map((item) => item.token)).toEqual([
    "dropped-token-1",
    "dropped-token-2",
  ]);
  expect(JSON.stringify(calls)).not.toMatch(/\/Users\/tester|lease-photo/);
});

test("switching an inline image to plain text preserves it and other files in the draft", async ({
  page,
}) => {
  const composer = await openComposer(page, "pickImage=1");
  const editor = composer.locator(".composer-editor");
  await editor.click();
  await editor.pressSequentially("Keep text before the image. ");
  await composer.getByRole("button", { name: "Picture", exact: true }).click();
  await expect(editor.locator("img")).toHaveCount(1);
  await editor.pressSequentially(" Keep text after the image.");
  await dropFiles(page, composer);

  await composer.getByRole("button", { name: "Message options" }).click();
  await composer.getByRole("menuitem", { name: "Plain text" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Switch to plain text?",
  });
  await confirm.getByRole("button", { name: "Switch to plain text" }).click();

  const plainBody = composer.getByRole("textbox", {
    name: "Message body (plain text)",
  });
  await expect(plainBody).toHaveValue(
    /Keep text before the image\.[\s\S]*Keep text after the image\./,
  );
  await expect(composer.locator(".composer-editor img")).toHaveCount(0);
  await expect(composer.locator(".compose-attachments")).toContainText(
    "family-photo.jpg",
  );
  await expect(composer.locator(".compose-attachments")).toContainText(
    "notes.txt",
  );
  await expect(composer.locator(".compose-attachments")).not.toContainText(
    "Image: family-photo.jpg",
  );

  const draft = await saveDraft(page, composer);
  expect(draft.bodyFormat).toBe("plain");
  expect(draft.htmlBody).toBe("");
  expect(draft.textBody).toMatch(
    /Keep text before the image\.[\s\S]*Keep text after the image\./,
  );
  expect(draft.attachments.map((item) => item.token)).toEqual([
    "picked-image",
    "dropped-token-1",
    "dropped-token-2",
  ]);
  expect(draft.attachments.every((item) => item.inline !== true)).toBe(true);
});
