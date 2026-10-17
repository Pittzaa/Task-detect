import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const DB = process.env.E2E_APP_DATABASE_URL ?? "postgres://tt_app_e2e:app@127.0.0.1:54329/tasktracker_e2e";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? "/opt/pw-browsers/chromium", args: ["--no-sandbox"] },
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    // Serves the production build. APP_ENV=e2e is the only thing that allows http + the email sink.
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      APP_ENV: "e2e",
      APP_URL: `http://localhost:${PORT}`,
      DATABASE_URL: DB,
      BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e-0000",
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      EMAIL_SINK_FILE: ".data/e2e/emails.jsonl",
      CRON_SECRET: "e2e-cron-secret-123456",
      BLOB_READ_WRITE_TOKEN: "",
      LOG_LEVEL: "warn",
    },
  },
});
