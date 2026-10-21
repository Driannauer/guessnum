import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4187",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "PORT=4187 DATA_DIR=/tmp/guessnum-browser-test node server.mjs",
    url: "http://127.0.0.1:4187/health",
    reuseExistingServer: !process.env.CI,
  },
});
