/**
 * The hooks linter is real (audit REG-016): the eslint-disable comments in the
 * web app named react-hooks/exhaustive-deps for years with no ESLint installed,
 * so nothing told an intended short dependency list from a stale one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const web = path.resolve(import.meta.dirname, "..");
const root = path.resolve(web, "../..");
const eslint = new ESLint({ cwd: web });
const lint = async (code: string) => (await eslint.lintText(code, { filePath: path.join(web, "src/probe.tsx") }))[0]!.messages.map((m) => `${m.ruleId}: ${m.message}`);

describe("eslint (apps/web)", () => {
  it("catches a stale dependency list and a hook called conditionally", async () => {
    const stale = await lint(`import { useEffect } from "react";\nexport function A({ id }: { id: string }) {\n  useEffect(() => { console.log(id); }, []);\n  return null;\n}\n`);
    expect(stale.join("\n")).toMatch(/react-hooks\/exhaustive-deps: React Hook useEffect has a missing dependency: 'id'/);
    const conditional = await lint(`import { useState } from "react";\nexport function B({ on }: { on: boolean }) {\n  if (on) useState(0);\n  return null;\n}\n`);
    expect(conditional.join("\n")).toMatch(/react-hooks\/rules-of-hooks/);
  }, 30_000);

  it("an async event handler must catch what it awaits (WEB-010)", async () => {
    const silent = await lint(`export const A = () => <button onClick={async () => { await fetch("/x"); }} />;\n`);
    expect(silent.join("\n")).toMatch(/basalt\/async-handler-catches: This async onClick awaits outside a try\/catch/);
    const control = await lint(`import { Button } from "./ui/controls.js";\nexport const A = () => <Button onClick={async () => { for await (const x of []) {} }} />;\n`);
    expect(control.join("\n")).toMatch(/basalt\/async-handler-catches/);
    const caught = await lint(`export const A = () => <form onSubmit={async () => { try { await fetch("/x"); } catch { /* said */ } }} />;\n`);
    const finallyOnly = await lint(`export const A = () => <form onSubmit={async () => { try { await fetch("/x"); } finally { } }} />;\n`);
    const awaitedByItsComponent = await lint(`import { NameDialog } from "./ui/NameDialog.js";\nexport const A = () => <NameDialog onSubmit={async () => { await fetch("/x"); }} />;\n`);
    const nested = await lint(`export const A = () => <button onClick={async () => { void (async () => { await fetch("/x"); })().catch(() => {}); }} />;\n`);
    expect(caught).toEqual([]);
    expect(finallyOnly.join("\n")).toMatch(/basalt\/async-handler-catches/);
    expect(awaitedByItsComponent).toEqual([]);
    expect(nested).toEqual([]);
  }, 30_000);

  it("reports a suppression that suppresses nothing", async () => {
    const unused = await lint(`export const x = 1; // eslint-disable-line react-hooks/exhaustive-deps\n`);
    expect(unused.join("\n")).toMatch(/Unused eslint-disable directive/);
  }, 30_000);

  it("every eslint-disable in the repo is in linted code and names an enforced rule", () => {
    const config = fs.readFileSync(path.join(web, "eslint.config.js"), "utf8");
    const enforced = [...config.matchAll(/"([\w-]+\/[\w-]+)": "error"/g)].map((m) => m[1]!);
    const hits = execFileSync("git", ["grep", "-n", "eslint-disable", "--", "apps", "packages"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((l) => !l.startsWith("apps/web/src/lint.test.ts") && !l.startsWith("apps/web/eslint.config.js"));
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h, h).toMatch(/^apps\/web\/src\//);
      const rule = /eslint-disable(?:-next-line|-line)?\s+([\w/-]+)/.exec(h)?.[1];
      expect(enforced, h).toContain(rule);
    }
  });

  it("runs in CI", () => {
    expect(JSON.parse(fs.readFileSync(path.join(web, "package.json"), "utf8")).scripts.lint).toBe("eslint .");
    expect(fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")).toMatch(/^\s+- run: pnpm lint$/m);
  });
});
