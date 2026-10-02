#!/usr/bin/env node
/**
 * T7 precondition — measure how much get_markdown duplicates the document body.
 *
 * get_markdown ships the body TWICE in one JSON-RPC result: once as content[0].text and again as
 * structuredContent.content (src/build-server.ts current-version and old-version paths; both go
 * through the ok() helper, which ALWAYS sets both fields). get_markdown declares no outputSchema,
 * so the SDK passes structuredContent through untouched (server/mcp.js validateToolOutput returns
 * early when !tool.outputSchema) — the duplicate really does reach the wire.
 *
 * This script measures the WIRE bytes so a human can decide T7. It deliberately does NOT use the
 * MCP SDK Client the way smoke.mjs does: the Client parses each frame and throws the raw bytes
 * away. Instead it speaks newline-delimited JSON-RPC straight to the built stdio server and keeps
 * the exact response line.
 *
 * WHAT THIS DOES *NOT* MEASURE — read before acting on the numbers:
 *   Whether a given MCP host renders structuredContent into the model's context at all. That is
 *   host-dependent and is the actual open question behind T7. This script bounds the PRIZE (bytes
 *   on the wire). Confirming the prize is collectable as TOKENS still needs a host-side check.
 *
 * Requires (read from env, same as smoke.mjs):
 *   MDLOG_API_BASE_URL   full backend base incl. /api/v1
 *   MDLOG_PAT            a real Personal Access Token
 * Optional:
 *   MEASURE_SIZES        CSV of probe body sizes in bytes (default "1024,16384,131072")
 *   MEASURE_KEEP         "1" to keep the probe documents instead of deleting them
 *
 * Run:  npm run build && node scripts/measure-get-markdown.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "../dist/server.js");

// In the SDK's SUPPORTED_PROTOCOL_VERSIONS; pinned rather than tracking LATEST so an SDK bump
// cannot change what we negotiate mid-measurement.
const PROTOCOL_VERSION = "2025-06-18";

const SIZES = (process.env.MEASURE_SIZES ?? "1024,16384,131072")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const KEEP = process.env.MEASURE_KEEP === "1";

const bytes = (s) => Buffer.byteLength(s, "utf8");
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
const pct = (a, b) => `${((1 - a / b) * 100).toFixed(1)}%`;

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

/** Deterministic ASCII markdown body of exactly `size` bytes (ASCII => chars === bytes). */
function makeBody(size, marker) {
  const head = `# Measure probe ${marker}\n\n`;
  const line = "lorem ipsum dolor sit amet consectetur adipiscing elit\n";
  const parts = [head];
  let len = head.length;
  while (len + line.length <= size) {
    parts.push(line);
    len += line.length;
  }
  if (len < size) parts.push("x".repeat(size - len));
  return parts.join("");
}

/**
 * Minimal newline-delimited JSON-RPC client over the built stdio server. Resolves each request with
 * BOTH the parsed message and the RAW response line — the raw line is the measurement.
 */
function startServer() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "inherit"], // stdout is JSON-RPC only; server logs go to stderr
  });

  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!raw.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue; // not a frame we care about
      }
      if (msg.id === undefined || msg.id === null) continue; // server notification
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      p.resolve({ raw, msg });
    }
  });
  child.on("exit", (code) => {
    for (const [, p] of pending) p.reject(new Error(`server exited early (code ${code})`));
    pending.clear();
  });

  let nextId = 1;
  function request(method, params, timeoutMs = 60_000) {
    const id = nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v); },
        reject: (e) => { clearTimeout(timer); rej(e); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  return { child, request, notify };
}

/**
 * Break one get_markdown response into its parts.
 *
 * `total` is the exact wire line. The part sizes are re-serialized from the PARSED result: V8
 * preserves key insertion order through JSON.parse, and it is the same JSON.stringify that produced
 * the line, so the parts sum to `total` up to the fixed envelope keys (jsonrpc/id/result braces).
 * That residue is reported as `envelope` rather than hidden.
 */
function measure(requestedSize, body, { raw, msg }) {
  const result = msg.result;
  const textPart = (result.content ?? []).map((c) => c.text ?? "").join("");
  const structured = result.structuredContent ?? {};

  const total = bytes(raw);
  const contentJson = bytes(JSON.stringify(result.content ?? []));
  const structJson = bytes(JSON.stringify(structured));
  const structBodyJson = bytes(JSON.stringify(structured.content ?? ""));
  const bodyRaw = bytes(body);

  return {
    requestedSize,
    bodyRaw,
    total,
    contentJson,
    structJson,
    structBodyJson,
    envelope: total - contentJson - structJson,
    // Two candidate fixes, priced separately.
    withoutDupBody: total - structBodyJson,      // drop structuredContent.content, keep the metadata
    withoutStructured: total - structJson,       // drop structuredContent entirely
    bodyCopies: (contentJson + structBodyJson) / bodyRaw,
    identical: textPart === structured.content,
  };
}

