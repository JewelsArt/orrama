/**
 * The launchd template recreates production, and `pnpm ship` checks the deploy
 * (audit OPS-005).
 *
 * The committed plist carried only PATH: no secrets (so the server refused to
 * start and KeepAlive restarted it forever), no vault path, and it ran pnpm
 * rather than the server. ship.sh then printed "shipped" on the first 200 from
 * /api/health, whatever process gave it.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envProblems } from "../src/env.js";
import { SIGNAL_HANDLERS } from "./helpers/platform.js";

const root = path.resolve(import.meta.dirname, "../../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-launchd-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const plist = fs.readFileSync(path.join(root, "scripts/dev.basalt.server.plist"), "utf8");
const strings = (xml: string) => [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
const section = (key: string, tag: "array" | "dict") => plist.split(`<key>${key}</key>`)[1]!.split(`</${tag}>`)[0]!;
const program = strings(section("ProgramArguments", "array"));
const workdir = strings(plist.split("<key>WorkingDirectory</key>")[1]!)[0]!;
const envDict = section("EnvironmentVariables", "dict");
const vars = Object.fromEntries([...envDict.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => [m[1]!, m[2]!]));

describe("launchd template", () => {
  it("runs node on the server, with every key production uses", () => {
    expect(program.slice(1)).toEqual(["--import", "tsx", "src/main.ts"]);
    expect(path.basename(program[0]!)).toBe("node");
    expect(workdir.endsWith("/apps/server")).toBe(true);
    expect(Object.keys(vars).sort()).toEqual(["ORRAMA_JWT_SECRET", "ORRAMA_PUBLIC_ORIGINS", "ORRAMA_SECRET_KEY", "ORRAMA_VAULT_DIR", "PATH"]);
    // Placeholders the server refuses, so a forgotten one fails loudly.
    expect(vars.ORRAMA_JWT_SECRET).toBe("REPLACE_ME");
    expect(vars.ORRAMA_SECRET_KEY).toBe("REPLACE_ME");
    expect(envProblems({ ORRAMA_JWT_SECRET: vars.ORRAMA_JWT_SECRET, ORRAMA_SECRET_KEY: vars.ORRAMA_SECRET_KEY })).toHaveLength(2);
    expect(envProblems({ ORRAMA_PUBLIC_ORIGINS: vars.ORRAMA_PUBLIC_ORIGINS })).toEqual([]);
  });

  it.skipIf(!SIGNAL_HANDLERS)("filled in, it boots on the vault it names and closes on SIGTERM (POSIX signals)", async () => {
    const data = path.join(tmp, "data");
    const vault = path.join(tmp, "My Vault");
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, "Hello.md"), "# Hello\n");
    // Exactly the plist's environment, filled in — nothing inherited from the
    // test runner but where node lives, a scratch data dir and a free port.
    const env = {
      ...vars,
      PATH: process.env.PATH!,
      ORRAMA_VAULT_DIR: vault,
      ORRAMA_JWT_SECRET: "j".repeat(64),
      ORRAMA_SECRET_KEY: "k".repeat(64),
      ORRAMA_DATA_DIR: data,
      PORT: "0",
    };
    const child = spawn(process.execPath, program.slice(1), { cwd: path.join(root, "apps/server"), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    for (let i = 0; i < 400 && !/Server listening at (\S+)/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    const url = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
    expect(url, out.slice(-400)).toBeDefined();
    const health = (await (await fetch(`${url}/api/health`, { headers: { host: "localhost" } })).json()) as { ok: boolean; notes: number };
    expect(health).toMatchObject({ ok: true, notes: 1 }); // the named vault, not data/vault
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(out).toMatch(/SIGTERM: closing/);
  }, 40_000);
});

// bash and lsof, as on the Mac that ships.
describe.skipIf(process.platform === "win32")("ship's restart check (scripts/await-restart.sh)", () => {
  const script = path.join(root, "scripts/await-restart.sh");
  /** A stand-in server in a child process, so it has its own pid. */
  async function fake(build: string) {
    const code = `require("http").createServer((q,s)=>{s.setHeader("content-type","application/json");s.end(JSON.stringify({ok:true,notes:0,build:${JSON.stringify(build)}}))}).listen(0,"127.0.0.1",function(){console.log(this.address().port)})`;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<number>((r) => child.stdout.once("data", (d) => r(Number(String(d).trim()))));
    return { port, pid: child.pid!, stop: () => child.kill() };
  }
  const run = (port: number, old: string, want: string) =>
    spawnSync("bash", [script, String(port), old, want], { encoding: "utf8", env: { ...process.env, AWAIT_SECONDS: "3" } });

  it("passes for a new process serving the build just made", async () => {
    const s = await fake("abc123def456");
    try {
      const r = run(s.port, "1", "abc123def456");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`pid ${s.pid}`);
    } finally {
      s.stop();
    }
  }, 20_000);

  it("fails when the server answering serves another build", async () => {
    const s = await fake("000000000000");
    try {
      const r = run(s.port, "1", "abc123def456");
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/serves build 000000000000, not abc123def456/);
    } finally {
      s.stop();
    }
  }, 20_000);

  it("fails when the process that answers is the one that was killed", async () => {
    const s = await fake("abc123def456");
    try {
      const r = run(s.port, String(s.pid), "abc123def456");
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/no new server/);
    } finally {
      s.stop();
    }
  }, 20_000);

  it("ship.sh waits on it rather than on any 200", () => {
    const ship = fs.readFileSync(path.join(root, "scripts/ship.sh"), "utf8");
    expect(ship).toMatch(/bash scripts\/await-restart\.sh 4623 "\$PID" "\$WANT"/);
    expect(ship).not.toMatch(/curl -fsS localhost:4623\/api\/health >\/dev\/null/);
  });
});
