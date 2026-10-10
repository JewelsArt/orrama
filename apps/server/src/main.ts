import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { createDb, tables } from "./db.js";
import { assertProductionSecrets, assertValidEnv, env, vaultDir } from "./env.js";
import { HttpError, VaultStore } from "./vaultStore.js";
import { runDataMigrations } from "./migrations.js";
import { CalendarNotes } from "./calendarNotes.js";
import { compactAll } from "./history.js";
import { isEntry } from "./entry.js";
import { authRoutes } from "./routes/auth.js";
import { vaultRoutes } from "./routes/vault.js";
import { taskRoutes } from "./routes/tasks.js";
import { projectRoutes } from "./routes/projects.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { adminRoutes } from "./routes/admin.js";
import { aiRoutes } from "./routes/ai.js";
import { wsRoutes } from "./routes/ws.js";
import { planRoutes } from "./routes/plan.js";
import { calendarRoutes } from "./routes/calendar.js";
import { contactRoutes } from "./routes/contacts.js";
import { graphRoutes } from "./routes/graph.js";
import { financeRoutes } from "./routes/finance.js";
import { homeRoutes } from "./routes/home.js";
import { icsRoutes } from "./routes/ics.js";
import { mailRoutes } from "./routes/mail.js";
import { integrationRoutes, hashToken } from "./routes/integrations.js";
import { initWebhooks } from "./webhooks.js";
import { sessionUser } from "./sessions.js";
import { eq } from "drizzle-orm";
import { privateLogFiles, reqSerializer, rotateLogIfLarge } from "./logging.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    userId: string;
    /** The sign-in session behind a JWT (sessions.ts); unset for API tokens. */
    sessionId?: string;
    /** True when authenticated with a personal API token instead of a session JWT. */
    viaToken?: boolean;
  }
  interface FastifyContextConfig {
    /**
     * Refuse API tokens on this route, saying why. For anything that creates,
     * changes or reveals a credential, or decides where one is sent — see
     * `authenticate`. Use `sessionOnly(reason)` from auth.ts.
     */
    sessionOnly?: string;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Is `host` (a Host header) a name this server answers to? Loopback, or a
 * host named in BASALT_PUBLIC_ORIGINS (the tailnet name); any port, because
 * vite dev proxies from :4625 and the attacker below controls the name, not
 * the port.
 *
 * CORS stops another site READING our responses, but not DNS rebinding: a
 * page on evil.example re-points its own name at 127.0.0.1, and from then on
 * it is same-origin with this server, so CORS never applies. Binding to
 * 127.0.0.1 does not help — the user's own browser makes the connection.
 * Without this, a page the user merely visited could drive the
 * unauthenticated auth routes: found the owner on a fresh install, guess the
 * passcode, enumerate accounts (audit SEC-005). The one thing such a page
 * cannot change is the Host its browser sends, which is its own name.
 */
export function allowedHost(host: string | undefined, publicOrigins: string[]): boolean {
  // No Host at all is not a browser — every browser sends one, and the only
  // client that can leave it out could equally write "localhost" in it.
  if (host === undefined) return true;
  // A name and an optional port, nothing URL-shaped: "localhost/x" or
  // "localhost@evil" would otherwise parse to a hostname of our choosing.
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(host)) return false;
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTS.has(name)) return true;
  return publicOrigins.some((o) => {
    try {
      return new URL(o).hostname === name;
    } catch {
      return false;
    }
  });
}

