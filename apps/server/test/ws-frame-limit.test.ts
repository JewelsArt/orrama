/**
 * The live-sync socket refuses a big frame on its header, before reading or
 * parsing it (audit SEC-010). The first frame used to be buffered up to ws's
 * 100 MiB default and JSON.parsed before anyone knew it was a valid auth, so
 * an unauthenticated peer could make the server hold hundreds of MiB.
 *
 * A real socket on a real port: 1009 ("message too big") comes from ws's
 * frame reader, while 4001 would mean the frame was read, parsed and only
 * then refused.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-ws-frame-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer, WS_MAX_FRAME } = await import("../src/main.js");
const b = await buildServer();
await b.app.listen({ port: 0, host: "127.0.0.1" });
const url = `ws://127.0.0.1:${(b.app.server.address() as AddressInfo).port}/api/ws`;
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

const reg = await b.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "o@example.test", username: "owner", displayName: "O", password: "a-real-password" } });
expect(reg.statusCode).toBe(200);
const session = reg.json().token as string;

/** Open a socket, send one frame, and report how it ended (or what came back). */
const sendOne = (frame: string) =>
  new Promise<{ code?: number; first?: string }>((resolve) => {
    const ws = new WebSocket(url); // Node's own, the browser API
    ws.onopen = () => ws.send(frame);
    ws.onmessage = (e) => {
      resolve({ first: String(e.data) });
      ws.close();
    };
    ws.onclose = (e) => resolve({ code: e.code });
  });

describe("live-sync frame limit", () => {
  it("closes on a frame over the limit, before it is parsed", async () => {
    const big = JSON.stringify({ type: "auth", token: "x".repeat(1024 * 1024) });
    expect((await sendOne(big)).code).toBe(1009);
    expect((await sendOne("y".repeat(WS_MAX_FRAME + 1))).code).toBe(1009);
  });

  it("still parses and refuses a small bad frame, and accepts a real auth", async () => {
    expect((await sendOne(JSON.stringify({ type: "auth", token: "nope" }))).code).toBe(4001);
    expect((await sendOne(JSON.stringify({ type: "auth", token: session }))).first).toBe(JSON.stringify({ type: "ready" }));
  });
});
