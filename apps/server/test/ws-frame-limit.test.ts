/**
 * The live-sync socket refuses a big frame on its header, before reading or
 * parsing it (audit SEC-010). The first frame used to be buffered up to ws's
 * 100 MiB default and JSON.parsed before anyone knew it was a valid auth, so
 * an unauthenticated peer could make the server hold hundreds of MiB.
 *
 * Since WEB-013 nobody unauthenticated gets a socket at all: it is signed in
 * on the upgrade, from the session cookie. The cap still bounds what a
 * signed-in socket can make the server buffer: 1009 ("message too big") comes
 * from ws's frame reader, before the body is read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { liveSocket, refusedWith, sessionOf } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-ws-frame-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer, WS_MAX_FRAME } = await import("../src/main.js");
const b = await buildServer();
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

const reg = await b.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "o@example.test", username: "owner", displayName: "O", password: "a-real-password" } });
expect(reg.statusCode).toBe(200);
const session = sessionOf(reg);

/** Open a signed-in socket, send one frame, and report whether it was closed for it. */
const sendOne = async (frame: string) => {
  const s = await liveSocket(b.app, session);
  expect(await s.ready()).toBe(true);
  s.ws.send(frame);
  const code = await Promise.race([s.closed, new Promise<"open">((r) => setTimeout(() => r("open"), 300))]);
  if (code === "open") s.ws.close();
  return code;
};

describe("live-sync frame limit", () => {
  it("closes on a frame over the limit, before it is parsed", async () => {
    expect(await sendOne(JSON.stringify({ type: "editing", noteId: "x".repeat(1024 * 1024) }))).toBe(1009);
    expect(await sendOne("y".repeat(WS_MAX_FRAME + 1))).toBe(1009);
  });

  it("a frame under the limit is read and, if it means nothing, ignored", async () => {
    expect(await sendOne(JSON.stringify({ type: "editing", noteId: "n-nothing" }))).toBe("open");
    expect(await sendOne("y".repeat(WS_MAX_FRAME - 1))).toBe("open");
  });

  it("an unauthenticated peer gets no socket to send a frame on", async () => {
    expect(await refusedWith(liveSocket(b.app, undefined))).toBe(401);
  });
});
