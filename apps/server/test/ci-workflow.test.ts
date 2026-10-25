/**
 * CI guards what it claims (audit OPS-004).
 *
 * Actions were referenced by movable tags with the repository's default token
 * scope; macOS — the platform Orrama runs on — ran only after a push to main,
 * never on sep-2026-redesign, the branch `pnpm ship` deploys from; and the
 * Docker image and the desktop crate were never built. Since 23 Oct 2026 the
 * minutes count too: only main runs on a push (Ubuntu and the audit), the
 * dear runners weekly and by hand. Since 25 Oct (stage 2, 2D) release.yml builds
 * the Windows installer on a tag or by hand, and is the one workflow that may
 * write to the repository: its jobs, to make a draft release.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
// The server does not depend on a YAML parser; core does.
const { parse } = createRequire(path.join(root, "packages/core/package.json"))("yaml") as { parse(text: string): unknown };
const dir = path.join(root, ".github/workflows");
type Step = { uses?: string; run?: string; name?: string };
type Job = { "runs-on": string; if?: string; steps: Step[]; "continue-on-error"?: boolean; permissions?: Record<string, string> };
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> };
const workflows = Object.fromEntries(
  fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, parse(fs.readFileSync(path.join(dir, f), "utf8")) as Workflow]),
);
const runs = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");

describe("CI workflows", () => {
  it("pin every action to a commit and grant the token read-only access", () => {
    expect(Object.keys(workflows).sort()).toEqual(["ci.yml", "desktop.yml", "docker.yml", "macos.yml", "release.yml", "windows.yml"]);
    for (const [file, wf] of Object.entries(workflows)) {
      expect(wf.permissions, file).toEqual({ contents: "read" });
      for (const job of Object.values(wf.jobs)) {
        for (const step of job.steps) if (step.uses) expect(step.uses, file).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        // Only a release job may write, and only contents (its draft release).
        if (file === "release.yml") expect(job.permissions, file).toEqual({ contents: "write" });
        else expect(job.permissions, file).toBeUndefined();
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
    for (const [file, os] of [["macos.yml", /^macos/], ["windows.yml", /^windows/], ["desktop.yml", /^windows/]] as const) {
      const wf = workflows[file]!;
      expect(Object.keys(wf.on).sort(), file).toEqual(["schedule", "workflow_dispatch"]);
      expect(Object.values(wf.jobs)[0]!["runs-on"], file).toMatch(os);
    }
    expect(runs(Object.values(workflows["macos.yml"]!.jobs)[0]!)).toMatch(/pnpm test/);
    // The desktop crate on Windows, where nothing else compiles it before a release.
    const desktop = Object.values(workflows["desktop.yml"]!.jobs)[0]! as Job & { defaults?: { run?: { "working-directory"?: string } } };
    expect(desktop.defaults?.run?.["working-directory"]).toBe("apps/desktop/src-tauri");
    expect(runs(desktop)).toMatch(/cargo clippy --locked .*-D warnings/);
    expect(runs(desktop)).toMatch(/cargo test --locked/);
  });

  it("builds the Windows installer on a v* tag or by hand, checks it installs, runs and uninstalls, and drafts the release", () => {
    const release = workflows["release.yml"]!;
    expect(Object.keys(release.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(release.on.push).toEqual({ tags: ["v*"] });
    const inputs = (release.on.workflow_dispatch as { inputs: Record<string, { required?: boolean; type?: string; default?: unknown }> }).inputs;
    expect(inputs.version).toMatchObject({ required: true, type: "string" });
    // The Mac on a runner costs 10x while the repository is private: only when asked.
    expect(inputs.mac).toMatchObject({ type: "boolean", default: false });
    const { windows, mac } = release.jobs as Record<string, Job>;
    expect(windows!["runs-on"]).toBe("windows-latest");
    expect(windows!.if).toBeUndefined();
    const steps = runs(windows!);
    expect(steps).toMatch(/node scripts\/release-build\.mjs --target x86_64-pc-windows-msvc/);
    expect(steps).toMatch(/node scripts\/install-check\.mjs --installer .*Orrama_\$\{\{ steps\.version\.outputs\.version \}\}_x64-setup\.exe/);
    expect(steps).toMatch(/gh release create "\$TAG" --draft/);
    expect(steps).toMatch(/gh release upload "\$TAG" .*_x64-setup\.exe/);
    expect(steps).toMatch(/Get-AuthenticodeSignature/);
    expect(steps).not.toMatch(/pnpm build|tauri build/); // the one script builds, the same as on the Mac
    expect(mac!.if).toBe("inputs.mac");
    expect(runs(mac!)).toMatch(/release-build\.mjs --target aarch64-apple-darwin/);
  });

  it("names the release from the app's version: the tag, or a test build by hand", async () => {
    const { releaseOf } = (await import(pathToFileURL(path.join(root, "scripts/release-version.mjs")).href)) as {
      releaseOf(r: { version: string; refType?: string; refName?: string; input?: string; runNumber?: string }): { version?: string; tag?: string; title?: string; problem?: string };
    };
    expect(releaseOf({ version: "0.2.0", refType: "tag", refName: "v0.2.0" })).toEqual({ version: "0.2.0", tag: "v0.2.0", title: "Orrama 0.2.0" });
    expect(releaseOf({ version: "0.2.0", refType: "tag", refName: "v0.1.9" }).problem).toMatch(/v0\.1\.9 is not v0\.2\.0/);
    expect(releaseOf({ version: "0.2.0", refType: "branch", refName: "main", input: "0.2.0", runNumber: "7" })).toEqual({
      version: "0.2.0",
      tag: "v0.2.0-test.7",
      title: "Orrama 0.2.0, test build 7",
    });
    expect(releaseOf({ version: "0.2.0", refType: "branch", refName: "main", input: "0.3.0", runNumber: "7" }).problem).toMatch(/asked for 0\.3\.0/);
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
