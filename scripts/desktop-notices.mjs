#!/usr/bin/env node
// The desktop app's own third-party notices: the Node it ships and the Rust crates its window is
// built from. The web app's and the server's come from the web build (apps/web/licenses.ts).
//
//   node scripts/desktop-notices.mjs [--target <triple>]   write THIRD_PARTY_NOTICES_DESKTOP.txt
//   node scripts/desktop-notices.mjs --licences            rewrite apps/desktop/crate-licences.json
//
// The notices go into apps/desktop/src-tauri/resources/server/ (run package-server first) and
// into its web/ folder, which the server serves: Settings links /THIRD_PARTY_NOTICES_DESKTOP.txt.
//
//   Node.js        the LICENSE file of the pinned archive for <triple> (fetch-node's download)
//   Rust crates    every crate the window is compiled from for <triple> (`cargo metadata`, normal
//                  dependencies, build scripts' and tests' left out), with the licence files it
//                  ships; identical texts are printed once, under every crate that ships them.
//                  A crate that ships no file gets the SPDX text of its licence from
//                  apps/desktop/licences/, printed once at the end.
//
// crate-licences.json is every crate in Cargo.lock with the licence its Cargo.toml states, for
// every platform: the licence guard (apps/web/src/crateLicences.test.ts) holds it to the same
// rule as the npm packages, without needing cargo. A notices run refuses when it no longer
// matches Cargo.lock: after a crate is added or bumped, run --licences and the guard.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP, TAURI, ROOT, expectSha256, fail, fetchPinned, fileInZip, filesInTarGz, mb, readPins, targetArg, writeWhole } from "./bundle-common.mjs";

export const NOTICES_FILE = "THIRD_PARTY_NOTICES_DESKTOP.txt";
export const LICENCES_FILE = path.join(DESKTOP, "crate-licences.json");
const TEXTS = path.join(DESKTOP, "licences");
const MANIFEST = path.join(TAURI, "Cargo.toml");
const OUT = path.join(TAURI, "resources", "server");
const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicense)([._-].*)?$/i;
/** Which of a crate's choices to print when it ships no text: the shortest and most common first. */
const PREFERRED = ["MIT", "Apache-2.0", "BSD-3-Clause", "Zlib", "MPL-2.0"];
const RULE = "=".repeat(78);
const LINE = "-".repeat(78);

function metadata(triple) {
  const args = ["metadata", "--format-version", "1", "--locked", "--manifest-path", MANIFEST];
  if (triple) args.push("--filter-platform", triple);
  try {
    return JSON.parse(execFileSync("cargo", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] }));
  } catch (e) {
    fail(`cargo metadata failed (${e.message.split("\n")[0]}): a Rust toolchain is needed to write the desktop notices`);
  }
}

const key = (p) => `${p.name}@${p.version}`;

/** Every crate from a registry in Cargo.lock, with the licence its Cargo.toml states. */
export function crateLicences(meta) {
  const out = {};
  for (const p of [...meta.packages].filter((p) => p.source).sort((a, b) => key(a).localeCompare(key(b)))) {
    out[key(p)] = p.license ?? (p.license_file ? `SEE FILE ${p.license_file}` : "UNKNOWN");
  }
  return out;
}

/** The crates compiled into the window for one target: normal dependencies from the root, down. */
export function shippedCrates(meta) {
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind === null)) walk(d.pkg);
  };
  walk(meta.resolve.root);
  return [...seen].map((id) => byId.get(id)).filter((p) => p.source);
}

/** `expr` split on `op` outside brackets, each part without its own outer brackets. */
function splitTop(expr, op) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") depth--;
    else if (depth === 0 && expr.startsWith(` ${op} `, i)) {
      parts.push(expr.slice(start, i));
      start = i + op.length + 2;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim().replace(/^\((.*)\)$/, "$1").trim());
}

/**
 * A crate's licence as an SPDX expression: Cargo's old `MIT/Apache-2.0` is an OR, and an
 * exception (`WITH LLVM-exception`) only adds permissions, so the licence it qualifies is the one
 * that counts.
 */
export const normalLicence = (expr) => expr.replace(/\s*\/\s*/g, " OR ").replace(/ WITH [\w.-]+/g, "").trim();

/** The SPDX ids to print for a crate that ships no licence file: one choice of each OR, every part of an AND. */
export function textsFor(expr) {
  const ids = splitTop(normalLicence(expr), "AND").flatMap((part) => {
    // Each part is shorter than the expression it came from (its brackets are gone), so this ends.
    const choices = splitTop(part, "OR");
    if (choices.length > 1) return textsFor(PREFERRED.find((id) => choices.includes(id)) ?? choices[0]);
    return / AND /.test(part) ? textsFor(part) : [part];
  });
  return [...new Set(ids)];
}

/** The licence files a crate ships, each as its text. */
function crateTexts(p) {
  const dir = path.dirname(p.manifest_path);
  const files = fs.readdirSync(dir).filter((f) => LICENCE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile());
  if (p.license_file && !files.includes(p.license_file)) files.push(p.license_file);
  return files.sort().map((f) => fs.readFileSync(path.join(dir, f), "utf8").trim()).filter(Boolean);
}

