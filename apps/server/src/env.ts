import path from "node:path";

export const DEV_JWT_SECRET = "dev-secret-change-me";
export const DEV_SECRET_KEY = "dev-secret-key-32-bytes-change!!";

/**
 * Placeholders that must never reach a real deployment. Includes the values
 * docker-compose.yml substitutes when the operator never exported their own —
 * `docker compose up` with no .env is the most likely way to run Basalt with
 * a forgeable JWT secret.
 */
const PLACEHOLDER_SECRETS = new Set([
  DEV_JWT_SECRET,
  DEV_SECRET_KEY,
  "change-me-please",
  "change-me-32-bytes-of-entropy!!",
]);

export const env = {
  port: Number(process.env.PORT ?? 4623),
  host: process.env.HOST ?? "127.0.0.1",
  /** Server data root: vault files live in <dataDir>/vault, DB in <dataDir>/basalt.db */
  dataDir: path.resolve(process.env.BASALT_DATA_DIR ?? "./data"),
  /**
   * Where the Markdown lives. Defaults to <dataDir>/vault; set BASALT_VAULT_DIR
   * to point Basalt at a vault you already keep elsewhere (an Obsidian vault,
   * say) so both apps read and write the same files. The DB stays in dataDir —
   * it is a cache of the files, and it has no business inside your notes.
   */
  vaultDir: process.env.BASALT_VAULT_DIR ? path.resolve(process.env.BASALT_VAULT_DIR) : null,
  jwtSecret: process.env.BASALT_JWT_SECRET ?? DEV_JWT_SECRET,
  /** Key used to encrypt the workspace AI key at rest (spec §9). */
  secretKey: process.env.BASALT_SECRET_KEY ?? DEV_SECRET_KEY,
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
   * both same-origin. Set BASALT_CORS_ORIGIN explicitly if a real cross-origin
   * client ever exists.
   */
  corsOrigin: process.env.BASALT_CORS_ORIGIN ?? false,
  /**
   * The exact origins Basalt is reached at (comma-separated), e.g.
   * `http://localhost:4623,https://mac.tailnet-name.ts.net`. Touch ID trusts
   * only these. Unset, it falls back to "the Origin must be the address the
   * request was sent to" — see `webauthnOrigin` in routes/auth.ts.
   */
  publicOrigins: (process.env.BASALT_PUBLIC_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean),
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
 * The default is now "refuse". Opting out takes `BASALT_ALLOW_DEV_SECRETS=1`,
 * which is a thing you have to type and can grep for, unlike a variable whose
 * ABSENCE was the unsafe state.
 */
export function assertProductionSecrets(
  allowDevSecrets = process.env.BASALT_ALLOW_DEV_SECRETS === "1",
): void {
  if (allowDevSecrets) return;
  const bad = [
    PLACEHOLDER_SECRETS.has(env.jwtSecret) ? "BASALT_JWT_SECRET" : null,
    PLACEHOLDER_SECRETS.has(env.secretKey) ? "BASALT_SECRET_KEY" : null,
  ].filter(Boolean);
  if (bad.length === 0) return;
  throw new Error(
    `Refusing to start: ${bad.join(" and ")} still ${bad.length > 1 ? "hold" : "holds"} a placeholder value. ` +
      `Generate real secrets (e.g. \`openssl rand -hex 32\`) and set them in the environment. ` +
      `For a throwaway install you do not mind anyone reading, set BASALT_ALLOW_DEV_SECRETS=1 instead. ` +
      `Rotating BASALT_SECRET_KEY on an existing database needs \`pnpm --dir apps/server rotate-secret-key\` ` +
      `first, or the stored mail and AI credentials become undecryptable.`,
  );
}

export const vaultDir = () => env.vaultDir ?? path.join(env.dataDir, "vault");
export const dbPath = () => path.join(env.dataDir, "basalt.db");
