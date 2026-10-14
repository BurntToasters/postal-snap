import { defineConfig } from "@playwright/test";

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
        /(?:reader-body|print-files|shortcuts-typing|quit-saves-draft|compose-hidden-recipients|download-older-mail|remembered-image-sender|outbox-reason|native-command-flows|mail-header-layout)\.spec\.ts/,
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer:
    process.env.POSTAL_SNAP_E2E_EXTERNAL_SERVER === "1"
      ? undefined
      : {
          command: "npm run dev -- --host 127.0.0.1 --port 4173",
          url: "http://127.0.0.1:4173",
          reuseExistingServer:
            !process.env.CI && process.env.VITE_COVERAGE !== "true",
        },
});