function report(rows) {
  if (rows.length === 0) {
    console.log("\nNo measurements collected.");
    return;
  }

  console.log("\n=== get_markdown response breakdown (exact stdio JSON-RPC wire bytes) ===\n");
  const cols = ["body", "TOTAL", "content[]", "structured", "of which body", "envelope", "dup?"];
  console.log(cols.map((c) => c.padStart(14)).join(""));
  for (const r of rows) {
    console.log(
      [
        kib(r.bodyRaw),
        kib(r.total),
        kib(r.contentJson),
        kib(r.structJson),
        kib(r.structBodyJson),
        `${r.envelope} B`,
        r.identical ? "identical" : "DIFFERENT",
      ]
        .map((c) => String(c).padStart(14))
        .join(""),
    );
  }

  console.log("\n=== What removing the duplicate would save ===\n");
  for (const r of rows) {
    console.log(
      `  body ${kib(r.bodyRaw).padStart(10)}  |  ` +
        `drop structuredContent.content: ${kib(r.total)} -> ${kib(r.withoutDupBody)} ` +
        `(${pct(r.withoutDupBody, r.total)} smaller)  |  ` +
        `drop structuredContent entirely: ${kib(r.withoutStructured)} ` +
        `(${pct(r.withoutStructured, r.total)} smaller)`,
    );
  }

  const big = rows[rows.length - 1];
  console.log(
    `\nDUPLICATION FACTOR (largest probe): a ${kib(big.bodyRaw)} body is carried ` +
      `${big.bodyCopies.toFixed(2)}x inside a ${kib(big.total)} response. ` +
      `Removing the second copy makes the response ${(big.total / big.withoutDupBody).toFixed(2)}x smaller.`,
  );
  console.log(
    "\nCAVEAT — these are WIRE bytes, not tokens. Whether they enter the model's context depends on\n" +
      "the MCP host: a host that renders only content[].text and ignores structuredContent already\n" +
      "pays zero extra tokens, and the saving here would be bandwidth only. Verify host behaviour\n" +
      "before changing ok() or get_markdown.",
  );
}

async function main() {
  const baseUrl = process.env.MDLOG_API_BASE_URL?.trim();
  const pat = process.env.MDLOG_PAT?.trim();
  if (!baseUrl || !pat) {
    console.error(
      "Missing env. Set MDLOG_API_BASE_URL (incl. /api/v1) and MDLOG_PAT before running the measurement.",
    );
    process.exit(2);
  }
  if (!existsSync(SERVER_PATH)) {
    console.error(`Built server not found at ${SERVER_PATH}. Run "npm run build" first.`);
    process.exit(2);
  }

  const srv = startServer();
  const rows = [];

  try {
    await srv.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "md-log-mcp-measure", version: "1.0.0" },
    });
    srv.notify("notifications/initialized", {});
    step("initialize", true, "handshake completed");

    for (const size of SIZES) {
      const stamp = `${Date.now()}-${size}`;
      const docPath = `mcp-measure/probe-${stamp}.md`;
      const body = makeBody(size, stamp);

      const saved = await srv.request("tools/call", {
        name: "save_markdown",
        arguments: {
          path: docPath,
          content: body,
          commit_message: `T7 measurement probe (${size} B body); deleted by the script unless MEASURE_KEEP=1`,
        },
      });
      if (!step(`save_markdown ${size}B`, !saved.msg.error && saved.msg.result?.isError !== true, docPath)) {
        console.error(saved.raw.slice(0, 400));
        continue;
      }

      const got = await srv.request("tools/call", { name: "get_markdown", arguments: { path: docPath } });
      if (step(`get_markdown ${size}B`, !got.msg.error && got.msg.result?.isError !== true, `${bytes(got.raw)} B on the wire`)) {
        const row = measure(size, body, got);
        step(
          `both copies present ${size}B`,
          row.identical && row.structBodyJson > 0,
          row.identical
            ? "content[].text === structuredContent.content"
            : "copies DIFFER — investigate before trusting the delta",
        );
        rows.push(row);
      } else {
        console.error(got.raw.slice(0, 400));
      }

      if (!KEEP) {
        await srv
          .request("tools/call", { name: "delete_markdown", arguments: { path: docPath, confirm: true } })
          .catch(() => { /* cleanup is best-effort; a leftover probe is not a measurement failure */ });
      }
    }
  } catch (err) {
    step("measurement run", false, err instanceof Error ? err.message : String(err));
  } finally {
    srv.child.kill("SIGTERM");
  }

  report(rows);
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 && rows.length > 0 ? 0 : 1);
}

main();
