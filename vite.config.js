import { defineConfig } from "vite";
import { resolve } from "node:path";

// Where the site is served from. GitHub Pages puts it under /<repo>/, but on
// your own host it is usually the document root ("/") or a subfolder — set
// VITE_BASE at build time, e.g. `VITE_BASE=/ npm run build`.
const base = process.env.VITE_BASE ?? "/Vitra/";

export default defineConfig({
  base,
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        generator: resolve(import.meta.dirname, "generator.html"),
      },
    },
  },
});
