import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import istanbul from "vite-plugin-istanbul";

export default defineConfig({
  plugins: [
    react(),
    istanbul({
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/tests/**"],
      requireEnv: true,
    }),
  ],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/target/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome120" : "safari17",
    minify: "esbuild",
    sourcemap: process.env.VITE_COVERAGE === "true" ? "inline" : false,
  },
});
