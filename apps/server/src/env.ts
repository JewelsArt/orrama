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
  corsOrigin: process.env.BASALT_CORS_ORIGIN ?? true,
};

/**
 * Refuse to boot a production server on shipped secrets. The JWT secret signs
 * every session token, so a known value means anyone can mint a workspace-owner
 * session; the secret key decrypts stored AI and mail credentials. Both are
 * silent failures — nothing about the running app looks wrong — so the only
 * useful place to catch them is startup.
 */
export function assertProductionSecrets(nodeEnv = process.env.NODE_ENV): void {
  if (nodeEnv !== "production") return;
  const bad = [
    PLACEHOLDER_SECRETS.has(env.jwtSecret) ? "BASALT_JWT_SECRET" : null,
    PLACEHOLDER_SECRETS.has(env.secretKey) ? "BASALT_SECRET_KEY" : null,
  ].filter(Boolean);
  if (bad.length === 0) return;
  throw new Error(
    `Refusing to start: ${bad.join(" and ")} still ${bad.length > 1 ? "hold" : "holds"} a placeholder value. ` +
      `Generate real secrets (e.g. \`openssl rand -hex 32\`) and set them in the environment before deploying.`,
  );
}

export const vaultDir = () => env.vaultDir ?? path.join(env.dataDir, "vault");
export const dbPath = () => path.join(env.dataDir, "basalt.db");
