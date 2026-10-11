/**
 * Dependency hygiene (audit OPS-011).
 *
 * Production runs TypeScript through tsx (`start`, the launchd plist, the
 * Dockerfile), so a production-only install must include it; and the Node
 * types must be the runtime's oldest supported major, or the compiler accepts
 * APIs that throw on Node 22 (CI, Docker) — the server and sync typed against
 * @types/node 26.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string } };
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")) as Pkg;
const manifests = ["package.json", ...["apps", "packages"].flatMap((d) => fs.readdirSync(path.join(root, d)).map((p) => `${d}/${p}/package.json`))].filter((f) =>
  fs.existsSync(path.join(root, f)),
);

describe("dependencies", () => {
  it("what runs in production is a production dependency", () => {
    const server = read("apps/server/package.json");
    expect(server.scripts!.start).toMatch(/^tsx /);
    expect(server.dependencies).toHaveProperty("tsx");
    expect(server.devDependencies ?? {}).not.toHaveProperty("tsx");
  });

  it("every package types Node as the oldest runtime it supports", () => {
    const floor = /^>=(\d+)$/.exec(read("package.json").engines!.node!)![1];
    const majors = manifests.flatMap((f) => {
      const p = read(f);
      const v = p.devDependencies?.["@types/node"] ?? p.dependencies?.["@types/node"];
      return v ? [`${f}: ${/\d+/.exec(v)![0]}`] : [];
    });
    expect(majors.length).toBeGreaterThan(0);
    expect(majors.filter((m) => !m.endsWith(`: ${floor}`))).toEqual([]);
  });
});
