/**
 * codebase-graph.md lists every source file (audit REG-012).
 *
 * The graph is written for an agent arriving cold, and it had silently gone
 * stale: no chatgpt.ts, export.ts, packages/schema or apps/mcp. This compares
 * the files it lists with what the generator finds today — the set, not every
 * import, so it fails on a missing or removed file, not on each edit.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const files = (md: string) => [...md.matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]!).sort();

describe("codebase-graph.md", () => {
  it("lists every source file — after adding or removing one, run `node scripts/graphify.mjs`", async () => {
    const { graph } = (await import(pathToFileURL(path.join(root, "scripts/graphify.mjs")).href)) as { graph(): string };
    const committed = files(fs.readFileSync(path.join(root, "codebase-graph.md"), "utf8"));
    const now = files(graph());
    expect(now).toEqual(expect.arrayContaining(["apps/server/src/chatgpt.ts", "packages/schema/src/responses.ts", "apps/mcp/src/index.ts"]));
    expect({ missing: now.filter((f) => !committed.includes(f)), gone: committed.filter((f) => !now.includes(f)) }).toEqual({ missing: [], gone: [] });
  });
});

describe("CLAUDE.md", () => {
  // The routes row had lost projects, finance and mail, three of the largest.
  it("names every route file in its Layout table, and the spec it points to is in the repo", () => {
    const guide = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    const row = guide.split("\n").find((l) => l.startsWith("| `apps/server/src/routes/` |"))!;
    const routes = fs.readdirSync(path.join(root, "apps/server/src/routes")).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, ""));
    expect(routes.filter((r) => !new RegExp(`\\b${r}\\b`).test(row))).toEqual([]);
    expect(guide).toContain("`docs/spec.md`");
    expect(fs.existsSync(path.join(root, "docs/spec.md"))).toBe(true);
    expect(guide).not.toMatch(/~\/basalt-prompt\.md/);
  });
});