/** `logStream` lets a test read exactly what the real app logs. */
export async function buildServer(opts: { logStream?: NodeJS.WritableStream } = {}) {
  assertValidEnv();
  assertProductionSecrets();
  const db = createDb();
  // Single-workspace server (spec §3): one company, one vault, one container.
  if (db.select().from(tables.workspace).all().length === 0) {
    db.insert(tables.workspace).values({ id: `w-${crypto.randomUUID().slice(0, 8)}`, name: "Basalt Workspace" }).run();
  }
  const store = new VaultStore(db);
  store.load();
  await store.watching;
  const calendar = new CalendarNotes(db, store);
  runDataMigrations(db, store, calendar);
  store.reconcileAll();
  // The block/event tables are an index of the calendar notes: re-read them all,
  // then keep each one current as it changes.
  calendar.rebuildAll();
  calendar.listen();
  // The Yjs log only ever grew. Merge old runs now and once a day (history.ts).
  const compact = () => {
    try {
      const removed = compactAll(db);
      if (removed) app.log.info(`history: compacted ${removed} old updates`);
    } catch (err) {
      app.log.error(err, "history compaction failed");
    }
  };

  const vaultRoot = vaultDir();
  const mcpPath = path.join(vaultRoot, ".mcp.json");
  if (!fs.existsSync(mcpPath)) {
    fs.writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        basalt: {
          command: "node",
          args: [path.resolve(import.meta.dirname, "../../mcp/dist/index.js")],
          env: {
            BASALT_TOKEN: "bslt_your_api_token_here",
            BASALT_URL: "http://localhost:4623"
          }
        }
      }
    }, null, 2));
  }

  const claudeMdPath = path.join(vaultRoot, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, `Edit notes through the Basalt MCP tools, not by writing files directly; direct file edits are absorbed by a watcher but lose granular history.
    
Vault layout:
- Notes are plain markdown files.
- Folders grant access.
- \`#only/<team>\` tags restrict access.
`);
  }

  /**
   * A second line behind the HTML scrubbers (.docx reader, mail): if markup
   * ever slips through into our origin, it still cannot run script — no inline
   * script, no `on*` handler, no `javascript:` URL, nothing from another host.
   *
   * What the rest allows, and why:
   * - style 'unsafe-inline': React `style={…}` props are inline styles.
   * - img/font https: + http:: the mail reader's srcdoc iframe INHERITS this
   *   policy (the two intersect), so "Show images" needs remote images here.
   * - blob: the document reader shows PDFs and images from object URLs.
   * - frame-ancestors 'self', not 'none': a blob: document INHERITS this
   *   policy, so with 'none' the PDF refused to be framed by Basalt itself and
   *   every PDF and payslip in the desktop app (WebKit) went blank from 25 Sep.
   *   'self' still stops any other site framing Basalt. Found by bisecting the
   *   policy in a WKWebView; Chrome showed nothing wrong.
   * - connect 'self' covers the same-origin WebSocket.
   * Not on /api: JSON is never rendered as a document, so a CSP there does nothing.
   */
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https:",
    "img-src 'self' data: blob: https: http:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");

  // URLs in the log are redacted: no query strings, no /ics/<token> (logging.ts).
  const app = Fastify({
    logger: { level: "info", serializers: { req: reqSerializer }, ...(opts.logStream ? { stream: opts.logStream } : {}) },
  });
  // Before anything else, routes and static files alike: a request must be
  // addressed to a name this server answers to (`allowedHost`).
  app.addHook("onRequest", async (req, reply) => {
    if (!allowedHost(req.headers.host, env.publicOrigins)) {
      return reply.code(421).send({ error: "this server does not answer to that host name — add it to BASALT_PUBLIC_ORIGINS" });
    }
  });
  // Stop the vault watcher with the app, so a closed server stops reacting to files.
  app.addHook("onClose", async () => store.close());
  compact();
  const compactTimer = setInterval(compact, 24 * 3_600_000);
  compactTimer.unref();
  app.addHook("onClose", async () => clearInterval(compactTimer));
  // Last: the database, once everything that writes to it has stopped.
  app.addHook("onClose", async () => (db as unknown as { $client: { close(): void } }).$client.close());
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    // Every non-API response, not just text/html: a revalidated index.html
    // comes back as a bare 304, and the browser keeps the headers it stored
    // with the 200 — so a shell cached before this header existed would stay
    // unprotected for as long as the file's ETag does not change.
    if (!req.url.startsWith("/api/")) reply.header("content-security-policy", CSP);
    return payload;
  });
  await app.register(cors, { origin: env.corsOrigin });
  await app.register(jwt, { secret: env.jwtSecret });
  await app.register(websocket);

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    // Personal API tokens (`bslt_…`) ride the same gate as JWTs: scripts and
    // shortcuts get the caller's normal permissions, nothing more.
    const header = (req.headers.authorization ?? "") as string;
    if (header.startsWith("Bearer bslt_")) {
      const row = db.select().from(tables.apiTokens).where(eq(tables.apiTokens.tokenHash, hashToken(header.slice(7)))).get();
      if (!row) return reply.code(401).send({ error: "invalid API token" });
      // A token is the weaker credential, and stays that way: it may never
      // create, change or reveal a credential, or re-aim one. That used to be
      // a `viaToken` line in two routes, so every other one was open — a
      // token set a passcode, unlocked with it and held a full session, then
      // minted siblings; it re-pointed the AI key at its own server and
      // replaced the mail account (audit SEC-013, SEC-004, SEC-014). Now a
      // route says so once, in its config, and it is refused here.
      const sessionOnly = req.routeOptions.config.sessionOnly;
      if (sessionOnly) return reply.code(403).send({ error: sessionOnly });
      req.userId = row.userId;
      req.viaToken = true;
      db.update(tables.apiTokens).set({ lastUsedAt: Date.now() }).where(eq(tables.apiTokens.id, row.id)).run();
      return;
    }
    let payload: { sub?: unknown; sid?: unknown };
    try {
      payload = await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "authentication required" });
    }
    // A valid signature is not enough: the session must still be open
    // (sessions.ts) — signed out, revoked from Settings, or from before
    // sessions existed, it is refused.
    const userId = sessionUser(db, payload);
    if (!userId) return reply.code(401).send({ error: "this session has ended — sign in again" });
    req.userId = userId;
    req.sessionId = payload.sid as string;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
    // Fastify's own rejections of a request (malformed or empty JSON, an
    // unsupported content type, a body over the limit) are the client's fault:
    // they keep their 4xx and message instead of reading as a server crash.
    // Only FST_ errors — anything else carrying a statusCode came from a
    // library and its message may describe the far end.
    const fst = err as { code?: unknown; statusCode?: unknown; message: string };
    if (typeof fst.code === "string" && fst.code.startsWith("FST_") && typeof fst.statusCode === "number" && fst.statusCode >= 400 && fst.statusCode < 500) {
      return reply.code(fst.statusCode).send({ error: fst.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  await authRoutes(app, db, store);
  await vaultRoutes(app, db, store);
  await taskRoutes(app, db, store);
  await projectRoutes(app, store, db);
  await dashboardRoutes(app, db, store);
  await adminRoutes(app, db, store);
  await aiRoutes(app, db, store, calendar);
  await wsRoutes(app, db, store);
  await planRoutes(app, db, store);
  await calendarRoutes(app, db, store, calendar);
  await contactRoutes(app, db, store);
  await graphRoutes(app, store);
  await homeRoutes(app, db, store);
  await financeRoutes(app, db, store);
  await icsRoutes(app, db, store);
  await mailRoutes(app, db);
  await integrationRoutes(app, db, store);
  initWebhooks(db, store);

  // Serve the built web app when present (self-host: one container serves everything).
  const webDist = path.resolve(import.meta.dirname, "../../web/dist");

  /**
   * Digest of the bundle currently on disk. `index.html` names the hashed asset
   * files, so it changes exactly when a rebuild produces new ones — which makes
   * it the answer to "is the running tab stale?". The web client remembers the
   * value it booted with and lights up the rail's Reload button when the served
   * build moves past it; without that the only way to pick up a `pnpm ship` in
   * the desktop shell was to quit and reopen the app (the Tauri window has no
   * menu, so ⌘R was unbound). Read per request, not cached at boot, so a plain
   * `vite build` with no server restart is noticed too. Null in dev, where Vite
   * serves the bundle and nothing is on disk to hash.
   */
  const buildId = (): string | null => {
    try {
      return crypto.createHash("sha1").update(fs.readFileSync(path.join(webDist, "index.html"))).digest("hex").slice(0, 12);
    } catch {
      return null;
    }
  };

  app.get("/api/health", async () => ({ ok: true, notes: store.index.all().length, build: buildId() }));

  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      // Take over caching ourselves (the plugin default is a flat max-age=0):
      // hashed assets are content-addressed → cache forever; index.html must always
      // revalidate, or a rebuild (new asset hashes) leaves a cached shell pointing
      // at deleted files (blank screen, esp. in the desktop webview).
      cacheControl: false,
      setHeaders: (res, pathName) => {
        if (pathName.endsWith(`${path.sep}index.html`)) res.setHeader("cache-control", "no-cache");
        else if (pathName.includes(`${path.sep}assets${path.sep}`)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      reply.header("cache-control", "no-cache");
      return reply.sendFile("index.html");
    });
  }

  return { app, db, store };
}

if (isEntry(import.meta.url, process.argv[1])) {
  // Under launchd stdout/stderr are a plain log file, created world-readable
  // and never rotated: tighten it, and keep it under a cap (logging.ts).
  const rotated = rotateLogIfLarge();
  const tightened = privateLogFiles();
  const { app } = await buildServer();
  if (rotated) app.log.info("log rotated: the previous one is server.log.1");
  if (tightened.length) app.log.info(`log file made owner-only (fd ${tightened.join(", ")})`);
  const rotateTimer = setInterval(() => {
    if (rotateLogIfLarge()) app.log.info("log rotated: the previous one is server.log.1");
  }, 3_600_000);
  rotateTimer.unref();
  await app.listen({ port: env.port, host: env.host });

  // launchd stops the agent with SIGTERM (a kickstart, a logout, `pnpm ship`).
  // Close properly — stop the watcher, finish in-flight requests, close the
  // database so its WAL is checkpointed — instead of dying mid-write. A close
  // that hangs is cut off, because launchd will SIGKILL us anyway.
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      app.log.info(`${signal}: closing`);
      setTimeout(() => process.exit(1), 10_000).unref();
      app.close().then(
        () => process.exit(0),
        (err) => {
          app.log.error(err, "close failed");
          process.exit(1);
        },
      );
    });
  }
}
