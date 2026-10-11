/**
 * `pnpm typecheck` cannot replay a pass from before an upstream change
 * (audit OPS-001).
 *
 * turbo.json had `typecheck: {}`: cached, no dependsOn. Turbo hashes a task
 * from its own package's files and the tasks it depends on, so an edit in
 * packages/core left @basalt/server#typecheck's hash unchanged and the cache
 * replayed its last "success" — on the machine `pnpm ship` deploys from.
 * Checked the way the ticket did: `turbo run typecheck --dry=json` hashes, on a
 * scratch copy of the working tree, before and after an edit.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const turbo = path.join(root, "node_modules/.bin/turbo");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-turbo-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

for (const f of execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0")) {
  if (!f || !fs.existsSync(path.join(root, f))) continue;
  fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
  fs.copyFileSync(path.join(root, f), path.join(tmp, f));
}

function hashes(): Record<string, string> {
  const out = execFileSync(turbo, ["run", "typecheck", "--dry=json"], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const json = JSON.parse(out) as { tasks: { taskId: string; task: string; hash: string }[] };
  return Object.fromEntries(json.tasks.filter((t) => t.task === "typecheck").map((t) => [t.taskId, t.hash]));
}
const append = (rel: string, text: string) => fs.appendFileSync(path.join(tmp, rel), text);

describe("turbo typecheck cache", () => {
  it("an edit upstream gives every dependent's typecheck a new hash", () => {
    const before = hashes();
    append("packages/core/src/acl.ts", "\nexport const __probe: number = 1;\n");
    const core = hashes();
    for (const t of ["@basalt/core#typecheck", "@basalt/sync#typecheck", "@basalt/server#typecheck", "@basalt/web#typecheck"]) {
      expect(core[t], t).toBeDefined();
      expect(core[t], t).not.toBe(before[t]);
    }
    append("packages/schema/src/responses.ts", "\nexport const __probe2: number = 1;\n");
    const schema = hashes();
    for (const t of ["@basalt/server#typecheck", "@basalt/web#typecheck"]) expect(schema[t], t).not.toBe(core[t]);
    // The shared compiler options are every package's input.
    append("tsconfig.base.json", "\n");
    const base = hashes();
    for (const t of Object.keys(base)) expect(base[t], t).not.toBe(schema[t]);
  }, 120_000);
});
