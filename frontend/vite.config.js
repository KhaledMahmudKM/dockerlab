import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies /api (including the console WebSocket) to the backend on :8000.
// `npm run build` writes straight into backend/static, which FastAPI serves.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: "http://127.0.0.1:8000", ws: true } } },
  build: {
    outDir: "../backend/static",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        console: resolve(import.meta.dirname, "console.html"),
      },
    },
  },
});
