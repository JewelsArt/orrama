/**
 * CI guards what it claims (audit OPS-004).
 *
 * Actions were referenced by movable tags with the repository's default token
 * scope; macOS — the platform Orrama runs on — ran only after a push to main,
 * never on sep-2026-redesign, the branch `pnpm ship` deploys from; and the
 * Docker image and the desktop crate were never built. Since 23 Oct 2026 the
 * minutes count too: only main runs on a push (Ubuntu and the audit), the
 * dear runners weekly and by hand.
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
    expect(Object.keys(workflows).sort()).toEqual(["ci.yml", "desktop.yml", "docker.yml", "macos.yml", "windows.yml"]);
    for (const [file, wf] of Object.entries(workflows)) {
      expect(wf.permissions, file).toEqual({ contents: "read" });
      for (const job of Object.values(wf.jobs)) {
        for (const step of job.steps) if (step.uses) expect(step.uses, file).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("runs on pushes to main only: sep-2026-redesign is pushed with the same commit", () => {
    const ci = workflows["ci.yml"]!;
    expect((ci.on.push as { branches: string[] }).branches).toEqual(["main"]);
    expect(Object.keys(ci.on)).toEqual(expect.arrayContaining(["workflow_dispatch"]));
    expect(Object.values(ci.jobs).every((j) => j["runs-on"].startsWith("ubuntu")), "the dear runners have their own workflows").toBe(true);
    expect(Object.values(ci.jobs).some((j) => /pnpm test/.test(runs(j)))).toBe(true);
    expect(Object.values(ci.jobs).some((j) => /pnpm audit --prod/.test(runs(j)))).toBe(true);
  });

  it("runs macOS, Windows and the desktop crate weekly and by hand, never on a push", () => {
    for (const [file, os] of [["macos.yml", /^macos/], ["windows.yml", /^windows/], ["desktop.yml", /^ubuntu/]] as const) {
      const wf = workflows[file]!;
      expect(Object.keys(wf.on).sort(), file).toEqual(["schedule", "workflow_dispatch"]);
      expect(Object.values(wf.jobs)[0]!["runs-on"], file).toMatch(os);
    }
    expect(runs(Object.values(workflows["macos.yml"]!.jobs)[0]!)).toMatch(/pnpm test/);
    expect(Object.values(workflows["desktop.yml"]!.jobs).some((j) => /cargo check .*apps\/desktop\/src-tauri\/Cargo\.toml/.test(runs(j)))).toBe(true);
  });

  it("builds and boots the Docker image when its files or the lockfile change, weekly and by hand", () => {
    const docker = workflows["docker.yml"]!;
    const job = Object.values(docker.jobs).find((j) => /docker compose up --build/.test(runs(j)))!;
    expect(job, "a job that builds the image").toBeDefined();
    expect(runs(job)).toMatch(/api\/health/);
    const push = docker.on.push as { branches: string[]; paths: string[] };
    expect(push.branches).toEqual(["main"]);
    expect(push.paths).toEqual(expect.arrayContaining(["Dockerfile", "docker-compose.yml", "docker-entrypoint.sh", "pnpm-lock.yaml"]));
    expect(Object.keys(docker.on)).toEqual(expect.arrayContaining(["schedule", "workflow_dispatch"]));
  });
});
