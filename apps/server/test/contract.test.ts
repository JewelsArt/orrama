/**
 * Every answer the web app reads, checked against the schema it is typed by.
 *
 * packages/schema/src/responses.ts describes what each GET endpoint sends;
 * the web app's types are inferred from it. Here a fixture-rich server answers
 * each one and the answer is parsed with its schema (strict objects: a field
 * the schema does not list fails too), so the server and the web app cannot
 * drift apart without this going red. The last test reads the web app's
 * source: a GET it makes that is neither checked here nor named as skipped
 * fails, so a new endpoint cannot slip past.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-contract-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";
process.env.BASALT_FETCH_ALLOW = "127.0.0.1"; // the local calendar feed below

const vault = process.env.BASALT_VAULT_DIR;
const fx = await import("./contract-fixtures.js");
const R = await import("@basalt/schema/responses");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { encryptSecret } = await import("../src/secrets.js");

let b: Awaited<ReturnType<typeof buildServer>>;
let ics: Awaited<ReturnType<typeof fx.serveIcs>>;
let token = "";
let noteId = "";
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await b.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? (JSON.parse(r.body) as unknown) : null };
};
const must = async (method: string, url: string, payload?: unknown) => {
  const r = await call(method, url, payload);
  if (r.status !== 200) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as Record<string, unknown> & unknown[];
};

beforeAll(async () => {
  fs.mkdirSync(vault, { recursive: true });
  fx.writeVaultFixtures(vault);
  await import("../src/seed.js");
  await fx.writeProjectFiles(vault, "atlas");
  fx.writeBrokenBoard(vault, "acme");
  ics = await fx.serveIcs();
  b = await buildServer();
  const login = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json();
  token = login.token;
  const me = login.user.id as string;

  // Rows behind every list, made the way the app makes them.
  const ws = await must("GET", "/api/projects/atlas");
  const [t1, t2] = ws["tasks"] as { noteId: string; line: number; raw: string }[];
  await must("POST", "/api/events", { title: "Dentist", date: "2026-10-06", startMin: 540, durationMin: 60 });
  await must("POST", "/api/tasks/blocks", { noteId: t1!.noteId, line: t1!.line, text: t1!.raw, date: "2026-10-07", startMin: 600, durationMin: 60 });
  await must("POST", "/api/tokens", { label: "CLI" });
  await must("POST", "/api/webhooks", { url: "https://hooks.example.com/basalt", events: ["note.changed"] });
  await must("POST", "/api/me/ics-token");
  await must("POST", "/api/calendar/feeds", { label: "Work", url: ics.url });
  await must("PATCH", "/api/projects/atlas", { goals: "- Ship v1", prompt: "Be brief." });
  await must("POST", "/api/projects/atlas/decisions", { text: "Chose JSON Canvas" });
  await must("POST", "/api/projects/atlas/capture", { text: "an idea" });
  const contact = (await must("GET", "/api/contacts"))[0] as { id: string };
  await must("POST", "/api/projects/atlas/people", { noteId: contact.id });
  const board = await must("GET", "/api/projects/atlas/board");
  const files = (board["nodes"] as { id: string; type: string }[]).filter((n) => n.type === "file");
  await must("PUT", "/api/projects/atlas/board", { ...board, edges: [{ id: "e1", fromNode: files[0]!.id, toNode: files[1]!.id }] });
  // An orphaned task object: promote a line, then delete it from its note.
  await must("POST", "/api/tasks/promote", { noteId: t2!.noteId, line: t2!.line, text: t2!.raw });
  const host = (await must("GET", `/api/vault/note/${t2!.noteId}`)) as unknown as { path: string; content: string; hash: string };
  await must("PUT", "/api/vault/note", { path: host.path, content: host.content.split("\n").filter((_l, i) => i !== t2!.line).join("\n"), baseHash: host.hash });
  // What has no endpoint to create it without a real device or mail server.
  b.db.insert(tables.webauthnCredentials).values({ id: fx.uid("wa"), userId: me, credentialId: fx.uid("cred"), publicKey: "x", counter: 0, transports: "[]", label: "MacBook", createdAt: Date.now() }).run();
  b.db.insert(tables.mailAccounts).values({ id: fx.uid("mail"), userId: me, email: "jules@example.com", imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465, passwordEncrypted: encryptSecret("pw"), createdAt: Date.now(), lastCheckedAt: null, lastError: null }).run();
  b.db.insert(tables.mailDrafts).values({ id: fx.uid("draft"), userId: me, to: "x@example.com", subject: "Hi", body: "Hello", inReplyTo: null, references: null, createdBy: "agent", createdAt: Date.now() }).run();
  noteId = b.store.index.all().find((n) => n.path.includes("Atlas Roadmap"))!.id;
}, 60_000);

afterAll(async () => {
  await b.app.close();
  await ics.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

/** [the pattern the web app's source spells, the URL to call, its schema]. */
const CASES: [string, () => string, z.ZodTypeAny][] = [
  ["/api/me", () => "/api/me", R.meResponse],
  ["/api/auth/status", () => "/api/auth/status", R.authStatusResponse],
  ["/api/auth/sessions", () => "/api/auth/sessions", R.sessionsResponse],
  ["/api/auth/webauthn/credentials", () => "/api/auth/webauthn/credentials", R.passkeysResponse],
  ["/api/health", () => "/api/health", R.healthResponse],
  ["/api/admin/ai", () => "/api/admin/ai", R.aiConfigResponse],
  ["/api/ai/status", () => "/api/ai/status", R.aiStatusResponse],
  ["/api/teams", () => "/api/teams", R.teamsResponse],
  ["/api/dashboard/:x", () => "/api/dashboard/engineering", R.teamDashboardResponse],
  ["/api/vault/tree", () => "/api/vault/tree", R.treeResponse],
  ["/api/vault/graph", () => "/api/vault/graph", R.graphResponse],
  ["/api/vault/note/:x", () => `/api/vault/note/${noteId}`, R.noteResponse],
  ["/api/vault/note/:x/related", () => `/api/vault/note/${noteId}/related`, R.relatedResponse],
  ["/api/vault/search", () => "/api/vault/search?q=atlas", R.searchResponse],
  ["/api/plan", () => "/api/plan", R.planResponse],
  ["/api/events", () => "/api/events?from=2026-10-01&to=2026-10-31", R.eventsResponse],
  ["/api/calendar/markers", () => "/api/calendar/markers?from=2026-07-01&to=2026-10-31", R.markersResponse],
  ["/api/calendar/feeds", () => "/api/calendar/feeds", R.feedsResponse],
  ["/api/me/ics-token", () => "/api/me/ics-token", R.icsTokenResponse],
  ["/api/graph/schema", () => "/api/graph/schema", R.graphSchemaResponse],
  ["/api/graph/entities", () => "/api/graph/entities?type=company", R.graphEntitiesResponse],
  ["/api/graph/relations", () => "/api/graph/relations?entity=Fixture%20Co", R.graphRelationsResponse],
  ["/api/graph/path", () => "/api/graph/path?from=Fixture%20Person&to=Fixture%20Co", R.graphPathResponse],
  ["/api/graph/summaries", () => "/api/graph/summaries?type=conversation", R.graphSummariesResponse],
  ["/api/contacts", () => "/api/contacts", R.contactsResponse],
  ["/api/companies", () => "/api/companies", R.companiesResponse],
  ["/api/projects", () => "/api/projects", R.projectsResponse],
  ["/api/projects/:x", () => "/api/projects/atlas", R.projectWorkspaceResponse],
  ["/api/projects/:x/board", () => "/api/projects/atlas/board", R.boardResponse],
  ["/api/projects/:x/board", () => "/api/projects/acme/board", R.boardResponse], // unreadable canvas
  [":x/:x/html", () => "/api/projects/atlas/files/brief.docx/html", R.docHtmlResponse],
  [":x/:x/sheet", () => "/api/projects/atlas/files/budget.xlsx/sheet", R.sheetResponse],
  [":x/:x/slides", () => "/api/projects/atlas/files/deck.pptx/slides", R.deckResponse],
  ["/api/finance", () => "/api/finance", R.financeResponse],
  ["/api/finance/category/:x", () => "/api/finance/category/Groceries", R.financeCategoryResponse],
  ["/api/finance/month/:x", () => "/api/finance/month/2026-02", R.financeMonthResponse],
  ["/api/finance/merchant/:x", () => "/api/finance/merchant/UNIQLO", R.financeMerchantResponse],
  ["/api/home", () => "/api/home", R.homeResponse],
  ["/api/mail/account", () => "/api/mail/account", R.mailAccountResponse],
  ["/api/mail/drafts", () => "/api/mail/drafts", R.mailDraftsResponse],
  ["/api/tokens", () => "/api/tokens", R.tokensResponse],
  ["/api/webhooks", () => "/api/webhooks", R.webhooksResponse],
];

