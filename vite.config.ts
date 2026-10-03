import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };
import { productionProxy } from "./scripts/environment-proxy.ts";
export default defineConfig(({ mode, command, isPreview }) => ({
  cacheDir: mode === "test" ? ".local/vite-test" : ".local/vite-dev",
  // Basalt's Radix portals discover this peer after the initial import scan.
  optimizeDeps: { include: ["react-dom"] },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "local-environment",
      apply: "serve",
      transformIndexHtml: () =>
        mode === "test"
          ? []
          : [
              {
                tag: "script",
                children: "window.__EAGLE_LOCAL__ = true;",
                injectTo: "head-prepend",
              },
            ],
    },
  ],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  preview: { proxy: {} },
  server: {
    host: "127.0.0.1",
    port: 7053,
    strictPort: true,
    allowedHosts: ["eagle.dev.hexly.ai"],
    proxy:
      mode === "test" || command !== "serve" || isPreview
        ? undefined
        : {
            "/__local/prod/": productionProxy(),
            "/api": {
              target: "http://127.0.0.1:37053",
              changeOrigin: false,
              ws: true,
            },
          },
  },
}));
