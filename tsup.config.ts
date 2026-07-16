import { defineConfig } from "tsup";

export default defineConfig({
  // Two bins from one codebase: the stdio server and the remote Streamable HTTP server.
  // They share src/build-server.ts (tsup inlines it into each — it has no side effects).
  entry: { server: "src/server.ts", http: "src/http.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  // Keep each bin self-contained (no shared chunk file to ship). build-server.ts is inlined
  // into both dist/server.js and dist/http.js — it has no top-level side effects, so this is safe.
  splitting: false,
  // dist/server.js (stdio) and dist/http.js (Streamable HTTP) are both bins — make them executable.
  banner: { js: "#!/usr/bin/env node" },
});
