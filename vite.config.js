import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
/**
 * Stamp the service worker with a build id derived from the emitted asset
 * names. The browser only treats a service worker as new when its bytes
 * differ, so this is what lets an installed phone app notice that the
 * workstation has been updated.
 */
function stampServiceWorker() {
  return {
    name: "agentbench-stamp-sw",
    apply: "build",
    async writeBundle(options, bundle) {
      const { createHash } = await import("node:crypto");
      const fs = await import("node:fs/promises");
      const swPath = path.join(options.dir, "sw.js");
      let source;
      try {
        source = await fs.readFile(swPath, "utf8");
      } catch {
        return; // no service worker in this build
      }
      const id = createHash("sha256")
        .update(Object.keys(bundle).sort().join("|"))
        .digest("hex")
        .slice(0, 12);
      await fs.writeFile(swPath, source.replace("__BUILD_ID__", id));
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        // desktop webview
        main: path.resolve(import.meta.dirname, "index.html"),
        // mobile command center, served by agentbench-gateway from the same
        // dist/ so the phone always gets the build matching its workstation
        mobile: path.resolve(import.meta.dirname, "mobile.html"),
      },
    },
  },
  optimizeDeps: {
    // lazily imported by the plan pane; pre-bundle to avoid dev-server
    // discovery reloads on first plan open
    include: ["@mdx-js/mdx", "remark-gfm"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
