import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const DEV_JWT_SECRET = "dev-secret-change-me";
export const DEV_SECRET_KEY = "dev-secret-key-32-bytes-change!!";

/**
 * Placeholders that must never reach a real deployment. Includes the values
 * docker-compose.yml substitutes when the operator never exported their own —
 * `docker compose up` with no .env is the most likely way to run Orrama with
 * a forgeable JWT secret.
 */
const PLACEHOLDER_SECRETS = new Set([
  DEV_JWT_SECRET,
  DEV_SECRET_KEY,
  "change-me-please",
  "change-me-32-bytes-of-entropy!!",
]);

/** The shortest secret accepted; `openssl rand -hex 32` gives 64. */
const MIN_SECRET_LENGTH = 32;

/**
 * `--dev` (the `dev` and `seed` scripts pass it): a scratch install. It may use
 * the dev secrets, and unless PORT / ORRAMA_DATA_DIR say otherwise it listens on
 * DEV_PORT and keeps its database in `./data-dev`, never in `./data`.
 *
 * On the Mac Orrama runs on, `apps/server/data` IS the live database and the
 * launchd agent holds 4623 (`start`, no flag). `dev` used to default to both,
 * and the guide said "delete apps/server/data to reseed" — the only copy of
 * accounts, credentials, comments, drafts and history (audit REG-013, OPS-007).
 * A flag rather than `VAR=1 cmd` in package.json, which cmd.exe cannot run
 * (OPS-003).
 */
export const devMode = (argv: readonly string[] = process.argv) => argv.includes("--dev");
export const DEV_PORT = 4627;
const DEV = devMode();

/**
 * The settings variables were called BASALT_* until the rename to Orrama (R13), and only the
 * ORRAMA_* names are read now. A BASALT_ variable without its ORRAMA_ twin is a switch-over
 * left half done, and running on would mean defaults: a default vault folder is the wrong
 * vault, a default secret key cannot decrypt the stored credentials. So every entry point
 * (the server, seed, export, rotate-secret-key, account) refuses at import, naming each
 * variable and never its value.
 */
export function renamedEnvProblems(e: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(e)
    .filter((name) => name.startsWith("BASALT_") && e[`ORRAMA_${name.slice(7)}`] === undefined)
    .sort()
    .map((name) => `${name} is set but ORRAMA_${name.slice(7)} is not: set ORRAMA_${name.slice(7)} to the same value (BASALT_ names are no longer read)`);
}

export function assertNoRenamedEnv(e: NodeJS.ProcessEnv = process.env): void {
  const problems = renamedEnvProblems(e);
  if (problems.length) throw new Error(`Refusing to start — Orrama reads only ORRAMA_* variables now:\n  - ${problems.join("\n  - ")}`);
}

assertNoRenamedEnv();

/**
 * Where Orrama's source is (AGPL §13: whoever uses it over a network is offered
 * it). Someone who runs a changed copy for others sets ORRAMA_SOURCE_URL to
 * theirs; Settings links to it.
 */
export const DEFAULT_SOURCE_URL = "https://github.com/JewelsArt/Basalt-backup";

