#!/usr/bin/env node
/**
 * Backend-free smoke test for the remote Streamable HTTP transport (dist/http.js).
 *
 * Spawns the BUILT http server, then exercises the transport + security edge over
 * a real MCP StreamableHTTPClientTransport. None of these steps touch the md-log
 * backend (tools/list is static; the file_path refusal fails BEFORE any HTTP call;
 * the 401/403 checks are rejected at the edge), so NO backend or real PAT is needed:
 *
 *   1. initialize + tools/list          — full handshake works, all 15 tools present
 *   2. upload_asset { file_path }        — refused (remote transport blocks local files)
 *   3. POST without Authorization        — 401 Unauthorized
 *   4. POST with a disallowed Origin     — 403 Forbidden
 *   5. POST with an allowed Origin + PAT — accepted (200)
 *   6. GET /health                       — 200 ok
 *   7. Oversized body                    — 413 with a clean JSON error (not a socket reset)
 *
 * Prints PASS/FAIL per step and exits non-zero on any failure.
 *
 * Run:  npm run build && node scripts/smoke-http.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PATH = resolve(__dirname, "../dist/http.js");

const PORT = 8788;
const HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const ALLOWED_ORIGIN = "https://good.example";
const BASE = `http://${HOST}:${PORT}`;
const MCP_URL = `${BASE}${MCP_PATH}`;
const DUMMY_PAT = "mdlog_pat_smoke000000000000000000000000";

let passed = 0;
let failed = 0;
function step(name, okCond, info = "") {
  if (okCond) {
    passed++;
    console.log(`PASS  ${name}${info ? `  — ${info}` : ""}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${info ? `  — ${info}` : ""}`);
  }
  return okCond;
}

function toolText(result) {
  if (!result?.content) return "";
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

async function rawPost(headers, body) {
  return fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body ?? { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

async function main() {
  if (!existsSync(HTTP_PATH)) {
    console.error(`Build first: ${HTTP_PATH} not found (run "npm run build").`);
    process.exit(2);
  }

  const child = spawn(process.execPath, [HTTP_PATH], {
    env: {
      ...process.env,
      MDLOG_API_BASE_URL: "http://127.0.0.1:9/api/v1", // unreachable dummy; never actually called
      MDLOG_HTTP_HOST: HOST,
      MDLOG_HTTP_PORT: String(PORT),
      MDLOG_HTTP_PATH: MCP_PATH,
      MDLOG_HTTP_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      // Small enough to trip step 7 with a padded body, but comfortably above the
      // initialize / tools/list / callTool bodies used by steps 1-2.
      MDLOG_HTTP_MAX_BODY_BYTES: "8192",
    },
    stdio: ["ignore", "inherit", "pipe"],
  });

  let stderr = "";
  const ready = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("server did not become ready in 10s")), 10_000);
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d); // surface server logs
      if (stderr.includes("md-log-mcp-http ready")) {
        clearTimeout(timer);
        res();
      }
    });
    child.on("exit", (code) => rej(new Error(`server exited early (code ${code})`)));
  });

  try {
    await ready;

    // 1) Full MCP handshake + tools/list via a real client.
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${DUMMY_PAT}` } },
    });
    const client = new Client({ name: "md-log-mcp-http-smoke", version: "1.0.0" });
    await client.connect(transport);
    const list = await client.listTools();
    const names = (list.tools ?? []).map((t) => t.name).sort();
    step("initialize + tools/list", names.length === 15, `${names.length} tools: ${names.join(", ")}`);

    // 2) file_path over the remote transport must be refused (no backend call).
    const refused = await client.callTool({
      name: "upload_asset",
      arguments: { path: "smoke/x.md", file_path: "/etc/hostname" },
    });
    const refusedText = toolText(refused);
    step(
      "upload_asset(file_path) refused remotely",
      refused.isError === true && /not supported over the remote HTTP transport/i.test(refusedText),
      refusedText.slice(0, 120),
    );

    await client.close();

    // 3) No Authorization header -> 401.
    const r401 = await rawPost({});
    step("POST without Bearer -> 401", r401.status === 401, `status ${r401.status}`);

    // 4) Disallowed Origin -> 403 (checked before auth).
    const r403 = await rawPost({ Origin: "https://evil.example", Authorization: `Bearer ${DUMMY_PAT}` });
    step("POST with bad Origin -> 403", r403.status === 403, `status ${r403.status}`);

    // 5) Allowed Origin + Bearer -> accepted (200).
    const rOk = await rawPost({ Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${DUMMY_PAT}` });
    step("POST with allowed Origin + Bearer -> 200", rOk.status === 200, `status ${rOk.status}`);

    // 6) Health probe.
    const health = await fetch(`${BASE}/health`);
    const healthJson = await health.json().catch(() => ({}));
    step("GET /health -> 200 ok", health.status === 200 && healthJson.status === "ok");

    // 7) Oversized body -> a clean 413 JSON error, NOT a socket reset.
    try {
      const big = await rawPost(
        { Authorization: `Bearer ${DUMMY_PAT}` },
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(20000) } },
      );
      const bigJson = await big.json().catch(() => ({}));
      step(
        "oversized body -> 413 clean JSON",
        big.status === 413 && /exceeds the .* limit/i.test(bigJson?.error?.message ?? ""),
        `status ${big.status}; msg ${JSON.stringify(bigJson?.error?.message ?? null)}`,
      );
    } catch (e) {
      step("oversized body -> 413 clean JSON", false, `request threw (socket reset?): ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (err) {
    step("smoke run", false, err instanceof Error ? err.message : String(err));
  } finally {
    child.kill("SIGTERM");
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
