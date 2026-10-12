/**
 * Leak tests for the day Basalt has a second account (audit wave S12). Each one
 * is the §5 permission model over real HTTP on the seeded workspace — jules
 * owns it, erin is in engineering, mara in marketing, and mara cannot read
 * `Engineering/` — and asserts one leak per test. Release-blocking, like the
 * rest of the permission tests: today Jules is the only account, and these
 * hold the line for the first collaborator, invitee or API token for someone
 * else.
 *
 * The common root (audit README, root cause 5): authorisation anchored on data
 * the caller controls — their own notes' tags, their own guesses.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-acl-s12-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");

let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};

const api = async (method: string, url: string, who: string, body?: unknown) => {
  const res = await b.app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${tokens[who]}` },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.statusCode, json, body: res.body };
};
const put = (who: string, notePath: string, content: string, extra: Record<string, unknown> = {}) =>
  api("PUT", "/api/vault/note", who, { path: notePath, content, ...extra });

beforeAll(async () => {
  b = await buildServer();
  for (const who of ["jules", "erin", "mara"]) {
    const res = await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@basalt.dev`, password: "basalt-demo" } });
    expect(res.statusCode).toBe(200);
    tokens[who] = res.json().token;
  }
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("ACL-002: tagging your own note never opens someone else's project", () => {
  const files = [
    ["GET", "/api/projects/reorg/files/salaries.csv"],
    ["GET", "/api/projects/reorg/files/plan.docx/html"],
    ["GET", "/api/projects/reorg/files/plan.xlsx/sheet"],
    ["GET", "/api/projects/reorg/files/plan.pptx/slides"],
    ["DELETE", "/api/projects/reorg/files/salaries.csv"],
  ] as const;

  beforeAll(async () => {
    // Engineering's project note lives outside 04-Projects/ (folder is irrelevant).
    expect((await put("jules", "Engineering/Reorg 2027.md", "---\ntitle: Reorg 2027\ntags: [project/reorg]\n---\n# Reorg 2027\n\n- [ ] draft org chart\n")).status).toBe(200);
    const up = await api("POST", "/api/projects/reorg/files", "jules", { name: "salaries.csv", dataBase64: Buffer.from("name,salary\nerin,120000\n").toString("base64") });
    expect(up.status).toBe(200);
    // mara, who cannot read Engineering/, tags a note of her own with the key —
    // and an older one too, carrying an id that sorts before the project note's.
    expect((await put("mara", "Marketing/mine.md", "---\ntags: [project/reorg]\n---\n- [ ] my own step\n")).status).toBe(200);
    expect((await put("mara", "Marketing/old.md", "---\nid: n-000000000000aa\ntags: [project/reorg]\n---\nold\n")).status).toBe(200);
  });

  it("the workspace is a 404 to her", async () => {
    expect((await api("GET", "/api/projects/reorg", "mara")).status).toBe(404);
  });

  it("every document route is a 404 to her", async () => {
    for (const [method, url] of files) expect((await api(method, url, "mara")).status, `${method} ${url}`).toBe(404);
    const up = await api("POST", "/api/projects/reorg/files", "mara", { name: "salaries.csv", dataBase64: Buffer.from("name,salary\nmara,999999\n").toString("base64") });
    expect(up.status).toBe(404);
    expect(fs.readdirSync(path.join(process.env.BASALT_VAULT_DIR!, "04-Projects/reorg/files"))).toEqual(["salaries.csv"]);
  });

  it("the board is a 404 to her, to read and to save", async () => {
    expect((await api("GET", "/api/projects/reorg/board", "mara")).status).toBe(404);
    expect((await api("PUT", "/api/projects/reorg/board", "mara", { nodes: [], edges: [] })).status).toBe(404);
  });

  it("the project list does not carry its name or note to her", async () => {
    const list = (await api("GET", "/api/projects", "mara")).json as { slug: string; name: string; noteId: string | null }[];
    expect(list.some((p) => p.slug === "reorg" || p.name === "Reorg 2027")).toBe(false);
  });

  it("her own tasks are not attributed to it by name", async () => {
    const tasks = (await api("GET", "/api/tasks", "mara")).json as { text: string; project: string | null }[];
    expect(tasks.find((t) => t.text === "my own step")?.project).toBeNull();
  });

  it("the team that can read the project note still opens it, documents included", async () => {
    const ws = await api("GET", "/api/projects/reorg", "erin");
    expect(ws.status).toBe(200);
    expect(ws.json.name).toBe("Reorg 2027");
    expect(ws.json.files.map((f: { name: string }) => f.name)).toEqual(["salaries.csv"]);
    expect((await api("GET", "/api/projects/reorg/files/salaries.csv", "erin")).body).toBe("name,salary\nerin,120000\n");
  });
});

describe("ACL-004: the team dashboard names only projects you can read", () => {
  beforeAll(async () => {
    expect((await put("jules", "Personal/jules/Divorce lawyer shortlist.md", "---\ntags: [project/divorce]\n---\nprivate\n")).status).toBe(200);
  });
  const names = async (who: string, team: string) => {
    const r = await api("GET", `/api/dashboard/${team}`, who);
    expect(r.status).toBe(200);
    return (r.json.projects as { project: string }[]).map((p) => p.project);
  };

  it("a personal project with no tasks is on no one else's board", async () => {
    expect(await names("erin", "engineering")).not.toContain("Divorce lawyer shortlist");
    expect(await names("mara", "marketing")).not.toContain("Divorce lawyer shortlist");
  });

  it("a folder project on a folder you cannot read is on no one else's board", async () => {
    b.db.insert(tables.projects).values({ id: "p-acl004f", kind: "folder", key: "Personal/jules/Private", name: "Jules's private folder", teamId: null }).run();
    expect(await names("erin", "engineering")).not.toContain("Jules's private folder");
    expect(await names("jules", "engineering")).toContain("Jules's private folder");
  });

  it("a readable project with no tasks still is on its reader's board", async () => {
    expect(await names("jules", "engineering")).toContain("Divorce lawyer shortlist");
  });
});
