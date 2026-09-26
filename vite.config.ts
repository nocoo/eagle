import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };
export default defineConfig(({ mode }) => ({
  cacheDir: mode === "test" ? ".local/vite-test" : ".local/vite-dev",
  // Basalt's Radix portals discover this peer after the initial import scan.
  optimizeDeps: { include: ["react-dom"] },
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    host: "127.0.0.1",
    port: 7053,
    strictPort: true,
    allowedHosts: ["eagle.dev.hexly.ai"],
    proxy:
      mode === "test"
        ? undefined
        : {
            "/api": {
              target: "http://127.0.0.1:37053",
              changeOrigin: false,
              ws: true,
            },
          },
  },
}));
