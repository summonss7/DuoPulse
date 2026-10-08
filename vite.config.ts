import { defineConfig } from "vite";

// Спайк M0: простой dev-сервер для UI-полосы (адресная строка).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome105",
    minify: false,
    sourcemap: false,
  },
});