export const env = {
  port: Number(process.env.PORT ?? (DEV ? DEV_PORT : 4623)),
  host: process.env.HOST ?? "127.0.0.1",
  /** Server data root: vault files live in <dataDir>/vault, DB in <dataDir>/basalt.db */
  dataDir: path.resolve(process.env.ORRAMA_DATA_DIR ?? (DEV ? "./data-dev" : "./data")),
  /**
   * Where the Markdown lives. Defaults to <dataDir>/vault; set ORRAMA_VAULT_DIR
   * to point Orrama at a vault you already keep elsewhere (an Obsidian vault,
   * say) so both apps read and write the same files. The DB stays in dataDir —
   * it is a cache of the files, and it has no business inside your notes.
   */
  vaultDir: process.env.ORRAMA_VAULT_DIR ? path.resolve(process.env.ORRAMA_VAULT_DIR) : null,
  jwtSecret: process.env.ORRAMA_JWT_SECRET ?? DEV_JWT_SECRET,
  /** Key used to encrypt the workspace AI key at rest (spec §9). */
  secretKey: process.env.ORRAMA_SECRET_KEY ?? DEV_SECRET_KEY,
  /**
   * Which origins a browser may call this server from. Defaults to FALSE — no
   * cross-origin requests at all.
   *
   * It used to default to `true`, which tells @fastify/cors to REFLECT whatever
   * Origin asked. Combined with a token any page could forge, that made every
   * website the user visited while the agent was running able to read the vault,
   * the mailbox and the finance data: the page sends a cross-origin request, the
   * preflight is answered with its own origin, and the body comes back readable.
   * Binding to 127.0.0.1 does not help, because the request comes from the
   * user's own browser.
   *
   * Nothing legitimate needed it. In production the server serves the web bundle
   * itself, and in dev vite proxies /api and /ics (ws included) through :4625 —
   * both same-origin. Set ORRAMA_CORS_ORIGIN explicitly if a real cross-origin
   * client ever exists.
   */
  corsOrigin: process.env.ORRAMA_CORS_ORIGIN ?? false,
  /**
   * The exact origins Orrama is reached at (comma-separated), e.g.
   * `http://localhost:4623,https://mac.tailnet-name.ts.net`. Touch ID trusts
   * only these. Unset, it falls back to "the Origin must be the address the
   * request was sent to" — see `webauthnOrigin` in routes/auth.ts.
   */
  publicOrigins: (process.env.ORRAMA_PUBLIC_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  /** The source this server runs, linked from Settings (AGPL §13). */
  sourceUrl: process.env.ORRAMA_SOURCE_URL || DEFAULT_SOURCE_URL,
};

/**
 * Refuse to boot on shipped secrets, ANYWHERE, unless the operator has said
 * out loud that this is a scratch install.
 *
 * The JWT secret signs every session token, so a known value means anyone who
 * reaches the port can mint a workspace-owner session; the secret key decrypts
 * the stored mail password and AI key, so a copy of basalt.db decrypts both
 * offline. Both are silent failures — nothing about the running app looks
 * wrong — so startup is the only useful place to catch them.
 *
 * This used to be gated on `NODE_ENV === "production"`, which made the guard
 * depend on the one variable the operator is just as likely to forget as the
 * secrets themselves. It did exactly that: the launchd agent serving the real
 * vault set neither, so the guard returned immediately for months while the
 * server signed sessions with a string published on GitHub (audit B2).
 *
 * The default is now "refuse". Opting out takes `ORRAMA_ALLOW_DEV_SECRETS=1`
 * or `--dev`, things you have to type and can grep for, unlike a variable whose
 * ABSENCE was the unsafe state.
 */
export function assertProductionSecrets(
  allowDevSecrets = process.env.ORRAMA_ALLOW_DEV_SECRETS === "1" || DEV,
): void {
  if (allowDevSecrets) return;
  // Empty or short counts too, not only the known placeholders: `??` keeps
  // an empty string, so `ORRAMA_SECRET_KEY=` (an empty <string/> in the
  // plist, an unset compose variable) booted and encrypted every stored
  // credential under sha256("") — a key anyone can compute (audit REG-002).
  const weak = (v: string) => PLACEHOLDER_SECRETS.has(v) || v.length < MIN_SECRET_LENGTH;
  const bad = [weak(env.jwtSecret) ? "ORRAMA_JWT_SECRET" : null, weak(env.secretKey) ? "ORRAMA_SECRET_KEY" : null].filter(Boolean);
  if (bad.length === 0) return;
  throw new Error(
    `Refusing to start: ${bad.join(" and ")} ${bad.length > 1 ? "are" : "is"} empty, shorter than ${MIN_SECRET_LENGTH} characters, or a placeholder value. ` +
      `Generate real secrets (e.g. \`openssl rand -hex 32\`) and set them in the environment. ` +
      `For a throwaway install you do not mind anyone reading, set ORRAMA_ALLOW_DEV_SECRETS=1 instead. ` +
      `Rotating ORRAMA_SECRET_KEY on an existing database needs \`pnpm --dir apps/server rotate-secret-key\` ` +
      `first, or the stored mail and AI credentials become undecryptable.`,
  );
}

/**
 * Everything wrong with the environment, in one list. Nothing was validated:
 * `PORT=abc` became NaN, `ORRAMA_PLAN_AI_TIMEOUT_MS=8s` made every AI estimate
 * throw inside AbortSignal.timeout and quietly fall back to the heuristic, a
 * typo in ORRAMA_PUBLIC_ORIGINS just broke Touch ID, and ORRAMA_VAULT_DIR
 * pointing at a file failed deep inside the first vault scan.
 */
export function envProblems(e: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const int = (name: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const v = e[name];
    if (v === undefined || v === "") return;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) out.push(`${name}=${JSON.stringify(v)} must be a whole number from ${min}${max === Number.MAX_SAFE_INTEGER ? " up" : ` to ${max}`}`);
  };
  const origin = (name: string, v: string) => {
    try {
      const u = new URL(v);
      if (!/^https?:$/.test(u.protocol) || u.origin !== v.replace(/\/+$/, "")) throw new Error();
    } catch {
      out.push(`${name}: ${JSON.stringify(v)} is not an origin like https://host:port (no path)`);
    }
  };
  const dir = (name: string) => {
    const v = e[name];
    if (!v) return;
    try {
      if (!fs.statSync(path.resolve(v)).isDirectory()) out.push(`${name}=${v} is not a directory`);
    } catch {
      /* missing is fine — it is created */
    }
  };

  int("PORT", 0, 65535);
  if (e["HOST"] !== undefined && e["HOST"].trim() === "") out.push("HOST is set but empty");
  dir("ORRAMA_DATA_DIR");
  dir("ORRAMA_VAULT_DIR");
  for (const o of (e["ORRAMA_PUBLIC_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) origin("ORRAMA_PUBLIC_ORIGINS", o);
  if (e["ORRAMA_CORS_ORIGIN"]) origin("ORRAMA_CORS_ORIGIN", e["ORRAMA_CORS_ORIGIN"]);
  if (e["ORRAMA_OPENAI_BASE_URL"] && !/^https?:\/\/[^/]/.test(e["ORRAMA_OPENAI_BASE_URL"])) out.push("ORRAMA_OPENAI_BASE_URL must be an http(s) URL");
  if (e["ORRAMA_SOURCE_URL"] && !/^https?:\/\/[^/\s]+\S*$/.test(e["ORRAMA_SOURCE_URL"])) out.push("ORRAMA_SOURCE_URL must be an http(s) URL");
  for (const entry of (e["ORRAMA_FETCH_ALLOW"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [addr, prefix, extra] = entry.split("/");
    const v = net.isIP(addr!);
    const okCidr = v !== 0 && extra === undefined && (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (v === 4 ? 32 : 128)));
    const okHost = v === 0 && prefix === undefined && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(entry);
    if (!okCidr && !okHost) out.push(`ORRAMA_FETCH_ALLOW: ${JSON.stringify(entry)} is not a hostname, an address or a CIDR`);
  }
  int("ORRAMA_DOC_CACHE", 1);
  int("ORRAMA_PLAN_AI_TIMEOUT_MS", 1);
  int("ORRAMA_AI_TIMEOUT_MS", 1);
  int("ORRAMA_WEBHOOK_DEBOUNCE_MS", 0);
  const allow = e["ORRAMA_ALLOW_DEV_SECRETS"];
  if (allow !== undefined && allow !== "" && allow !== "1" && allow !== "0") {
    out.push(`ORRAMA_ALLOW_DEV_SECRETS=${JSON.stringify(allow)} means nothing — it is "1" or unset`);
  }
  // A real secret is long; `openssl rand -hex 32` gives 64 characters. Set
  // but empty is the same mistake, not "unset" (REG-002).
  if (allow !== "1") {
    for (const name of ["ORRAMA_JWT_SECRET", "ORRAMA_SECRET_KEY"]) {
      const v = e[name];
      if (v === "") out.push(`${name} is set but empty; use at least ${MIN_SECRET_LENGTH} characters (openssl rand -hex 32)`);
      else if (v !== undefined && !PLACEHOLDER_SECRETS.has(v) && v.length < MIN_SECRET_LENGTH) out.push(`${name} is ${v.length} characters; use at least ${MIN_SECRET_LENGTH} (openssl rand -hex 32)`);
    }
  }
  return out;
}

/** Refuse to boot on a malformed environment, naming every problem at once. */
export function assertValidEnv(e: NodeJS.ProcessEnv = process.env): void {
  const problems = envProblems(e);
  if (problems.length) throw new Error(`Refusing to start — the environment is not valid:\n  - ${problems.join("\n  - ")}`);
}

export const vaultDir = () => env.vaultDir ?? path.join(env.dataDir, "vault");
export const dbPath = () => path.join(env.dataDir, "basalt.db");
