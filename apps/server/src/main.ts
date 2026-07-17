import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { ZodError } from "zod";
import { createDb, tables } from "./db.js";
import { env, vaultDir } from "./env.js";
import { HttpError, VaultStore } from "./vaultStore.js";
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
import { homeRoutes } from "./routes/home.js";
import { icsRoutes } from "./routes/ics.js";
import { mailRoutes } from "./routes/mail.js";
import { integrationRoutes, hashToken } from "./routes/integrations.js";
import { terminalRoutes } from "./routes/terminal.js";
import { initWebhooks } from "./webhooks.js";
import { eq } from "drizzle-orm";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    userId: string;
    /** True when authenticated with a personal API token instead of a session JWT. */
    viaToken?: boolean;
  }
}

export async function buildServer() {
  const db = createDb();
  // Single-workspace server (spec §3): one company, one vault, one container.
  if (db.select().from(tables.workspace).all().length === 0) {
    db.insert(tables.workspace).values({ id: `w-${crypto.randomUUID().slice(0, 8)}`, name: "Basalt Workspace" }).run();
  }
  const store = new VaultStore(db);
  store.load();

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

  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: env.corsOrigin });
  await app.register(jwt, { secret: env.jwtSecret });
  await app.register(websocket);

  app.decorate("authenticate", async (req: any, reply: any) => {
    // Personal API tokens (`bslt_…`) ride the same gate as JWTs: scripts and
    // shortcuts get the caller's normal permissions, nothing more.
    const header = (req.headers.authorization ?? "") as string;
    if (header.startsWith("Bearer bslt_")) {
      const row = db.select().from(tables.apiTokens).where(eq(tables.apiTokens.tokenHash, hashToken(header.slice(7)))).get();
      if (!row) return reply.code(401).send({ error: "invalid API token" });
      req.userId = row.userId;
      req.viaToken = true;
      db.update(tables.apiTokens).set({ lastUsedAt: Date.now() }).where(eq(tables.apiTokens.id, row.id)).run();
      return;
    }
    try {
      const payload = await req.jwtVerify();
      req.userId = payload.sub as string;
    } catch {
      reply.code(401).send({ error: "authentication required" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  await authRoutes(app, db, store);
  await vaultRoutes(app, db, store);
  await taskRoutes(app, db, store);
  await projectRoutes(app, store);
  await dashboardRoutes(app, db, store);
  await adminRoutes(app, db, store);
  await aiRoutes(app, db, store);
  await wsRoutes(app, db, store);
  await planRoutes(app, db, store);
  await calendarRoutes(app, db, store);
  await contactRoutes(app, db, store);
  await homeRoutes(app, db, store);
  await icsRoutes(app, db, store);
  await mailRoutes(app, db);
  await integrationRoutes(app, db, store);
  await terminalRoutes(app, db, store);
  initWebhooks(db, store);

  app.get("/api/health", async () => ({ ok: true, notes: store.index.all().length }));

  // Serve the built web app when present (self-host: one container serves everything).
  const webDist = path.resolve(import.meta.dirname, "../../web/dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return { app, db, store };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).includes("main.ts");
if (isMain) {
  const { app } = await buildServer();
  await app.listen({ port: env.port, host: env.host });
}
