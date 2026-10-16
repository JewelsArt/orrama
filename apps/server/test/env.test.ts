/**
 * The environment is validated at boot, every problem named at once. Before,
 * PORT=abc was NaN, a malformed timeout silently disabled AI estimates, a typo
 * in ORRAMA_PUBLIC_ORIGINS just broke Touch ID, and a vault path that was a
 * file failed deep inside the first scan.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertValidEnv, envProblems } from "../src/env.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-env-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const good = {
  ORRAMA_JWT_SECRET: "a".repeat(64),
  ORRAMA_SECRET_KEY: "b".repeat(64),
  ORRAMA_PUBLIC_ORIGINS: "http://localhost:4623,https://mac.example.ts.net",
  ORRAMA_VAULT_DIR: tmp,
};

describe("environment", () => {
  it("accepts a real configuration (the shape of the live launchd agent)", () => {
    expect(envProblems(good)).toEqual([]);
    expect(envProblems({})).toEqual([]); // everything has a default
  });

  it("names each malformed value", () => {
    const file = path.join(tmp, "not-a-dir");
    fs.writeFileSync(file, "");
    const problems = envProblems({
      ...good,
      PORT: "abc",
      HOST: " ",
      ORRAMA_VAULT_DIR: file,
      ORRAMA_PUBLIC_ORIGINS: "http://localhost:4623,https://mac.example.ts.net/app,mac.example.ts.net",
      ORRAMA_PLAN_AI_TIMEOUT_MS: "8s",
      ORRAMA_DOC_CACHE: "0",
      ORRAMA_ALLOW_DEV_SECRETS: "true",
      ORRAMA_JWT_SECRET: "short",
      ORRAMA_FETCH_ALLOW: "nas.local,100.64.0.0/10,10.0.0.0/99,http://x",
    });
    const has = (re: RegExp) => expect(problems.some((p) => re.test(p)), `${re} in ${JSON.stringify(problems)}`).toBe(true);
    has(/^PORT="abc"/);
    has(/^HOST is set but empty/);
    has(/^ORRAMA_VAULT_DIR=.* is not a directory/);
    has(/ORRAMA_PUBLIC_ORIGINS: "https:\/\/mac\.example\.ts\.net\/app"/);
    has(/ORRAMA_PUBLIC_ORIGINS: "mac\.example\.ts\.net"/);
    has(/^ORRAMA_PLAN_AI_TIMEOUT_MS="8s"/);
    has(/^ORRAMA_DOC_CACHE="0"/);
    has(/^ORRAMA_ALLOW_DEV_SECRETS="true"/);
    has(/^ORRAMA_JWT_SECRET is 5 characters/);
    has(/ORRAMA_FETCH_ALLOW: "10\.0\.0\.0\/99"/);
    has(/ORRAMA_FETCH_ALLOW: "http:\/\/x"/);
    expect(problems.some((p) => /nas\.local|100\.64\.0\.0\/10/.test(p))).toBe(false);
    expect(problems.some((p) => p.includes("http://localhost:4623"))).toBe(false);
    expect(() => assertValidEnv({ PORT: "99999" })).toThrow(/Refusing to start[\s\S]*PORT="99999"/);
  });

  it("short secrets are allowed only on a declared throwaway install", () => {
    expect(envProblems({ ORRAMA_JWT_SECRET: "short", ORRAMA_ALLOW_DEV_SECRETS: "1" })).toEqual([]);
  });

  // The first import of main.ts loads the whole server through tsx: 1.5 s on a Mac, more than
  // the default 5 s on a Windows runner.
  it("the server itself refuses to boot on it", async () => {
    process.env.ORRAMA_DATA_DIR = path.join(tmp, "data");
    process.env.ORRAMA_VAULT_DIR = path.join(tmp, "vault");
    process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
    process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
    process.env.ORRAMA_PLAN_AI_TIMEOUT_MS = "8s";
    try {
      const { buildServer } = await import("../src/main.js");
      await expect(buildServer()).rejects.toThrow(/environment is not valid[\s\S]*ORRAMA_PLAN_AI_TIMEOUT_MS/);
    } finally {
      delete process.env.ORRAMA_PLAN_AI_TIMEOUT_MS;
    }
  }, 30_000);
});

/**
 * A secret set to "" is a missing secret (audit REG-002). `??` kept the empty
 * string, the placeholder check did not know it, and the length rule skipped
 * it as falsy — so ORRAMA_SECRET_KEY= booted and encrypted the mail password
 * and AI key under sha256(""), which anyone can compute.
 */
describe("empty or short secrets", () => {
  const REAL = "6f1c0b9a4d2e8f37a1b5c9d0e4f8a2b6c3d7";
  /** The boot guard, run against a fresh env module under these variables. */
  const guard = async (vars: Record<string, string>) => {
    const saved = { ...process.env };
    delete process.env.ORRAMA_ALLOW_DEV_SECRETS;
    Object.assign(process.env, vars);
    vi.resetModules();
    try {
      const fresh = await import("../src/env.js");
      return () => fresh.assertProductionSecrets();
    } finally {
      process.env = saved;
    }
  };
  afterAll(() => vi.resetModules());

  it("refuse to boot, naming the variable", async () => {
    expect(await guard({ ORRAMA_JWT_SECRET: REAL, ORRAMA_SECRET_KEY: "" })).toThrow(/Refusing to start: ORRAMA_SECRET_KEY is empty/);
    expect(await guard({ ORRAMA_JWT_SECRET: "", ORRAMA_SECRET_KEY: REAL })).toThrow(/Refusing to start: ORRAMA_JWT_SECRET is empty/);
    expect(await guard({ ORRAMA_JWT_SECRET: REAL, ORRAMA_SECRET_KEY: "x".repeat(20) })).toThrow(/ORRAMA_SECRET_KEY/);
    expect(await guard({ ORRAMA_JWT_SECRET: REAL, ORRAMA_SECRET_KEY: REAL })).not.toThrow();
  });

  it("are listed as environment problems", () => {
    for (const name of ["ORRAMA_JWT_SECRET", "ORRAMA_SECRET_KEY"]) {
      const problems = envProblems({ ...good, [name]: "" });
      expect(problems.some((p) => p.startsWith(`${name} is set but empty`)), JSON.stringify(problems)).toBe(true);
    }
  });
});
