#!/usr/bin/env node
// The update feed (2E): `latest.json`, the file every installed Orrama reads at launch and every
// 6 hours (apps/desktop/src-tauri/src/updater.rs) from
// https://github.com/<repo>/releases/latest/download/latest.json (tauri.conf.json,
// plugins.updater.endpoints). It names the newest version and, per platform, where its signed
// update bundle is and the bundle's signature; the app checks that signature against the public
// key in tauri.conf.json before it installs anything.
//
//   node scripts/release-feed.mjs add --feed <latest.json> --version <X.Y.Z> --platform <platform>
//        --asset <bundle> --base <download URL folder> [--notes-file <file>]
//   node scripts/release-feed.mjs check --feed <latest.json> --version <X.Y.Z> [--platforms a,b]
//
// add: puts one platform's entry into the feed (made when missing): the bundle's signature is read
// from `<bundle>.sig`, which `tauri build` writes beside it when the signing key is set
// (TAURI_SIGNING_PRIVATE_KEY, _PASSWORD), and its URL is <base>/<bundle's file name>. The notes are
// the version's CHANGELOG.md entry unless --notes-file says otherwise (the dialog shows their first
// three lines). A feed made for another version is refused, never mixed.
// check: before the release is published, the feed must be this version's and hold every platform.
//
// Platforms: darwin-aarch64 (Orrama_<v>_aarch64.app.tar.gz, from Jules's Mac or the mac job) and
// windows-x86_64 (Orrama_<v>_x64-setup.exe, from release.yml's windows job). Plain Node, no shell.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLATFORMS = ["darwin-aarch64", "windows-x86_64"];
const VERSION = /^\d+\.\d+\.\d+$/;

/** The text under `## [<version>] — <date>` in a changelog, up to the next `## `; "" when absent. */
export function notesFromChangelog(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/** Whether a URL may be put in a feed: https, or http to this computer (a local test feed). */
function urlProblem(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return `${url} is not a URL`;
  }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
  return `${url}: a feed's downloads are https (http only to this computer, for a test)`;
}

/** The feed with one platform's entry put in, or { problem }. `feed` is null for a new one. */
export function addToFeed(feed, { version, platform, signature, url, notes, now = new Date() }) {
  if (!VERSION.test(version ?? "")) return { problem: `${version || "no version"} is not X.Y.Z: a test build (-test.N) never goes in a feed` };
  if (!PLATFORMS.includes(platform)) return { problem: `${platform || "no platform"} is not one of ${PLATFORMS.join(", ")}` };
  if (!signature?.trim()) return { problem: `no signature for ${platform}: build with TAURI_SIGNING_PRIVATE_KEY and _PASSWORD set` };
  const bad = urlProblem(url);
  if (bad) return { problem: bad };
  if (feed && feed.version !== version) return { problem: `the feed is for ${feed.version}, not ${version}: start a new one for a new version` };
  const base = feed ?? { version, notes: notes ?? "", pub_date: now.toISOString().replace(/\.\d+Z$/, "Z"), platforms: {} };
  return { feed: { ...base, notes: notes ?? base.notes, platforms: { ...base.platforms, [platform]: { signature: signature.trim(), url } } } };
}

/** What stops this feed from being published for `version`; [] when nothing. */
export function checkFeed(feed, version, platforms = PLATFORMS) {
  if (!feed) return ["there is no feed"];
  const problems = [];
  if (feed.version !== version) problems.push(`the feed is for ${feed.version}, not ${version}`);
  for (const p of platforms) {
    const entry = feed.platforms?.[p];
    if (!entry) problems.push(`${p} is missing`);
    else {
      if (!entry.signature) problems.push(`${p} has no signature`);
      const bad = urlProblem(entry.url ?? "");
      if (bad) problems.push(`${p}: ${bad}`);
      else if (!new URL(entry.url).pathname.includes(version)) problems.push(`${p}'s download (${entry.url}) does not name ${version}`);
    }
  }
  return problems;
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

function fail(msg) {
  console.error(`release-feed: ${msg}`);
  process.exit(1);
}

const readFeed = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2));
  const [command] = a._;
  if (!a.feed || !a.version) fail("usage: add|check --feed <latest.json> --version <X.Y.Z> …");
  if (command === "add") {
    if (!a.asset || !a.base || !a.platform) fail("add needs --platform, --asset and --base");
    if (!fs.existsSync(a.asset)) fail(`${a.asset} is not there`);
    const sig = `${a.asset}.sig`;
    if (!fs.existsSync(sig)) fail(`${sig} is not there: build with TAURI_SIGNING_PRIVATE_KEY and _PASSWORD set`);
    if (!path.basename(a.asset).includes(a.version)) fail(`${path.basename(a.asset)} does not name ${a.version}: upload it as Orrama_${a.version}_…`);
    const notes = a["notes-file"] ? fs.readFileSync(a["notes-file"], "utf8").trim() : notesFromChangelog(fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"), a.version);
    const r = addToFeed(readFeed(a.feed), {
      version: a.version,
      platform: a.platform,
      signature: fs.readFileSync(sig, "utf8"),
      url: `${a.base.replace(/\/+$/, "")}/${encodeURIComponent(path.basename(a.asset))}`,
      notes,
    });
    if (r.problem) fail(r.problem);
    fs.writeFileSync(a.feed, `${JSON.stringify(r.feed, null, 2)}\n`);
    console.log(`${a.feed}: ${a.platform} → ${r.feed.platforms[a.platform].url}`);
  } else if (command === "check") {
    const problems = checkFeed(readFeed(a.feed), a.version, a.platforms ? a.platforms.split(",") : PLATFORMS);
    if (problems.length) fail(`not ready to publish:\n  ${problems.join("\n  ")}`);
    console.log(`${a.feed}: ${a.version} for ${(a.platforms ?? PLATFORMS.join(",")).split(",").join(" and ")}, ready to publish`);
  } else fail(`unknown command ${command ?? ""}: add or check`);
}
