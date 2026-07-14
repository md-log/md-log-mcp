/**
 * Environment configuration for md-log-mcp.
 *
 * Reads the two required env vars and fails fast (with a clear, actionable
 * message) if either is missing. The MCP server is a thin authenticated
 * client; it has no other configuration.
 */

export interface Config {
  /** Full backend API base, INCLUDING /api/v1 (no version suffix is appended). */
  apiBaseUrl: string;
  /** md-log Personal Access Token (mdlog_pat_...). */
  pat: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiBaseUrl = env.MDLOG_API_BASE_URL?.trim();
  const pat = env.MDLOG_PAT?.trim();

  const missing: string[] = [];
  if (!apiBaseUrl) missing.push("MDLOG_API_BASE_URL");
  if (!pat) missing.push("MDLOG_PAT");

  if (missing.length > 0) {
    throw new Error(
      `md-log-mcp: missing required environment variable(s): ${missing.join(
        ", ",
      )}.\n` +
        "  - MDLOG_API_BASE_URL must be the FULL backend base including /api/v1, " +
        "e.g. http://localhost:8080/api/v1 or https://md.example.com/api/v1\n" +
        "  - MDLOG_PAT must be a md-log Personal Access Token (mdlog_pat_...).\n" +
        "Set these in the MCP server's `env` block (see README.md).",
    );
  }

  // Validate the base URL early so failures are obvious at startup.
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl as string);
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
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol === "http:" && !isLocal) {
    process.stderr.write(
      `md-log-mcp: WARNING — MDLOG_API_BASE_URL uses plaintext http to a non-local host ` +
        `("${parsed.host}"); your PAT is sent unencrypted. Use https in production.\n`,
    );
  }
  const normalized = parsed.toString();

  return {
    // Strip trailing slash(es) so we can safely concatenate "/mcp/...".
    apiBaseUrl: normalized.replace(/\/+$/, ""),
    pat: pat as string,
  };
}
