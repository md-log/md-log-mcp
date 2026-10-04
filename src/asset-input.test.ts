import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "./build-server.js";
import { MdlogClient } from "./client.js";

/**
 * Inline base64 assets are validated before any backend call. The padding strip used to be the regex
 * /=+$/, which backtracks quadratically over a long run of '=' that is not at the end — one upload_asset
 * call could stall the shared HTTP server for minutes. These pin the linear replacement, and that valid
 * padded or unpadded input still decodes byte-for-byte.
 */
async function upload(client: MdlogClient, dataBase64: string) {
  const server = buildServer(client, { allowLocalFiles: false });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(clientSide);
  try {
    return (await mcp.callTool({
      name: "upload_asset",
      arguments: { path: "r/doc.md", filename: "x.png", content_type: "image/png", data_base64: dataBase64 },
    })) as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
  } finally {
    await mcp.close();
  }
}

/** A backend that must never be reached: invalid input has to be rejected before any call. */
const unreachable = new Proxy({}, {
  get: () => () => {
    throw new Error("the backend must not be called for an invalid asset");
  },
}) as unknown as MdlogClient;

describe("upload_asset base64 validation", () => {
  it("rejects a huge run of '=' that is not at the end in linear time", async () => {
    // 400k '=' then a stray character: the old regex needed ~1 minute for this (100k took 4.1 s).
    const started = performance.now();
    const res = await upload(unreachable, "=".repeat(400_000) + "x");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error?.code).toBe("VALIDATION");
  });

  it("still rejects characters outside the base64 alphabet", async () => {
    const res = await upload(unreachable, "abc$def=");
    expect(res.structuredContent?.error?.code).toBe("VALIDATION");
  });

  /** A PNG signature plus filler — the magic-byte check needs at least 12 bytes. */
  const png = (...extra: number[]) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, ...extra];
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

  it.each([
    ["two '=' of padding", b64(png(1)), "==", png(1)],
    ["one '=' of padding", b64(png(1, 2)), "=", png(1, 2)],
    ["no padding needed", b64(png()), "", png()],
    ["its padding stripped by the encoder", b64(png(1)).replace(/=+$/, ""), "", png(1)],
  ])("uploads base64 with %s byte-for-byte", async (_name, data, padding, expected) => {
    expect(data.length - data.replace(/=+$/, "").length).toBe(padding.length);
    const uploaded: Buffer[] = [];
    const client = {
      async reserveAsset() {
        return { asset_key: "k1", upload_url: "https://upload.invalid/k1", headers: {} };
      },
      async putBytes(_url: string, bytes: Buffer) {
        uploaded.push(bytes);
      },
      async completeAsset() {
        return { asset_key: "k1" };
      },
    } as unknown as MdlogClient;
    const res = await upload(client, data);
    expect(res.isError).toBeFalsy();
    expect(uploaded).toHaveLength(1);
    expect([...uploaded[0]!]).toEqual(expected);
  });
});
