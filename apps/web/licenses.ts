/**
 * Third-party notices for what Orrama ships (audit OPS-011), and the licence
 * guard behind them.
 *
 * The web app is redistributed — by the server, the Docker image and the
 * desktop bundle — and after minification 1 chunk in 113 kept any copyright
 * comment. MIT, BSD and ISC all ask for the notice to travel with the code. So
 * the build writes `dist/THIRD_PARTY_NOTICES.txt`: every package a chunk was
 * built from, its version and licence, and the licence file it ships — and the
 * licence beside any bundled asset (the Figtree fonts' OFL.txt).
 *
 * The server and the MCP server run from their own `node_modules` (the Docker
 * image today, the desktop app from stage 2), so the same build writes
 * `dist/THIRD_PARTY_NOTICES_SERVER.txt` beside it: every production dependency
 * of `apps/server` and `apps/mcp`, walked through `node_modules`
 * (`productionPackages`).
 *
 * Orrama is proprietary, so nothing it ships may be under a licence that would
 * force its code open (GPL, AGPL, SSPL, …). `licenceProblem` holds every
 * production dependency to `ALLOWED_LICENCES`; `licenses.test.ts` fails on any
 * other, naming the package.
 */
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export type Notice = { name: string; version: string; license: string; text: string | null };

const NM = /[\\/]node_modules[\\/]/g;
const LICENSE_FILE = /^(licen[cs]e|copying|notice|ofl)([.-].*)?$/i;

/** The folder of the package a bundled module came from, or null for our own code. */
export function packageDir(id: string): string | null {
  const file = id.replace(/^\0/, "").split("?")[0]!;
  let last = -1;
  for (const m of file.matchAll(NM)) last = m.index!;
  if (last < 0) return null;
  const parts = file.slice(last).split(/[\\/]/).filter(Boolean); // node_modules, name | @scope, name, …
  const name = parts[1]!.startsWith("@") ? `${parts[1]}/${parts[2]}` : parts[1]!;
  return path.join(file.slice(0, last), "node_modules", ...name.split("/"));
}

export function noticeOf(dir: string): Notice {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    license?: string | { type?: string };
    licenses?: { type?: string }[];
  };
  const license =
    typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? pkg.licenses?.map((l) => l.type).join(" OR ") ?? "UNKNOWN";
  const files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  const text = files.length ? files.map((f) => fs.readFileSync(path.join(dir, f), "utf8").trim()).join("\n\n") : null;
  return { name: pkg.name, version: pkg.version, license, text };
}

/** A licence file in the folder an asset was copied from: fonts ship theirs beside them. */
export function assetNotice(file: string): Notice | null {
  const dir = path.dirname(file);
  let found: string[];
  try {
    found = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  } catch {
    return null;
  }
  if (!found.length) return null;
  const text = found.map((f) => fs.readFileSync(path.join(dir, f), "utf8").trim()).join("\n\n");
  const license = /SIL OPEN FONT LICENSE/i.test(text) ? "OFL-1.1" : "see text";
  // Named by where it sits ("ui/src/fonts"): the same on every machine.
  return { name: dir.split(/[\\/]/).slice(-3).join("/"), version: "", license, text };
}

export function noticesText(notices: Notice[], what = "Orrama's web app"): string {
  const head =
    `${what} includes the following third-party software. Each is listed with its\n` +
    "version and licence, followed by the licence text the package ships.\n";
  const body = [...notices]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => `${"=".repeat(78)}\n${n.name}${n.version ? `@${n.version}` : ""} — ${n.license}\n${"=".repeat(78)}\n\n${n.text ?? `(The package ships no licence file. Its licence: ${n.license}.)`}\n`);
  return `${head}\n${body.join("\n")}`;
}

export const NOTICES_FILE = "THIRD_PARTY_NOTICES.txt";
export const SERVER_NOTICES_FILE = "THIRD_PARTY_NOTICES_SERVER.txt";

/** Where `name` resolves from `dir`, the way Node looks it up, or null. */
function resolvePackage(dir: string, name: string): string | null {
  for (let at = dir; ; at = path.dirname(at)) {
    const nm = path.basename(at) === "node_modules" ? at : path.join(at, "node_modules");
    const candidate = path.join(nm, ...name.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(at) === at) return null;
  }
}

