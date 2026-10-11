/**
 * A seeded server in a temp dir for the agent's tests, with the provider set
 * to a fake Chat-Completions endpoint (fakeChat.ts). Import it from a test
 * file's top level: it sets the environment before the server modules load.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeChat, type Turn } from "./fakeChat.js";

export async function bootAi(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `basalt-${name}-`));
  process.env.BASALT_DATA_DIR = dir;
  process.env.BASALT_VAULT_DIR = path.join(dir, "vault");
  process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
  process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";
  await import("../../src/seed.js");
  const { buildServer } = await import("../../src/main.js");
  const { tables } = await import("../../src/db.js");
  const logPath = path.join(dir, "server.log");
  const logStream = fs.createWriteStream(logPath);
  const built = await buildServer({ logStream });

  // Each test queues the turns it wants — a turn, or a function of the request
  // that builds one from what the model was sent; an empty queue answers "done".
  const queue: (Turn | ((body: any) => Turn))[] = [];
  const llm = await fakeChat((_n, body) => {
    const next = queue.shift() ?? { text: "done" };
    return typeof next === "function" ? next(body) : next;
  });

  const tokens: Record<string, string> = {};
  for (const who of ["jules", "erin", "mara"]) {
    tokens[who] = (await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } })).json().token;
  }
  const call = async (who: string, method: string, url: string, payload?: object) => {
    const auth = who.startsWith("bslt_") ? who : tokens[who];
    const r = await built.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${auth}` }, ...(payload ? { payload } : {}) });
    let json: any = null;
    try {
      json = r.json();
    } catch {
      // a stream or plain text
    }
    return { status: r.statusCode, body: r.body, json };
  };
  const r = await call("jules", "POST", "/api/admin/ai", { provider: "openai-compatible", model: "fake-model", apiKey: "sk-test-0123456789", baseUrl: llm.baseUrl });
  if (r.status !== 200) throw new Error(`could not configure the fake provider: ${r.body}`);

  const users = built.db.select().from(tables.users).all();
  const aclUser = (username: string) => built.store.aclUser(users.find((u) => u.username === username)!.id);
  const vault = path.join(dir, "vault");
  const close = async () => {
    await built.app.close();
    await llm.close();
    logStream.end();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { built, tokens, call, dir, vault, logPath, llm, queue, aclUser, close };
}
