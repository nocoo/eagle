import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: true,
  workers: 4,
  use: { baseURL: "http://127.0.0.1:27053", trace: "retain-on-failure" },
  webServer: {
    command:
      "npm run build -- --mode test --outDir .local/browser-dist && vite preview --mode test --outDir .local/browser-dist --host 127.0.0.1 --port 27053 --strictPort",
    url: "http://127.0.0.1:27053",
    reuseExistingServer: false,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
