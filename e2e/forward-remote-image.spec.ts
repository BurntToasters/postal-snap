import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import {
  attachArtifacts,
  attachArtifactsAfterEach,
  attachIpcLog,
  ipcCalls,
} from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// 1. A forwarded message loses its remote picture before it is sent.
// 2. The composer loads the remote picture, so the privileged webview hits the network.
// 3. The composer shows no placeholder, or an English one, for the picture.
// 4. The sent htmlBody drops the picture URL.
// The run ends with a screenshot and the recorded IPC calls.

const PICTURE = "https://images.example.test/pixel.png";
const PLACEHOLDER = "Picture will be included when sent";

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
});

async function callsOf(page: Page, command: string) {
  return (await ipcCalls(page)).filter((call) => call.command === command);
}

test("a forwarded remote picture stays unloaded in the composer and is sent with its URL", async ({
  page,
}, testInfo: TestInfo) => {
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("images.example.test")) {
      remoteRequests.push(request.url());
    }
  });

  await page.goto("/?remote=1");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Forward", exact: true }).click();

  const editor = page.locator(".composer-editor");
  const picture = editor.getByRole("img", { name: PLACEHOLDER });
  await expect(picture).toHaveCount(1);
  await expect(editor.locator("img:not(.ProseMirror-separator)")).toHaveCount(
    0,
  );
  await expect(picture).toBeVisible();
  await picture.scrollIntoViewIfNeeded();
  await attachArtifacts(page, testInfo, "composer");

  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByLabel("Message body").pressSequentially("See the picture.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);

  const [sent] = await callsOf(page, "send_message");
  const htmlBody = (sent.args as { draft: { htmlBody: string } }).draft
    .htmlBody;
  expect(htmlBody).toContain(PICTURE);
  expect(htmlBody).not.toContain(PLACEHOLDER);
  expect(remoteRequests, "no remote fetch from the webview").toEqual([]);

  await attachIpcLog(page, testInfo, "forward-remote-image");
});
