import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import type { MockShared } from "./mock/context";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, emitTauriEvent, ipcCalls, ipcCommands } from "./ipc";

// Failure modes covered here:
// 1. A native frame-link click in an opened .eml does nothing on the setup screen (no reader mounted).
// 2. A frame-link click with a reader mounted checks link text against the reader's frame, not the viewer's.
// 3. A mailto link in an opened .eml is a silent no-op, with or without an account.
// 4. A real iframe click can miss the viewer listener because the event target belongs to another realm.
// 5. The WebKit browser fallback can mask unrelated requests or leave its denied popup open.
// Each run leaves a screenshot and IPC log under artifacts/0.5.2/eml-viewer-frame-link/.

const FILE_LINK = "https://files.example.test/lease";
const SIGN_TEXT = "https://sign.example.test/lease";
const MAILTO = "mailto:riley@example.test";
const SANDBOX = "allow-same-origin allow-popups";

function dialog(page: Page) {
  return page.getByRole("dialog", { name: "Lease renewal" });
}

// Swaps the opened message's fields in the mock, keeping the rest of the fixture.
async function setOpenedMessage(page: Page, fields: Record<string, unknown>) {
  await page.evaluate((patch) => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const original = mock.handlers.get_opened_message;
    if (!original) throw new Error("get_opened_message handler missing");
    mock.handlers.get_opened_message = (args) => {
      const opened = original(args) as {
        token: string;
        message: Record<string, unknown>;
      };
      return { ...opened, message: { ...opened.message, ...patch } };
    };
  }, fields);
}

async function openViewer(page: Page, fields: Record<string, unknown>) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.eventListeners.get("eml-opened")?.size ??
          0,
      ),
    )
    .toBeGreaterThan(0);
  await setOpenedMessage(page, fields);
  await emitTauriEvent(page, "eml-opened", { token: "opened-eml-1" });
  await expect(dialog(page)).toBeVisible();
}

// The viewer's body frame renders after the dialog opens; wait for its link before emitting.
async function waitForViewerLink(page: Page, text: string) {
  await expect(
    dialog(page).frameLocator("iframe").getByRole("link", { name: text }),
  ).toBeVisible();
}

async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__POSTAL_SNAP_TEST__?.openedUrls ?? []);
}