/**
 * Every third-party package these workspace packages need at run time:
 * `dependencies`, then theirs, and so on (optional and peer dependencies when
 * installed), keyed `name@version`, valued with the package's folder. Our own
 * workspace packages are walked through, never listed.
 */
export function productionPackages(roots: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const walk = (dir: string, own: boolean) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    if (!own) found.set(`${pkg.name}@${pkg.version}`, dir);
    const required = Object.keys(pkg.dependencies ?? {});
    const optional = [...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];
    for (const name of [...required, ...optional]) {
      const at = resolvePackage(dir, name);
      if (!at) {
        if (required.includes(name)) throw new Error(`${pkg.name} needs ${name}, which is not installed`);
        continue;
      }
      walk(at, !at.split(path.sep).includes("node_modules"));
    }
  };
  for (const root of roots) walk(fs.realpathSync(root), true);
  return found;
}

/**
 * Licences a dependency may carry: permissive ones, which ask for the notice
 * and nothing that would force Orrama's code open. A dual licence is fine when
 * one choice is here; `A AND B` needs both.
 */
export const ALLOWED_LICENCES = [
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "0BSD",
  "MIT-0",
  "Zlib",
  "Unlicense",
  "Python-2.0",
  "CC0-1.0",
] as const;

/** Old spellings of an allowed licence, as package.json files still carry them. */
const SPELLINGS: Record<string, string> = { "MIT/X11": "MIT" };

/**
 * Packages whose package.json does not say a licence we can read, checked by
 * hand, with the reason. Keyed by version: a new version is checked again.
 */
export const ALLOWED_BY_NAME: Record<string, string> = {
  "duck@0.1.12": 'package.json says only "BSD"; its LICENSE file is the 2-clause BSD text (Michael Williamson, 2013).',
  "buffers@0.1.1":
    "states no licence anywhere (no field, no file; its repository, substack/node-buffers, is deleted). " +
    "Reached only through exceljs → unzipper@0.10 → binary, which reads .xlsx statements and documents; " +
    "every sibling package by the same author (binary, chainsaw, traverse) is MIT. Accepted as MIT-in-practice " +
    "for now; the clean fix is an exceljs whose unzipper no longer needs it (unzipper 0.12 dropped binary).",
};

function allowedExpression(expr: string): boolean {
  const e = expr.trim().replace(/^\((.*)\)$/, "$1").trim();
  if (/ OR /i.test(e)) return e.split(/ OR /i).some(allowedExpression);
  if (/ AND /i.test(e)) return e.split(/ AND /i).every(allowedExpression);
  const id = SPELLINGS[e] ?? e;
  return (ALLOWED_LICENCES as readonly string[]).includes(id);
}

/** Why `notice`'s licence is not allowed, or null when it is. */
export function licenceProblem(notice: Notice): string | null {
  if (ALLOWED_BY_NAME[`${notice.name}@${notice.version}`]) return null;
  if (allowedExpression(notice.license)) return null;
  return `${notice.name}@${notice.version}: ${notice.license}`;
}

/** The packages that run from their own node_modules, relative to apps/web. */
export const SHIPPED_RUNTIMES = ["../server", "../mcp"];

export function licenseNotices(): Plugin {
  let root = process.cwd();
  return {
    name: "orrama-license-notices",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const dirs = new Set<string>();
      const byName = new Map<string, Notice>();
      for (const out of Object.values(bundle)) {
        if (out.type === "chunk") {
          for (const id of out.moduleIds) {
            const dir = packageDir(id);
            if (dir) dirs.add(dir);
          }
        } else {
          for (const f of out.originalFileNames ?? []) {
            const n = assetNotice(path.resolve(root, f));
            if (n) byName.set(n.name, n);
          }
        }
      }
      for (const dir of dirs) {
        const n = noticeOf(dir);
        byName.set(`${n.name}@${n.version}`, n);
      }
      this.emitFile({ type: "asset", fileName: NOTICES_FILE, source: noticesText([...byName.values()]) });
      const server = [...productionPackages(SHIPPED_RUNTIMES.map((p) => path.resolve(root, p))).values()].map(noticeOf);
      this.emitFile({ type: "asset", fileName: SERVER_NOTICES_FILE, source: noticesText(server, "Orrama's server and MCP server") });
    },
  };
}
