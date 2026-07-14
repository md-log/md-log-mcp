#!/usr/bin/env node
/**
 * Self-contained smoke test for md-log-mcp.
 *
 * Spawns the BUILT server (dist/server.js) over stdio using the MCP SDK Client
 * + StdioClientTransport, then exercises the round-trip against a LIVE backend:
 *
 *   1. initialize        (implicit on client.connect)
 *   2. tools/list
 *   3. save_markdown     — a small report embedding a tiny data: PNG
 *   4. get_markdown      — read it back
 *   5. search_markdown   — find it by body text (asserts >=1 hit: content search e2e)
 *
 * Prints PASS/FAIL per step and exits non-zero on any failure.
 *
 * Requires (read from env):
 *   MDLOG_API_BASE_URL   full backend base incl. /api/v1
 *   MDLOG_PAT            a real Personal Access Token
 *
 * Run:  npm run build && node scripts/smoke.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "../dist/server.js");

// 1x1 transparent PNG.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function main() {
  const baseUrl = process.env.MDLOG_API_BASE_URL?.trim();
  const pat = process.env.MDLOG_PAT?.trim();
  if (!baseUrl || !pat) {
    console.error(
      "Missing env. Set MDLOG_API_BASE_URL (incl. /api/v1) and MDLOG_PAT before running the smoke test.",
    );
    process.exit(2);
  }
  if (!existsSync(SERVER_PATH)) {
    console.error(`Built server not found at ${SERVER_PATH}. Run "npm run build" first.`);
    process.exit(2);
  }

  const stamp = Date.now();
  const docPath = `mcp-smoke/report-${stamp}.md`;
  const marker = `md-log-smoke-${stamp}`;
  const content =
    `# Smoke Report ${stamp}\n\n` +
    `Marker: ${marker}\n\n` +
    `Here is a tiny embedded screenshot:\n\n` +
    `![tiny](data:image/png;base64,${TINY_PNG_B64})\n`;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: { ...process.env, MDLOG_API_BASE_URL: baseUrl, MDLOG_PAT: pat },
    stderr: "inherit",
  });
  const client = new Client({ name: "md-log-mcp-smoke", version: "1.0.0" });

  try {
    // Step 1: initialize (handshake happens during connect).
    await client.connect(transport);
    step("initialize", true, "handshake completed");

    // Step 2: tools/list
    const listed = await client.listTools();
    const names = (listed.tools ?? []).map((t) => t.name);
    const expected = [
      "save_markdown",
      "upload_asset",
      "append_to_markdown",
      "update_markdown",
      "get_markdown",
      "delete_markdown",
      "create_folder",
      "list_folders",
      "list_files",
      "search_markdown",
    ];
    const missing = expected.filter((n) => !names.includes(n));
    step("tools/list", missing.length === 0, `${names.length} tools; missing: [${missing.join(", ")}]`);

    // Step 3: save_markdown
    const saveRes = await client.callTool({
      name: "save_markdown",
      arguments: { path: docPath, content },
    });
    step(
      "save_markdown",
      saveRes.isError !== true,
      saveRes.isError ? toolText(saveRes) : `saved ${docPath}`,
    );

    // Step 4: get_markdown
    const getRes = await client.callTool({
      name: "get_markdown",
      arguments: { path: docPath },
    });
    const got = toolText(getRes);
    step(
      "get_markdown",
      getRes.isError !== true && got.includes(marker),
      getRes.isError ? toolText(getRes) : `read back ${got.length} chars; marker present=${got.includes(marker)}`,
    );

    // Step 5: search_markdown — the marker only exists in the BODY, so asserting a hit proves
    // content (full-text) search end-to-end, not merely that the endpoint answered.
    const searchRes = await client.callTool({
      name: "search_markdown",
      arguments: { query: marker },
    });
    const searchHits = searchRes.structuredContent?.results?.hits?.length ?? 0;
    step(
      "search_markdown",
      searchRes.isError !== true && searchHits >= 1,
      searchRes.isError ? toolText(searchRes) : `body-content hits=${searchHits}`,
    );
  } catch (err) {
    failed++;
    console.log(`FAIL  fatal — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