async function armFrameLinkAtViewerCommit(page: Page, url: string) {
  await page.evaluate((href) => {
    const browser = window as typeof window & {
      __TAURI_INTERNALS__?: {
        invoke: (
          command: string,
          args: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      __POSTAL_SNAP_FIRST_COMMIT_LINK__?: {
        href: string;
        state: "armed" | "emitting" | "sent" | "failed";
        error?: string;
      };
    };
    const internals = browser.__TAURI_INTERNALS__;
    if (!internals) throw new Error("The Tauri event mock is unavailable.");
    const pending: {
      href: string;
      state: "armed" | "emitting" | "sent" | "failed";
      error?: string;
    } = { href, state: "armed" };
    browser.__POSTAL_SNAP_FIRST_COMMIT_LINK__ = pending;
    const observer = new MutationObserver(() => {
      if (!document.querySelector(".eml-viewer")) return;
      observer.disconnect();
      pending.state = "emitting";
      void internals
        .invoke("plugin:event|emit", { event: "frame-link", payload: href })
        .then(
          () => {
            pending.state = "sent";
          },
          (cause: unknown) => {
            pending.state = "failed";
            pending.error = String(cause);
          },
        );
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, url);
}

type UserActivatedNavigation = {
  href: string;
  clickStarted: boolean;
  userActivated: boolean;
  documentRequestObserved: boolean;
  uiHandled: boolean;
  popupCountBefore: number;
};

type ExternalRequestGuard = {
  unexpectedExternalRequests: string[];
  externalResponses: string[];
  expectedDocumentNavigations: string[];
  beginUserActivatedNavigation(
    href: string,
    popupCountBefore: number,
  ): UserActivatedNavigation;
  finishUserActivatedNavigation(attempt: UserActivatedNavigation): void;
};

async function blockExternalRequests(
  page: Page,
  testInfo: TestInfo,
): Promise<ExternalRequestGuard> {
  const appOrigin = new URL(page.url()).origin;
  const unexpectedExternalRequests: string[] = [];
  const externalResponses: string[] = [];
  const expectedDocumentNavigations: string[] = [];
  let activeAttempt: UserActivatedNavigation | null = null;
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== appOrigin) {
      const expectedWebkitNavigation =
        testInfo.project.name === "webkit" &&
        activeAttempt?.href === url.href &&
        activeAttempt.clickStarted &&
        !activeAttempt.documentRequestObserved &&
        /^https?:\/\//i.test(url.href) &&
        request.isNavigationRequest() &&
        request.resourceType() === "document" &&
        request.method() === "GET";
      if (expectedWebkitNavigation && activeAttempt) {
        activeAttempt.documentRequestObserved = true;
        expectedDocumentNavigations.push(url.href);
      } else {
        unexpectedExternalRequests.push(url.href);
      }
      await route.abort();
      return;
    }
    await route.continue();
  });
  page.context().on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== appOrigin) externalResponses.push(url.href);
  });
  return {
    unexpectedExternalRequests,
    externalResponses,
    expectedDocumentNavigations,
    beginUserActivatedNavigation(href, popupCountBefore) {
      if (activeAttempt) {
        throw new Error("A prior external link click is still being checked.");
      }
      const attempt = {
        href,
        clickStarted: false,
        userActivated: false,
        documentRequestObserved: false,
        uiHandled: false,
        popupCountBefore,
      };
      activeAttempt = attempt;
      return attempt;
    },
    finishUserActivatedNavigation(attempt) {
      if (activeAttempt === attempt) activeAttempt = null;
    },
  };
}

type PopupAudit = { events: Page[]; paired: Page[] };

function trackPopups(page: Page): PopupAudit {
  const audit: PopupAudit = { events: [], paired: [] };
  page.on("popup", (popup) => audit.events.push(popup));
  return audit;
}

async function closeTransientDeniedPopup(
  attempt: UserActivatedNavigation,
  audit: PopupAudit,
): Promise<void> {
  if (attempt.documentRequestObserved) {
    await expect
      .poll(() => audit.events.length > attempt.popupCountBefore)
      .toBe(true);
  }
  const newPopups = audit.events.slice(attempt.popupCountBefore);
  expect(newPopups).toHaveLength(attempt.documentRequestObserved ? 1 : 0);
  if (!attempt.documentRequestObserved) return;
  const popup = newPopups[0]!;
  if (audit.paired.includes(popup)) return;
  audit.paired.push(popup);
  if (!popup.isClosed()) await popup.close();
}

async function clickAtCenter(
  page: Page,
  target: Locator,
  requestGuard: ExternalRequestGuard,
  popupAudit: PopupAudit,
  expectedHref: string,
): Promise<UserActivatedNavigation> {
  const box = await target.boundingBox();
  if (!box) throw new Error("The sandboxed link target has no visible bounds.");
  await expectSanitizedHref(target, expectedHref);
  const attempt = requestGuard.beginUserActivatedNavigation(
    expectedHref,
    popupAudit.events.length,
  );
  attempt.clickStarted = true;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  attempt.userActivated = true;
  return attempt;
}

async function expectSanitizedHref(link: Locator, expectedHref: string) {
  const actualHref = await link.evaluate(
    (node) => node.closest("a[href]")?.getAttribute("href")?.trim() ?? "",
  );
  expect(actualHref).toBe(expectedHref);
  return actualHref;
}

