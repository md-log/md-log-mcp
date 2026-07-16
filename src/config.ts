/**
 * Environment configuration for md-log-mcp.
 *
 * Two shapes, one per transport:
 *   - `loadConfig()`      — stdio: requires MDLOG_API_BASE_URL + MDLOG_PAT (the
 *                           token is baked into the process, one user per process).
 *   - `loadHttpConfig()`  — remote Streamable HTTP: requires only
 *                           MDLOG_API_BASE_URL. The PAT is NOT read from env —
 *                           each request carries its own `Authorization: Bearer`
 *                           token, so one endpoint serves many users.
 *
 * Both fail fast (clear, actionable message on stderr) if required env is missing.
 * The MCP server is a thin authenticated client; it has no other configuration.
 */

export interface Config {
  /** Full backend API base, INCLUDING /api/v1 (no version suffix is appended). */
  apiBaseUrl: string;
  /** md-log Personal Access Token (mdlog_pat_...). */
  pat: string;
}

/**
 * Validate + normalize MDLOG_API_BASE_URL. Shared by both transports so the same
 * http/https guard and plaintext-PAT warning apply everywhere. Throws a clear
 * Error if unset or malformed.
 */
export function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const apiBaseUrl = env.MDLOG_API_BASE_URL?.trim();
  if (!apiBaseUrl) {
    throw new Error(
      "md-log-mcp: missing required environment variable MDLOG_API_BASE_URL.\n" +
        "  - MDLOG_API_BASE_URL must be the FULL backend base including /api/v1, " +
        "e.g. http://localhost:8080/api/v1 or https://app.md-log.com/api/v1",
    );
  }

  // Validate the base URL early so failures are obvious at startup.
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new Error(
      `md-log-mcp: MDLOG_API_BASE_URL is not a valid URL: "${apiBaseUrl}". ` +
        "Expected something like http://localhost:8080/api/v1",
    );
  }
  // #66: only http/https — the PAT is sent as a Bearer header on every request, so an accidental
  // file:/gopher:/etc. scheme (or a copy-paste error) must not smuggle the token to an arbitrary handler.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `md-log-mcp: MDLOG_API_BASE_URL must use http or https (got "${parsed.protocol}"). ` +
        "The PAT is sent as a Bearer token to this host on every call.",
    );
  }
  // #66: warn (don't block — local dev is http) when a non-localhost host is reached over plaintext http,
  // which would expose the long-lived PAT on the wire.
  const isLocal =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol === "http:" && !isLocal) {
    process.stderr.write(
      `md-log-mcp: WARNING — MDLOG_API_BASE_URL uses plaintext http to a non-local host ` +
        `("${parsed.host}"); your PAT is sent unencrypted. Use https in production.\n`,
    );
  }
  // Strip trailing slash(es) so we can safely concatenate "/mcp/...".
  return parsed.toString().replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const pat = env.MDLOG_PAT?.trim();
  // Validate the base URL first, then require the PAT — collect both so a user missing
  // both env vars sees a complete message rather than fixing them one at a time.
  let apiBaseUrl: string | undefined;
  let baseErr: Error | undefined;
  try {
    apiBaseUrl = resolveApiBaseUrl(env);
  } catch (e) {
    baseErr = e as Error;
  }

  if (!apiBaseUrl || !pat) {
    const missing: string[] = [];
    if (!apiBaseUrl) missing.push("MDLOG_API_BASE_URL");
    if (!pat) missing.push("MDLOG_PAT");
    // If the base URL was present but malformed, surface that specific error verbatim.
    if (apiBaseUrl === undefined && baseErr && env.MDLOG_API_BASE_URL?.trim()) {
      throw baseErr;
    }
    throw new Error(
      `md-log-mcp: missing required environment variable(s): ${missing.join(", ")}.\n` +
        "  - MDLOG_API_BASE_URL must be the FULL backend base including /api/v1, " +
        "e.g. http://localhost:8080/api/v1 or https://app.md-log.com/api/v1\n" +
        "  - MDLOG_PAT must be a md-log Personal Access Token (mdlog_pat_...).\n" +
        "Set these in the MCP server's `env` block (see README.md).",
    );
  }

  return { apiBaseUrl, pat };
}

export interface HttpConfig {
  /** Full backend API base, INCLUDING /api/v1. */
  apiBaseUrl: string;
  /** Interface to bind. Default 127.0.0.1 (localhost-only) per the MCP security guidance. */
  host: string;
  /** TCP port to listen on. Default 8787. */
  port: number;
  /** The single MCP endpoint path (POST/GET/DELETE). Default "/mcp". */
  mcpPath: string;
  /**
   * Allowed browser `Origin` header values (DNS-rebinding defense). A request that
   * CARRIES an Origin not in this list is rejected; requests with NO Origin
   * (non-browser MCP clients) are always allowed. Empty = no browser origin permitted.
   */
  allowedOrigins: string[];
  /**
   * Optional `Host` header allowlist (extra DNS-rebinding defense). Empty = Host not checked.
   */
  allowedHosts: string[];
  /** Max request body size in bytes (base64 images inflate ~33%). Default 32 MiB. */
  maxBodyBytes: number;
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const apiBaseUrl = resolveApiBaseUrl(env); // throws if unset/malformed

  const host = env.MDLOG_HTTP_HOST?.trim() || "127.0.0.1";
  const port = parsePositiveInt(env.MDLOG_HTTP_PORT, 8787);
  let mcpPath = env.MDLOG_HTTP_PATH?.trim() || "/mcp";
  if (!mcpPath.startsWith("/")) mcpPath = "/" + mcpPath;
  // Normalize away any trailing slash so "/mcp/" and "/mcp" match the same route (but keep root "/").
  if (mcpPath.length > 1) mcpPath = mcpPath.replace(/\/+$/, "");

  if (host === "0.0.0.0" || host === "::") {
    process.stderr.write(
      `md-log-mcp: WARNING — binding the HTTP server to ${host} exposes it on all interfaces. ` +
        "Put it behind a TLS reverse proxy and set MDLOG_HTTP_ALLOWED_ORIGINS.\n",
    );
  }

  return {
    apiBaseUrl,
    host,
    port,
    mcpPath,
    allowedOrigins: parseList(env.MDLOG_HTTP_ALLOWED_ORIGINS),
    allowedHosts: parseList(env.MDLOG_HTTP_ALLOWED_HOSTS),
    maxBodyBytes: parsePositiveInt(env.MDLOG_HTTP_MAX_BODY_BYTES, 32 * 1024 * 1024),
  };
}
