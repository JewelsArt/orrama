/**
 * The five graph tools have one name in four places — the MCP server, the
 * in-app agent, the benchmark's `graph` variant and the agent's guide. A tool
 * renamed in one and not the others is a tool a model is told about and cannot
 * call, which no type checks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TOOLS = ["vault_schema", "find_entities", "get_relations", "find_path", "list_summaries"];
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, "..", "..", ...p), "utf8");

describe("graph tool names", () => {
  it("the MCP server lists and handles each", () => {
    const mcp = read("mcp", "src", "tools.ts");
    for (const t of TOOLS) {
      expect(mcp, t).toContain(`name: "${t}"`);
      expect(mcp, t).toContain(`case "${t}"`);
    }
    expect(read("mcp", "src", "graphQuery.ts")).toContain("vault_schema: \"schema\"");
  });

  it("the in-app agent has each, and its guide names them", () => {
    const ai = read("server", "src", "routes", "ai.ts");
    for (const t of TOOLS) {
      expect(ai, t).toMatch(new RegExp(`\\b${t}: tool\\(`));
      expect(ai, t).toContain(`${t} (`); // the guide: "vault_schema (the map…"
    }
  });

  const run = path.join(os.homedir(), "basalt-kg", "benchmark", "run.py");
  it.skipIf(!fs.existsSync(run))("the benchmark's graph variant allows exactly these on top of the baseline", () => {
    const src = fs.readFileSync(run, "utf8");
    const graph = /"graph":\s*\[([^\]]*)\]/s.exec(src)![1]!;
    const names = [...graph.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(names.slice(-TOOLS.length)).toEqual(TOOLS);
  });
});
