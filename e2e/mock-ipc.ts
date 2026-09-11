import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

import { registerMockAccountsSetup } from "./mock/accounts-setup";
import { registerMockDraftsOutbox } from "./mock/drafts-outbox";
import { registerMockFixtures } from "./mock/fixtures";
import { registerMockFolders } from "./mock/folders";
import { registerMockMessages } from "./mock/messages";
import { registerMockRemoteSecurity } from "./mock/remote-security";
import { registerMockSettingsSystem } from "./mock/settings-system";
import { registerMockState } from "./mock/state";
import { registerMockWindowEvents } from "./mock/window-events";

// Installs the mocked Tauri IPC layer for e2e tests. Each module registers
// one slice of the mock; install order matters because later slices build on
// the shared fixtures, state, and invoke dispatcher above.
export async function installMockIpc(
  page: Page,
  distribution: "direct" | "store" = "direct",
) {
  const filename = distribution === "direct" ? "direct/default" : "store/store";
  const { permissions } = JSON.parse(
    readFileSync(`src-tauri/capabilities/${filename}.json`, "utf8"),
  ) as { permissions: string[] };
  await registerMockFixtures(page);
  await registerMockState(page);
  await registerMockWindowEvents(page, permissions);
  await registerMockAccountsSetup(page);
  await registerMockMessages(page);
  await registerMockFolders(page);
  await registerMockDraftsOutbox(page);
  await registerMockSettingsSystem(page);
  await registerMockRemoteSecurity(page);
}
