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
import { env } from "./env.js";
import { HttpError, VaultStore } from "./vaultStore.js";
import { authRoutes } from "./routes/auth.js";
import { vaultRoutes } from "./routes/vault.js";
import { taskRoutes } from "./routes/tasks.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { adminRoutes } from "./routes/admin.js";
import { aiRoutes } from "./routes/ai.js";
import { wsRoutes } from "./routes/ws.js";
import { planRoutes } from "./routes/plan.js";
import { calendarRoutes } from "./routes/calendar.js";
import { contactRoutes } from "./routes/contacts.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    userId: string;
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

  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: env.corsOrigin });
  await app.register(jwt, { secret: env.jwtSecret });
  await app.register(websocket);

  app.decorate("authenticate", async (req: any, reply: any) => {
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
  await dashboardRoutes(app, db, store);
  await adminRoutes(app, db, store);
  await aiRoutes(app, db, store);
  await wsRoutes(app, db, store);
  await planRoutes(app, db, store);
  await calendarRoutes(app, db, store);
  await contactRoutes(app, db, store);

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
