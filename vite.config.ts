import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = Number(process.env.PORT ?? 4317);

export default defineConfig({
  plugins: [react()],
  // Localhost app served from disk: one ~560 kB bundle is fine, so don't warn at 500.
  build: { chunkSizeWarningLimit: 700 },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}` } },
  },
});