async function emitWebkitDelegateIfNeeded(
  page: Page,
  testInfo: TestInfo,
  link: Locator,
  alreadyHandled: () => Promise<boolean>,
  attempt: UserActivatedNavigation,
): Promise<boolean> {
  if (testInfo.project.name !== "webkit") return false;
  const href = await expectSanitizedHref(link, attempt.href);
  if (!/^https?:\/\//i.test(href)) {
    throw new Error("The WebKit fallback requires a sanitized HTTP link.");
  }
  if (!attempt.userActivated || attempt.href !== href) {
    throw new Error(
      "The WebKit delegate fallback needs its matching real click.",
    );
  }
  if (/^https?:\/\//i.test(href) && process.platform === "linux") {
    await expect
      .poll(async () => {
        if (attempt.documentRequestObserved) return true;
        attempt.uiHandled = await alreadyHandled();
        return attempt.uiHandled;
      })
      .toBe(true);
  }
  if (!attempt.uiHandled) attempt.uiHandled = await alreadyHandled();
  if (attempt.uiHandled) return false;
  // Harness-only delegate simulation: Playwright WebKit has no Tauri delegate.
  // macOS native proof also records denied HTTPS links with no browser request,
  // so a matching real click may need this fallback without a route event.
  // Any request still passes the exact-origin, method, type, and click checks
  // in blockExternalRequests; native behavior is covered separately.
  await emitTauriEvent(page, "frame-link", href);
  return true;
}

test.beforeEach(async ({ page }) => installMockIpc(page));

