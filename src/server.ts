/**
 * md-log-mcp — stdio entrypoint (the `md-log-mcp` bin).
 *
 * The default, local transport: the MCP client (Claude Code, Cursor, …) launches
 * this as a subprocess and speaks JSON-RPC over stdin/stdout. The PAT comes from
 * the process environment (MDLOG_PAT) and local `file_path` image uploads are
 * allowed (the server runs on the user's own machine).
 *
 * All tool logic lives in `build-server.ts` and is shared with the remote
 * Streamable HTTP entrypoint (`http.ts`).
 *
 * stdout is reserved for the JSON-RPC stream — every log line goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer } from "./build-server.js";
import { MdlogClient } from "./client.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  // loadConfig throws a clear error (printed to stderr) if env is missing.
  const config = loadConfig();
  const client = new MdlogClient(config);
  const server = buildServer(client, { allowLocalFiles: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout — that channel is the JSON-RPC stream.
  process.stderr.write(`md-log-mcp ready (stdio; backend: ${config.apiBaseUrl})\n`);
}

main().catch((err) => {
  process.stderr.write(
    `md-log-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
