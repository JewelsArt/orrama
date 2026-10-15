/**
 * CI guards what it claims (audit OPS-004).
 *
 * Actions were referenced by movable tags with the repository's default token
 * scope; macOS — the platform Orrama runs on — ran only after a push to main,
 * never on sep-2026-redesign, the branch `pnpm ship` deploys from; and the
 * Docker image and the desktop crate were never built.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
// The server does not depend on a YAML parser; core does.
const { parse } = createRequire(path.join(root, "packages/core/package.json"))("yaml") as { parse(text: string): unknown };
const dir = path.join(root, ".github/workflows");
type Step = { uses?: string; run?: string };
type Job = { "runs-on": string; if?: string; steps: Step[]; "continue-on-error"?: boolean };
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> };
const workflows = Object.fromEntries(
  fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, parse(fs.readFileSync(path.join(dir, f), "utf8")) as Workflow]),
);
const runs = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");

describe("CI workflows", () => {
  it("pin every action to a commit and grant the token read-only access", () => {
    expect(Object.keys(workflows).sort()).toEqual(["ci.yml", "desktop.yml", "windows.yml"]);
    for (const [file, wf] of Object.entries(workflows)) {
      expect(wf.permissions, file).toEqual({ contents: "read" });
      for (const job of Object.values(wf.jobs)) {
        for (const step of job.steps) if (step.uses) expect(step.uses, file).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("runs macOS on pushes to both branches that ship, and by hand", () => {
    const ci = workflows["ci.yml"]!;
    const mac = Object.values(ci.jobs).find((j) => j["runs-on"].startsWith("macos"))!;
    expect(mac.if).toContain("refs/heads/main");
    expect(mac.if).toContain("refs/heads/sep-2026-redesign");
    expect(mac.if).toContain("workflow_dispatch");
    expect(runs(mac)).toMatch(/pnpm test/);
    expect((ci.on.push as { branches: string[] }).branches).toEqual(expect.arrayContaining(["main", "sep-2026-redesign"]));
  });

  it("builds and boots the Docker image, and audits dependencies", () => {
    const jobs = Object.values(workflows["ci.yml"]!.jobs);
    const docker = jobs.find((j) => /docker compose up --build/.test(runs(j)))!;
    expect(docker, "a job that builds the image").toBeDefined();
    expect(runs(docker)).toMatch(/api\/health/);
    expect(jobs.some((j) => /pnpm audit --prod/.test(runs(j)))).toBe(true);
  });

  it("checks the desktop crate when it changes, and Windows by hand", () => {
    const desktop = workflows["desktop.yml"]!;
    expect(Object.values(desktop.jobs).some((j) => /cargo check .*apps\/desktop\/src-tauri\/Cargo\.toml/.test(runs(j)))).toBe(true);
    expect((desktop.on.pull_request as { paths: string[] }).paths).toContain("apps/desktop/**");
    const windows = workflows["windows.yml"]!;
    expect(Object.keys(windows.on)).toEqual(["workflow_dispatch"]);
    expect(Object.values(windows.jobs)[0]!["runs-on"]).toMatch(/^windows/);
  });
});
