#!/usr/bin/env node
// A release build of the desktop app: the same steps on Jules's Mac and on CI's Windows runner.
//
//   node scripts/release-build.mjs [--target <triple>]     (default: this computer)
//   pnpm --dir apps/desktop release:mac                      (Apple silicon: Orrama_<v>_aarch64.dmg)
//
//   1. the licence guards: the npm packages' and the Rust crates' (two vitest files)
//   2. the web app, built into node_modules/.cache/orrama-release/web, never apps/web/dist (in
//      Jules's ~/basalt that folder is what the server on :4623 serves)
//   3. fetch-node, package-server --web <that folder>, desktop-notices, for <triple>
//   4. tauri build with tauri.bundle.conf.json: the .app and the .dmg on a Mac (ad-hoc signed),
//      the NSIS installer on Windows (unsigned), from the release profile in Cargo.toml
//
// It ends with the installer's path and size and how long it took. Unsigned on purpose for the
// friends' round (plan, 16 Oct 2026): a Mac says "Open Anyway" once, Windows SmartScreen "Run
// anyway". Builds for this computer's platform only (Tauri cannot make a Windows installer on a Mac
// without its experimental cross-compiling). Plain Node and no shell: cmd.exe runs it too.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CACHE, DESKTOP, ROOT, TARGETS, TAURI, fail, hostTriple, mb, targetArg } from "./bundle-common.mjs";

const WEB = path.join(ROOT, "apps", "web");
const WEB_OUT = path.join(path.dirname(CACHE), "orrama-release", "web");
const BUNDLES = { darwin: "app,dmg", win32: "nsis" };

const triple = targetArg();
const { platform } = TARGETS[triple];
if (platform !== process.platform) fail(`${triple} is built on ${platform}, this computer is ${process.platform}`);
const version = JSON.parse(fs.readFileSync(path.join(TAURI, "tauri.conf.json"), "utf8")).version;
const started = Date.now();

function step(what, script, args, cwd = ROOT) {
  console.log(`\n▸ ${what}`);
  const at = Date.now();
  const r = spawnSync(process.execPath, [script, ...args], { cwd, stdio: "inherit" });
  if (r.status !== 0) fail(`${what} failed${r.signal ? ` (${r.signal})` : ""}`);
  console.log(`  ${what}: ${((Date.now() - at) / 1000).toFixed(0)} s`);
}

step("licence guards", path.join(WEB, "node_modules", "vitest", "vitest.mjs"), ["run", "src/licenses.test.ts", "src/crateLicences.test.ts", "--maxWorkers=2"], WEB);
fs.rmSync(WEB_OUT, { recursive: true, force: true });
step("web app", path.join(WEB, "node_modules", "vite", "bin", "vite.js"), ["build", "--outDir", WEB_OUT, "--emptyOutDir"], WEB);
step("Node", path.join(ROOT, "scripts", "fetch-node.mjs"), ["--target", triple]);
step("server bundle", path.join(ROOT, "scripts", "package-server.mjs"), ["--target", triple, "--web", WEB_OUT]);
step("desktop notices", path.join(ROOT, "scripts", "desktop-notices.mjs"), ["--target", triple]);
const cross = triple === hostTriple() ? [] : ["--target", triple];
step(
  "tauri build",
  path.join(DESKTOP, "node_modules", "@tauri-apps", "cli", "tauri.js"),
  ["build", "--config", path.join("src-tauri", "tauri.bundle.conf.json"), "--bundles", BUNDLES[platform], ...cross],
  DESKTOP,
);

const bundle = path.join(TAURI, "target", ...(cross.length ? [triple] : []), "release", "bundle");
const installer =
  platform === "darwin"
    ? path.join(bundle, "dmg", `Orrama_${version}_${triple.startsWith("aarch64") ? "aarch64" : "x64"}.dmg`)
    : path.join(bundle, "nsis", `Orrama_${version}_x64-setup.exe`);
if (!fs.existsSync(installer)) fail(`tauri build finished but ${path.relative(ROOT, installer)} is not there`);
const minutes = (Date.now() - started) / 60000;
console.log(`\nOrrama ${version} for ${triple}: ${path.relative(ROOT, installer)} (${mb(fs.statSync(installer).size)}), in ${minutes.toFixed(1)} min`);
