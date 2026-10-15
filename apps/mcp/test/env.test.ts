import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { renamedEnvProblems } from "../src/env.js";

describe("renamed settings variables", () => {
  it("names BASALT_URL and BASALT_TOKEN when their ORRAMA_ twins are missing, never the value", () => {
    const problems = renamedEnvProblems({ BASALT_URL: "http://localhost:4623", BASALT_TOKEN: "bslt_secretvalue" });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^BASALT_URL is set but ORRAMA_URL is not/);
    expect(problems[1]).toMatch(/^BASALT_TOKEN is set but ORRAMA_TOKEN is not/);
    expect(problems.join(" ")).not.toContain("secretvalue");
    expect(renamedEnvProblems({ BASALT_TOKEN: "bslt_x", ORRAMA_TOKEN: "bslt_x" })).toEqual([]);
    expect(renamedEnvProblems({ ORRAMA_TOKEN: "bslt_x" })).toEqual([]);
  });
});

describe("the MCP server on a half-done switch", () => {
  it("exits before serving, saying which variable to rename", () => {
    const mcp = path.resolve(import.meta.dirname, "..");
    const tsx = pathToFileURL(path.join(mcp, "node_modules/tsx/dist/loader.mjs")).href;
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BASALT|ORRAMA)_/.test(k)));
    const r = spawnSync(process.execPath, ["--import", tsx, path.join(mcp, "src/index.ts")], {
      env: { ...clean, BASALT_TOKEN: "bslt_secretvalue" },
      encoding: "utf8",
      input: "",
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BASALT_TOKEN is set but ORRAMA_TOKEN is not/);
    expect(r.stderr).not.toContain("secretvalue");
  });
});
