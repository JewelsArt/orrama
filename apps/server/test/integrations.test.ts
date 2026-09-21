/**
 * Integration layer over real HTTP: personal API tokens, the inbound ICS
 * subscription, the outbound private feed, and HMAC-signed webhooks — with the
 * same §5.4 leak rule as every other surface (a hook never learns about notes
 * its owner can't read).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-integr-"));
// Pin the vault INSIDE this test's temp data dir. Without this line vaultDir()
// falls through to BASALT_VAULT_DIR from the surrounding shell - which INSTALL.md
// tells people to export - and the suite writes its demo notes into the real
// Obsidian vault, then id-stamps every note it finds there. Same location the
// default computes; stated explicitly so the environment cannot redirect it.
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret";
// The startup guard refuses placeholder secrets everywhere now, not just
// under NODE_ENV=production, so the suite has to carry a real-shaped one too.
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";
process.env.BASALT_WEBHOOK_DEBOUNCE_MS = "40";
process.env.TZ = "Europe/Amsterdam";

const { buildServer } = await import("../src/main.js");

let app: Awaited<ReturnType<typeof buildServer>>["app"];
const tokens: Record<string, string> = {};

const api = async (method: string, url: string, auth?: string, body?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: res.json.bind(res), body: res.body };
};

/** Tiny local HTTP server: serves an ICS body and records webhook deliveries. */
interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}
let helper: http.Server;
let helperPort: number;
let icsBody = "";
const received: Received[] = [];

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
  return pred();
};

beforeAll(async () => {
  await import("../src/seed.js");
  const built = await buildServer();
  app = built.app;
  for (const email of ["jules@basalt.dev", "erin@basalt.dev", "mara@basalt.dev"]) {
    const r = await api("POST", "/api/auth/login", undefined, { email, password: "basalt-demo" });
    tokens[email.split("@")[0]!] = r.json().token;
  }
  helper = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.setHeader("content-type", "text/calendar");
      res.end(icsBody);
      return;
    }
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: data });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => helper.listen(0, "127.0.0.1", resolve));
  helperPort = (helper.address() as { port: number }).port;
});

