#!/usr/bin/env node
// The server as the desktop app carries it: apps/desktop/src-tauri/resources/server/ (git-ignored).
//
//   node scripts/package-server.mjs [--target <triple>] [--web <dir>]
//   (default: this computer, and apps/web/dist; a release builds the web app into its own folder)
//
// What goes in (the contract in ~/orrama-next/build/2-COMMON.md):
//   server.mjs               apps/server and the workspace packages in one ESM file (esbuild)
//   pdfText.worker.mjs       the PDF worker, beside it, bundled with unpdf
//   node_modules/            only the two native modules, built for <triple> and the pinned
//                            Node's ABI: better-sqlite3 (+ bindings, file-uri-to-path) and
//                            @node-rs/argon2 with its one platform package
//   web/                     the built web app (apps/web/dist; build it first)
//   package.json             { "type": "module", "version": <the app's version> }
//   LICENSE, NOTICE, THIRD_PARTY_NOTICES*.txt
//
// Any target can be built on any computer: the native modules are downloaded prebuilts, checked
// against apps/desktop/node-version.json, and their headers are read to make sure they are for
// <triple>. Nothing is compiled.
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import * as esbuild from "esbuild";
import {
  ROOT,
  TARGETS,
  TAURI,
  arg,
  binaryTarget,
  expectIntegrity,
  expectSha256,
  fail,
  fetchPinned,
  filesInTarGz,
  folderSize,
  mb,
  readPins,
  targetArg,
  writeWhole,
} from "./bundle-common.mjs";

const SERVER = path.join(ROOT, "apps", "server");
const WEB_DIST = path.resolve(arg("web", path.join(ROOT, "apps", "web", "dist")));
export const OUT = path.join(TAURI, "resources", "server");
/** Built here, then put in place whole: a refusal halfway never leaves a folder that looks built. */
const BUILD = `${OUT}.partial`;

/** Entry points that run themselves when they are the program (`isEntry`): only main may be in the bundle. */
const OTHER_ENTRIES = ["account.ts", "export.ts", "rotate-secret-key.ts", "seed.ts", "remove-user.ts"];
/** What the server imports only when it needs it (aiProvider.ts, projects.ts, finance.ts, the PDF worker). */
const LAZY = ["@ai-sdk/anthropic", "@ai-sdk/google", "@ai-sdk/openai", "mammoth", "exceljs", "unpdf"];
/** Loaded by the bundle at run time from node_modules beside it. */
const NATIVE = ["better-sqlite3", "@node-rs/argon2"];

const requireFromServer = createRequire(path.join(SERVER, "package.json"));
/** The installed copy of a package, by its folder (pnpm's store, symlinks resolved). */
const installed = (name, from = requireFromServer) => path.dirname(fs.realpathSync(from.resolve(`${name}/package.json`)));
const versionOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;

/** Copy a package's own files (never its node_modules) from `from` to `to`, keeping only what `keep` accepts. */
function copyPackage(from, to, keep = () => true) {
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.name === "node_modules" || !keep(r.split(path.sep).join("/"), e.isDirectory())) continue;
      if (e.isDirectory()) walk(r);
      else {
        fs.mkdirSync(path.join(to, rel), { recursive: true });
        fs.copyFileSync(path.join(from, r), path.join(to, r));
      }
    }
  };
  walk("");
}

function checkBinary(file, data, triple) {
  const want = TARGETS[triple];
  const got = binaryTarget(data);
  if (got.platform !== want.platform || got.arch !== want.arch) fail(`${file} is built for ${got.platform}-${got.arch}, not ${triple}`);
}

async function bundle(version) {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: { server: path.join(SERVER, "src", "main.ts"), "pdfText.worker": path.join(SERVER, "src", "pdfText.worker.mjs") },
    outdir: BUILD,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    // The two native modules load from node_modules beside the bundle; the rest are optional
    // speed-ups that ws and others try to require and do without.
    external: [...NATIVE, "bufferutil", "utf-8-validate"],
    // CommonJS dependencies inside an ES module still call require().
    banner: { js: 'import { createRequire as __orramaRequire } from "node:module";\nconst require = __orramaRequire(import.meta.url);' },
    define: { __ORRAMA_BUNDLE__: JSON.stringify({ version }) },
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
  });
  const inputs = Object.keys(result.metafile.inputs).map((p) => p.split("\\").join("/"));
  const strays = inputs.filter((p) => OTHER_ENTRIES.some((e) => p.endsWith(`apps/server/src/${e}`)));
  if (strays.length) fail(`the bundle took in ${strays.join(", ")}: in one file every module's import.meta.url is the bundle's, so its isEntry() would say yes and run it`);
  // Imported with import() when first needed: bundled in, or the first document opened, or
  // the first question to Orr, fails on a friend's computer.
  const missing = LAZY.filter((pkg) => !inputs.some((p) => p.includes(`/node_modules/${pkg}/`)));
  if (missing.length) fail(`the bundle does not hold ${missing.join(", ")}, which the server imports when first needed`);
  const external = Object.values(result.metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external && !i.path.startsWith("node:")).map((i) => i.path));
  const unexpected = [...new Set(external)].filter((p) => !NATIVE.includes(p) && !["bufferutil", "utf-8-validate"].includes(p) && !builtinModules.includes(p));
  if (unexpected.length) fail(`the bundle would need ${unexpected.join(", ")} at run time, which the app does not carry`);
  const main = fs.readFileSync(path.join(BUILD, "server.mjs"), "utf8");
  if (!main.includes('new URL("./pdfText.worker.mjs", import.meta.url)')) fail("server.mjs no longer starts the PDF worker from ./pdfText.worker.mjs beside it");
}

