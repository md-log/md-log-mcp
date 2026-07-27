import { describe, expect, it } from "vitest";
import { mapError, sha256Hex } from "./client.js";

/**
 * `mapError` decides which structured code an agent sees, and agents branch on it — mapping a
 * cross-scope move rejection to QUOTA_EXCEEDED, say, invites a destructive retry. These pin each
 * server code / status to its intended bucket.
 */
describe("mapError", () => {
  const code = (status: number, serverCode?: string, json: unknown = {}) =>
    mapError(status, serverCode, json).code;

  it("gives folder-duplicate its own code (create_folder treats it as success)", () => {
    expect(code(400, "MDLOG_FLD_0001")).toBe("FOLDER_EXISTS");
  });

  it("maps quota exhaustion, which the backend returns as a 200-FAIL", () => {
    expect(code(200, "MDLOG_DOC_0007")).toBe("QUOTA_EXCEEDED");
  });

  it("maps cross-scope move rejection to VALIDATION, never QUOTA_EXCEEDED", () => {
    expect(code(400, "MDLOG_DOC_0008")).toBe("VALIDATION");
    expect(code(400, "MDLOG_FLD_0008")).toBe("VALIDATION");
  });

  it("maps optimistic-concurrency conflicts", () => {
    expect(code(409)).toBe("CONFLICT");
    expect(code(200, "MDLOG_SYNC_0409")).toBe("CONFLICT");
  });

  it("maps not-found, rate-limit and auth", () => {
    expect(code(404)).toBe("NOT_FOUND");
    expect(code(200, "MDLOG_CM_0404")).toBe("NOT_FOUND");
    expect(code(429)).toBe("RATE_LIMITED");
    expect(code(401)).toBe("UNAUTHORIZED");
    expect(code(403)).toBe("UNAUTHORIZED");
    expect(code(200, "MDLOG_AU_0401")).toBe("UNAUTHORIZED");
  });

  it("maps 5xx to BACKEND_UNAVAILABLE and anything else to ERROR", () => {
    expect(code(500)).toBe("BACKEND_UNAVAILABLE");
    expect(code(503)).toBe("BACKEND_UNAVAILABLE");
    expect(code(418)).toBe("ERROR");
  });

  it("keeps the server message and carries the detail payload", () => {
    const err = mapError(409, "MDLOG_SYNC_0409", {
      message: "version conflict",
      data: { current_version_no: 7 },
    });
    expect(err.message).toBe("version conflict");
    expect(err.detail).toEqual({ current_version_no: 7 });
    expect(err.status).toBe(409);
  });

  it("falls back to a generic message when the body carries none", () => {
    expect(mapError(500, undefined, {}).message).toContain("500");
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of the empty input", () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known digest of 'abc'", () => {
    expect(sha256Hex(Buffer.from("abc", "utf8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