test("a nested iframe link uses cancelable confirmation without external navigation", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?noAccounts=1&emlSeeded=1");
  await openViewer(page, {
    htmlBody: `<p><a href="${FILE_LINK}"><span><strong>Open lease details</strong></span></a></p>`,
  });
  await expect(dialog(page).locator("iframe")).toHaveAttribute(
    "sandbox",
    SANDBOX,
  );
  const requestGuard = await blockExternalRequests(page, testInfo);
  const popupAudit = trackPopups(page);
  const nestedText = dialog(page)
    .frameLocator("iframe")
    .getByRole("link", { name: "Open lease details" })
    .locator("strong");
  await expect(nestedText).toBeVisible();

  const inspectCount = async () =>
    (await ipcCommands(page)).filter(
      (command) => command === "inspect_external_url",
    ).length;
  let cancelMessage = "";
  page.once("dialog", async (native) => {
    cancelMessage = native.message();
    await native.dismiss();
  });
  const inspectBeforeCancel = await inspectCount();
  const cancelAttempt = await clickAtCenter(
    page,
    nestedText,
    requestGuard,
    popupAudit,
    FILE_LINK,
  );
  let delegateSimulations = 0;
  let requestlessDelegateSimulations = 0;
  if (
    await emitWebkitDelegateIfNeeded(
      page,
      testInfo,
      nestedText,
      async () => (await inspectCount()) > inspectBeforeCancel,
      cancelAttempt,
    )
  ) {
    delegateSimulations += 1;
    if (!cancelAttempt.documentRequestObserved) {
      requestlessDelegateSimulations += 1;
    }
  }
  await closeTransientDeniedPopup(cancelAttempt, popupAudit);
  requestGuard.finishUserActivatedNavigation(cancelAttempt);
  expect(cancelMessage).toContain("files.example.test");
  expect(cancelMessage).toContain("Open it in your browser?");
  await expect.poll(() => ipcCommands(page)).toContain("inspect_external_url");
  expect(
    (await ipcCalls(page))
      .filter((call) => call.command === "inspect_external_url")
      .map((call) => call.args),
  ).toEqual([{ url: FILE_LINK }]);
  expect(
    (await ipcCalls(page)).filter(
      (call) => call.command === "open_external_url",
    ),
  ).toEqual([]);
  expect(await openedUrls(page)).toEqual([]);
  expect(await ipcCommands(page)).not.toContain("open_external_url");

  let openMessage = "";
  page.once("dialog", async (native) => {
    openMessage = native.message();
    await native.accept();
  });
  const inspectBeforeOpen = await inspectCount();
  const openAttempt = await clickAtCenter(
    page,
    nestedText,
    requestGuard,
    popupAudit,
    FILE_LINK,
  );
  if (
    await emitWebkitDelegateIfNeeded(
      page,
      testInfo,
      nestedText,
      async () => (await inspectCount()) > inspectBeforeOpen,
      openAttempt,
    )
  ) {
    delegateSimulations += 1;
    if (!openAttempt.documentRequestObserved) {
      requestlessDelegateSimulations += 1;
    }
  }
  await closeTransientDeniedPopup(openAttempt, popupAudit);
  requestGuard.finishUserActivatedNavigation(openAttempt);
  expect(openMessage).toContain("files.example.test");
  expect(
    (await ipcCalls(page))
      .filter((call) => call.command === "inspect_external_url")
      .map((call) => call.args),
  ).toEqual([{ url: FILE_LINK }, { url: FILE_LINK }]);
  await expect
    .poll(
      async () =>
        (await ipcCalls(page)).filter(
          (call) => call.command === "open_external_url",
        ).length,
    )
    .toBe(1);
  expect(
    (await ipcCalls(page))
      .filter((call) => call.command === "open_external_url")
      .map((call) => call.args),
  ).toEqual([{ url: FILE_LINK, openAnyway: false }]);
  await expect.poll(() => openedUrls(page)).toEqual([FILE_LINK]);
  expect(requestGuard.unexpectedExternalRequests).toEqual([]);
  expect(requestGuard.externalResponses).toEqual([]);
  expect(requestGuard.expectedDocumentNavigations).toEqual(
    [cancelAttempt, openAttempt]
      .filter((attempt) => attempt.documentRequestObserved)
      .map((attempt) => attempt.href),
  );
  expect(requestGuard.expectedDocumentNavigations).toHaveLength(
    popupAudit.events.length,
  );
  expect(popupAudit.paired).toHaveLength(
    requestGuard.expectedDocumentNavigations.length,
  );
  if (testInfo.project.name === "webkit") {
    if (process.platform === "linux") {
      expect([
        cancelAttempt.documentRequestObserved || cancelAttempt.uiHandled,
        openAttempt.documentRequestObserved || openAttempt.uiHandled,
      ]).toEqual([true, true]);
    }
  } else {
    expect(requestGuard.expectedDocumentNavigations).toEqual([]);
    expect(popupAudit.events).toHaveLength(0);
  }
  expect(
    popupAudit.events.filter((popup) => !popupAudit.paired.includes(popup)),
  ).toEqual([]);
  expect(popupAudit.events.every((popup) => popup.isClosed())).toBe(true);
  expect(
    page
      .context()
      .pages()
      .filter((candidate) => candidate !== page),
  ).toEqual([]);
  await attachArtifacts(page, testInfo, "nested-iframe-link-confirmation", {
    webkitDelegateSimulations: delegateSimulations,
    requestlessWebkitDelegateSimulations: requestlessDelegateSimulations,
    expectedWebkitDocumentNavigations: requestGuard.expectedDocumentNavigations,
    unexpectedExternalRequests: requestGuard.unexpectedExternalRequests,
    externalResponses: requestGuard.externalResponses,
    pairedDeniedPopupCount: popupAudit.paired.length,
    realNativeDelegateObserved: false,
  });
});

