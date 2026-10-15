import { defineConfig } from "astro/config";

// A static site; the Worker in src/worker.ts serves it, plus /install.sh.
export default defineConfig({
  site: "https://nibblets.dev",
  output: "static",
  // Compression drops the line break before a link on its own line, gluing it to the text before.
  compressHTML: false,
});
