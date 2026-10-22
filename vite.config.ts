// Vite build for the frontend: dev server on the fixed port Tauri expects, ES2022 output.

import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    // xterm + its WebGL renderer are ~500 kB in one chunk; it loads from disk, so don't split.
    chunkSizeWarningLimit: 800,
  },
});
