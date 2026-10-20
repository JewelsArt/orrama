/**
 * A project's group inside its area is front matter `group:` (Jules, 20 Oct: "some work is for
 * Scooperz, some for my website making, some personal branding"). The list and the workspace
 * send it, PATCH writes it as one tidy line, and clearing it drops the line instead of leaving
 * `group: ""` in the note.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-project-group-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let token = "";
const VAULT = process.env.ORRAMA_VAULT_DIR;

const api = async (method: string, url: string, body?: unknown) => {
  const res = await built.app.inject({
    method: method as "GET",
    url,
    headers: signedIn(token),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};
const onDisk = (rel: string) => fs.readFileSync(path.join(VAULT, rel), "utf8");
const listed = async (slug: string) => ((await api("GET", "/api/projects")).json as { slug: string; group: string | null }[]).find((p) => p.slug === slug);

beforeAll(async () => {
  built = await buildServer();
  token = sessionOf(await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
  const r = await api("PUT", "/api/vault/note", {
    path: "04-Projects/shop-site.md",
    content: ["---", "title: Shop site", "domain: professional", "group: Websites", "tags: [project, project/shop-site]", "---", "# Shop site", "", "- [ ] Draft the home page", ""].join("\n"),
  });
  expect(r.status).toBe(200);
  const r2 = await api("PUT", "/api/vault/note", {
    path: "04-Projects/loose.md",
    content: ["---", "title: Loose", "domain: professional", "tags: [project, project/loose]", "---", "# Loose", ""].join("\n"),
  });
  expect(r2.status).toBe(200);
});
afterAll(async () => {
  await built.app.close();
});

describe("a project's group", () => {
  it("is sent by the list and the workspace, and is null or empty without one", async () => {
    expect((await listed("shop-site"))?.group).toBe("Websites");
    expect((await api("GET", "/api/projects/shop-site")).json.group).toBe("Websites");
    expect((await listed("loose"))?.group).toBeNull();
    expect((await api("GET", "/api/projects/loose")).json.group).toBe("");
  });

  it("is written as one tidy line, and the rest of the front matter stays", async () => {
    expect((await api("PATCH", "/api/projects/loose", { group: "  Personal\n  branding  " })).status).toBe(200);
    const text = onDisk("04-Projects/loose.md");
    expect(text).toMatch(/^group: Personal branding$/m);
    expect(text).toMatch(/^title: Loose$/m);
    expect(text).toMatch(/^domain: professional$/m);
    expect((await listed("loose"))?.group).toBe("Personal branding");
  });

  it("is capped at 60 characters", async () => {
    await api("PATCH", "/api/projects/loose", { group: "x".repeat(90) });
    expect((await api("GET", "/api/projects/loose")).json.group).toBe("x".repeat(60));
  });

  it("cleared, drops the line from the note", async () => {
    expect((await api("PATCH", "/api/projects/shop-site", { group: "" })).status).toBe(200);
    expect(onDisk("04-Projects/shop-site.md")).not.toMatch(/^group:/m);
    expect((await listed("shop-site"))?.group).toBeNull();
  });
});
