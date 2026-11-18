/**
 * Settings → Connections → Connect to Claude (`claudeConnect.ts`): the state, connect and
 * disconnect. Session only: connecting makes a credential, and a token must never mint one.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { claudeStatus, connectClaude, disconnectClaude, type ClaudeHost } from "../claudeConnect.js";
import { sessionOnly } from "./auth.js";

export async function claudeRoutes(app: FastifyInstance, db: Db, host: ClaudeHost) {
  const auth = { preHandler: [app.authenticate], config: sessionOnly("connect Claude from a signed-in session") };
  app.get("/api/claude", auth, async (req) => claudeStatus(db, host, req.userId));
  app.post("/api/claude/connect", auth, async (req) => connectClaude(db, host, req.userId));
  app.post("/api/claude/disconnect", auth, async (req) => disconnectClaude(db, host, req.userId));
}