test("an iframe mailto delegate or click shows its notice and opens nothing", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?noAccounts=1&emlSeeded=1");
  await openViewer(page, {
    htmlBody: `<p><a href="${MAILTO}"><span><strong>Email Riley</strong></span></a></p>`,
  });
  const requestGuard = await blockExternalRequests(page, testInfo);
  const popupAudit = trackPopups(page);
  const nestedText = dialog(page)
    .frameLocator("iframe")
    .getByRole("link", { name: "Email Riley" })
    .locator("strong");
  await expect(nestedText).toBeVisible();
  const notice = dialog(page).locator(".eml-viewer-notice");
  let delegateSimulated = false;
  if (testInfo.project.name === "webkit") {
    // Playwright WebKit cannot install script into this scriptless frame or
    // safely activate the host mail client. Send only its native delegate event.
    const href = await expectSanitizedHref(nestedText, MAILTO);
    await emitTauriEvent(page, "frame-link", href);
    delegateSimulated = true;
  } else {
    const clickAttempt = await clickAtCenter(
      page,
      nestedText,
      requestGuard,
      popupAudit,
      MAILTO,
    );
    requestGuard.finishUserActivatedNavigation(clickAttempt);
  }

  await expect(notice).toHaveText(
    "Add a mail account to write to this address.",
  );
  await expect(page.locator(".composer-layer")).toHaveCount(0);
  expect(await ipcCommands(page)).not.toContain("inspect_external_url");
  expect(await ipcCommands(page)).not.toContain("open_external_url");
  expect(await openedUrls(page)).toEqual([]);
  expect(requestGuard.unexpectedExternalRequests).toEqual([]);
  expect(requestGuard.externalResponses).toEqual([]);
  expect(requestGuard.expectedDocumentNavigations).toEqual([]);
  expect(popupAudit.events).toHaveLength(0);
  expect(
    page
      .context()
      .pages()
      .filter((candidate) => candidate !== page),
  ).toEqual([]);
  await attachArtifacts(page, testInfo, "nested-iframe-mailto-no-account", {
    webkitDelegateSimulation: delegateSimulated,
    webkitMailtoPath: delegateSimulated ? "delegate-only" : "pointer-click",
    expectedWebkitDocumentNavigations: requestGuard.expectedDocumentNavigations,
    unexpectedExternalRequests: requestGuard.unexpectedExternalRequests,
    externalResponses: requestGuard.externalResponses,
    realNativeDelegateObserved: false,
  });
});

test("save and preview errors leave opened-file attachments usable for retry", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?emlSeeded=1");
  await openViewer(page, { htmlBody: "<p>Attachment recovery.</p>" });
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const save = mock.handlers.save_opened_attachment;
    const preview = mock.handlers.preview_opened_attachment;
    let failSave = true;
    let failPreview = true;
    mock.handlers.save_opened_attachment = async (args) => {
      if (failSave) {
        failSave = false;
        throw mock.mockError("operationFailed", "Synthetic save failure.");
      }
      return save(args);
    };
    mock.handlers.preview_opened_attachment = async (args) => {
      if (failPreview) {
        failPreview = false;
        throw mock.mockError("operationFailed", "Synthetic preview failure.");
      }
      return preview(args);
    };
  });
  const viewer = dialog(page);
  const save = viewer.getByRole("button", { name: "Save Lease.pdf" });
  await save.click();
  await expect(viewer.getByRole("alert")).toHaveText("Synthetic save failure.");
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(
      async () =>
        (await ipcCommands(page)).filter(
          (command) => command === "save_opened_attachment",
        ).length,
    )
    .toBe(2);

  const preview = viewer.getByRole("button", {
    name: "Preview: Lease.pdf",
  });
  await preview.click();
  await expect(viewer.getByRole("alert")).toHaveText(
    "Synthetic preview failure.",
  );
  await preview.click();
  const previewDialog = page.getByRole("dialog", {
    name: "Preview of Lease.pdf",
  });
  await expect(previewDialog.locator(".pdf-pages img")).toHaveCount(3);
  await previewDialog.getByRole("button", { name: "Close" }).click();
  await expect(previewDialog).toHaveCount(0);
  await expect(viewer.getByRole("alert")).toHaveCount(0);
  await expect(viewer).toBeVisible();
  await attachArtifacts(page, testInfo, "attachment-error-recovery");
});