/** GETs the web app makes that no fixture can answer — named, with why. */
const SKIPPED: Record<string, string> = {
  "/api/mail/inbox": "live IMAP; typed by R.mailInboxResponse",
  "/api/mail/message/:x": "live IMAP; typed by R.mailMessageResponse",
  "/api/admin/ai/chatgpt/models": "needs a signed-in ChatGPT account; typed by R.chatgptModelsResponse",
};

const describeIssues = (e: z.ZodError) => e.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");

describe("every GET the web app reads matches its schema", () => {
  it.each(CASES.map(([pattern, url, schema]) => ({ pattern, url, schema })))("$pattern", async ({ url, schema }) => {
    const r = await call("GET", url());
    expect(r.status).toBe(200);
    const parsed = schema.safeParse(r.body);
    if (!parsed.success) throw new Error(`does not match its schema:\n${describeIssues(parsed.error)}`);
  });

  it("the web app makes no GET that is neither checked here nor named as skipped", () => {
    const web = path.join(import.meta.dirname, "../../web/src");
    const patterns = new Set<string>();
    for (const f of fs.readdirSync(web)) {
      if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f)) continue;
      const src = fs.readFileSync(path.join(web, f), "utf8");
      for (const m of src.matchAll(/api(?:<[^(]*>)?\(\s*"GET",\s*[`"]([^`"]+)[`"]/g)) {
        patterns.add(m[1]!.replace(/\$\{[^}]*\}/g, ":x").replace(/(:x)+/g, ":x").replace(/\?.*$/, ""));
      }
    }
    expect(patterns.size).toBeGreaterThan(30); // the scan itself works
    const known = new Set([...CASES.map(([p]) => p), ...Object.keys(SKIPPED)]);
    expect([...patterns].filter((p) => !known.has(p)).sort()).toEqual([]);
  });
});
