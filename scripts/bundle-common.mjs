// What fetch-node.mjs and package-server.mjs share: the pins, the target triples, downloads
// checked against a pinned hash, and reading one file out of a .tar.gz or a .zip. Plain Node,
// no tar or unzip on the PATH: the same script runs on this Mac and on a Windows runner.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DESKTOP = path.join(ROOT, "apps", "desktop");
export const TAURI = path.join(DESKTOP, "src-tauri");
export const PINS_FILE = path.join(DESKTOP, "node-version.json");
/** Downloads are kept here, so a second run needs no network. Inside node_modules: git-ignored. */
export const CACHE = path.join(ROOT, "node_modules", ".cache", "orrama-bundle");

/** The targets the app is built for, by Rust target triple (what Tauri names sidecars by). */
export const TARGETS = {
  "aarch64-apple-darwin": { platform: "darwin", arch: "arm64", exe: "" },
  "x86_64-apple-darwin": { platform: "darwin", arch: "x64", exe: "" },
  "x86_64-pc-windows-msvc": { platform: "win32", arch: "x64", exe: ".exe" },
};

export function hostTriple() {
  const found = Object.entries(TARGETS).find(([, t]) => t.platform === process.platform && t.arch === process.arch);
  if (!found) fail(`there is no Orrama build for ${process.platform}-${process.arch}; pass --target with one of ${Object.keys(TARGETS).join(", ")}`);
  return found[0];
}

export function fail(message) {
  console.error(`\n${path.basename(process.argv[1] ?? "bundle")}: ${message}\n`);
  process.exit(1);
}

export function readPins() {
  return JSON.parse(fs.readFileSync(PINS_FILE, "utf8"));
}

/** `--name value` from argv, or the fallback. */
export function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) fail(`--${name} needs a value`);
  return v;
}

export function targetArg() {
  const triple = arg("target", hostTriple());
  if (!(triple in TARGETS)) fail(`unknown target ${triple}; one of ${Object.keys(TARGETS).join(", ")}`);
  return triple;
}

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
/** npm's `integrity` form: `sha512-<base64>`. */
export const sha512Integrity = (buf) => `sha512-${crypto.createHash("sha512").update(buf).digest("base64")}`;

/**
 * The bytes at `url`, from the cache when a copy there still matches, else downloaded. Either
 * way they must match `check(bytes)` (a pinned hash), or nothing is kept and the script stops.
 */
export async function fetchPinned(url, name, check) {
  fs.mkdirSync(CACHE, { recursive: true });
  const cached = path.join(CACHE, name);
  if (fs.existsSync(cached)) {
    const bytes = fs.readFileSync(cached);
    if (check(bytes) === null) return bytes;
    fs.rmSync(cached);
  }
  process.stdout.write(`  downloading ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) fail(`${url} answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const wrong = check(bytes);
  if (wrong !== null) fail(`${name} does not match its pin (${wrong}). Nothing was kept. If the pin is out of date, update it in ${path.relative(ROOT, PINS_FILE)} on purpose.`);
  const tmp = `${cached}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, cached);
  return bytes;
}

export const expectSha256 = (want) => (bytes) => {
  const got = sha256(bytes);
  return got === want ? null : `sha256 ${got}, pinned ${want}`;
};
export const expectIntegrity = (want) => (bytes) => {
  const got = sha512Integrity(bytes);
  return got === want ? null : `${got}, pinned ${want}`;
};

// ---- archives ----------------------------------------------------------------

const octal = (b) => {
  // A size of 8 GiB or more is base-256: the high bit of the first byte set.
  if (b[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < b.length; i++) n = n * 256 + b[i];
    return n;
  }
  const s = b.toString("latin1").replace(/\0.*$/s, "").trim();
  return s ? parseInt(s, 8) : 0;
};
const cstr = (b) => b.toString("utf8").replace(/\0.*$/s, "");

/**
 * Every regular file in a gzipped tar, as `{ name, mode, data }`, for which `want(name)` holds.
 * Reads ustar and pax names (npm and Node's archives use both); skips everything else.
 */
export function filesInTarGz(gz, want) {
  const tar = zlib.gunzipSync(gz);
  const out = [];
  let longName = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    const prefix = cstr(h.subarray(345, 500));
    let name = longName ?? (prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100)));
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      longName = m ? m[1] : null;
      continue;
    }
    if (type === "L") {
      longName = cstr(body);
      continue;
    }
    longName = null;
    if (type === "g") continue;
    if ((type === "0" || type === "\0" || type === "7") && want(name)) out.push({ name, mode: octal(h.subarray(100, 108)), data: Buffer.from(body) });
  }
  return out;
}

/** One file out of a .zip, by its exact name inside it. */
export function fileInZip(zip, name) {
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) fail("not a zip archive");
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) fail("the zip's central directory is damaged");
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entry = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    if (entry !== name) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) fail("the zip's local header is damaged");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    if (method === 0) return Buffer.from(raw);
    if (method === 8) return zlib.inflateRawSync(raw);
    fail(`${name} is compressed with method ${method}, which this script does not read`);
  }
  return null;
}

/** Write a file whole: a temp file beside it, then a rename, so a half-written one never stays. */
export function writeWhole(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// ---- what a native binary is for ------------------------------------------------

/**
 * The platform and architecture a binary was built for, read from its header: Mach-O (macOS),
 * PE (Windows) or ELF. A `.node` file for the wrong target fails only when it is loaded, on a
 * friend's computer; this says it at build time.
 */
export function binaryTarget(buf) {
  const magic = buf.readUInt32LE(0);
  if (magic === 0xfeedfacf) {
    const cpu = buf.readUInt32LE(4);
    return { platform: "darwin", arch: cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : `cpu ${cpu.toString(16)}` };
  }
  if (magic === 0xbebafeca) return { platform: "darwin", arch: "universal" };
  if (buf.readUInt16LE(0) === 0x5a4d) {
    const pe = buf.readUInt32LE(0x3c);
    if (buf.readUInt32LE(pe) !== 0x00004550) return { platform: "unknown", arch: "unknown" };
    const machine = buf.readUInt16LE(pe + 4);
    return { platform: "win32", arch: machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : `machine ${machine.toString(16)}` };
  }
  if (magic === 0x464c457f) return { platform: "linux", arch: "unknown" };
  return { platform: "unknown", arch: "unknown" };
}

/**
 * Whether a PE file carries an Authenticode signature (its certificate table is not empty).
 * That the signature is valid is checked on Windows (`Get-AuthenticodeSignature`); here it
 * proves the binary was not rewritten on the way, which drops the table.
 */
export function peHasSignature(buf) {
  const pe = buf.readUInt32LE(0x3c);
  const optional = pe + 24;
  const magic = buf.readUInt16LE(optional);
  const dirs = optional + (magic === 0x20b ? 112 : 96);
  const securitySize = buf.readUInt32LE(dirs + 4 * 8 + 4);
  return securitySize > 0;
}

/** Bytes as MB with one decimal. */
export const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Total size of every file under a folder. */
export function folderSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? folderSize(p) : fs.statSync(p).size;
  }
  return total;
}