test("a native frame link on the viewer's first commit is inspected and confirmed", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?noAccounts=1&emlSeeded=1");
  await expect(page.locator(".setup-host")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.eventListeners.get("frame-link")?.size ??
          0,
      ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.eventListeners.get("eml-opened")?.size ??
          0,
      ),
    )
    .toBeGreaterThan(0);
  await setOpenedMessage(page, {
    htmlBody: `<p>Sign here: <a href="${FILE_LINK}">${FILE_LINK}</a></p>`,
  });
  await armFrameLinkAtViewerCommit(page, FILE_LINK);

  const confirmations: string[] = [];
  page.on("dialog", async (native) => {
    confirmations.push(native.message());
    await native.accept();
  });
  await emitTauriEvent(page, "eml-opened", { token: "opened-eml-1" });
  await expect(dialog(page)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_FIRST_COMMIT_LINK__?: { state: string };
            }
          ).__POSTAL_SNAP_FIRST_COMMIT_LINK__?.state,
      ),
    )
    .toBe("sent");
  await expect(dialog(page).locator("iframe")).toHaveAttribute(
    "sandbox",
    SANDBOX,
  );

  await expect.poll(() => openedUrls(page)).toEqual([FILE_LINK]);
  const completedCalls = await ipcCalls(page);
  const inspections = completedCalls.filter(
    (call) => call.command === "inspect_external_url",
  );
  const opens = completedCalls.filter(
    (call) => call.command === "open_external_url",
  );
  expect(inspections).toHaveLength(1);
  expect(inspections.map((call) => call.args)).toEqual([{ url: FILE_LINK }]);
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]).toContain("files.example.test");
  expect(opens).toHaveLength(1);
  expect(opens.map((call) => call.args)).toEqual([
    { url: FILE_LINK, openAnyway: false },
  ]);
  await attachArtifacts(
    page,
    testInfo,
    "first-commit-setup-screen-frame-link",
    {
      frameLinkDispatch: await page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_FIRST_COMMIT_LINK__?: unknown;
            }
          ).__POSTAL_SNAP_FIRST_COMMIT_LINK__ ?? null,
      ),
      inspectionCount: inspections.length,
      confirmationCount: confirmations.length,
    },
  );
});

test("a mailto link in an opened file with no account says so and opens nothing", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?noAccounts=1&emlSeeded=1");
  await expect(page.locator(".setup-host")).toBeVisible();
  await openViewer(page, {
    htmlBody: `<p><a href="${MAILTO}">Email Riley</a></p>`,
  });
  await waitForViewerLink(page, "Email Riley");

  await emitTauriEvent(page, "frame-link", MAILTO);

  await expect(dialog(page).locator(".eml-viewer-notice")).toHaveText(
    "Add a mail account to write to this address.",
  );
  await expect(page.locator(".composer-layer")).toHaveCount(0);
  expect(await ipcCommands(page)).not.toContain("inspect_external_url");
  await attachArtifacts(page, testInfo, "setup-screen-mailto-notice");
});

test("a plain-text mailto in an opened file opens the composer with the address", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?emlSeeded=1");
  await openViewer(page, {
    htmlBody: null,
    textBody: `Questions? Write to ${MAILTO} before Friday.`,
  });

  await dialog(page).getByRole("link", { name: "riley@example.test" }).click();

  const to = page
    .locator(".composer-layer")
    .getByRole("combobox", { name: "To", exact: true });
  await expect(to).toHaveValue(/riley@example\.test/);
  await attachArtifacts(page, testInfo, "plain-text-mailto-composer");
});

test("with a reader mounted, the mismatch warning names the viewer's link text", async ({
  page,
}, testInfo: TestInfo) => {
  // The reader's own frame has a link to bank.example with a different href;
  // the viewer's link must be judged against its own frame, not that one.
  await page.goto("/?mismatchLink=1&emlSeeded=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page
      .frameLocator('iframe[title="Message content"]')
      .getByRole("link", { name: "https://bank.example/login" }),
  ).toBeVisible();

  await openViewer(page, {
    htmlBody: `<p>Sign here: <a href="${FILE_LINK}">${SIGN_TEXT}</a></p>`,
  });
  await waitForViewerLink(page, SIGN_TEXT);

  page.once("dialog", async (native) => {
    const text = native.message();
    expect(text).toContain("files.example.test");
    expect(text).toContain(
      `The link text shows a different address: ${SIGN_TEXT}`,
    );
    expect(text).not.toContain("bank.example");
    await native.accept();
  });
  await emitTauriEvent(page, "frame-link", FILE_LINK);

  await expect.poll(() => openedUrls(page)).toEqual([FILE_LINK]);
  await attachArtifacts(page, testInfo, "reader-mounted-viewer-link-text");
});
