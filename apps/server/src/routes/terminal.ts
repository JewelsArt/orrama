import type { FastifyInstance } from "fastify";
import * as pty from "node-pty";
import type { Db } from "../db.js";
import type { VaultStore } from "../vaultStore.js";
import { vaultDir } from "../env.js";
import { execSync } from "node:child_process";
import fs from "node:fs";

export async function terminalRoutes(app: FastifyInstance, _db: Db, store: VaultStore) {
  if (process.env.BASALT_TERMINAL !== "1") return;

  app.get("/api/terminal", { websocket: true }, (socket, req) => {
    let userId: string;
    try {
      const token = (req.query as { token?: string }).token ?? "";
      const payload = app.jwt.verify<{ sub: string }>(token);
      userId = payload.sub;
    } catch {
      socket.close(4001, "authentication required");
      return;
    }

    try {
      const user = store.aclUser(userId);
      if (!user.isOwner) {
        socket.close(4003, "forbidden");
        return;
      }
    } catch {
      socket.close(4003, "forbidden");
      return;
    }

    let ptyProcess: pty.IPty;
    let claudePath = "claude";
    try {
      try {
        claudePath = execSync("which claude", { encoding: "utf8", env: process.env }).trim();
      } catch {
        if (fs.existsSync("/opt/homebrew/bin/claude")) {
          claudePath = "/opt/homebrew/bin/claude";
        }
      }

      ptyProcess = pty.spawn(claudePath, [], {
        name: "xterm-color",
        cols: 80,
        rows: 30,
        cwd: vaultDir(),
        env: process.env as any,
      });
    } catch (e: any) {
      if (e.message && (e.message.includes("ENOENT") || e.message.includes("posix_spawnp failed"))) {
        socket.send(`Error: 'claude' command not found on PATH. (Tried ${claudePath})\r\n`);
        socket.close();
        return;
      }
      socket.send(`Error spawning PTY: ${e.message}\r\n`);
      socket.close();
      return;
    }

    ptyProcess.onData((data) => {
      socket.send(data);
    });

    socket.on("message", (raw: Buffer) => {
      const text = raw.toString("utf8");
      if (text.startsWith('{"type":"resize"')) {
        try {
          const msg = JSON.parse(text);
          if (msg.cols && msg.rows) ptyProcess.resize(msg.cols, msg.rows);
          return;
        } catch {
          // ignore parsing error, fall through
        }
      }
      ptyProcess.write(text);
    });

    socket.on("close", () => {
      ptyProcess.kill();
    });
  });
}
