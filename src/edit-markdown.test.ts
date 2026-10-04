import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "./build-server.js";
import { MdlogClient, MdlogError } from "./client.js";

/**
 * Drives the real edit_markdown handler over an in-memory MCP transport against a fake backend, to pin
 * the property batch mode exists for — N edits -> exactly ONE putByPath (one version, one notification)
 * — and the all-or-nothing / retry / error-shape contract around it.
 */
interface PutCall {
  readonly content: string;
  readonly baseVersionNo?: number;
  readonly commitMessage?: string;
}

interface FakeOptions {
  /** Content another writer saves just before each of our PUTs — one injected CONFLICT per entry. */
  readonly concurrentWrites?: readonly string[];
  readonly notFound?: boolean;
  readonly versionMissing?: boolean;
}

function fakeBackend(initial: string, opts: FakeOptions = {}) {
  const pendingWrites = [...(opts.concurrentWrites ?? [])];
  const state = { content: initial, version: 1, reads: 0, puts: [] as PutCall[] };
  const client = {
    async getByPath() {
      state.reads += 1;
      if (opts.notFound) throw new MdlogError("NOT_FOUND", "no such document");
      return { current_version_no: opts.versionMissing ? undefined : state.version, content: state.content };
    },
    async materializeContent(doc: { content: string }) {
      return doc.content;
    },
    async putByPath(args: PutCall) {
      const concurrent = pendingWrites.shift();
      if (concurrent !== undefined) {
        state.content = concurrent;
        state.version += 1;
        throw new MdlogError("CONFLICT", "stale base");
      }
      state.puts.push(args);
      state.content = args.content;
      state.version += 1;
      return { document_key: "k", current_version_no: state.version, checksum_sha256: "x" };
    },
  } as unknown as MdlogClient;
  return { state, client };
}

interface ToolError {
  readonly code?: string;
  readonly detail?: Record<string, unknown> | null;
}