afterAll(async () => {
  await app.close();
  helper.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("personal API tokens", () => {
  let apiToken = "";
  let tokenId = "";

  it("creates a token that authenticates as the caller", async () => {
    const r = await api("POST", "/api/tokens", tokens["jules"], { label: "Shortcut" });
    expect(r.status).toBe(200);
    apiToken = r.json().token;
    tokenId = r.json().id;
    expect(apiToken).toMatch(/^bslt_[0-9a-f]{48}$/);

    const me = await api("GET", "/api/me", apiToken);
    expect(me.status).toBe(200);
    expect(me.json().username).toBe("jules");
  });

  it("keeps the caller's ACL: token user sees exactly what the session user sees", async () => {
    const viaToken = await api("GET", "/api/vault/tree", apiToken);
    const viaJwt = await api("GET", "/api/vault/tree", tokens["jules"]);
    expect(viaToken.json().length).toBe(viaJwt.json().length);
  });

  it("rejects unknown tokens and blocks token-based token management", async () => {
    expect((await api("GET", "/api/me", `bslt_${"0".repeat(48)}`)).status).toBe(401);
    expect((await api("POST", "/api/tokens", apiToken, { label: "sneaky" })).status).toBe(403);
    expect((await api("GET", "/api/tokens", apiToken)).status).toBe(403);
  });

  it("revocation kills the token immediately", async () => {
    expect((await api("DELETE", `/api/tokens/${tokenId}`, tokens["jules"])).status).toBe(200);
    expect((await api("GET", "/api/me", apiToken)).status).toBe(401);
  });
});

describe("inbound ICS feeds", () => {
  it("rejects an address that is not a calendar", async () => {
    icsBody = "<html>definitely not ics</html>";
    const r = await api("POST", "/api/calendar/feeds", tokens["jules"], {
      label: "Bad",
      url: `http://127.0.0.1:${helperPort}/bad.ics`,
    });
    expect(r.status).toBe(400);
  });

  it("subscribes and renders occurrences in /api/events for the owner only", async () => {
    icsBody = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:lecture-1",
      "DTSTART;TZID=Europe/Amsterdam:20260629T090000",
      "DTEND;TZID=Europe/Amsterdam:20260629T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TH",
      "SUMMARY:TCL exam prep",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const add = await api("POST", "/api/calendar/feeds", tokens["jules"], {
      label: "Uni",
      url: `http://127.0.0.1:${helperPort}/uni.ics`,
    });
    expect(add.status).toBe(200);
    expect(add.json().eventCount).toBe(1);
    expect(add.json().host).toBe(`127.0.0.1:${helperPort}`);

    const mine = await api("GET", "/api/events?from=2026-07-06&to=2026-07-12", tokens["jules"]);
    const ics = mine.json().filter((e: { source?: string }) => e.source === "ics");
    expect(ics.map((e: { date: string; startMin: number }) => [e.date, e.startMin])).toEqual([
      ["2026-07-06", 540],
      ["2026-07-09", 540],
    ]);
    expect(ics[0].readonly).toBe(true);
    expect(ics[0].feedLabel).toBe("Uni");

    // Erin queries the same range: jules's subscribed calendar is not hers to see.
    const erin = await api("GET", "/api/events?from=2026-07-06&to=2026-07-12", tokens["erin"]);
    expect(erin.json().filter((e: { source?: string }) => e.source === "ics")).toEqual([]);
  });
});

describe("outbound ICS feed", () => {
  it("serves my events to an unauthenticated subscriber via the secret URL", async () => {
    await api("POST", "/api/events", tokens["jules"], { title: "Scooperz defense", date: "2026-07-01", startMin: 600, durationMin: 90 });
    const mint = await api("POST", "/api/me/ics-token", tokens["jules"]);
    const token = mint.json().token;

    const feed = await api("GET", `/ics/${token}.ics`);
    expect(feed.status).toBe(200);
    expect(feed.body).toContain("BEGIN:VCALENDAR");
    expect(feed.body).toContain("SUMMARY:Scooperz defense");

    // rotate → old URL is dead, new one works
    const rotated = (await api("POST", "/api/me/ics-token", tokens["jules"])).json().token;
    expect((await api("GET", `/ics/${token}.ics`)).status).toBe(404);
    expect((await api("GET", `/ics/${rotated}.ics`)).status).toBe(200);
    expect((await api("DELETE", "/api/me/ics-token", tokens["jules"])).status).toBe(200);
    expect((await api("GET", `/ics/${rotated}.ics`)).status).toBe(404);
  });
});

describe("webhooks", () => {
  let secret = "";

  it("registers a hook and receives a signed test ping", async () => {
    const r = await api("POST", "/api/webhooks", tokens["mara"], {
      url: `http://127.0.0.1:${helperPort}/hook`,
      events: ["note.changed", "task.completed"],
    });
    expect(r.status).toBe(200);
    secret = r.json().secret;
    expect(secret).toMatch(/^whsec_/);

    received.length = 0;
    const test = await api("POST", `/api/webhooks/${r.json().id}/test`, tokens["mara"]);
    expect(test.json().status).toBe(200);
    expect(received).toHaveLength(1);
    const expected = `sha256=${crypto.createHmac("sha256", secret).update(received[0]!.body).digest("hex")}`;
    expect(received[0]!.headers["x-basalt-signature"]).toBe(expected);
    expect(JSON.parse(received[0]!.body).event).toBe("ping");
  });

  it("fires note.changed for readable notes, signed and debounced", async () => {
    received.length = 0;
    const tree = await api("GET", "/api/vault/tree", "" + tokens["mara"]);
    const note = tree.json().find((n: { path: string }) => n.path === "Marketing/Surprise Campaign.md");
    const detail = await api("GET", `/api/vault/note/${note.id}`, tokens["mara"]);
    const w = await api("PUT", "/api/vault/note", tokens["mara"], {
      path: "Marketing/Surprise Campaign.md",
      content: detail.json().content + "\nwebhook test line\n",
    });
    expect(w.status).toBe(200);

    expect(await waitFor(() => received.length >= 1)).toBe(true);
    const payload = JSON.parse(received[0]!.body);
    expect(payload.event).toBe("note.changed");
    expect(payload.note.path).toBe("Marketing/Surprise Campaign.md");
    expect(payload.author).toBe("mara");
    const expected = `sha256=${crypto.createHmac("sha256", secret).update(received[0]!.body).digest("hex")}`;
    expect(received[0]!.headers["x-basalt-signature"]).toBe(expected);
  });

  it("never fires for a note the hook owner cannot read (§5.4)", async () => {
    received.length = 0;
    // jules edits an #only/engineering note — mara's hook must stay silent.
    const tree = await api("GET", "/api/vault/tree", tokens["jules"]);
    const runbook = tree.json().find((n: { path: string }) => n.path === "Engineering/Incident Runbook.md");
    const detail = await api("GET", `/api/vault/note/${runbook.id}`, tokens["jules"]);
    await api("PUT", "/api/vault/note", tokens["jules"], {
      path: "Engineering/Incident Runbook.md",
      content: detail.json().content + "\nsecret engineering line\n",
    });
    expect(await waitFor(() => received.length > 0, 400)).toBe(false);
  });

  it("fires task.completed when a checkbox is checked", async () => {
    received.length = 0;
    const tree = await api("GET", "/api/vault/tree", tokens["mara"]);
    const note = tree.json().find((n: { path: string }) => n.path === "Marketing/Surprise Campaign.md");
    const detail = await api("GET", `/api/vault/note/${note.id}`, tokens["mara"]);
    const task = detail.json().tasks.find((t: { checked: boolean }) => !t.checked);
    expect(task).toBeDefined();

    const r = await api("POST", "/api/tasks/check", tokens["mara"], { noteId: note.id, line: task.line, checked: true });
    expect(r.status).toBe(200);

    expect(await waitFor(() => received.some((m) => JSON.parse(m.body).event === "task.completed"))).toBe(true);
    const payload = JSON.parse(received.find((m) => JSON.parse(m.body).event === "task.completed")!.body);
    expect(payload.task.text).toBe(task.text);
    expect(payload.author).toBe("mara");
  });
});
