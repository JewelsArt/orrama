#!/usr/bin/env node
// The Node the desktop app ships, put where Tauri takes its sidecar from:
// apps/desktop/src-tauri/binaries/node-<target triple>[.exe] (git-ignored).
//
//   node scripts/fetch-node.mjs [--target <triple>]   the pinned Node for one target (default: this computer)
//   node scripts/fetch-node.mjs --pin <version>       write a new version's hashes into the pins
//
// The official nodejs.org build, unmodified: Homebrew's node is a launcher linked to Homebrew's
// libraries, and a rewritten node.exe loses its OpenJS signature. The archive must match the
// SHA-256 pinned in apps/desktop/node-version.json AND the one in that release's SHASUMS256.txt,
// and the binary taken out of it must match its own pin; any mismatch stops with nothing
// written. Only the binary is extracted, not npm or the headers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TARGETS,
  TAURI,
  PINS_FILE,
  ROOT,
  arg,
  binaryTarget,
  expectSha256,
  fail,
  fetchPinned,
  fileInZip,
  filesInTarGz,
  mb,
  peHasSignature,
  readPins,
  sha256,
  targetArg,
  writeWhole,
} from "./bundle-common.mjs";

const DIST = "https://nodejs.org/dist";
/** nodejs.org's name for each target's archive, and the binary's path inside it. */
const archiveOf = (version, triple) => {
  const { platform, arch } = TARGETS[triple];
  const base = `node-v${version}-${platform === "win32" ? "win" : platform}-${arch}`;
  return platform === "win32" ? { archive: `${base}.zip`, file: `${base}/node.exe` } : { archive: `${base}.tar.gz`, file: `${base}/bin/node` };
};

async function shasums(version) {
  // Not pinned itself: it is checked against the pins, which are.
  const text = (await fetchPinned(`${DIST}/v${version}/SHASUMS256.txt`, `node-v${version}-SHASUMS256.txt`, () => null)).toString("utf8");
  return new Map(text.trim().split("\n").map((l) => l.trim().split(/\s+/).reverse()));
}

function extract(bytes, archive, file) {
  if (archive.endsWith(".zip")) return fileInZip(bytes, file);
  return filesInTarGz(bytes, (name) => name === file)[0]?.data ?? null;
}

/** The binary for one target, checked against every pin, or the script stops. */
export async function nodeBinary(triple, pins = readPins()) {
  const node = pins.node;
  const pin = node.targets[triple];
  if (!pin) fail(`${path.relative(ROOT, PINS_FILE)} has no Node for ${triple}`);
  const listed = (await shasums(node.version)).get(pin.archive);
  if (listed !== pin.sha256) fail(`${pin.archive}: SHASUMS256.txt says ${listed ?? "nothing"}, the pin says ${pin.sha256}`);
  const bytes = await fetchPinned(`${DIST}/v${node.version}/${pin.archive}`, pin.archive, expectSha256(pin.sha256));
  const bin = extract(bytes, pin.archive, pin.file);
  if (!bin) fail(`${pin.archive} has no ${pin.file}`);
  if (sha256(bin) !== pin.binarySha256) fail(`${pin.file}: sha256 ${sha256(bin)}, pinned ${pin.binarySha256}`);
  const { platform, arch } = binaryTarget(bin);
  if (platform !== TARGETS[triple].platform || arch !== TARGETS[triple].arch) fail(`${pin.file} is built for ${platform}-${arch}, not ${triple}`);
  if (platform === "win32" && !peHasSignature(bin)) fail(`${pin.file} carries no signature`);
  return bin;
}

export const nodePath = (triple) => path.join(TAURI, "binaries", `node-${triple}${TARGETS[triple].exe}`);

async function pin(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`--pin wants a version like 24.22.0, not ${version}`);
  const index = await (await fetch(`${DIST}/index.json`)).json();
  const release = index.find((r) => r.version === `v${version}`);
  if (!release) fail(`nodejs.org has no v${version}`);
  const sums = await shasums(version);
  const targets = {};
  for (const triple of Object.keys(TARGETS)) {
    const { archive, file } = archiveOf(version, triple);
    const sha = sums.get(archive);
    if (!sha) fail(`SHASUMS256.txt for v${version} lists no ${archive}`);
    const bytes = await fetchPinned(`${DIST}/v${version}/${archive}`, archive, expectSha256(sha));
    const bin = extract(bytes, archive, file);
    if (!bin) fail(`${archive} has no ${file}`);
    targets[triple] = { archive, sha256: sha, file, binarySha256: sha256(bin) };
  }
  const pins = readPins();
  pins.node = { version, abi: Number(release.modules), lts: release.lts || null, released: release.date, targets };
  fs.writeFileSync(PINS_FILE, `${JSON.stringify(pins, null, 2)}\n`);
  console.log(`Pinned Node ${version} (ABI ${release.modules}, released ${release.date}) in ${path.relative(ROOT, PINS_FILE)}.`);
  if (Number(release.modules) !== pins.native.abi) {
    console.log(`Its ABI is not the native modules' (${pins.native.abi}): pin better-sqlite3's prebuilt for ABI ${release.modules} too.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = arg("pin");
  if (version) {
    await pin(version);
  } else {
    const triple = targetArg();
    const bin = await nodeBinary(triple);
    const out = nodePath(triple);
    writeWhole(out, bin, 0o755);
    console.log(`Node ${readPins().node.version} for ${triple}: ${path.relative(ROOT, out)} (${mb(bin.length)})`);
  }
}