async function callEdit(client: MdlogClient, args: Record<string, unknown>) {
  const server = buildServer(client, { allowLocalFiles: false });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(clientSide);
  try {
    const res = (await mcp.callTool({ name: "edit_markdown", arguments: { path: "r/doc.md", ...args } })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    return { ...res, error: (res.structuredContent?.error ?? undefined) as ToolError | undefined };
  } finally {
    await mcp.close();
  }
}

describe("edit_markdown handler", () => {
  it("writes a batch of edits in exactly one PUT with one commit message", async () => {
    const { state, client } = fakeBackend("a1 b1 c1");
    const res = await callEdit(client, {
      edits: [
        { old_string: "a1", new_string: "a2" },
        { old_string: "b1", new_string: "b2" },
        { old_string: "c1", new_string: "c2" },
      ],
      commit_message: "bump all three",
    });
    expect(res.isError).toBeFalsy();
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0]).toMatchObject({ content: "a2 b2 c2", baseVersionNo: 1, commitMessage: "bump all three" });
    expect(res.structuredContent).toMatchObject({ edit_count: 3, replaced: 3, current_version_no: 2 });
  });

  it("keeps the single-edit shorthand working", async () => {
    const { state, client } = fakeBackend("hello world");
    const res = await callEdit(client, { old_string: "world", new_string: "md-log" });
    expect(res.isError).toBeFalsy();
    expect(state.puts.map((p) => p.content)).toEqual(["hello md-log"]);
    expect(res.structuredContent).toMatchObject({ edit_count: 1, occurrences: 1, replace_all: false });
  });

  it("accepts empty shorthand defaults sent next to a batch", async () => {
    const { state, client } = fakeBackend("a1");
    const res = await callEdit(client, {
      edits: [{ old_string: "a1", new_string: "a2" }],
      old_string: "",
      new_string: "",
      replace_all: false,
    });
    expect(res.isError).toBeFalsy();
    expect(state.puts.map((p) => p.content)).toEqual(["a2"]);
  });

  it("writes nothing when any edit in the batch fails", async () => {
    const { state, client } = fakeBackend("a1 b1");
    const res = await callEdit(client, {
      edits: [
        { old_string: "a1", new_string: "a2" },
        { old_string: "zz", new_string: "yy" },
      ],
    });
    expect(res.isError).toBe(true);
    expect(state.puts).toHaveLength(0);
    expect(res.error).toMatchObject({ code: "VALIDATION", detail: { reason: "NO_MATCH", edit_index: 1 } });
  });

  it("stops geometric growth with a structured error instead of crashing the process", async () => {
    // Each step multiplies the text by 1000: 1 -> 1e3 -> 1e6 -> 1e9 chars. The third result would be far
    // over the 25 MiB cap, so it is refused before it is built.
    const { state, client } = fakeBackend("a");
    const grow = { old_string: "a", new_string: "a".repeat(1000), replace_all: true };
    const res = await callEdit(client, { edits: [grow, grow, grow] });
    expect(res.isError).toBe(true);
    expect(state.puts).toHaveLength(0);
    expect(res.error).toMatchObject({ code: "VALIDATION", detail: { reason: "DOCUMENT_TOO_LARGE", edit_index: 2 } });
  });

  describe("rejects malformed input with a structured error and no backend round-trip", () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
      ["mixed input", { edits: [{ old_string: "a1", new_string: "a2" }], old_string: "a1", new_string: "a3" }, "MIXED_INPUT"],
      ["no edit at all", {}, "MISSING_EDIT"],
      ["an empty batch", { edits: [] }, "EMPTY_EDITS"],
      ["an oversized batch", { edits: Array.from({ length: 51 }, (_, i) => ({ old_string: `k${i}`, new_string: "v" })) }, "TOO_MANY_EDITS"],
      ["an empty old_string", { edits: [{ old_string: "", new_string: "x" }] }, "EMPTY_OLD_STRING"],
      ["identical strings", { old_string: "a1", new_string: "a1" }, "IDENTICAL_STRINGS"],
    ];
    it.each(cases)("%s", async (_name, args, reason) => {
      const { state, client } = fakeBackend("a1");
      const res = await callEdit(client, args);
      expect(res.isError).toBe(true);
      expect(res.error).toMatchObject({ code: "VALIDATION", detail: { reason } });
      expect(state.reads).toBe(0);
      expect(state.puts).toHaveLength(0);
    });
  });

  it("re-reads and re-applies every edit on a CONFLICT, still writing once", async () => {
    // A concurrent writer appended a line; our edits still apply to the new text.
    const { state, client } = fakeBackend("a1 b1", { concurrentWrites: ["a1 b1\nnew line"] });
    const res = await callEdit(client, {
      edits: [
        { old_string: "a1", new_string: "a2" },
        { old_string: "b1", new_string: "b2" },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(state.reads).toBe(2);
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0]).toMatchObject({ content: "a2 b2\nnew line", baseVersionNo: 2 });
  });

  it("surfaces CONFLICT after a second concurrent write, having written nothing", async () => {
    const { state, client } = fakeBackend("a1", { concurrentWrites: ["a1 x", "a1 y"] });
    const res = await callEdit(client, { old_string: "a1", new_string: "a2" });
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe("CONFLICT");
    expect(state.reads).toBe(2);
    expect(state.puts).toHaveLength(0);
  });

  it("says a concurrent write is why an edit no longer matches on the retry", async () => {
    // The other writer changed exactly the text this edit targets.
    const { state, client } = fakeBackend("a1 b1", { concurrentWrites: ["a1 B9"] });
    const res = await callEdit(client, {
      edits: [
        { old_string: "a1", new_string: "a2" },
        { old_string: "b1", new_string: "b2" },
      ],
    });
    expect(res.isError).toBe(true);
    expect(state.puts).toHaveLength(0);
    expect(res.error).toMatchObject({
      code: "VALIDATION",
      detail: { reason: "NO_MATCH", edit_index: 1, after_concurrent_write: true },
    });
  });

  it("propagates NOT_FOUND for a missing document instead of creating it", async () => {
    const { state, client } = fakeBackend("", { notFound: true });
    const res = await callEdit(client, { edits: [{ old_string: "a", new_string: "b" }] });
    expect(res.error?.code).toBe("NOT_FOUND");
    expect(state.puts).toHaveLength(0);
  });

  it("refuses to write when the backend reports no current version (no force-overwrite)", async () => {
    const { state, client } = fakeBackend("a1", { versionMissing: true });
    const res = await callEdit(client, { edits: [{ old_string: "a1", new_string: "a2" }] });
    expect(res.error?.code).toBe("BACKEND_UNAVAILABLE");
    expect(state.puts).toHaveLength(0);
  });
});
