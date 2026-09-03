/**
 * Thin authenticated HTTP client over the hosted md-log service.
 *
 * Responsibilities (and ONLY these — no business logic lives here):
 *   - attach `Authorization: Bearer <PAT>` (+ `X-API-Token` for compat),
 *   - send/receive JSON,
 *   - unwrap the backend `ResponseData<T>` envelope `{status, message, code, data}`,
 *   - map backend HTTP status + `MDLOG_*` error codes to typed `MdlogError`s that
 *     the tool layer surfaces to the agent.
 *
 * The backend is the single source of truth for auth, storage and quota.
 */

import { createHash } from "node:crypto";
import { resolveMaxDocumentBytes } from "./config.js";
import type { Config } from "./config.js";

/** Stable, agent-facing error codes (see plan §7.4 "Errors -> agent codes"). */
export type AgentErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "BACKEND_UNAVAILABLE"
  | "VALIDATION"
  | "FOLDER_EXISTS"
  | "ERROR";

export interface MdlogErrorOptions {
  /** The raw backend `code` (e.g. MDLOG_SYNC_0409), if any. */
  serverCode?: string;
  /** HTTP status, if the failure originated from an HTTP response. */
  status?: number;
  /**
   * Extra structured detail for the agent. For CONFLICT this carries the
   * server head: `{server_version_no, server_checksum, server_updated_at}`.
   */
  detail?: unknown;
}

export class MdlogError extends Error {
  readonly code: AgentErrorCode;
  readonly serverCode?: string;
  readonly status?: number;
  readonly detail?: unknown;

