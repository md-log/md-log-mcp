import { defineConfig } from "tsup";

export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  // dist/server.js is the bin/stdio entrypoint — make it directly executable.
  banner: { js: "#!/usr/bin/env node" },
});