async function nodeLicence(triple) {
  const pins = readPins();
  const pin = pins.node.targets[triple];
  const bytes = await fetchPinned(`https://nodejs.org/dist/v${pins.node.version}/${pin.archive}`, pin.archive, expectSha256(pin.sha256));
  const name = `${pin.file.split("/")[0]}/LICENSE`;
  const text = pin.archive.endsWith(".zip") ? fileInZip(bytes, name) : filesInTarGz(bytes, (n) => n === name)[0]?.data;
  if (!text) fail(`${pin.archive} has no ${name}`);
  return { version: pins.node.version, text: text.toString("utf8").trim() };
}

export function noticesText({ triple, node, crates }) {
  const groups = new Map();
  const missing = new Set();
  for (const p of crates.sort((a, b) => key(a).localeCompare(key(b)))) {
    const texts = crateTexts(p);
    const label = `${key(p)} — ${p.license ?? "see its licence file"}`;
    if (!texts.length) {
      const ids = textsFor(p.license ?? "UNKNOWN");
      ids.forEach((id) => missing.add(id));
      const authors = p.authors?.length ? `\n  by ${p.authors.join(", ")}` : "";
      const g = `(ships no licence file: ${ids.join(" and ")}, the text at the end of this file${p.authors?.length ? ", with these authors as its copyright holders" : ""})`;
      groups.set(`\0${key(p)}`, { labels: [`${label}${authors}`], text: g });
      continue;
    }
    // The same text (most Apache-2.0 files, many MIT ones) is printed once, under every crate that ships it.
    for (const text of texts) {
      const same = text.replace(/\s+/g, " ");
      const g = groups.get(same) ?? { labels: [], text };
      g.labels.push(label);
      groups.set(same, g);
    }
  }
  const texts = [...missing].sort().map((id) => {
    const file = path.join(TEXTS, `${id}.txt`);
    if (!fs.existsSync(file)) fail(`a crate ships no licence file and its licence is ${id}: add the SPDX text as ${path.relative(ROOT, file)}`);
    return `${LINE}\n${id}\n${LINE}\n\n${fs.readFileSync(file, "utf8").trim()}\n`;
  });
  return [
    "Orrama's desktop app includes the following third-party software: the Node.js runtime its",
    "server runs on, and the Rust crates its window is built from. The web app's notices are in",
    "THIRD_PARTY_NOTICES.txt, the server's in THIRD_PARTY_NOTICES_SERVER.txt, beside this file.",
    `Built for ${triple}.`,
    "",
    RULE,
    `Node.js ${node.version} — MIT, and the licences of the parts it includes, as Node.js ships them`,
    RULE,
    "",
    node.text,
    "",
    RULE,
    `Rust crates (${crates.length})`,
    RULE,
    "",
    ...[...groups.values()].map((g) => `${LINE}\n${g.labels.join("\n")}\n${LINE}\n\n${g.text}\n`),
    ...(texts.length ? [RULE, "Licence texts for the crates that ship none", RULE, "", ...texts] : []),
  ].join("\n");
}

const sameLicences = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = crateLicences(metadata(null));
  if (process.argv.includes("--licences")) {
    fs.writeFileSync(LICENCES_FILE, `${JSON.stringify(all, null, 2)}\n`);
    console.log(`${Object.keys(all).length} crates in ${path.relative(ROOT, LICENCES_FILE)}; now run the guard: pnpm --dir apps/web exec vitest run src/crateLicences.test.ts`);
  } else {
    const kept = fs.existsSync(LICENCES_FILE) ? JSON.parse(fs.readFileSync(LICENCES_FILE, "utf8")) : {};
    if (!sameLicences(kept, all)) {
      const added = Object.keys(all).filter((k) => kept[k] !== all[k]);
      const gone = Object.keys(kept).filter((k) => !(k in all));
      fail(
        `${path.relative(ROOT, LICENCES_FILE)} does not match Cargo.lock (new or changed: ${added.join(", ") || "none"}; gone: ${gone.join(", ") || "none"}). ` +
          "Run node scripts/desktop-notices.mjs --licences, then the guard (pnpm --dir apps/web exec vitest run src/crateLicences.test.ts), and commit both.",
      );
    }
    const triple = targetArg();
    if (!fs.existsSync(path.join(OUT, "server.mjs"))) fail(`there is no server bundle in ${path.relative(ROOT, OUT)}: run package-server --target ${triple} first`);
    const text = noticesText({ triple, node: await nodeLicence(triple), crates: shippedCrates(metadata(triple)) });
    for (const dir of [OUT, path.join(OUT, "web")]) writeWhole(path.join(dir, NOTICES_FILE), text);
    console.log(`Desktop notices for ${triple}: ${path.relative(ROOT, path.join(OUT, NOTICES_FILE))} and web/ (${mb(Buffer.byteLength(text))})`);
  }
}