  constructor(code: AgentErrorCode, message: string, opts: MdlogErrorOptions = {}) {
    super(message);
    this.name = "MdlogError";
    this.code = code;
    this.serverCode = opts.serverCode;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

/** Map a failed HTTP response (status + envelope) to a typed MdlogError. */
export function mapError(
  status: number,
  serverCode: string | undefined,
  json: any,
): MdlogError {
  const message: string =
    (json && (json.message || json.error)) || `Backend request failed (HTTP ${status})`;
  const detail = json && "data" in json ? json.data : json;
  const opts: MdlogErrorOptions = { serverCode, status, detail };

  // Folder duplicate is treated as success by create_folder; give it its own code.
  if (serverCode === "MDLOG_FLD_0001") {
    return new MdlogError("FOLDER_EXISTS", message, opts);
  }
  // Quota is a 200-FAIL on the backend.
  if (serverCode === "MDLOG_DOC_0007") {
    return new MdlogError("QUOTA_EXCEEDED", message, opts);
  }
  // Cross-scope move rejection (400) — a distinct code from quota so the agent doesn't misread it as
  // "storage full" and retry destructively. It's a plain validation failure, not something to reconcile.
  if (serverCode === "MDLOG_DOC_0008" || serverCode === "MDLOG_FLD_0008") {
    return new MdlogError("VALIDATION", message, opts);
  }
  // Optimistic concurrency conflict — carries the server head in `detail`.
  if (serverCode === "MDLOG_SYNC_0409" || status === 409) {
    return new MdlogError("CONFLICT", message, opts);
  }
  if (serverCode === "MDLOG_CM_0404" || status === 404) {
    return new MdlogError("NOT_FOUND", message, opts);
  }
  if (serverCode === "MDLOG_AU_0429" || status === 429) {
    return new MdlogError("RATE_LIMITED", message, opts);
  }
  if ((serverCode && serverCode.startsWith("MDLOG_AU_")) || status === 401 || status === 403) {
    return new MdlogError("UNAUTHORIZED", message, opts);
  }
  if (
    serverCode === "MDLOG_CM_0005" ||
    serverCode === "VALIDATION_FAILED" ||
    serverCode === "MDLOG_CM_0006" ||
    status === 400
  ) {
    return new MdlogError("VALIDATION", message, opts);
  }
  if (status >= 500 || serverCode === "MDLOG_CM_0500") {
    return new MdlogError("BACKEND_UNAVAILABLE", message, opts);
  }
  return new MdlogError("ERROR", message, opts);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ReserveResult {
  reservation_key?: string;
  asset_key?: string;
  upload_url: string;
  headers: Record<string, string>;
  raw: any;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * #67: per-request timeout. Every fetch runs over the stdio JSON-RPC channel, so a hung backend or a stalled
 * presigned upload/download would otherwise block the tool call — and the whole agent — indefinitely. 60s is
 * generous for a 10 MiB blob transfer while still bounding the worst case. Overridable via MDLOG_HTTP_TIMEOUT_MS.
 */
const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.MDLOG_HTTP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

/**
 * Client-side mirror of the backend's 25 MiB per-document cap (Constant.MAX_DOCUMENT_BYTES), resolved
 * once at module load exactly like REQUEST_TIMEOUT_MS above. Read via config so the env-var contract
 * lives in one place; override with MDLOG_MAX_DOCUMENT_BYTES.
 */
const MAX_DOCUMENT_BYTES = resolveMaxDocumentBytes();

export class MdlogClient {
  private readonly base: string;
  private readonly pat: string;

  constructor(config: Config) {
    this.base = config.apiBaseUrl;
    this.pat = config.pat;
  }

  // --- low-level -----------------------------------------------------------

  private async request(method: string, path: string, opts: RequestOptions = {}): Promise<any> {
    const url = new URL(this.base + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.pat}`,
      "X-API-Token": this.pat,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      throw new MdlogError(
        "BACKEND_UNAVAILABLE",
        `Cannot reach md-log backend at ${url.origin}: ${(e as Error).message}`,
      );
    }

    const text = await res.text();
    let json: any;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    const serverCode: string | undefined = json?.code;
    const failByStatus = json?.status === "FAIL" || json?.status === false;
    const ok = res.ok && !failByStatus && (!serverCode || serverCode === "MDLOG_CM_0000");

    if (ok) {
      return json && "data" in json ? json.data : json;
    }
    throw mapError(res.status, serverCode, json ?? { message: text });
  }

  /** Presigned PUT of raw bytes straight to the object store. Content-Type MUST match the signed type. */
  async putBytes(
    url: string,
    bytes: Buffer,
    contentType: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": contentType, ...extraHeaders },
        body: bytes,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new MdlogError(
        "BACKEND_UNAVAILABLE",
        `Asset upload (presigned PUT) failed: ${(e as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new MdlogError(
        "BACKEND_UNAVAILABLE",
        `Asset upload (presigned PUT) returned HTTP ${res.status}. ` +
          "Check that the signed Content-Type matches the uploaded bytes.",
      );
    }
  }

  // --- documents (by path, MCP lane) --------------------------------------

  /**
   * PUT /mcp/documents/by-path
   * Omitting baseVersionNo => forced LWW (the headline save path).
   */
  async putByPath(args: {
    path: string;
    content: string;
    baseVersionNo?: number;
    commitMessage?: string;
    createFolders?: boolean;
  }): Promise<any> {
    // Pre-flight the backend's 25 MiB document cap HERE rather than per tool: every write lane funnels
    // through putByPath — save_markdown, update_markdown, edit_markdown and append_to_markdown, which
    // pushes the MERGED existing+new body and is the one lane that can silently grow past the cap while
    // each individual append stays tiny. Byte length, not .length: the cap is UTF-8 BYTES and Korean is
    // 3 bytes/char, so a char count under-reports by ~3x. Without this, oversize surfaces as an opaque
    // backend 400 or, if the upload stalls, a 60s REQUEST_TIMEOUT_MS abort.
    // VALIDATION is deliberate: mapError() already routes the server's own 400 (MDLOG_DOC_0006) to
    // VALIDATION, so the agent sees an identical code whether the cap trips locally or remotely. NOT
    // QUOTA_EXCEEDED — that means "storage full" (MDLOG_DOC_0007) and an agent may react by deleting
    // other documents.
    const contentBytes = Buffer.byteLength(args.content, "utf8");
    if (contentBytes > MAX_DOCUMENT_BYTES) {
      throw new MdlogError(
        "VALIDATION",
        `document body is ${contentBytes} bytes when UTF-8 encoded, over the ${MAX_DOCUMENT_BYTES}-byte ` +
          `server cap for "${args.path}". Split it into smaller documents, or move large embedded images ` +
          "to upload_asset (asset:// references) instead of inline data: URIs.",
        {
          detail: {
            path: args.path,
            content_bytes: contentBytes,
            max_bytes: MAX_DOCUMENT_BYTES,
            over_by_bytes: contentBytes - MAX_DOCUMENT_BYTES,
          },
        },
      );
    }

    const body: Record<string, unknown> = {
      path: args.path,
      content: args.content,
      source: "MCP",
      create_folders: args.createFolders ?? true,
    };
    if (args.baseVersionNo !== undefined && args.baseVersionNo !== null) {
      body.base_version_no = args.baseVersionNo;
    }
    if (args.commitMessage) body.commit_message = args.commitMessage;
    return this.request("PUT", "/mcp/documents/by-path", { body });
  }

  /** GET /mcp/documents/by-path?path= */
  async getByPath(path: string): Promise<any> {
    return this.request("GET", "/mcp/documents/by-path", { query: { path } });
  }

  /**
   * Resolve a backend doc body to a string, whether the backend returned it
   * inline or as a presigned URL (large docs).
   */
  async materializeContent(data: any): Promise<string> {
    if (typeof data?.content === "string") return data.content;
    if (typeof data?.body === "string") return data.body;
    const contentUrl: string | undefined = data?.content_url ?? data?.url;
    if (contentUrl) {
      let res: Response;
      try {
        res = await fetch(contentUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (e) {
        throw new MdlogError(
          "BACKEND_UNAVAILABLE",
          `Failed to fetch document content URL: ${(e as Error).message}`,
        );
      }
      if (!res.ok) {
        throw new MdlogError(
          "BACKEND_UNAVAILABLE",
          `Document content URL returned HTTP ${res.status}.`,
        );
      }
      return res.text();
    }
    return "";
  }

  /** DELETE /documents/{key} (soft delete). */
  async deleteDocument(documentKey: string): Promise<any> {
    return this.request("DELETE", `/documents/${encodeURIComponent(documentKey)}`);
  }

  /** GET /documents/{key}/versions — immutable history, newest first (VersionRes[]). */
  async listVersions(documentKey: string): Promise<any> {
    return this.request("GET", `/documents/${encodeURIComponent(documentKey)}/versions`);
  }

  /**
   * GET /documents/{key}/content?as=inline&version_no= — a specific version's body (or the current
   * one when versionNo is omitted). The response discriminator is `mode` ('inline'|'url'); large
   * bodies come back as a presigned `url` — materializeContent() handles both.
   */
  async getContentByKey(documentKey: string, versionNo?: number): Promise<any> {
    return this.request("GET", `/documents/${encodeURIComponent(documentKey)}/content`, {
      query: { as: "inline", version_no: versionNo },
    });
  }

  /**
   * POST /documents/{key}/versions/{versionNo}/restore — re-apply an OLD version's body as a NEW head
   * version. The history is immutable: nothing is rewound or dropped, the restore is simply another
   * version on top, so it is itself undoable. Distinct from POST /documents/{key}/restore, which
   * UN-DELETES a soft-deleted document. Returns the same document shape as the by-path PUT
   * (document_key, current_version_no, checksum_sha256).
   *
   * Restoring the version the document is already on is an idempotent NO-OP server-side: it returns the
   * UNCHANGED head, so an unmoved current_version_no is success, not failure.
   */
  async restoreVersion(documentKey: string, versionNo: number, commitMessage?: string): Promise<any> {
    const body: Record<string, unknown> = { source: "MCP" };
    if (commitMessage) body.commit_message = commitMessage;
    return this.request(
      "POST",
      `/documents/${encodeURIComponent(documentKey)}/versions/${encodeURIComponent(String(versionNo))}/restore`,
      { body },
    );
  }

  /** POST /documents/{key}/move — new_folder_key null/omitted = move to root. */
  async moveDocument(documentKey: string, newFolderKey: string | null): Promise<any> {
    return this.request("POST", `/documents/${encodeURIComponent(documentKey)}/move`, {
      body: { new_folder_key: newFolderKey },
    });
  }

  /** PATCH /documents/{key} — rename the file (filename is unique per folder, case-insensitive). */
  async renameDocument(documentKey: string, filename: string): Promise<any> {
    return this.request("PATCH", `/documents/${encodeURIComponent(documentKey)}`, {
      body: { filename },
    });
  }

  // --- folders -------------------------------------------------------------

  /** GET /folders/tree */
  async getFoldersTree(): Promise<any> {
    return this.request("GET", "/folders/tree");
  }

  /** GET /mcp/folders/by-path?path= */
  async getFolderByPath(path: string): Promise<any> {
    return this.request("GET", "/mcp/folders/by-path", { query: { path } });
  }

  /** GET /folders/resolve?path= — returns the folder, or null when it does not exist. */
  async resolveFolder(path: string): Promise<any | null> {
    try {
      return await this.request("GET", "/folders/resolve", { query: { path } });
    } catch (e) {
      if (e instanceof MdlogError && e.code === "NOT_FOUND") return null;
      throw e;
    }
  }

  /** POST /folders {parent_key?, name} */
  async createFolderSegment(args: { parentKey?: string; name: string }): Promise<any> {
    const body: Record<string, unknown> = { name: args.name };
    if (args.parentKey) body.parent_key = args.parentKey;
    return this.request("POST", "/folders", { body });
  }

  /** POST /folders/{key}/move — new_parent_key null/omitted = move to root. Cyclic moves are rejected server-side. */
  async moveFolder(folderKey: string, newParentKey: string | null): Promise<any> {
    return this.request("POST", `/folders/${encodeURIComponent(folderKey)}/move`, {
      body: { new_parent_key: newParentKey },
    });
  }

  /** PATCH /folders/{key} — rename (descendant paths are rewritten server-side). */
  async renameFolder(folderKey: string, name: string): Promise<any> {
    return this.request("PATCH", `/folders/${encodeURIComponent(folderKey)}`, {
      body: { name },
    });
  }

  /**
   * DELETE /folders/{key}?cascade= — cascade=false refuses a non-empty folder (MDLOG_FLD_0005,
   * mapped to VALIDATION); cascade=true soft-deletes the whole subtree (folders + documents).
   */
  async deleteFolder(folderKey: string, cascade: boolean): Promise<any> {
    return this.request("DELETE", `/folders/${encodeURIComponent(folderKey)}`, {
      query: { cascade },
    });
  }

  // --- search --------------------------------------------------------------

  /** GET /search?q=&scope=content&type=documents */
  async searchDocuments(query: string): Promise<any> {
    return this.request("GET", "/search", {
      query: { q: query, scope: "content", type: "documents" },
    });
  }

  // --- assets (MCP image lane) --------------------------------------------

  /**
   * POST /mcp/documents/by-path/assets/reserve?path=
   * Wire contract (McpController.reserveAsset): the DOCUMENT PATH is a QUERY PARAM (not body); the body
   * is McpReserveAssetReq {content_type, size_bytes, checksum_sha256, filename}. The response is
   * ReserveAssetRes {reservation_key, asset_key, storage_key, upload_url, expires_at}.
   */
  async reserveAsset(args: {
    path: string;
    filename: string;
    contentType: string;
    size: number;
    checksum: string;
  }): Promise<ReserveResult> {
    const data = await this.request("POST", "/mcp/documents/by-path/assets/reserve", {
      query: { path: args.path },
      body: {
        content_type: args.contentType,
        size_bytes: args.size,
        checksum_sha256: args.checksum,
        filename: args.filename,
      },
    });
    const uploadUrl: string | undefined = data?.upload_url;
    if (!uploadUrl) {
      throw new MdlogError(
        "BACKEND_UNAVAILABLE",
        "Asset reserve response did not include a presigned upload URL.",
        { detail: data },
      );
    }
    return {
      reservation_key: data?.reservation_key,
      asset_key: data?.asset_key,
      upload_url: uploadUrl,
      headers: {},
      raw: data,
    };
  }

  /**
   * POST /mcp/documents/by-path/assets/{assetKey}/complete?path=
   * Wire contract (McpController.completeAsset): assetKey in the URL, document path as a query param,
   * NO body (the backend HEAD-verifies the staged bytes itself).
   */
  async completeAsset(args: {
    path: string;
    assetKey: string;
  }): Promise<{ asset_key: string; raw: any }> {
    const data = await this.request(
      "POST",
      `/mcp/documents/by-path/assets/${encodeURIComponent(args.assetKey)}/complete`,
      { query: { path: args.path } },
    );
    return { asset_key: data?.asset_key ?? args.assetKey, raw: data };
  }
}
