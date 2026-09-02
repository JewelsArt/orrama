#!/usr/bin/env node
/**
 * One-off: fold Basalt's copy of the vault into the real Obsidian vault, so the
 * two apps can share a single folder from here on.
 *
 * Rules, in order:
 *   - a file only Basalt has  → copied in
 *   - a file only Obsidian has → left alone
 *   - a file both have        → the newer mtime wins
 *
 * With one exception that matters: when Obsidian's copy wins, Basalt's `id:`
 * front-matter line is carried over onto it. Note ids key the task objects in
 * the database (planned dates, statuses, comments); dropping an id would orphan
 * that history even though the prose is identical.
 *
 * Nothing is deleted. Every overwrite is listed at the end.
 *
 *   node scripts/merge-vaults.mjs <basalt-vault> <obsidian-vault> [--apply]
 */
import fs from "node:fs";
import path from "node:path";

const [, , SRC, DST, ...flags] = process.argv;
const APPLY = flags.includes("--apply");
if (!SRC || !DST) {
  console.error("usage: merge-vaults.mjs <basalt-vault> <obsidian-vault> [--apply]");
  process.exit(1);
}

const walk = (root, base = root) =>
  fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".")) return [];
    const full = path.join(root, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });

const idOf = (text) => /^id: (n-\w+)$/m.exec(text)?.[1] ?? null;
/** Put `id:` back as the first front-matter line, where the indexer writes it. */
const withId = (text, id) => {
  if (idOf(text) === id) return text;
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return `---\nid: ${id}\n---\n\n${text}`;
  const close = lines.indexOf("---", 1);
  if (close === -1) return text;
  const body = lines.slice(1, close).filter((l) => !/^id: n-\w+$/.test(l));
  return [lines[0], `id: ${id}`, ...body, ...lines.slice(close)].join("\n");
};

const copied = [];
const overwritten = [];
const kept = [];
const idCarried = [];

for (const rel of walk(SRC)) {
  const from = path.join(SRC, rel);
  const to = path.join(DST, rel);

  if (!fs.existsSync(to)) {
    copied.push(rel);
    if (APPLY) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    continue;
  }

  const a = fs.statSync(from);
  const b = fs.statSync(to);
  const isMd = rel.toLowerCase().endsWith(".md");
  const srcText = isMd ? fs.readFileSync(from, "utf8") : null;
  const dstText = isMd ? fs.readFileSync(to, "utf8") : null;

  // Identical apart from the id line: nothing to decide, just keep the id.
  const strip = (t) => t.replace(/^id: n-\w+\n/m, "").trim();
  if (isMd && strip(srcText) === strip(dstText)) {
    const id = idOf(srcText);
    if (id && idOf(dstText) !== id) {
      idCarried.push(rel);
      if (APPLY) fs.writeFileSync(to, withId(dstText, id));
    } else {
      kept.push(rel);
    }
    continue;
  }

  if (a.mtimeMs > b.mtimeMs) {
    overwritten.push(`${rel}  (basalt ${a.mtime.toISOString().slice(0, 10)} > obsidian ${b.mtime.toISOString().slice(0, 10)})`);
    if (APPLY) fs.copyFileSync(from, to);
  } else {
    kept.push(`${rel}  (obsidian ${b.mtime.toISOString().slice(0, 10)} newer)`);
    const id = isMd ? idOf(srcText) : null;
    if (id && idOf(dstText) !== id) {
      idCarried.push(rel);
      if (APPLY) fs.writeFileSync(to, withId(dstText, id));
    }
  }
}

const show = (title, list) => {
  console.log(`\n${title}: ${list.length}`);
  for (const r of list) console.log("   " + r);
};
console.log(APPLY ? "APPLIED" : "DRY RUN — nothing written");
show("copied in (Basalt only)", copied);
show("overwritten (Basalt newer)", overwritten);
show("kept Obsidian's version", kept.filter((k) => k.includes("newer")));
show("id carried onto Obsidian's copy", idCarried);
console.log(`\nunchanged: ${kept.filter((k) => !k.includes("newer")).length}`);
