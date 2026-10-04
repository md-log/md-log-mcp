/**
 * md-log-mcp — shared tool/server builder (transport-agnostic).
 *
 * `buildServer(client, opts)` registers all 17 tools on a fresh `McpServer` and
 * is reused by BOTH entrypoints: the stdio bootstrap (`server.ts`) and the
 * remote Streamable HTTP bootstrap (`http.ts`). This module has NO top-level
 * side effects (no transport, no process bootstrap) so either entry can import
 * it without accidentally starting the other.
 *
 * A THIN authenticated HTTP client over the hosted md-log service.
 * No business logic lives here: path validation + asset orchestration +
 * error mapping only; the backend is the single authority for auth, storage,
 * versioning and quota.
 *
 * Every tool:
 *   - validates the POSIX path BEFORE any backend call,
 *   - returns dual output: human-readable `content[].text` + machine-readable
 *     `structuredContent`,
 *   - surfaces backend failures as `{ isError: true, content:[{type:text,...}] }`
 *     carrying the mapped agent error code so the model can react.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MdlogClient, MdlogError, sha256Hex } from "./client.js";
import { afterConcurrentWrite, applyLiteralEdits, MAX_EDITS, resolveEdits } from "./edit.js";
import { replaceAllLiteral, validatePath } from "./path.js";

/** Options that vary the tool surface per transport. */
export interface BuildServerOptions {
  /**
   * Whether the `file_path` asset source (reading an image off the LOCAL disk)
   * is allowed. True for the stdio server (runs on the user's machine); MUST be
   * false for the remote HTTP server, where `file_path` would read the SERVER's
   * filesystem — a confused-deputy / local-file-read vector. Default true.
   */
  allowLocalFiles?: boolean;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function fail(err: unknown): ToolResult {
  if (err instanceof MdlogError) {
    return {
      isError: true,
      content: [{ type: "text", text: `[${err.code}] ${err.message}` }],
      structuredContent: {
        error: {
          code: err.code,
          server_code: err.serverCode ?? null,
          http_status: err.status ?? null,
          detail: err.detail ?? null,
          message: err.message,
        },
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `[ERROR] ${message}` }],
    structuredContent: { error: { code: "ERROR", message } },
  };
}

function folderKeyOf(folder: any): string | undefined {
  return folder?.folder_key ?? folder?.key ?? folder?.id;
}

// ---------------------------------------------------------------------------
// Asset upload orchestration (reserve -> presigned PUT -> complete)
// ---------------------------------------------------------------------------

interface AssetInput {
  // Both optional at the type level: exactly one of data_base64 / file_path must be provided, and
  // filename/content_type may be inferred from a file_path. resolveAssetBytes normalizes all four.
  filename?: string;
  content_type?: string;
  data_base64?: string;
  file_path?: string;
}

// Mirror the service's 10 MiB asset-size limit: reject an oversized file_path up front so
// it fails fast locally instead of buffering the whole file into memory only to be rejected at reserve.
const MAX_ASSET_BYTES = 10 * 1024 * 1024;

// Extension -> MIME for file_path uploads whose content_type is omitted. Raster-only, mirroring the
// service's allowed-image-type allowlist (no svg/bmp — those would be rejected at reserve).
const EXT_CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

// M-11: the raster allowlist the effective content_type MUST belong to (mirrors the backend's
// ALLOWED_IMAGE_TYPES). An explicit content_type must not bypass the extension-inferred allowlist.
const ALLOWED_IMAGE_TYPES = new Set(Object.values(EXT_CONTENT_TYPE));

/**
 * M-11: verify the bytes actually START with a known raster-image signature. This is the primary defense
 * against the confused-deputy exfil vector — a prompt-injected agent uploading `~/.ssh/id_rsa` or a `.env`
 * with `content_type:"image/png"` — because those files are not image bytes and never match a signature,
 * regardless of the declared type or path. Only genuine images (the intended use) pass.
 */
function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  const b = bytes;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true;
  // WEBP: "RIFF"...."WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;
  // AVIF: ....'ftyp' with an 'avif'/'avis' major brand
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = b.toString("latin1", 8, 12);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

/**
 * M-11 (opt-in): when MDLOG_ASSET_ROOT is set, a `file_path` upload must resolve (after symlink resolution)
 * INSIDE that root — a defense-in-depth sandbox on top of the magic-byte check. Unset = no path restriction
 * (the magic-byte check still blocks non-image exfil).
 */
async function assertFilePathAllowed(fp: string): Promise<void> {
  const rootEnv = process.env.MDLOG_ASSET_ROOT?.trim();
  if (!rootEnv) return;
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(resolve(rootEnv));
    realTarget = await realpath(fp);
  } catch (err) {
    throw new MdlogError("VALIDATION", `cannot resolve asset path "${fp}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const rel = relative(realRoot, realTarget);
  if (rel === "" || rel.startsWith("..") || (rel.length > 1 && rel[1] === ":")) {
    throw new MdlogError(
      "VALIDATION",
      `asset file "${fp}" is outside the allowed MDLOG_ASSET_ROOT ("${rootEnv}").`,
    );
  }
}

/**
 * Resolve an asset's raw bytes + effective filename/content_type from EITHER an inline base64 payload
 * (`data_base64`) OR a local `file_path`. Exactly one source must be given. When a file path is used,
 * a missing filename defaults to the file's basename and a missing content_type is inferred from its
 * extension. Throws VALIDATION on: neither/both sources, unreadable file, empty bytes, or an
 * unresolved filename/content_type.
 */
async function resolveAssetBytes(
  asset: AssetInput,
  allowLocalFiles: boolean,
): Promise<{ filename: string; contentType: string; bytes: Buffer }> {
  const hasB64 = typeof asset.data_base64 === "string" && asset.data_base64.length > 0;
  const hasPath = typeof asset.file_path === "string" && asset.file_path.length > 0;
  if (hasB64 === hasPath) {
    throw new MdlogError(
      "VALIDATION",
      "provide exactly one of `data_base64` or `file_path` for the asset (got " +
        (hasB64 ? "both" : "neither") +
        ").",
    );
  }
  // Remote HTTP transport: a `file_path` would read the SERVER's disk, not the caller's — refuse it
  // so the only remote image source is inline `data_base64`. (On stdio the server IS the user's machine,
  // so local files are the intended, safe path.)
  if (hasPath && !allowLocalFiles) {
    throw new MdlogError(
      "VALIDATION",
      "`file_path` is not supported over the remote HTTP transport (it would read the server's " +
        "filesystem). Provide the image inline as `data_base64` instead.",
    );
  }

  const label = asset.filename ?? (hasPath ? basename(asset.file_path as string) : "(asset)");

  let bytes: Buffer;
  let filenameFallback: string | undefined;
  let contentTypeFallback: string | undefined;

  if (hasPath) {
    const fp = asset.file_path as string;
    // Guard BEFORE reading. `stat` (symlink-following) returns immediately even for a FIFO, so we can
    // reject anything that isn't a regular file — a pipe/char-device path such as '/dev/zero' or the
    // stdio JSON-RPC channel itself would otherwise hang `readFile` forever or balloon memory to ~2GB
    // before erroring — and reject an oversized file up front instead of buffering it all locally.
    // All of these collapse into the same clean VALIDATION error the base64 path already yields.
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(fp);
    } catch (err) {
      throw new MdlogError(
        "VALIDATION",
        `cannot read asset file "${fp}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!st.isFile()) {
      throw new MdlogError(
        "VALIDATION",
        `asset file "${fp}" is not a regular file (got a directory, device, or pipe).`,
      );
    }
    if (st.size > MAX_ASSET_BYTES) {
      throw new MdlogError(
        "VALIDATION",
        `asset file "${fp}" is ${st.size} bytes, over the ${MAX_ASSET_BYTES}-byte (10 MiB) limit.`,
      );
    }
    await assertFilePathAllowed(fp); // M-11: opt-in MDLOG_ASSET_ROOT containment (symlink-resolved)
    try {
      bytes = await readFile(fp);
    } catch (err) {
      throw new MdlogError(
        "VALIDATION",
        `cannot read asset file "${fp}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    filenameFallback = basename(fp);
    contentTypeFallback = EXT_CONTENT_TYPE[extname(fp).toLowerCase()];
  } else {
    // #80: Node's base64 decoder silently SKIPS invalid characters, so a full data: URI or an accidental
    // whitespace/prefix would decode to corrupted bytes and store a broken asset with a success response.
    // Strip an explicit data-URI prefix, then reject anything that isn't canonical base64 before decoding.
    const raw = (asset.data_base64 as string).replace(/^data:[^;,]*;base64,/, "").trim();
    // I-7: accept canonical base64 with OR without '=' padding — some encoders emit unpadded output that
    // Buffer.from decodes faithfully; the old `length % 4 !== 0` clause wrongly rejected it. Reject only
    // non-base64 characters and the impossible length (mod 4 === 1), then re-pad so decoding is exact.
    // Strip the padding by scanning back from the end — NOT /=+$/, which backtracks quadratically over a
    // long run of '=' that is not at the end ("="x40000 + "x" took 0.6 s; a multi-MB payload, hours).
    let end = raw.length;
    while (end > 0 && raw.charCodeAt(end - 1) === 0x3d /* '=' */) end--;
    const stripped = raw.slice(0, end);
    if (!/^[A-Za-z0-9+/]*$/.test(stripped) || stripped.length % 4 === 1) {
      throw new MdlogError(
        "VALIDATION",
        `asset "${label}" is not valid base64 (pass raw base64 bytes, not a data: URI or text).`,
      );
    }
    const b64 = stripped + "=".repeat((4 - (stripped.length % 4)) % 4);
    bytes = Buffer.from(b64, "base64");
  }

  if (bytes.length === 0) {
    throw new MdlogError("VALIDATION", `asset "${label}" resolved to zero bytes.`);
  }

  const filename = asset.filename ?? filenameFallback;
  if (!filename) {
    throw new MdlogError("VALIDATION", "asset filename is required (could not be inferred).");
  }
  const contentType = asset.content_type ?? contentTypeFallback;
  if (!contentType) {
    throw new MdlogError(
      "VALIDATION",
      `content_type is required for asset "${filename}" (could not infer from its extension).`,
    );
  }
  // M-11: an explicit content_type must not bypass the raster allowlist, AND the bytes must actually be a
  // raster image. Together these stop a confused-deputy from exfiltrating arbitrary local files (SSH keys,
  // .env, ...) by mislabeling them as image/png.
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new MdlogError(
      "VALIDATION",
      `content_type "${contentType}" is not an allowed image type for asset "${filename}" ` +
        `(allowed: ${[...ALLOWED_IMAGE_TYPES].join(", ")}).`,
    );
  }
  if (!looksLikeImage(bytes)) {
    throw new MdlogError(
      "VALIDATION",
      `asset "${filename}" is not a recognizable raster image (magic-byte check failed) — only genuine ` +
        `image files can be uploaded as assets.`,
    );
  }

  return { filename, contentType, bytes };
}

async function uploadOneAsset(
  client: MdlogClient,
  docPath: string,
  asset: AssetInput,
  allowLocalFiles: boolean,
): Promise<string> {
  const { filename, contentType, bytes } = await resolveAssetBytes(asset, allowLocalFiles);
  const checksum = sha256Hex(bytes);

  const reservation = await client.reserveAsset({
    path: docPath,
    filename,
    contentType,
    size: bytes.length,
    checksum,
  });
  if (!reservation.asset_key) {
    throw new MdlogError(
      "BACKEND_UNAVAILABLE",
      "Asset reserve response did not include an asset_key.",
      { detail: reservation.raw },
    );
  }

  await client.putBytes(reservation.upload_url, bytes, contentType, reservation.headers);

  const completed = await client.completeAsset({
    path: docPath,
    assetKey: reservation.asset_key,
  });

  return completed.asset_key;
}

/**
 * Ensure a folder path exists (mkdir -p): walk each segment, creating missing ones; duplicate races
 * are treated as success. Returns the leaf folder key, or undefined for the root (no segments).
 * Shared by create_folder, save-time ensure, and the move tools' destination handling.
 */
async function ensureFolderPath(
  client: MdlogClient,
  segments: string[],
): Promise<{ folderKey: string | undefined; createdSegments: string[] }> {
  let parentKey: string | undefined;
  let accum = "";
  const createdSegments: string[] = [];
  for (const name of segments) {
    accum = accum ? `${accum}/${name}` : name;
    const existing = await client.resolveFolder(accum);
    if (existing) {
      parentKey = folderKeyOf(existing);
      continue;
    }
    try {
      const folder = await client.createFolderSegment({ parentKey, name });
      parentKey = folderKeyOf(folder);
      createdSegments.push(accum);
    } catch (err) {
      // Duplicate (race or pre-existing) is success — re-resolve to get its key.
      if (err instanceof MdlogError && err.code === "FOLDER_EXISTS") {
        const again = await client.resolveFolder(accum);
        const againKey = folderKeyOf(again);
        // H14: if the re-resolve can't find it (a case-only-differing sibling exists — create was
        // case-INSENSITIVE but resolve was case-SENSITIVE), do NOT fall through with parentKey=undefined,
        // which would silently create/move the rest of the path at ROOT and report false success. Fail
        // loudly so the agent (and the human reviewer) know the target casing is ambiguous.
        if (!againKey) {
          throw new MdlogError(
            "VALIDATION",
            `A folder named "${name}" already exists here with different casing; ` +
              `use the existing folder's exact name in the path`,
          );
        }
        parentKey = againKey;
      } else {
        throw err;
      }
    }
  }
  return { folderKey: parentKey, createdSegments };
}

