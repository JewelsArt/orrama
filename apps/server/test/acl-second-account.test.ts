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
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-acl-s12-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";
// Webhooks (ACL-007) deliver to a receiver on this machine, after a short debounce.
process.env.BASALT_FETCH_ALLOW = "127.0.0.1";
process.env.BASALT_WEBHOOK_DEBOUNCE_MS = "150";

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

describe("ACL-005: saves, moves and links never confirm a note you cannot read", () => {
  const vault = () => process.env.BASALT_VAULT_DIR!;
  const same = (a: { status: number; body: string }, b: { status: number; body: string }) => expect([a.status, a.body]).toEqual([b.status, b.body]);
  const probe = (notePath: string, extra: Record<string, unknown> = {}) => put("erin", notePath, "probe", extra);

  beforeAll(async () => {
    expect((await api("POST", "/api/capture", "mara", { text: "call the recruiter" })).status).toBe(200); // Personal/mara/Inbox.md
    // In a folder erin edits, restricted to marketing.
    expect((await put("mara", "Shared/Launch plan.md", "---\ntags: [only/marketing]\n---\nheadcount cuts: 4\n")).status).toBe(200);
    // An unreadable note whose filename is a readable note's alias.
    expect((await put("jules", "Marketing/Roadmap.md", "---\ntags: [only/marketing]\n---\nsecret roadmap\n")).status).toBe(200);
  });

  it("a save with any baseHash answers an unreadable note as it answers a missing one", async () => {
    same(await probe("Marketing/Surprise Campaign.md", { baseHash: "0000000000000000" }), await probe("Marketing/No Such Note.md", { baseHash: "0000000000000000" }));
    same(await probe("Personal/mara/Inbox.md", { baseHash: "0000000000000000" }), await probe("Personal/mara/Diary.md", { baseHash: "0000000000000000" }));
    same(await probe("Personal/mara/Inbox.md"), await probe("Personal/mara/Diary.md"));
  });

  it("a right and a wrong guess of an unreadable note's text get the same answer", async () => {
    const { hash } = await import("../src/vaultStore.js");
    const real = fs.readFileSync(path.join(vault(), "Shared/Launch plan.md"), "utf8");
    const right = await probe("Shared/Launch plan.md", { baseHash: hash(real) });
    const wrong = await probe("Shared/Launch plan.md", { baseHash: hash(real.replace("4", "5")) });
    same(right, wrong);
    expect(right.status).toBe(403);
    expect(fs.readFileSync(path.join(vault(), "Shared/Launch plan.md"), "utf8")).toBe(real);
  });

  it("a create-only save answers an unreadable note as it answers a missing one", async () => {
    same(await probe("Personal/mara/Inbox.md", { create: true }), await probe("Personal/mara/Diary.md", { create: true }));
  });

  it("moving onto an unreadable note answers as moving onto nothing", async () => {
    const move = (toPath: string) => api("POST", "/api/vault/move", "erin", { fromPath: "Engineering/Atlas Architecture.md", toPath });
    same(await move("Marketing/Surprise Campaign.md"), await move("Marketing/No Such Note.md"));
    same(await move("Personal/mara/Inbox.md"), await move("Personal/mara/Diary.md"));
  });

  it("a link to an unreadable note reads exactly like a link to nothing", async () => {
    const w = await put("erin", "Engineering/probe.md", "[[Surprise Campaign]] [[Nonexistent Campaign]] [[Personal/mara/Inbox]] [[Personal/mara/Diary]]\n");
    const links = (await api("GET", `/api/vault/note/${w.json.id}`, "erin")).json.links as { target: string; locked: boolean; targetId: string | null }[];
    const shape = (t: string) => {
      const l = links.find((x) => x.target === t)!;
      return { locked: l.locked, targetId: l.targetId };
    };
    expect(shape("Surprise Campaign")).toEqual(shape("Nonexistent Campaign"));
    expect(shape("Personal/mara/Inbox")).toEqual(shape("Personal/mara/Diary"));
  });

  it("a link resolves to the note you can read, not to an unreadable one with a stronger key", async () => {
    const atlas = b.store.index.getByPath("Engineering/Atlas Roadmap.md")!;
    const w = await put("erin", "Engineering/probe2.md", "see [[Roadmap]]\n");
    const links = (await api("GET", `/api/vault/note/${w.json.id}`, "erin")).json.links as { targetId: string | null }[];
    expect(links.map((l) => l.targetId)).toEqual([atlas.id]);
    const back = (await api("GET", `/api/vault/note/${atlas.id}`, "erin")).json.backlinks as { fromId: string }[];
    expect(back.map((l) => l.fromId)).toContain(w.json.id);
    const graph = (await api("GET", "/api/vault/graph", "erin")).json as { edges: { from: string; to: string }[] };
    expect(graph.edges).toContainEqual({ from: w.json.id, to: atlas.id });
  });
});

describe("ACL-007: a webhook delivery is judged when it goes out", () => {
  const got: { event: string; note: { id: string; path: string; title: string } | null }[] = [];
  let receiver: http.Server;
  const settle = () => new Promise((r) => setTimeout(r, 600));

  beforeAll(async () => {
    receiver = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got.push(JSON.parse(body));
        res.end("ok");
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    const port = (receiver.address() as { port: number }).port;
    expect((await api("POST", "/api/webhooks", "erin", { url: `http://127.0.0.1:${port}/hook`, events: ["note.changed"] })).status).toBe(200);
  });
  afterAll(() => new Promise<void>((r) => receiver.close(() => r())));

  it("a note moved where the hook's owner cannot read it is not delivered", async () => {
    got.length = 0;
    expect((await put("jules", "Shared/Draft.md", "---\ntitle: Draft\n---\nwip\n")).status).toBe(200);
    expect((await api("POST", "/api/vault/move", "jules", { fromPath: "Shared/Draft.md", toPath: "Marketing/Layoffs plan - March.md" })).status).toBe(200);
    await settle();
    expect(JSON.stringify(got)).not.toContain("Layoffs");
  });

  it("a note restricted and retitled in the wait is not delivered", async () => {
    got.length = 0;
    const first = await put("jules", "Shared/Notes.md", "---\ntitle: Notes\n---\nwip\n");
    expect(first.status).toBe(200);
    const second = await put("jules", "Shared/Notes.md", "---\ntitle: Acquisition of Acme Corp\ntags: [only/marketing]\n---\nwip\n", { baseHash: first.json.hash });
    expect(second.status).toBe(200);
    await settle();
    expect(JSON.stringify(got)).not.toContain("Acquisition");
  });

  it("a note the owner can still read is delivered as before", async () => {
    got.length = 0;
    expect((await put("jules", "Shared/Weekly.md", "---\ntitle: Weekly\n---\nagenda\n")).status).toBe(200);
    await settle();
    expect(got.map((p) => [p.event, p.note?.path])).toEqual([["note.changed", "Shared/Weekly.md"]]);
  });
});
