/**
 * The server as the desktop app carries it (stage 2, 2A): resources/server/ run by the Node
 * that fetch-node.mjs put in binaries/, never the one running this test, on an empty data
 * folder and an empty notes folder, the way a friend starts. Built by
 *   pnpm --dir apps/desktop prepare-bundle
 * and skipped, saying so, when it isn't there.
 *
 * It proves what the bundle could lose and tsx never does: the native modules for that Node's
 * ABI (sign-up hashes with argon2, everything writes through better-sqlite3), the PDF worker
 * beside server.mjs, the dynamic imports bundled in (mammoth, exceljs), the web app beside it,
 * the version without a package.json two folders up; and the contract: weak secrets refused,
 * the launch id in /api/health, a clean stop when stdin closes.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pdf, textLine } from "./helpers/pdf.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TAURI = path.join(ROOT, "apps/desktop/src-tauri");
const SERVER_DIR = path.join(TAURI, "resources/server");
const TRIPLES: Record<string, string> = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "win32-x64": "x86_64-pc-windows-msvc" };
const triple = TRIPLES[`${process.platform}-${process.arch}`];
const NODE = triple ? path.join(TAURI, "binaries", `node-${triple}${process.platform === "win32" ? ".exe" : ""}`) : "";
const built = !!triple && fs.existsSync(NODE) && fs.existsSync(path.join(SERVER_DIR, "server.mjs"));
if (!built) console.warn("bundle.test.ts skipped: the desktop bundle hasn't been built here. Run pnpm --dir apps/desktop prepare-bundle (it needs apps/web/dist).");

/** The exit code, or "still running" after `ms`: a test that waits for an exit must not hang past its own finally. */
const exitWithin = (exited: Promise<number | null>, ms = 15_000) =>
  Promise.race([exited, new Promise<"still running">((r) => setTimeout(() => r("still running"), ms))]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-bundle-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
/**
 * A copy of the folder, outside the repository: run where it was built, Node would find any
 * module the bundle forgot in the checkout's own node_modules, a few folders up. In the app
 * there is nothing above it.
 */
const APP = path.join(tmp, "app", "server");
if (built) fs.cpSync(SERVER_DIR, APP, { recursive: true });

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

/**
 * The environment the shell passes (2-COMMON.md): nothing of ours from this one, nothing of
 * vitest's. NODE_PATH above all: pnpm's vitest shim points it at the checkout's store, where
 * Node would find any native module the bundle forgot.
 */
function shellEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ORRAMA_|BASALT_|VITEST|NODE_OPTIONS$|NODE_PATH$|PORT$|HOST$|TSX)/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

