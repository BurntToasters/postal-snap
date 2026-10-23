import { defineConfig } from "@playwright/test";

import { resolveE2ePort } from "./scripts/lib/e2e-port.js";

const port = resolveE2ePort();

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 2 : 0,
  failOnFlakyTests: Boolean(process.env.CI),
  reporter: [[process.env.CI ? "github" : "list"], ["html", { open: "never" }]],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "webkit",
      use: { browserName: "webkit" },
      testMatch:
        /(?:reader-body|print-files|shortcuts-typing|quit-saves-draft|compose-hidden-recipients|download-older-mail|remembered-image-sender|outbox-reason|native-command-flows|mail-header-layout|composer-replacement-(?:save|races|no-editor)|list-row-layout|list-row-actions|mailbox-filter-segments|quick-reply-layout|quick-reply-refused|reader-toolbar-groups|ui-matrix-0\.4\.2|nested-row-hit-area|settings-focus-audit-fixes|settings-layout-audit-fixes)\.spec\.ts/,
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer:
    process.env.POSTAL_SNAP_E2E_EXTERNAL_SERVER === "1"
      ? undefined
      : {
          command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
          url: `http://127.0.0.1:${port}`,
          reuseExistingServer:
            !process.env.CI && process.env.VITE_COVERAGE !== "true",
        },
});
