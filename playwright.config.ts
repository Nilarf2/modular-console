import { defineConfig } from "@playwright/test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const root =
  process.env.CONSOLE_E2E_ROOT ?? mkdtempSync(join(tmpdir(), "console-e2e-"));
process.env.CONSOLE_E2E_ROOT = root;
const passwordFile = join(root, "test-password");
if (!existsSync(passwordFile))
  writeFileSync(passwordFile, randomBytes(24).toString("base64url"), {
    mode: 0o600,
  });
process.env.CONSOLE_E2E_PASSWORD_FILE = passwordFile;
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npx tsx src/server/main.ts",
      url: "http://127.0.0.1:19471/api/health",
      reuseExistingServer: false,
      env: {
        CONSOLE_DEMO: "true",
        CONSOLE_DATA_DIR: join(root, "demo"),
        PORT: "19471",
      },
    },
    {
      command: "npx tsx src/server/main.ts",
      url: "http://127.0.0.1:19470/api/health",
      reuseExistingServer: false,
      env: {
        CONSOLE_DEMO: "false",
        CONSOLE_DATA_DIR: join(root, "live"),
        CONSOLE_ADMIN_PASSWORD_FILE: passwordFile,
        PORT: "19470",
      },
    },
  ],
});
