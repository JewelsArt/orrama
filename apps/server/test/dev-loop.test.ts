/**
 * The dev loop cannot reach the live instance (audit REG-013, OPS-007).
 *
 * On the Mac Basalt runs on, `apps/server/data` is the live database and the
 * launchd agent holds :4623. `dev` defaulted to both, the guide said "delete
 * apps/server/data to reseed", and `seed` — guarded only by "no users yet" —
 * wrote its demo notes over whatever vault ORRAMA_VAULT_DIR named, with bare
 * writes, and added an owner whose password is published.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const server = path.resolve(import.meta.dirname, "..");
// By file, so a process started in a scratch folder still finds the loader.
const tsx = pathToFileURL(path.join(server, "node_modules/tsx/dist/loader.mjs")).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-devloop-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Run a server script the way `pnpm --dir apps/server <script>` does, cwd included. */
function run(args: string[], env: Record<string, string>, cwd = server) {
  const clean = { ...process.env };
  for (const k of ["ORRAMA_SEED_INTO_EXISTING_VAULT", "PORT", "ORRAMA_DATA_DIR", "ORRAMA_VAULT_DIR", "ORRAMA_ALLOW_DEV_SECRETS", "ORRAMA_JWT_SECRET", "ORRAMA_SECRET_KEY"]) delete clean[k];
  const r = spawnSync(process.execPath, ["--import", tsx, ...args], { cwd, env: { ...clean, ...env }, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// import() takes a URL: a bare `D:\…` path reads as the scheme "d:" on Windows.
const probe = `const { env, assertProductionSecrets } = await import(${JSON.stringify(pathToFileURL(path.join(server, "src/env.ts")).href)});
let secrets = "ok"; try { assertProductionSecrets(); } catch { secrets = "refused"; }
console.log(JSON.stringify({ port: env.port, dataDir: env.dataDir, secrets, cwd: process.cwd() }));`;
/** The dev settings a process started in `cwd` gets; `dataDir` relative to its own cwd. */
const envOf = (flag: string[], cwd: string, env: Record<string, string> = {}) => {
  const r = run(["--input-type=module", "-e", probe, "--", ...flag], env, cwd);
  expect(r.code, r.out).toBe(0);
  const out = JSON.parse(r.out.trim().split("\n").pop()!) as { port: number; dataDir: string; secrets: string; cwd: string };
  // The child spells its cwd its own way (/private/var on macOS, a short
  // RUNNER~1 on Windows): compare the folder, then name the path from it.
  expect(fs.realpathSync.native(out.cwd)).toBe(fs.realpathSync.native(cwd));
  return { port: out.port, secrets: out.secrets, dataDir: out.dataDir, inCwd: path.relative(out.cwd, out.dataDir).split(path.sep).join("/") };
};

describe("dev loop", () => {
  it("dev and seed run with --dev; start does not", () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(server, "package.json"), "utf8")).scripts as Record<string, string>;
    expect(scripts.dev).toMatch(/ --dev$/);
    expect(scripts.seed).toMatch(/ --dev$/);
    expect(scripts.start).not.toMatch(/--dev/);
  });

  it("--dev keeps away from the live database and port unless told otherwise", () => {
    const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
    expect(envOf(["--dev"], cwd)).toMatchObject({ port: 4627, inCwd: "data-dev", secrets: "ok" });
    // `start` (the launchd agent) is unchanged: ./data, :4623, real secrets required.
    expect(envOf([], cwd)).toMatchObject({ port: 4623, inCwd: "data", secrets: "refused" });
    // An explicit setting still wins in dev — the session scratch servers rely on it.
    expect(envOf(["--dev"], cwd, { PORT: "4721", ORRAMA_DATA_DIR: path.join(cwd, "x") })).toMatchObject({ port: 4721, dataDir: path.join(cwd, "x") });
  }, 30_000);

  it("seed refuses a vault that already holds notes, and writes nothing", () => {
    const data = fs.mkdtempSync(path.join(tmp, "data-"));
    const vault = path.join(data, "vault");
    fs.mkdirSync(path.join(vault, "Deep"), { recursive: true });
    const mine = path.join(vault, "Deep", "Welcome.md"); // a name the demo also uses, one folder down
    const welcome = path.join(vault, "Welcome.md");
    fs.writeFileSync(mine, "my own note\n");
    const r = run(["src/seed.ts", "--dev"], { ORRAMA_DATA_DIR: data, ORRAMA_VAULT_DIR: vault });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Refusing to seed: .* already holds notes/);
    expect(fs.readFileSync(mine, "utf8")).toBe("my own note\n");
    expect(fs.existsSync(welcome)).toBe(false);
    expect(fs.readdirSync(vault)).toEqual(["Deep"]);
  }, 30_000);

  it("seed fills an empty vault, closes its database, and a second run changes nothing", () => {
    const data = fs.mkdtempSync(path.join(tmp, "data-"));
    const vault = path.join(data, "vault");
    fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true }); // settings are not notes
    fs.writeFileSync(path.join(vault, ".obsidian", "app.json"), "{}");
    const first = run(["src/seed.ts", "--dev"], { ORRAMA_DATA_DIR: data, ORRAMA_VAULT_DIR: vault });
    expect(first.code, first.out).toBe(0);
    expect(fs.existsSync(path.join(vault, "Welcome.md"))).toBe(true);
    fs.writeFileSync(path.join(vault, "Welcome.md"), "edited\n");
    const again = run(["src/seed.ts", "--dev"], { ORRAMA_DATA_DIR: data, ORRAMA_VAULT_DIR: vault });
    expect(again.code, again.out).toBe(0);
    expect(again.out).toMatch(/already seeded/);
    expect(fs.readFileSync(path.join(vault, "Welcome.md"), "utf8")).toBe("edited\n");
  }, 60_000);

  // In a child process better-sqlite3 closes every handle at exit, so only an
  // in-process seed — what 42 test files do — shows the leak. Closed, the last
  // connection checkpoints and removes the WAL; open, Windows cannot delete the
  // data dir afterwards (EBUSY, audit OPS-003).
  it("seed closes its database when it returns", async () => {
    const data = fs.mkdtempSync(path.join(tmp, "data-"));
    process.env.ORRAMA_DATA_DIR = data;
    process.env.ORRAMA_VAULT_DIR = path.join(data, "vault");
    await import("../src/seed.js");
    expect(fs.existsSync(path.join(data, "vault", "Welcome.md"))).toBe(true);
    expect(fs.existsSync(path.join(data, "basalt.db-wal"))).toBe(false);
  }, 30_000);

  it("the repo's preview config runs the dev server, never the live port or database", () => {
    const launch = JSON.parse(fs.readFileSync(path.join(server, "../../.claude/launch.json"), "utf8")) as { configurations: { name: string; runtimeArgs: string[]; port: number }[] };
    for (const c of launch.configurations) {
      expect(c.port, c.name).not.toBe(4623);
      if (c.runtimeArgs.includes("apps/server")) expect(c.runtimeArgs, c.name).toContain("dev");
      if (c.runtimeArgs.includes("apps/web")) expect(c.runtimeArgs.join(" "), c.name).toMatch(/ORRAMA_API_PORT=(?!4623)\d+/);
    }
  });

  it("no guide calls the database disposable or says to delete it, and every quickstart sets the secrets", () => {
    const read = (f: string) => fs.readFileSync(path.join(server, "../..", f), "utf8");
    for (const f of ["README.md", "INSTALL.md", "CLAUDE.md"]) {
      const text = read(f);
      expect(text, f).not.toMatch(/disposable/i);
      expect(text, f).not.toMatch(/delete (the )?apps\/server\/data(?!-dev)\b(?! \(or)| to reseed|rm -rf [^\n]*data\/basalt\.db/);
    }
    // "Running it" and "Quickstart": the secrets come before the start, or the
    // walkthrough ends at "Refusing to start" (OPS-007).
    const block = (text: string, heading: string) => text.split(heading)[1]!.split("```")[1]!;
    for (const [f, heading] of [["README.md", "## Running it"], ["INSTALL.md", "## Quickstart"], ["INSTALL.md", "## For an AI agent"]] as const) {
      const cmds = block(read(f), heading);
      const start = cmds.indexOf("apps/server start");
      expect(start, f).toBeGreaterThan(0);
      for (const v of ["ORRAMA_JWT_SECRET=$(openssl rand -hex 32)", "ORRAMA_SECRET_KEY=$(openssl rand -hex 32)"]) {
        expect(cmds.indexOf(v), `${f} ${heading}: ${v}`).toBeGreaterThan(-1);
        expect(cmds.indexOf(v), `${f} ${heading}: ${v}`).toBeLessThan(start);
      }
    }
  });
});
