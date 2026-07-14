/**
 * POSIX path validation for the MCP lane.
 *
 * Mirrors the service's path/name rules and runs BEFORE any backend call:
 *   - NFC-normalize,
 *   - reject '..'/'.' segments, control chars, empty segments (leading/trailing
 *     or doubled '/'), backslash separators, '/'-in-name (implicit via split),
 *   - reject leading/trailing whitespace in a segment,
 *   - reject reserved device names,
 *   - enforce 255-byte name / 1024-byte path limits,
 *   - require a trailing '.md' for file paths (opts.requireMd).
 */

import { MdlogError } from "./client.js";

const RESERVED_NAMES = new Set([
  ".",
  "..",
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** True if the string contains any C0 control char (0x00-0x1F) or DEL (0x7F). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface NormalizedPath {
  /** Normalized, validated full path (NFC, no surrounding slashes). */
  path: string;
  /** Path segments in order. */
  segments: string[];
  /** Parent directory (segments minus the last), '' when at root. */
  dir: string;
  /** Last segment (the file name for file paths). */
  name: string;
}

export function validatePath(
  input: unknown,
  opts: { requireMd: boolean },
): NormalizedPath {
  if (typeof input !== "string" || input.length === 0) {
    throw new MdlogError("VALIDATION", "path must be a non-empty string.");
  }

  const p = input.normalize("NFC");

  if (p.includes("\\")) {
    throw new MdlogError(
      "VALIDATION",
      `path must use POSIX '/' separators, not backslash: "${input}"`,
    );
  }

  const segments = p.split("/");

  for (const seg of segments) {
    if (seg.length === 0) {
      throw new MdlogError(
        "VALIDATION",
        `path has an empty segment (a leading, trailing, or doubled '/'): "${input}"`,
      );
    }
    if (seg !== seg.trim()) {
      throw new MdlogError(
        "VALIDATION",
        `path segment has leading/trailing whitespace: "${seg}"`,
      );
    }
    if (hasControlChar(seg)) {
      throw new MdlogError("VALIDATION", `path segment contains a control character: "${seg}"`);
    }
    if (seg === "." || seg === "..") {
      throw new MdlogError("VALIDATION", `path may not contain '.' or '..' segments: "${input}"`);
    }
    if (RESERVED_NAMES.has(seg.toUpperCase())) {
      throw new MdlogError("VALIDATION", `path segment is a reserved name: "${seg}"`);
    }
    if (Buffer.byteLength(seg, "utf8") > 255) {
      throw new MdlogError("VALIDATION", `path segment exceeds 255 bytes: "${seg}"`);
    }
  }

  if (Buffer.byteLength(p, "utf8") > 1024) {
    throw new MdlogError("VALIDATION", `full path exceeds 1024 bytes: "${input}"`);
  }

  const name = segments[segments.length - 1] as string;
  if (opts.requireMd && !name.toLowerCase().endsWith(".md")) {
    throw new MdlogError("VALIDATION", `file path must end in '.md': "${input}"`);
  }

  return {
    path: segments.join("/"),
    segments,
    dir: segments.slice(0, -1).join("/"),
    name,
  };
}

/** Replace every literal occurrence of `needle` in `haystack` (no regex semantics). */
export function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0) return haystack;
  return haystack.split(needle).join(replacement);
}
