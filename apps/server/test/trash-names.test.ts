/**
 * Notes → Trash names a project's things by the project (2L, stage 1's leftover): a file
 * from `04-Projects/garden-studio/files/` was listed "from Projects / garden-studio / files",
 * its key and folder names. The trash list now carries `project`, the project's name — its
 * note as it is now, or its note in the trash when the whole project went — and the board's
 * own file is the Documents board, not `documents.canvas`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trashResponse } from "@orrama/schema/responses";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-trash-names-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
const { buildServer } = await import("../src/main.js");
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const call = async (method: string, url: string, payload?: object) => {
  const r = await app.inject({ method: method as "GET", url, headers: signedIn(token), ...(payload && { payload }) });
  return { status: r.statusCode, json: r.body ? r.json() : null };
};
const trash = async () => trashResponse.parse((await call("GET", "/api/vault/trash")).json);
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), text);
};

beforeAll(async () => {
  fs.mkdirSync(VAULT, { recursive: true });
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = sessionOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("the trash says a project's things by the project's name", () => {
  it("a file trashed from a project that is still there: its name now", async () => {
    expect((await call("POST", "/api/projects", { name: "Garden studio" })).json).toMatchObject({ slug: "garden-studio" });
    put("04-Projects/garden-studio/files/plan.pdf", "%PDF-1.4");
    expect((await call("DELETE", "/api/projects/garden-studio/files/plan.pdf")).status).toBe(200);
    expect((await trash()).find((t) => t.from === "04-Projects/garden-studio/files/plan.pdf")).toMatchObject({ title: "plan.pdf", project: "Garden studio", kind: "file" });
  });

  it("a whole project deleted: its files and board named by the note that went to the trash with them", async () => {
    put("04-Projects/garden-studio/documents.canvas", JSON.stringify({ nodes: [], edges: [] }));
    put("04-Projects/garden-studio/files/quote.pdf", "%PDF-1.4");
    // Renamed since it was made: the name is the note's, not the key.
    expect((await call("PATCH", "/api/projects/garden-studio", { name: "Garden room" })).status).toBe(200);
    expect((await call("POST", "/api/projects/garden-studio/trash")).status).toBe(200);
    const list = await trash();
    const at = (from: string) => list.find((t) => t.from === from);
    expect(at("04-Projects/garden-studio/files/quote.pdf")).toMatchObject({ title: "quote.pdf", project: "Garden room" });
    expect(at("04-Projects/garden-studio/documents.canvas")).toMatchObject({ title: "Documents board", project: "Garden room" });
    // The project's own note sits in the Projects folder, not inside a project: said by its folder.
    expect(at("04-Projects/garden-studio.md")).toMatchObject({ title: "Garden room", project: null });
  });

  it("anything else keeps project null, and the page says its folder", async () => {
    expect((await call("PUT", "/api/vault/note", { path: "Ideas/Loose.md", content: "# Loose\n", create: true })).status).toBe(200);
    expect((await call("POST", "/api/vault/trash", { path: "Ideas/Loose.md" })).status).toBe(200);
    expect((await trash()).find((t) => t.from === "Ideas/Loose.md")).toMatchObject({ title: "Loose", project: null });
  });
});
