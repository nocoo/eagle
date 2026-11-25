import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: true,
  workers: 4,
  use: { baseURL: "http://127.0.0.1:27053", trace: "retain-on-failure" },
  webServer: {
    command: process.env.CI
      ? "npm --workspace @eagle/web exec -- vite preview --host 127.0.0.1 --port 27053 --strictPort"
      : "npm --workspace @eagle/web run build && npm --workspace @eagle/web exec -- vite preview --host 127.0.0.1 --port 27053 --strictPort",
    url: "http://127.0.0.1:27053",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