async function natives(triple, pins) {
  const nm = path.join(BUILD, "node_modules");
  const node = pins.node;
  if (pins.native.abi !== node.abi) fail(`the native modules are pinned for ABI ${pins.native.abi}, Node ${node.version} is ABI ${node.abi}`);

  // better-sqlite3: its JavaScript from the lockfile's copy, its addon from the release built for this ABI.
  const sqlite = installed("better-sqlite3");
  const sqlitePin = pins.native["better-sqlite3"];
  if (versionOf(sqlite) !== sqlitePin.version) fail(`better-sqlite3 ${versionOf(sqlite)} is installed, ${sqlitePin.version} is pinned: update the pins`);
  const sqliteTarget = sqlitePin.targets[triple];
  const sqliteTar = await fetchPinned(sqliteTarget.url, path.basename(sqliteTarget.url), expectSha256(sqliteTarget.sha256));
  const addon = filesInTarGz(sqliteTar, (n) => n === "build/Release/better_sqlite3.node")[0];
  if (!addon) fail(`${path.basename(sqliteTarget.url)} has no build/Release/better_sqlite3.node`);
  checkBinary("better_sqlite3.node", addon.data, triple);
  const sqliteOut = path.join(nm, "better-sqlite3");
  copyPackage(sqlite, sqliteOut, (r) => r === "package.json" || r === "LICENSE" || r === "lib" || r.startsWith("lib/"));
  writeWhole(path.join(sqliteOut, "build", "Release", "better_sqlite3.node"), addon.data, 0o755);
  const fromSqlite = createRequire(path.join(sqlite, "package.json"));
  const bindings = installed("bindings", fromSqlite);
  copyPackage(bindings, path.join(nm, "bindings"), (r) => !r.endsWith(".md"));
  copyPackage(installed("file-uri-to-path", createRequire(path.join(bindings, "package.json"))), path.join(nm, "file-uri-to-path"), (r, dir) => !dir && /^(package\.json|LICENSE|index\.js)$/.test(r));

  // @node-rs/argon2: its loader from the lockfile's copy, the one platform package from npm.
  const argon = installed("@node-rs/argon2");
  const argonPin = pins.native["@node-rs/argon2"];
  if (versionOf(argon) !== argonPin.version) fail(`@node-rs/argon2 ${versionOf(argon)} is installed, ${argonPin.version} is pinned: update the pins`);
  copyPackage(argon, path.join(nm, "@node-rs", "argon2"), (r) => r === "package.json" || r === "index.js" || r === "LICENSE");
  const argonTarget = argonPin.targets[triple];
  const tgz = await fetchPinned(argonTarget.url, path.basename(argonTarget.url), expectIntegrity(argonTarget.integrity));
  const files = filesInTarGz(tgz, (n) => n.startsWith("package/"));
  const binding = files.find((f) => f.name.endsWith(".node"));
  if (!binding) fail(`${argonTarget.package} has no .node file`);
  checkBinary(binding.name, binding.data, triple);
  for (const f of files) writeWhole(path.join(nm, ...argonTarget.package.split("/"), f.name.slice("package/".length)), f.data, f.name.endsWith(".node") ? 0o755 : 0o644);
}

function web() {
  if (!fs.existsSync(path.join(WEB_DIST, "index.html"))) fail(`there is no built web app in ${path.relative(ROOT, WEB_DIST)}: run pnpm --dir apps/web build first`);
  fs.cpSync(WEB_DIST, path.join(BUILD, "web"), { recursive: true });
  for (const f of ["THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES_SERVER.txt"]) {
    if (!fs.existsSync(path.join(WEB_DIST, f))) fail(`${f} is missing from the web build`);
    fs.copyFileSync(path.join(WEB_DIST, f), path.join(BUILD, f));
  }
  for (const f of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(ROOT, f), path.join(BUILD, f));
}

const triple = targetArg();
const pins = readPins();
const version = versionOf(ROOT);
const started = Date.now();
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
await bundle(version);
await natives(triple, pins);
web();
fs.writeFileSync(path.join(BUILD, "package.json"), `${JSON.stringify({ type: "module", version }, null, 2)}\n`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(BUILD, OUT);

const part = (p) => mb(fs.statSync(path.join(OUT, p)).isDirectory() ? folderSize(path.join(OUT, p)) : fs.statSync(path.join(OUT, p)).size);
console.log(`Orrama ${version} server for ${triple} in ${path.relative(ROOT, OUT)} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
console.log(`  server.mjs ${part("server.mjs")}, pdfText.worker.mjs ${part("pdfText.worker.mjs")}, node_modules ${part("node_modules")}, web ${part("web")}`);
console.log(`  total ${mb(folderSize(OUT))}`);