async function boot(name: string, secrets: { jwt: string; key: string }) {
  const data = path.join(tmp, name, "data");
  const notes = path.join(tmp, name, "notes");
  const cwd = path.join(tmp, name, "elsewhere"); // nothing may depend on where the app was started from
  for (const d of [data, notes, cwd]) fs.mkdirSync(d, { recursive: true });
  const log = path.join(data, "logs", "server.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "a");
  const port = await freePort();
  const launch = crypto.randomBytes(16).toString("hex");
  const started = Date.now();
  const child = spawn(NODE, [path.join(APP, "server.mjs")], {
    cwd,
    env: shellEnv({
      ORRAMA_PACKAGED: "1",
      ORRAMA_DATA_DIR: data,
      ORRAMA_DEFAULT_NOTES_DIR: notes,
      ORRAMA_WEB_DIST: path.join(APP, "web"),
      ORRAMA_LOG_FILE: log,
      PORT: String(port),
      HOST: "127.0.0.1",
      ORRAMA_PUBLIC_ORIGINS: `http://localhost:${port}`,
      ORRAMA_JWT_SECRET: secrets.jwt,
      ORRAMA_SECRET_KEY: secrets.key,
      ORRAMA_LAUNCH_ID: launch,
    }),
    stdio: ["pipe", fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  let listening = false;
  for (let i = 0; i < 600 && child.exitCode === null && !(listening = fs.readFileSync(log, "utf8").includes("Server listening")); i++) await new Promise((r) => setTimeout(r, 50));
  return { child, exited, port, launch, data, notes, log, listening, bootMs: Date.now() - started };
}

const real = () => ({ jwt: crypto.randomBytes(32).toString("hex"), key: crypto.randomBytes(32).toString("hex") });

describe.skipIf(!built)("the desktop bundle", () => {
  it("runs on the pinned Node, not this one", () => {
    const pins = JSON.parse(fs.readFileSync(path.join(ROOT, "apps/desktop/node-version.json"), "utf8"));
    const bin = fs.readFileSync(NODE);
    expect(crypto.createHash("sha256").update(bin).digest("hex")).toBe(pins.node.targets[triple!].binarySha256);
  });

  it("refuses to start on the development secrets", async () => {
    const s = await boot("dev-secrets", { jwt: "dev-secret-change-me", key: "dev-secret-key-32-bytes-change!!" });
    const code = await exitWithin(s.exited);
    expect(code).not.toBe(0);
    expect(fs.readFileSync(s.log, "utf8")).toContain("Refusing to start: ORRAMA_JWT_SECRET and ORRAMA_SECRET_KEY");
  }, 60_000);

  it("starts from nothing, does a friend's first minutes, and stops cleanly when stdin closes", async () => {
    const s = await boot("friend", real());
    const url = (p: string) => `http://localhost:${s.port}${p}`;
    const origin = `http://localhost:${s.port}`;
    let cookie = "";
    const call = async (method: string, p: string, body?: unknown) => {
      const r = await fetch(url(p), {
        method,
        headers: { origin, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const set = r.headers.getSetCookie().find((c) => c.startsWith(`orrama_session_${s.port}=`));
      if (set) cookie = set.split(";")[0]!;
      return r;
    };
    try {
      expect(s.listening, fs.readFileSync(s.log, "utf8").slice(-2000)).toBe(true);
      console.log(`bundle booted in ${s.bootMs} ms`);

      // The shell knows its own child.
      expect(await (await call("GET", "/api/health")).json()).toMatchObject({ ok: true, notes: 0, launch: s.launch });
      // The web app beside the bundle, for any address.
      const page = await call("GET", "/planning");
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<div id="root">');

      // Sign up (argon2), then the first-run choice, then Start empty (better-sqlite3, the vault).
      expect((await call("POST", "/api/auth/register", { email: "sam@example.test", username: "sam", displayName: "Sam", password: "correct horse battery" })).status).toBe(200);
      expect(await (await call("GET", "/api/auth/status")).json()).toEqual({ needsSetup: false, chooseNotes: true });
      expect(await (await call("POST", "/api/settings/start", { example: false })).json()).toMatchObject({ ontology: "written" });
      expect(fs.existsSync(path.join(s.notes, "Orrama", "What things are.md"))).toBe(true);
      const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
      expect(await (await call("GET", "/api/settings/server")).json()).toMatchObject({ version, own: true });

      // A note, written and read back.
      const put = await call("PUT", "/api/vault/note", { path: "Ideas.md", content: "# Ideas\n\nA shed for the bikes.\n", create: true });
      expect(put.status).toBe(200);
      const { id } = (await put.json()) as { id: string };
      expect(((await (await call("GET", `/api/vault/note/${id}`)).json()) as { content: string }).content).toContain("A shed for the bikes.");
      expect(fs.readFileSync(path.join(s.notes, "Ideas.md"), "utf8")).toContain("A shed for the bikes.");

      // The PDF worker beside server.mjs: a letter is read (and is no payslip).
      const slip = await call("POST", "/api/finance/payslip", { name: "letter.pdf", dataBase64: pdf([textLine("Dear Sam, thank you for your letter")]).toString("base64") });
      expect(await slip.json()).toMatchObject({ stored: true, filed: false, reason: "unfamiliar payslip layout" });

      // mammoth and exceljs, imported when a document is opened.
      const project = (await (await call("POST", "/api/projects", { name: "Garden shed" })).json()) as { slug: string };
      const docx = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "links.docx"));
      expect((await call("POST", `/api/projects/${project.slug}/files`, { name: "links.docx", dataBase64: docx.toString("base64") })).status).toBe(200);
      const html = await call("GET", `/api/projects/${project.slug}/files/links.docx/html`);
      expect(html.status).toBe(200);
      expect(JSON.stringify(await html.json())).toContain("https");
      const { default: ExcelJS } = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet("Costs").addRows([["Item", "Cost"], ["Timber", 240]]);
      const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
      expect((await call("POST", `/api/projects/${project.slug}/files`, { name: "costs.xlsx", dataBase64: xlsx.toString("base64") })).status).toBe(200);
      const sheet = await call("GET", `/api/projects/${project.slug}/files/costs.xlsx/sheet`);
      expect(sheet.status).toBe(200);
      expect(JSON.stringify(await sheet.json())).toContain("Timber");

      // The shell quits: stdin closes, the server closes like on SIGTERM and exits 0.
      expect(fs.existsSync(path.join(s.data, "basalt.db-wal"))).toBe(true);
      s.child.stdin!.end();
      expect(await exitWithin(s.exited)).toBe(0);
      expect(fs.readFileSync(s.log, "utf8")).toContain("stdin closed: closing");
      expect(fs.existsSync(path.join(s.data, "basalt.db-wal"))).toBe(false);
    } finally {
      if (s.child.exitCode === null) s.child.kill("SIGKILL");
      await s.exited;
    }
  }, 120_000);
});
