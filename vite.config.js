import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "/Vitra/",
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        generator: resolve(import.meta.dirname, "generator.html"),
      },
    },
  },
});
