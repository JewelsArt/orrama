/**
 * Third-party notices for the built bundle (audit OPS-011).
 *
 * The web app is redistributed — by the server, the Docker image and the
 * desktop bundle — and after minification 1 chunk in 113 kept any copyright
 * comment. MIT, BSD and ISC all ask for the notice to travel with the code. So
 * the build writes `dist/THIRD_PARTY_NOTICES.txt`: every package a chunk was
 * built from, its version and licence, and the licence file it ships — and the
 * licence beside any bundled asset (the Figtree fonts' OFL.txt).
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

export function noticesText(notices: Notice[]): string {
  const head =
    "Basalt's web app includes the following third-party software. Each is listed with its\n" +
    "version and licence, followed by the licence text the package ships.\n";
  const body = [...notices]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => `${"=".repeat(78)}\n${n.name}${n.version ? `@${n.version}` : ""} — ${n.license}\n${"=".repeat(78)}\n\n${n.text ?? `(The package ships no licence file. Its licence: ${n.license}.)`}\n`);
  return `${head}\n${body.join("\n")}`;
}

export const NOTICES_FILE = "THIRD_PARTY_NOTICES.txt";

export function licenseNotices(): Plugin {
  let root = process.cwd();
  return {
    name: "basalt-license-notices",
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
    },
  };
}
