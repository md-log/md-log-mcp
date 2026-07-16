/**
 * md-log-mcp — remote Streamable HTTP entrypoint (the `md-log-mcp-http` bin).
 *
 * Serves the SAME 15 tools as the stdio server over MCP's Streamable HTTP
 * transport, so agents connect by URL with no local install. It stays true to
 * the project's "thin, backend-is-the-authority" ethos:
 *
 *   - PAT PER REQUEST: the token is taken from each request's
 *     `Authorization: Bearer <pat>` header (never from env), so ONE endpoint
 *     serves MANY users — each with their own md-log token.
 *   - STATELESS: a fresh MdlogClient + McpServer + transport per request, no
 *     shared session state (replica/serverless friendly). `sessionIdGenerator`
 *     is left undefined and `enableJsonResponse` returns one JSON reply.
 *   - NO LOCAL FILES: `file_path` asset uploads are refused (they would read the
 *     SERVER's disk); only inline `data_base64` images are accepted remotely.
 *
 * Security (per the MCP Streamable HTTP spec):
 *   - binds to 127.0.0.1 by default (override with MDLOG_HTTP_HOST for a
 *     reverse-proxied deployment),
 *   - validates the `Origin` header against an allowlist to defeat DNS-rebinding
 *     attacks from browsers (non-browser clients send no Origin and are allowed),
 *   - requires a Bearer token on every MCP request,
 *   - caps the request body size.
 *
 * Uses only Node's built-in `http` — no new runtime dependency.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer } from "./build-server.js";
import { MdlogClient } from "./client.js";
import { loadHttpConfig } from "./config.js";
import type { HttpConfig } from "./config.js";

// JSON-RPC error codes we emit at the HTTP edge (before the message reaches the SDK).
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_UNAUTHORIZED = -32001; // implementation-defined server error

class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds the ${limit}-byte limit`);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(payload);
}

/** A JSON-RPC error response envelope (id null: the edge rejected it before dispatch). */
function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

/** Extract the raw token from an `Authorization: Bearer <token>` header. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * DNS-rebinding defense. A request that carries an `Origin` header (i.e. a browser)
 * must present one on the allowlist; a request with no Origin (a normal MCP client
 * such as Claude Code) is allowed. When the allowlist is empty, no browser Origin
 * is permitted.
 */
function originAllowed(req: IncomingMessage, cfg: HttpConfig): boolean {
  const origin = req.headers["origin"];
  if (origin === undefined) return true; // non-browser client
  const value = Array.isArray(origin) ? origin[0] : origin;
  return typeof value === "string" && cfg.allowedOrigins.includes(value);
}

/** Optional Host allowlist (empty = not enforced). */
function hostAllowed(req: IncomingMessage, cfg: HttpConfig): boolean {
  if (cfg.allowedHosts.length === 0) return true;
  const host = req.headers["host"];
  return typeof host === "string" && cfg.allowedHosts.includes(host);
}

/**
 * Read the full request body into a Buffer, rejecting with BodyTooLargeError if it
 * exceeds `maxBytes`. On overflow we PAUSE the stream (stop reading) but do NOT destroy
 * the socket — `req` and `res` share it, so destroying here would drop the 413 response
 * the caller is about to write. The caller writes the 413 first, then tears down.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        req.pause();
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

async function handleMcpPost(req: IncomingMessage, res: ServerResponse, cfg: HttpConfig): Promise<void> {
  // 1) Auth — every MCP request must carry the caller's PAT.
  const pat = bearerToken(req);
  if (!pat) {
    sendRpcError(res, 401, JSONRPC_UNAUTHORIZED, "Missing 'Authorization: Bearer <md-log PAT>' header.", {
      "WWW-Authenticate": 'Bearer realm="md-log-mcp"',
    });
    return;
  }

  // 2) Body — read with a size cap, then parse.
  let parsedBody: unknown;
  try {
    const raw = await readBody(req, cfg.maxBodyBytes);
    if (raw.length === 0) {
      sendRpcError(res, 400, JSONRPC_INVALID_REQUEST, "Empty request body.");
      return;
    }
    parsedBody = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // Deliver the 413 BEFORE destroying the socket, then tear down to stop the in-flight
      // upload. (readBody only paused the stream; destroying it earlier would drop this
      // response and leave the client with a bare connection reset and no diagnostic.)
      if (!res.headersSent) {
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          error: { code: JSONRPC_INVALID_REQUEST, message: err.message },
          id: null,
        });
        res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
        res.end(payload, () => req.destroy());
      } else {
        req.destroy();
      }
      return;
    }
    sendRpcError(res, 400, JSONRPC_PARSE_ERROR, "Request body is not valid JSON.");
    return;
  }

  // 3) Per-request, stateless server bound to THIS caller's token.
  const client = new MdlogClient({ apiBaseUrl: cfg.apiBaseUrl, pat });
  const server = buildServer(client, { allowLocalFiles: false });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no session store
    enableJsonResponse: true, // reply with a single JSON body (no long-lived SSE)
  });

  // Tear down the per-request server+transport once the response is done.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    process.stderr.write(
      `md-log-mcp-http: request handling failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    // If the transport already started writing, we can't change the status.
    sendRpcError(res, 500, JSONRPC_INVALID_REQUEST, "Internal server error handling the MCP request.");
  }
}

function requestPath(req: IncomingMessage): string {
  // req.url is path+query; take just the pathname. Base is irrelevant (host-relative).
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function makeRequestHandler(cfg: HttpConfig) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = requestPath(req);
    const method = req.method ?? "GET";

    // Liveness probe (no auth) — handy for load balancers / container health checks.
    if (path === "/health" && method === "GET") {
      sendJson(res, 200, { status: "ok", transport: "streamable-http" });
      return;
    }

    if (path !== cfg.mcpPath) {
      sendRpcError(res, 404, JSONRPC_INVALID_REQUEST, `Not found. The MCP endpoint is ${cfg.mcpPath}.`);
      return;
    }

    // DNS-rebinding defenses apply to every method on the MCP endpoint.
    if (!originAllowed(req, cfg)) {
      sendRpcError(res, 403, JSONRPC_INVALID_REQUEST, "Origin not allowed.");
      return;
    }
    if (!hostAllowed(req, cfg)) {
      sendRpcError(res, 403, JSONRPC_INVALID_REQUEST, "Host not allowed.");
      return;
    }

    if (method === "POST") {
      void handleMcpPost(req, res, cfg);
      return;
    }

    // Stateless server: no standalone server->client SSE stream (GET) and no
    // session to terminate (DELETE). The spec permits answering both with 405.
    sendRpcError(res, 405, JSONRPC_INVALID_REQUEST, `${method} is not supported; POST JSON-RPC to ${cfg.mcpPath}.`, {
      Allow: "POST",
    });
  };
}

function main(): void {
  const cfg = loadHttpConfig(); // throws a clear error if MDLOG_API_BASE_URL is unset/malformed

  const httpServer = createServer(makeRequestHandler(cfg));

  httpServer.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    process.stderr.write(
      `md-log-mcp-http ready — POST http://${cfg.host}:${cfg.port}${cfg.mcpPath} ` +
        `(backend: ${cfg.apiBaseUrl}; auth: per-request Bearer PAT; ` +
        `origins: ${cfg.allowedOrigins.length ? cfg.allowedOrigins.join(",") : "none (non-browser only)"})\n`,
    );
  });

  const shutdown = (signal: string) => {
    process.stderr.write(`md-log-mcp-http: received ${signal}, shutting down.\n`);
    httpServer.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
