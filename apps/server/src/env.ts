import path from "node:path";

export const env = {
  port: Number(process.env.PORT ?? 4623),
  host: process.env.HOST ?? "127.0.0.1",
  /** Server data root: vault files live in <dataDir>/vault, DB in <dataDir>/basalt.db */
  dataDir: path.resolve(process.env.BASALT_DATA_DIR ?? "./data"),
  jwtSecret: process.env.BASALT_JWT_SECRET ?? "dev-secret-change-me",
  /** Key used to encrypt the workspace AI key at rest (spec §9). */
  secretKey: process.env.BASALT_SECRET_KEY ?? "dev-secret-key-32-bytes-change!!",
  corsOrigin: process.env.BASALT_CORS_ORIGIN ?? true,
};

export const vaultDir = () => path.join(env.dataDir, "vault");
export const dbPath = () => path.join(env.dataDir, "basalt.db");
