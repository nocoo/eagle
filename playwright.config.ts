import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: true,
  workers: 4,
  use: { baseURL: "http://127.0.0.1:27053", trace: "retain-on-failure" },
  webServer: {
    command:
      "npm --workspace @eagle/web run build -- --mode test && npm --workspace @eagle/web exec -- vite preview --mode test --host 127.0.0.1 --port 27053 --strictPort",
    url: "http://127.0.0.1:27053",
    reuseExistingServer: false,
    // The UI names its deployments at build time; the suite builds against example origins.
    env: {
      VITE_PRODUCTION_ORIGIN: "https://app.example.com",
      VITE_PRODUCTION_INGEST_ORIGIN: "https://ingest.example.com",
    },
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /workspace-mobile\.spec\.ts/,
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
      testIgnore: /workspace-desktop\.spec\.ts/,
    },
  ],
});
