import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:4300" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: {
    command: "pnpm --filter @a2a/web dev --hostname 127.0.0.1 --port 4300",
    url: "http://127.0.0.1:4300",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
