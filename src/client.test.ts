import { describe, expect, it } from "vitest";
import { MdlogClient, mapError, sha256Hex } from "./client.js";

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

/**
 * Route + pre-flight pinning for the two client-side behaviours an agent cannot see until it is too
 * late: which URL a rollback actually hits, and whether an oversize body is rejected before it is
 * pushed over the wire.
 */
describe("MdlogClient.restoreVersion", () => {
  const client = () => new MdlogClient({ apiBaseUrl: "https://api.example/api/v1", pat: "p" });

  const stubFetch = () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(
        JSON.stringify({ status: "SUCCESS", code: "MDLOG_CM_0000", data: { current_version_no: 9 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
  };

  it("POSTs to /documents/{key}/versions/{n}/restore — NOT /documents/{key}/restore", () => {
    // /documents/{key}/restore is TRASH restore. Hitting it by mistake un-deletes a document instead
    // of rolling back its content, and both return 200, so only the URL distinguishes them.
    const f = stubFetch();
    return client()
      .restoreVersion("abc-123", 7, "revert")
      .then((data) => {
        expect(f.calls).toHaveLength(1);
        const [call] = f.calls;
        expect(call?.method).toBe("POST");
        expect(call?.url).toBe("https://api.example/api/v1/documents/abc-123/versions/7/restore");
        expect(call?.body).toEqual({ source: "MCP", commit_message: "revert" });
        expect(data.current_version_no).toBe(9);
      })
      .finally(f.restore);
  });

  it("omits commit_message when none is given, so the backend default applies", () => {
    const f = stubFetch();
    return client()
      .restoreVersion("abc-123", 7)
      .then(() => {
        expect(f.calls[0]?.body).toEqual({ source: "MCP" });
      })
      .finally(f.restore);
  });

  it("percent-encodes the document key", () => {
    const f = stubFetch();
    return client()
      .restoreVersion("a/b", 2)
      .then(() => {
        expect(f.calls[0]?.url).toContain("/documents/a%2Fb/versions/2/restore");
      })
      .finally(f.restore);
  });
});

describe("MdlogClient.putByPath size pre-flight", () => {
  const client = () => new MdlogClient({ apiBaseUrl: "https://api.example/api/v1", pat: "p" });

  it("rejects an over-cap body BEFORE any fetch, as VALIDATION", async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const oversize = "a".repeat(25 * 1024 * 1024 + 1);
      await expect(client().putByPath({ path: "a.md", content: oversize })).rejects.toMatchObject({
        code: "VALIDATION",
      });
      // The point of a pre-flight: nothing is sent. Otherwise a 25 MiB body is uploaded only to be
      // rejected, or the request stalls until the 60s timeout.
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("measures UTF-8 BYTES, not characters", async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      // 9M Korean chars = 27 MB UTF-8: over the 25 MiB cap even though .length is well under the
      // old 26_214_400 CHARACTER limit. A char-based check would have let this through.
      const korean = "가".repeat(9 * 1000 * 1000);
      expect(korean.length).toBeLessThan(26_214_400);
      await expect(client().putByPath({ path: "a.md", content: korean })).rejects.toMatchObject({
        code: "VALIDATION",
      });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});
