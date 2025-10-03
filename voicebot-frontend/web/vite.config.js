import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/stream": {
        target: "http://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
      "/control": {
        target: "http://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
      "/audio": {
        target: "http://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist" },
});