/**
 * Turn the backend's terse cross-scope rejection into actionable guidance. A shared subtree is
 * single-owner/single-org, so the server refuses to reparent a document/folder across share scopes
 * (out of a shared folder/team into private space, or vice-versa) with MDLOG_DOC_0008 / MDLOG_FLD_0008.
 * The raw message ("Cannot move a shared document out of its shared folder/team") is correct but doesn't
 * say WHY or WHAT to do, so we rewrite it; every other error passes through untouched.
 */
function explainCrossScopeMove(err: unknown, fromPath: string, toPath: string): unknown {
  if (
    err instanceof MdlogError &&
    (err.serverCode === "MDLOG_DOC_0008" || err.serverCode === "MDLOG_FLD_0008")
  ) {
    return new MdlogError(
      "VALIDATION",
      `Cannot move "${fromPath}" to "${toPath}": the source and destination are in different share ` +
        `scopes — one lives inside a shared folder/team and the other in your private space. A shared ` +
        `subtree is single-owner, so an item can only be moved WITHIN the same shared folder or entirely ` +
        `within your private space. To relocate across scopes, first unshare the source folder (or share ` +
        `the destination into the same team), then move; otherwise re-create the file at the destination.`,
      { serverCode: err.serverCode, status: err.status, detail: err.detail },
    );
  }
  return err;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const filePathField = z
  .string()
  .min(1)
  .describe("POSIX path to the .md file, e.g. 'reports/2026/error-report.md'. Folders auto-created.");

const folderPathField = z
  .string()
  .min(1)
  .describe("POSIX folder path, e.g. 'reports/2026'. No '.md' suffix.");

// L-12: list_files documents passing '' (or '/') to list the ROOT. The shared folderPathField's
// .min(1) rejects '' even when .optional() (which only short-circuits undefined), so the documented
// empty-string call errored before reaching the root branch. This field accepts '' / omitted / '/'.
const listFolderPathField = z
  .string()
  .optional()
  .describe("POSIX folder path, e.g. 'reports/2026'. Omit or pass '' / '/' to list the ROOT folder.");

const embeddedAssetSchema = z
  .object({
    placeholder: z
      .string()
      .min(1)
      .describe(
        "Exact text in `content` to replace with the uploaded 'asset://<key>' reference " +
          "(e.g. the temporary filename or URL you used in the markdown image).",
      ),
    filename: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Original file name (content-type/extension hint). Optional when `file_path` is given " +
          "(defaults to the file's basename).",
      ),
    content_type: z
      .string()
      .min(1)
      .optional()
      .describe(
        "MIME type, e.g. 'image/png'. Optional when `file_path` is given and the extension is " +
          "recognized (png/jpg/jpeg/gif/webp/avif).",
      ),
    data_base64: z
      .string()
      .min(1)
      .optional()
      .describe("Base64-encoded raw image bytes. Provide EITHER this OR `file_path`, not both."),
    file_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute or relative local filesystem path to the image file to read and upload. " +
          "Provide EITHER this OR `data_base64`, not both.",
      ),
  })
  .refine((a) => Boolean(a.data_base64) !== Boolean(a.file_path), {
    message: "provide exactly one of `data_base64` or `file_path` for the asset",
  });

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function buildServer(client: MdlogClient, opts: BuildServerOptions = {}): McpServer {
  const allowLocalFiles = opts.allowLocalFiles ?? true;
  const server = new McpServer({
    name: "md-log-mcp",
    version: "1.0.0",
  });

  // --- save_markdown (headline) -----------------------------------------
  server.registerTool(
    "save_markdown",
    {
      title: "Save Markdown",
      description:
        "Save (create or overwrite) a .md file in md-log by path; missing folders are " +
        "auto-created. Optionally upload embedded images as assets first and rewrite their refs " +
        "to asset:// links. This is a force-write (last-writer-wins) — the headline agent tool. " +
        "Before choosing a path, PREFER an existing folder that already holds related documents and " +
        "reuse its exact spelling — do not invent a new casing or separator (e.g. don't save to " +
        "'MdLog/…' when 'md-log/…' already exists). Call list_folders / list_files first if unsure. " +
        "(The server also auto-reuses a unique near-duplicate folder, but consistent spelling keeps paths clean.)",
      inputSchema: {
        path: filePathField,
        content: z.string().describe("Full markdown content of the file."),
        assets: z
          .array(embeddedAssetSchema)
          .optional()
          .describe(
            "Embedded images to upload before saving. Each is uploaded, then its `placeholder` " +
              "in `content` is replaced with the resulting asset:// reference.",
          ),
        commit_message: z
          .string()
          .max(500)
          .optional()
          .describe(
            "A concise 1-2 line summary of WHAT changed in this version and WHY, written for a " +
              "human reviewer scanning the version history (it is stored on the version and shown " +
              "next to it on web & mobile). ALWAYS provide this — summarize the change yourself " +
              "(e.g. 'Reworked the retention job to batch-delete expired blobs; fixes slow GC'). " +
              "For a brand-new file, briefly state what the document is.",
          ),
      },
    },
    async ({ path, content, assets, commit_message }): Promise<ToolResult> => {
      try {
        const norm = validatePath(path, { requireMd: true });
        let finalContent = content;
        const uploaded: { placeholder: string; asset_key: string; ref: string }[] = [];
        /** Placeholders that never appeared in the content — uploaded but unreferenced. */
        const unmatched: string[] = [];

        if (assets && assets.length > 0) {
          // H15: assets are reserved against an EXISTING document (the backend resolves the doc by path
          // at reserve time). For a brand-new file the reserve 404s, so create the doc first with the raw
          // content (placeholders intact); then upload the assets and re-save the rewritten content below.
          // Only a genuine NOT_FOUND means "brand-new file". Swallowing everything (401/429/5xx/timeout)
          // made a transient backend hiccup read as "does not exist", so the pre-create below force-wrote
          // the raw placeholder content over an EXISTING document — adding a junk intermediate version to
          // its history. Mirrors the NOT_FOUND-only handling move_markdown already uses.
          const existing = await client.getByPath(norm.path).catch((e: unknown) => {
            if (e instanceof MdlogError && e.code === "NOT_FOUND") return null;
            throw e;
          });
          if (!existing) {
            await client.putByPath({
              path: norm.path,
              content,
              commitMessage: commit_message,
            });
          }
          for (const asset of assets) {
            const assetKey = await uploadOneAsset(client, norm.path, asset, allowLocalFiles);
            const ref = `asset://${assetKey}`;
            // replaceAllLiteral is a silent no-op when the placeholder isn't in `content`: the asset
            // still uploads and still counts against the owner's quota, but nothing in the document
            // ever references it. Detect that and report it rather than leaving a silent orphan.
            const beforeReplace = finalContent;
            finalContent = replaceAllLiteral(finalContent, asset.placeholder, ref);
            if (finalContent === beforeReplace) unmatched.push(asset.placeholder);
            uploaded.push({ placeholder: asset.placeholder, asset_key: assetKey, ref });
          }
        }

        const data = await client.putByPath({
          path: norm.path,
          content: finalContent,
          commitMessage: commit_message,
        });

        const documentKey: string | undefined = data?.document_key ?? data?.key;
        const versionNo = data?.current_version_no;
        const created = data?.created;

        const lines = [
          `${created ? "Created" : "Saved"} "${norm.path}" (version ${versionNo ?? "?"}).`,
        ];
        if (uploaded.length > 0) {
          lines.push(`Uploaded ${uploaded.length} asset(s): ${uploaded.map((u) => u.ref).join(", ")}.`);
        }
        if (unmatched.length > 0) {
          lines.push(
            `WARNING: ${unmatched.length} placeholder(s) were not found in the content, so those ` +
              `assets are uploaded but UNREFERENCED: ${unmatched.join(", ")}.`,
          );
        }

        return ok(lines.join(" "), {
          path: norm.path,
          document_key: documentKey ?? null,
          current_version_no: versionNo ?? null,
          created: created ?? null,
          checksum_sha256: data?.checksum_sha256 ?? null,
          assets: uploaded,
          unmatched_placeholders: unmatched,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- upload_asset ------------------------------------------------------
  server.registerTool(
    "upload_asset",
    {
      title: "Upload Asset",
      description:
        "Upload a single image as an asset (reserve -> presigned PUT -> complete) and return an " +
        "'asset://<key>' reference you can embed in markdown image syntax: ![alt](asset://<key>). " +
        "Provide the image as EITHER `data_base64` (inline base64) OR `file_path` (a local file to " +
        "read) — exactly one.",
      inputSchema: {
        path: filePathField.describe(
          "The .md document path this asset is associated with (used for quota/scoping).",
        ),
        filename: z
          .string()
          .min(1)
          .optional()
          .describe("Original file name. Optional with `file_path` (defaults to its basename)."),
        content_type: z
          .string()
          .min(1)
          .optional()
          .describe(
            "MIME type, e.g. 'image/png'. Optional with `file_path` when the extension is " +
              "recognized (png/jpg/jpeg/gif/webp/avif).",
          ),
        data_base64: z
          .string()
          .min(1)
          .optional()
          .describe("Base64-encoded raw image bytes. Provide EITHER this OR `file_path`, not both."),
        file_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Absolute or relative local filesystem path to the image file to read and upload. " +
              "Provide EITHER this OR `data_base64`, not both.",
          ),
      },
    },
    async ({ path, filename, content_type, data_base64, file_path }): Promise<ToolResult> => {
      try {
        const norm = validatePath(path, { requireMd: true });
        const assetKey = await uploadOneAsset(client, norm.path, {
          filename,
          content_type,
          data_base64,
          file_path,
        }, allowLocalFiles);
        const ref = `asset://${assetKey}`;
        const displayName = filename ?? (file_path ? basename(file_path) : "image");
        return ok(`Uploaded asset. Embed it with: ![${displayName}](${ref})`, {
          asset_key: assetKey,
          ref,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- append_to_markdown -----------------------------------------------
  server.registerTool(
    "append_to_markdown",
    {
      title: "Append to Markdown",
      description:
        "Append content to the end of an existing .md file using optimistic concurrency " +
        "(GET current -> concat -> PUT with base_version_no). Auto-retries once on conflict, " +
        "then surfaces CONFLICT.",
      inputSchema: {
        path: filePathField,
        content: z.string().describe("Markdown to append. A newline separator is inserted if needed."),
        commit_message: z
          .string()
          .max(500)
          .optional()
          .describe(
            "A concise 1-2 line summary of WHAT you appended and WHY, written for a human reviewer " +
              "scanning the version history (stored on the new version, shown next to it on web & " +
              "mobile). ALWAYS provide this — summarize the appended change yourself " +
              "(e.g. 'Added the 2026-07 rollback postmortem section').",
          ),
      },
    },
    async ({ path, content, commit_message }): Promise<ToolResult> => {
      try {
        // #79: validate INSIDE the try so a path error returns the structured error contract like every
        // other tool, instead of escaping as an unwrapped throw.
        const norm = validatePath(path, { requireMd: true });
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const doc = await client.getByPath(norm.path);
            const existing = await client.materializeContent(doc);
            const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
            const merged = `${existing}${separator}${content}`;
            const baseVersionNo: number | undefined = doc?.current_version_no;

            const data = await client.putByPath({
              path: norm.path,
              content: merged,
              baseVersionNo,
              commitMessage: commit_message,
            });

            return ok(
              `Appended to "${norm.path}" (now version ${data?.current_version_no ?? "?"}).`,
              {
                path: norm.path,
                document_key: data?.document_key ?? null,
                current_version_no: data?.current_version_no ?? null,
                checksum_sha256: data?.checksum_sha256 ?? null,
              },
            );
          } catch (err) {
            if (err instanceof MdlogError && err.code === "CONFLICT" && attempt < 1) {
              attempt++;
              continue;
            }
            return fail(err);
          }
        }
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- edit_markdown (targeted literal replace) -------------------------
  server.registerTool(
    "edit_markdown",
    {
      title: "Edit Markdown",
      description:
        "Change PART of an existing .md file by replacing exact literal strings. USE THIS, NOT " +
        "update_markdown, for any partial change — a fixed line, a corrected table row, a reworded " +
        "paragraph, an added section under a heading. update_markdown requires the ENTIRE new " +
        "document, so using it for a small change means regenerating text you never meant to touch " +
        "and risks silently rewriting the rest of the report. Read the file with get_markdown first " +
        "and copy each `old_string` VERBATIM out of it, including indentation, punctuation and any " +
        "blank lines. SEVERAL CHANGES TO ONE FILE? Send them together in ONE call via `edits` " +
        "(an ordered list of {old_string, new_string, replace_all?}) with one commit_message: every " +
        "call writes a new version AND notifies the user's devices, so one call per change floods " +
        "their history and their phone. For a single change you may pass old_string/new_string " +
        "directly instead of `edits` (never both). Edits apply in order, each against the text the " +
        "previous ones produced. Each `old_string` must match EXACTLY ONCE — overlapping positions count, " +
        "so \"\\n\\n\" inside a run of three newlines is ambiguous: zero matches, or more " +
        "than once while replace_all is false, REJECTS THE WHOLE CALL and NOTHING is written " +
        "(detail.edit_index names the failing edit) — extend that `old_string` with neighbouring " +
        "lines until it is unique, or set replace_all:true to change every occurrence on purpose. " +
        "The write is always optimistic: the version just read is the base, so a concurrent write is " +
        "retried once (re-read, all edits re-applied) and then surfaces CONFLICT — there is no force " +
        "mode. The file must already exist; this tool never creates one (use save_markdown for a new " +
        "file). Because every edit is based on the version it just read, a file deleted out from " +
        "under you is rejected rather than silently re-created.",
      inputSchema: {
        path: filePathField,
        // The count/emptiness limits live in resolveEdits, NOT in this schema: a zod rejection surfaces
        // as a bare -32602 protocol error with no structuredContent, so the agent would never receive
        // the documented VALIDATION detail.reason (EMPTY_EDITS, TOO_MANY_EDITS, EMPTY_OLD_STRING).
        edits: z
          .array(
            z.object({
              old_string: z.string().describe("EXACT literal text to find (see old_string). Non-empty."),
              new_string: z.string().describe("Literal replacement; empty string deletes the match."),
              replace_all: z
                .boolean()
                .optional()
                .describe("Replace every occurrence of this old_string instead of exactly one."),
            }),
          )
          .optional()
          .describe(
            `Ordered list of literal edits applied in ONE write (one version, one notification), ` +
              `all-or-nothing. Prefer this whenever you change a file in more than one place. ` +
              `At most ${MAX_EDITS} edits. Do not combine with top-level old_string/new_string.`,
          ),
        old_string: z
          .string()
          .optional()
          .describe(
            "Single-edit shorthand. The EXACT, non-empty literal text to find in the current document — not a " +
              "regex, not a pattern, no wildcards. Copy it verbatim from get_markdown output; " +
              "whitespace and line breaks must match. Must occur exactly once unless replace_all is " +
              "true. Omit when using `edits`.",
          ),
        new_string: z
          .string()
          .optional()
          .describe(
            "Single-edit shorthand. The literal text to put in its place, inserted as-is (no " +
              "escaping, no '$' substitution). Pass an empty string to DELETE the matched text. " +
              "Omit when using `edits`.",
          ),
        replace_all: z
          .boolean()
          .optional()
          .describe(
            "Single-edit shorthand. Opt in to replacing EVERY occurrence of `old_string` (e.g. " +
              "renaming a term throughout the document). Default false = exactly one occurrence is " +
              "required, otherwise the edit is rejected without writing.",
          ),
        commit_message: z
          .string()
          .max(500)
          .optional()
          .describe(
            "A concise 1-2 line summary of WHAT you changed and WHY, written for a human reviewer " +
              "scanning the version history (stored on the new version, shown next to it on web & " +
              "mobile). ALWAYS provide this — with several edits, summarize them together (e.g. " +
              "'Fixed the JWT TTL row (30d -> 14d) and updated the rollout conclusion').",
          ),
      },
    },
    async ({ path, edits, old_string, new_string, replace_all, commit_message }): Promise<ToolResult> => {
      try {
        // #79: validate INSIDE the try so a path error returns the structured error contract.
        const norm = validatePath(path, { requireMd: true });
        // Resolved once, before any read: an invalid input shape must never cost a backend round-trip.
        const plan = resolveEdits({ edits, old_string, new_string, replace_all }, norm.path);
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            // getByPath THROWS NOT_FOUND for a missing document and that MUST propagate untouched —
            // an edit never falls through to a create. (Contrast save_markdown/move_markdown, which
            // deliberately swallow NOT_FOUND here; doing that would upsert a one-line file over a
            // path the caller believed already held a report.) It sits INSIDE the loop so a CONFLICT
            // retry genuinely re-reads and re-bases, exactly like append_to_markdown.
            const doc = await client.getByPath(norm.path);
            const existing = await client.materializeContent(doc);

            // Occurrence safety: every edit is counted and applied IN MEMORY before anything is
            // written; any 0-match or ambiguous >1 aborts the whole call with NO mutation (all-or-
            // nothing). applyLiteralEdits throws VALIDATION — never NOT_FOUND (the model would fall back
            // to the force-writing save_markdown) and never CONFLICT (the retry below would swallow
            // it). `detail.reason` / `detail.edit_index` reach structuredContent.error.detail via fail().
            const applied = applyLiteralEdits(existing, plan, norm.path);

            const baseVersionNo: unknown = doc?.current_version_no;
            // Never let a missing version degrade this into a force-overwrite: putByPath omits
            // base_version_no when it is undefined, and the backend reads an omitted base_version_no
            // as "force LWW" (McpUpsertReq#baseVersionNo, DocumentServiceImpl.saveContent). That silent
            // degradation is exactly why edit_markdown exposes no expected_version at all.
            if (typeof baseVersionNo !== "number") {
              throw new MdlogError(
                "BACKEND_UNAVAILABLE",
                `The backend did not report a current version for "${norm.path}", so this edit cannot be ` +
                  `applied safely (it would degrade to a force-overwrite). Nothing was written.`,
                { detail: doc ?? null },
              );
            }

            // ONE write for the whole batch: one version, one push, one inbox row per recipient.
            const data = await client.putByPath({
              path: norm.path,
              content: applied.content,
              baseVersionNo,
              commitMessage: commit_message,
              // The document — and therefore its folder — already exists; an edit must never
              // re-create a folder tree that vanished between the read and the write.
              createFolders: false,
            });

            const replaced = applied.results.reduce((sum, r) => sum + r.replaced, 0);
            const first = applied.results[0];
            return ok(
              `Edited "${norm.path}": applied ${applied.results.length} edit(s), replacing ${replaced} ` +
                `occurrence(s), in one write (now version ${data?.current_version_no ?? "?"}).`,
              {
                path: norm.path,
                document_key: data?.document_key ?? null,
                current_version_no: data?.current_version_no ?? null,
                base_version_no: baseVersionNo,
                checksum_sha256: data?.checksum_sha256 ?? null,
                edit_count: applied.results.length,
                replaced,
                edits: applied.results,
                // Single-edit fields kept for callers written before batch mode (<= 1.2.0).
                occurrences: first?.occurrences ?? 0,
                replace_all: first?.replace_all ?? false,
              },
            );
          } catch (err) {
            // Only CONFLICT is retried, and only once: re-read, re-apply every edit, re-base. A
            // NO_MATCH / AMBIGUOUS_MATCH is deliberately NOT retryable — re-reading cannot resolve it,
            // and if the re-read after a real conflict no longer contains an old_string the caller is
            // told so — including that a concurrent write is why — instead of having a stale edit
            // applied blind.
            if (err instanceof MdlogError && err.code === "CONFLICT" && attempt < 1) {
              attempt++;
              continue;
            }
            return fail(attempt > 0 ? afterConcurrentWrite(err) : err);
          }
        }
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- update_markdown ---------------------------------------------------
  server.registerTool(
    "update_markdown",
    {
      title: "Update Markdown",
      description:
        "Replace the ENTIRE content of an existing .md file. For a PARTIAL change — a line, a row, a " +
        "paragraph — use edit_markdown instead: it replaces one exact string in place, so you never " +
        "regenerate (and never accidentally rewrite) the rest of the document. Reach for this tool " +
        "only when you are genuinely rewriting the whole file. Pass expected_version for optimistic " +
        "concurrency (mismatch -> CONFLICT); omit it to force last-writer-wins. If you pass " +
        "expected_version for a path that does not exist you get CONFLICT (detail.server_version_no " +
        "is 0), not a new file — use save_markdown to create.",
      inputSchema: {
        path: filePathField,
        content: z.string().describe("New full markdown content."),
        expected_version: z
          .number()
          .int()
          // Match get_markdown's `version`: version numbers start at 1, so 0/-1 is a client bug that
          // should be rejected here rather than sent to the backend as a base_version_no.
          .min(1)
          .optional()
          .describe("Version you based your edit on. Omit to force-overwrite (LWW)."),
        commit_message: z
          .string()
          .max(500)
          .optional()
          .describe(
            "A concise 1-2 line summary of WHAT changed in this version and WHY, written for a " +
              "human reviewer scanning the version history (stored on the version, shown next to " +
              "it on web & mobile). ALWAYS provide this — diff the old and new content in your head " +
              "and summarize the change yourself (e.g. 'Corrected the JWT TTL table and added the " +
              "tablet 90d refresh note').",
          ),
      },
    },
    async ({ path, content, expected_version, commit_message }): Promise<ToolResult> => {
      try {
        const norm = validatePath(path, { requireMd: true });
        const data = await client.putByPath({
          path: norm.path,
          content,
          baseVersionNo: expected_version,
          commitMessage: commit_message,
        });
        return ok(`Updated "${norm.path}" (now version ${data?.current_version_no ?? "?"}).`, {
          path: norm.path,
          document_key: data?.document_key ?? null,
          current_version_no: data?.current_version_no ?? null,
          checksum_sha256: data?.checksum_sha256 ?? null,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- get_markdown ------------------------------------------------------
  server.registerTool(
    "get_markdown",
    {
      title: "Get Markdown",
      description:
        "Read a .md file's content by path. Pass `version` (a version_no from list_versions) to " +
        "read an OLD immutable version instead of the current one.",
      inputSchema: {
        path: filePathField,
        version: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Version number to read (see list_versions). Omit for the current version."),
      },
    },
    async ({ path, version }): Promise<ToolResult> => {
      try {
        const norm = validatePath(path, { requireMd: true });
        const doc = await client.getByPath(norm.path);
        const documentKey: string | undefined = doc?.document_key ?? doc?.key;
        const currentVersionNo: number | null = doc?.current_version_no ?? null;

        // Old version: fetch that version's body via the key-based content endpoint.
        if (version !== undefined && version !== currentVersionNo) {
          if (!documentKey) {
            throw new MdlogError("NOT_FOUND", `Could not resolve a document key for "${norm.path}".`);
          }
          const versioned = await client.getContentByKey(documentKey, version);
          const content = await client.materializeContent(versioned);
          return ok(content, {
            path: norm.path,
            document_key: documentKey,
            version_no: versioned?.version_no ?? version,
            current_version_no: currentVersionNo,
            checksum_sha256: versioned?.checksum_sha256 ?? null,
            content,
          });
        }

        const content = await client.materializeContent(doc);
        return ok(content, {
          path: norm.path,
          document_key: documentKey ?? null,
          version_no: currentVersionNo,
          current_version_no: currentVersionNo,
          checksum_sha256: doc?.checksum_sha256 ?? null,
          content,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- list_versions -------------------------------------------------------
  server.registerTool(
    "list_versions",
    {
      title: "List Versions",
      description:
        "List a .md file's immutable version history, newest first (version_no, commit_message, " +
        "author, registered_at, size). Read an old version's content with get_markdown + `version`.",
      inputSchema: { path: filePathField },
    },
    async ({ path }): Promise<ToolResult> => {
      try {
        const norm = validatePath(path, { requireMd: true });
        const doc = await client.getByPath(norm.path);
        const documentKey: string | undefined = doc?.document_key ?? doc?.key;
        if (!documentKey) {
          throw new MdlogError("NOT_FOUND", `Could not resolve a document key for "${norm.path}".`);
        }
        const versions = await client.listVersions(documentKey);
        const count = Array.isArray(versions) ? versions.length : 0;
        return ok(
          `"${norm.path}" has ${count} version(s); current is v${doc?.current_version_no ?? "?"}.`,
          {
            path: norm.path,
            document_key: documentKey,
            current_version_no: doc?.current_version_no ?? null,
            versions,
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- restore_version -----------------------------------------------------
  server.registerTool(
    "restore_version",
    {
      title: "Restore Version",
      description:
        "Roll a .md file back to an earlier version: version N's exact stored content becomes a NEW " +
        "current version. History is immutable — nothing is deleted or rewound, the rollback is just " +
        "another version on top, so it is itself undoable by restoring again. Use this after a bad " +
        "write instead of retyping the old text through save_markdown, which would guess at the " +
        "content and lose fidelity. Get version numbers from list_versions (and read one first with " +
        "get_markdown + `version` if you want to check before rolling back). Restoring the version the " +
        "file is already on is accepted and does nothing.",
      inputSchema: {
        path: filePathField,
        version: z
          .number()
          .int()
          .min(1)
          .describe(
            "The version_no to restore, from list_versions. Its content becomes the new current version.",
          ),
        commit_message: z
          .string()
          .max(500)
          .optional()
          .describe(
            "A concise 1-2 line summary of WHY you are rolling back, written for a human reviewer " +
              "scanning the version history (stored on the new version, shown next to it on web & " +
              "mobile). ALWAYS provide this (e.g. 'Reverted to v7: the v8 rewrite dropped the incident " +
              "timeline').",
          ),
      },
    },
    async ({ path, version, commit_message }): Promise<ToolResult> => {
      try {
        const norm = validatePath(path, { requireMd: true });
        const doc = await client.getByPath(norm.path);
        const documentKey: string | undefined = doc?.document_key ?? doc?.key;
        if (!documentKey) {
          throw new MdlogError("NOT_FOUND", `Could not resolve a document key for "${norm.path}".`);
        }
        const currentVersionNo: number | null = doc?.current_version_no ?? null;
        // Fast, local pre-check for a genuinely impossible input. There is deliberately NO
        // "version === current" rejection: the backend treats restore-to-head as an idempotent no-op,
        // and a client that rejects what the server accepts is a divergence waiting to bite.
        if (typeof currentVersionNo === "number" && version > currentVersionNo) {
          throw new MdlogError(
            "VALIDATION",
            `"${norm.path}" has no version ${version} — the current version is v${currentVersionNo}. ` +
              `Call list_versions to see the available version numbers.`,
          );
        }
        const data = await client.restoreVersion(documentKey, version, commit_message);
        const newVersionNo: number | null = data?.current_version_no ?? null;
        // The backend makes restore-to-identical-content an idempotent no-op (it returns the UNCHANGED
        // head), so an unmoved version number is a success, not a failure. Say so plainly instead of
        // reporting a rollback that did not need to happen.
        const noop = newVersionNo !== null && newVersionNo === currentVersionNo;
        return ok(
          noop
            ? `"${norm.path}" is already byte-identical to v${version}; no new version was created ` +
              `(still v${newVersionNo}).`
            : `Restored "${norm.path}" from v${version}; its content is now version ` +
              `${newVersionNo ?? "?"} (full history preserved).`,
          {
            path: norm.path,
            document_key: documentKey,
            restored_from_version: version,
            previous_version_no: currentVersionNo,
            current_version_no: newVersionNo,
            checksum_sha256: data?.checksum_sha256 ?? null,
            no_op: noop,
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- delete_markdown (guarded) ----------------------------------------
  server.registerTool(
    "delete_markdown",
    {
      title: "Delete Markdown",
      description:
        "Soft-delete a .md file. Requires confirm:true (otherwise VALIDATION). Resolves the path " +
        "to a document key, then DELETE /documents/{key}.",
      inputSchema: {
        path: filePathField,
        confirm: z
          .boolean()
          .describe("Must be true to actually delete. A safety guard against accidental deletes."),
      },
    },
    async ({ path, confirm }): Promise<ToolResult> => {
      try {
        if (confirm !== true) {
          throw new MdlogError(
            "VALIDATION",
            "delete_markdown requires confirm:true to proceed. No document was deleted.",
          );
        }
        const norm = validatePath(path, { requireMd: true });
        const doc = await client.getByPath(norm.path);
        const documentKey: string | undefined = doc?.document_key ?? doc?.key;
        if (!documentKey) {
          throw new MdlogError("NOT_FOUND", `Could not resolve a document key for "${norm.path}".`);
        }
        await client.deleteDocument(documentKey);
        return ok(`Deleted "${norm.path}" (soft delete; recoverable in history).`, {
          path: norm.path,
          document_key: documentKey,
          deleted: true,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- create_folder (mkdir -p) -----------------------------------------
  server.registerTool(
    "create_folder",
    {
      title: "Create Folder",
      description:
        "Create a folder path, creating every missing parent segment (mkdir -p). Already-existing " +
        "folders are treated as success.",
      inputSchema: { path: folderPathField },
    },
    async ({ path }): Promise<ToolResult> => {
      try {
        const norm = validatePath(path, { requireMd: false });
        const { folderKey, createdSegments } = await ensureFolderPath(client, norm.segments);
        const text =
          createdSegments.length > 0
            ? `Ensured folder "${norm.path}" (created: ${createdSegments.join(", ")}).`
            : `Folder "${norm.path}" already existed.`;
        return ok(text, {
          path: norm.path,
          folder_key: folderKey ?? null,
          created_segments: createdSegments,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- move_markdown (move and/or rename a document by path) --------------
  server.registerTool(
    "move_markdown",
    {
      title: "Move Markdown",
      description:
        "Move and/or rename a .md file: from_path -> to_path. Destination folders are auto-created " +
        "(mkdir -p). The document KEEPS its identity (same document key), so its whole version " +
        "history and reviewers' annotations survive the move — never re-save + delete to relocate " +
        "a file. Fails if a different file already occupies to_path.",
      inputSchema: {
        from_path: filePathField.describe("Current POSIX path of the .md file."),
        to_path: filePathField.describe(
          "Target POSIX path (must end in .md). Same folder + new name = rename; " +
            "new folder + same name = move; both may change at once.",
        ),
      },
    },
    async ({ from_path, to_path }): Promise<ToolResult> => {
      try {
        const from = validatePath(from_path, { requireMd: true });
        const to = validatePath(to_path, { requireMd: true });
        if (from.path === to.path) {
          throw new MdlogError("VALIDATION", "from_path and to_path are identical — nothing to do.");
        }

        const doc = await client.getByPath(from.path);
        const documentKey: string | undefined = doc?.document_key ?? doc?.key;
        if (!documentKey) {
          throw new MdlogError("NOT_FOUND", `Could not resolve a document key for "${from.path}".`);
        }

        // M-12: pre-check the destination so a name collision fails EARLY with no partial mutation. Without
        // it, a committed move followed by a rename that 409s on a name clash would strand the doc at
        // toFolder/fromName — and a retry with from_path would 404 and read as data loss.
        // getByPath THROWS NOT_FOUND when nothing occupies the destination — the NORMAL case for a move or
        // rename — so swallow that (null = "vacant, proceed") and only propagate real errors. Leaving this
        // unguarded made EVERY move to an empty path fail with "[NOT_FOUND] No resource exists at this path".
        const existingAtDest = await client.getByPath(to.path).catch((e: unknown) => {
          if (e instanceof MdlogError && e.code === "NOT_FOUND") return null;
          throw e;
        });
        const existingKey: string | undefined = existingAtDest?.document_key ?? existingAtDest?.key;
        if (existingKey && existingKey !== documentKey) {
          throw new MdlogError("CONFLICT", `a different document already occupies "${to.path}".`);
        }

        const fromFolderSegments = from.segments.slice(0, -1);
        const fromFolder = fromFolderSegments.join("/");
        const toFolderSegments = to.segments.slice(0, -1);
        const toFolder = toFolderSegments.join("/");
        const fromName = from.segments[from.segments.length - 1]!;
        const toName = to.segments[to.segments.length - 1]!;

        let moved = false;
        let renamed = false;
        let newFolderKey: string | null = null;

        if (fromFolder !== toFolder) {
          const ensured = await ensureFolderPath(client, toFolderSegments);
          newFolderKey = ensured.folderKey ?? null; // null = root
          try {
            await client.moveDocument(documentKey, newFolderKey);
          } catch (moveErr) {
            // A cross-scope move (shared <-> private) is rejected server-side; give actionable guidance.
            throw explainCrossScopeMove(moveErr, from.path, to.path);
          }
          moved = true;
        }
        if (fromName !== toName) {
          try {
            await client.renameDocument(documentKey, toName);
            renamed = true;
          } catch (renameErr) {
            // M-12: compensate a committed move so a late rename failure doesn't strand the doc — restore
            // its original folder so the from_path retry resolves cleanly.
            if (moved) {
              try {
                const restoredKey =
                  (await ensureFolderPath(client, fromFolderSegments)).folderKey ?? null;
                await client.moveDocument(documentKey, restoredKey);
              } catch {
                throw new MdlogError(
                  "CONFLICT",
                  `rename to "${to.path}" failed and rolling the move back also failed — the document is ` +
                    `currently at "${toFolder ? toFolder + "/" : ""}${fromName}". Re-run move_markdown from there.`,
                );
              }
            }
            throw renameErr;
          }
        }

        const what =
          moved && renamed ? "Moved and renamed" : moved ? "Moved" : "Renamed";
        return ok(
          `${what} "${from.path}" -> "${to.path}" (history and annotations preserved).`,
          {
            from_path: from.path,
            to_path: to.path,
            document_key: documentKey,
            moved,
            renamed,
            new_folder_key: newFolderKey,
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- move_folder ---------------------------------------------------------
  server.registerTool(
    "move_folder",
    {
      title: "Move Folder",
      description:
        "Move a folder (with its whole subtree: documents, versions, annotations) under a new " +
        "parent. new_parent_path '' or omitted = move to the root. Parent folders are auto-created. " +
        "Moving a folder into its own subtree is rejected by the server.",
      inputSchema: {
        path: folderPathField.describe("Current POSIX path of the folder to move."),
        new_parent_path: z
          .string()
          .optional()
          .describe("POSIX path of the destination PARENT folder. Empty/omitted = root."),
      },
    },
    async ({ path, new_parent_path }): Promise<ToolResult> => {
      try {
        const norm = validatePath(path, { requireMd: false });
        const source = await client.resolveFolder(norm.path);
        const sourceKey = folderKeyOf(source);
        if (!sourceKey) {
          throw new MdlogError("NOT_FOUND", `Folder "${norm.path}" does not exist.`);
        }

        let newParentKey: string | null = null;
        let parentPath = "";
        if (new_parent_path && new_parent_path.trim().length > 0) {
          const parent = validatePath(new_parent_path, { requireMd: false });
          parentPath = parent.path;
          const ensured = await ensureFolderPath(client, parent.segments);
          newParentKey = ensured.folderKey ?? null;
        }

        const name = norm.segments[norm.segments.length - 1]!;
        const newPath = parentPath ? `${parentPath}/${name}` : name;
        let res: any;
        try {
          res = await client.moveFolder(sourceKey, newParentKey);
        } catch (moveErr) {
          // A cross-scope folder move (shared subtree <-> private) is rejected server-side; guide the caller.
          throw explainCrossScopeMove(moveErr, norm.path, newPath);
        }
        return ok(`Moved folder "${norm.path}" -> "${newPath}" (subtree intact).`, {
          from_path: norm.path,
          to_path: newPath,
          folder_key: sourceKey,
          new_parent_key: newParentKey,
          folder: res ?? null,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- rename_folder -------------------------------------------------------
  server.registerTool(
    "rename_folder",
    {
      title: "Rename Folder",
      description:
        "Rename a folder in place (descendant paths are rewritten automatically; documents, " +
        "versions and annotations are untouched).",
      inputSchema: {
        path: folderPathField.describe("Current POSIX path of the folder."),
        new_name: z
          .string()
          .min(1)
          .describe("New folder NAME (a single path segment, not a path)."),
      },
    },
    async ({ path, new_name }): Promise<ToolResult> => {
      try {
        const norm = validatePath(path, { requireMd: false });
        const nameNorm = validatePath(new_name, { requireMd: false });
        if (nameNorm.segments.length !== 1) {
          throw new MdlogError(
            "VALIDATION",
            "new_name must be a single folder NAME (no '/'), not a path.",
          );
        }
        const source = await client.resolveFolder(norm.path);
        const sourceKey = folderKeyOf(source);
        if (!sourceKey) {
          throw new MdlogError("NOT_FOUND", `Folder "${norm.path}" does not exist.`);
        }
        const res = await client.renameFolder(sourceKey, nameNorm.segments[0]!);
        const newPath = [...norm.segments.slice(0, -1), nameNorm.segments[0]!].join("/");
        return ok(`Renamed folder "${norm.path}" -> "${newPath}".`, {
          from_path: norm.path,
          to_path: newPath,
          folder_key: sourceKey,
          folder: res ?? null,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- delete_folder (guarded) ---------------------------------------------
  server.registerTool(
    "delete_folder",
    {
      title: "Delete Folder",
      description:
        "Delete a folder. Requires confirm:true (otherwise VALIDATION). By default only an EMPTY " +
        "folder is deleted (a non-empty one is refused); pass cascade:true to soft-delete the whole " +
        "subtree — every subfolder and document under it (like `rm -r`). Documents are " +
        "soft-deleted (recoverable), but prefer move_folder/move_markdown when reorganizing.",
      inputSchema: {
        path: folderPathField.describe("POSIX path of the folder to delete."),
        confirm: z
          .boolean()
          .describe("Must be true to actually delete. A safety guard against accidental deletes."),
        cascade: z
          .boolean()
          .optional()
          .describe(
            "true = delete the folder AND everything under it. Default false = refuse unless empty.",
          ),
      },
    },
    async ({ path, confirm, cascade }): Promise<ToolResult> => {
      try {
        if (confirm !== true) {
          throw new MdlogError(
            "VALIDATION",
            "delete_folder requires confirm:true to proceed. No folder was deleted.",
          );
        }
        const norm = validatePath(path, { requireMd: false });
        const source = await client.resolveFolder(norm.path);
        const sourceKey = folderKeyOf(source);
        if (!sourceKey) {
          throw new MdlogError("NOT_FOUND", `Folder "${norm.path}" does not exist.`);
        }
        await client.deleteFolder(sourceKey, cascade === true);
        return ok(
          `Deleted folder "${norm.path}"${cascade === true ? " and its whole subtree" : ""} ` +
            "(soft delete).",
          {
            path: norm.path,
            folder_key: sourceKey,
            cascade: cascade === true,
            deleted: true,
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- list_folders ------------------------------------------------------
  server.registerTool(
    "list_folders",
    {
      title: "List Folders",
      description: "Return the full folder tree.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const tree = await client.getFoldersTree();
        return ok("Folder tree retrieved.", { tree });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- list_files --------------------------------------------------------
  server.registerTool(
    "list_files",
    {
      title: "List Files",
      description:
        "List the documents (and immediate subfolders) inside a folder path. Omit path (or pass '' / " +
        "'/') to list the ROOT folder.",
      inputSchema: { path: listFolderPathField },
    },
    async ({ path }): Promise<ToolResult> => {
      try {
        // #81: the backend endpoint lists the ROOT for an empty path; the tool must allow it too.
        const raw = path ?? "";
        if (raw === "" || raw === "/") {
          const listing = await client.getFolderByPath("");
          return ok("Listing for the root folder retrieved.", { path: "", listing });
        }
        const norm = validatePath(raw, { requireMd: false });
        const listing = await client.getFolderByPath(norm.path);
        return ok(`Listing for "${norm.path}" retrieved.`, { path: norm.path, listing });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- search_markdown ---------------------------------------------------
  server.registerTool(
    "search_markdown",
    {
      title: "Search Markdown",
      description:
        "Search documents by TITLE (substring) and BODY (full-text over current versions; " +
        "whole-word match, ranked, body hits carry a **bolded** snippet). Use it to find a prior " +
        "report by its content or name.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Search query; matched against document titles (substring) and body text (words)."),
      },
    },
    async ({ query }): Promise<ToolResult> => {
      try {
        const results = await client.searchDocuments(query);
        return ok(`Search results for "${query}".`, { query, results });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
