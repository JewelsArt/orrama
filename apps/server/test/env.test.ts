/**
 * The environment is validated at boot, every problem named at once. Before,
 * PORT=abc was NaN, a malformed timeout silently disabled AI estimates, a typo
 * in BASALT_PUBLIC_ORIGINS just broke Touch ID, and a vault path that was a
 * file failed deep inside the first scan.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertValidEnv, envProblems } from "../src/env.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-env-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const good = {
  BASALT_JWT_SECRET: "a".repeat(64),
  BASALT_SECRET_KEY: "b".repeat(64),
  BASALT_PUBLIC_ORIGINS: "http://localhost:4623,https://mac.example.ts.net",
  BASALT_VAULT_DIR: tmp,
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
      BASALT_VAULT_DIR: file,
      BASALT_PUBLIC_ORIGINS: "http://localhost:4623,https://mac.example.ts.net/app,mac.example.ts.net",
      BASALT_PLAN_AI_TIMEOUT_MS: "8s",
      BASALT_DOC_CACHE: "0",
      BASALT_ALLOW_DEV_SECRETS: "true",
      BASALT_JWT_SECRET: "short",
      BASALT_FETCH_ALLOW: "nas.local,100.64.0.0/10,10.0.0.0/99,http://x",
    });
    const has = (re: RegExp) => expect(problems.some((p) => re.test(p)), `${re} in ${JSON.stringify(problems)}`).toBe(true);
    has(/^PORT="abc"/);
    has(/^HOST is set but empty/);
    has(/^BASALT_VAULT_DIR=.* is not a directory/);
    has(/BASALT_PUBLIC_ORIGINS: "https:\/\/mac\.example\.ts\.net\/app"/);
    has(/BASALT_PUBLIC_ORIGINS: "mac\.example\.ts\.net"/);
    has(/^BASALT_PLAN_AI_TIMEOUT_MS="8s"/);
    has(/^BASALT_DOC_CACHE="0"/);
    has(/^BASALT_ALLOW_DEV_SECRETS="true"/);
    has(/^BASALT_JWT_SECRET is 5 characters/);
    has(/BASALT_FETCH_ALLOW: "10\.0\.0\.0\/99"/);
    has(/BASALT_FETCH_ALLOW: "http:\/\/x"/);
    expect(problems.some((p) => /nas\.local|100\.64\.0\.0\/10/.test(p))).toBe(false);
    expect(problems.some((p) => p.includes("http://localhost:4623"))).toBe(false);
    expect(() => assertValidEnv({ PORT: "99999" })).toThrow(/Refusing to start[\s\S]*PORT="99999"/);
  });

  it("short secrets are allowed only on a declared throwaway install", () => {
    expect(envProblems({ BASALT_JWT_SECRET: "short", BASALT_ALLOW_DEV_SECRETS: "1" })).toEqual([]);
  });

  it("the server itself refuses to boot on it", async () => {
    process.env.BASALT_DATA_DIR = path.join(tmp, "data");
    process.env.BASALT_VAULT_DIR = path.join(tmp, "vault");
    process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
    process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";
    process.env.BASALT_PLAN_AI_TIMEOUT_MS = "8s";
    try {
      const { buildServer } = await import("../src/main.js");
      await expect(buildServer()).rejects.toThrow(/environment is not valid[\s\S]*BASALT_PLAN_AI_TIMEOUT_MS/);
    } finally {
      delete process.env.BASALT_PLAN_AI_TIMEOUT_MS;
    }
  });
});

/**
 * A secret set to "" is a missing secret (audit REG-002). `??` kept the empty
 * string, the placeholder check did not know it, and the length rule skipped
 * it as falsy — so BASALT_SECRET_KEY= booted and encrypted the mail password
 * and AI key under sha256(""), which anyone can compute.
 */
describe("empty or short secrets", () => {
  const REAL = "6f1c0b9a4d2e8f37a1b5c9d0e4f8a2b6c3d7";
  /** The boot guard, run against a fresh env module under these variables. */
  const guard = async (vars: Record<string, string>) => {
    const saved = { ...process.env };
    delete process.env.BASALT_ALLOW_DEV_SECRETS;
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
    expect(await guard({ BASALT_JWT_SECRET: REAL, BASALT_SECRET_KEY: "" })).toThrow(/Refusing to start: BASALT_SECRET_KEY is empty/);
    expect(await guard({ BASALT_JWT_SECRET: "", BASALT_SECRET_KEY: REAL })).toThrow(/Refusing to start: BASALT_JWT_SECRET is empty/);
    expect(await guard({ BASALT_JWT_SECRET: REAL, BASALT_SECRET_KEY: "x".repeat(20) })).toThrow(/BASALT_SECRET_KEY/);
    expect(await guard({ BASALT_JWT_SECRET: REAL, BASALT_SECRET_KEY: REAL })).not.toThrow();
  });

  it("are listed as environment problems", () => {
    for (const name of ["BASALT_JWT_SECRET", "BASALT_SECRET_KEY"]) {
      const problems = envProblems({ ...good, [name]: "" });
      expect(problems.some((p) => p.startsWith(`${name} is set but empty`)), JSON.stringify(problems)).toBe(true);
    }
  });
});
