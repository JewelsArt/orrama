/**
 * The environment is validated at boot, every problem named at once. Before,
 * PORT=abc was NaN, a malformed timeout silently disabled AI estimates, a typo
 * in BASALT_PUBLIC_ORIGINS just broke Touch ID, and a vault path that was a
 * file failed deep inside the first scan.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
