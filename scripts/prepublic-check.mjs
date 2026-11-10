#!/usr/bin/env node
/**
 * Before a repository goes public: what in its *whole history* would be published (2G).
 *
 *   node scripts/prepublic-check.mjs [--repo <path>] [--refs <ref,ref,…>] [--words <file>] [--json <file>]
 *
 * Reads every commit reachable from the refs (default: every branch and tag of the repo,
 * so run it on the copy you are about to push) and every file version in them, and reports:
 *
 * - secret: API keys, `bslt_` tokens, private keys, JWTs, a secret's value next to its name
 *   (the plist's ORRAMA_JWT_SECRET / ORRAMA_SECRET_KEY, the updater's signing key), `.env` files,
 *   key files, the updater key's path;
 * - personal: real mailboxes, bank statement descriptors that name someone (the same rule as
 *   apps/server/test/personal-data.test.ts), IBANs with a valid checksum, phone numbers, files
 *   from a notes vault, mail, finance exports or a database;
 * - look: files over 1 MB, spreadsheets and CSVs, and every author and committer address
 *   (they all become public with the commits), and each word of `--words` (a file kept outside the
 *   repo, one name per line: an employer, a school, a person) with the files and commits it is in.
 *
 * Exit 1 when a secret or personal finding is left that `ALLOWED` doesn't explain, else 0.
 * It reads only: it never rewrites history (fix the tree; history is Jules's call).
 * `gitleaks` is run as well when it is installed, never installed by this script.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LARGE = 1024 * 1024;
/** Biggest blob whose text is read; above it only the size counts. */
const MAX_TEXT = 4 * 1024 * 1024;

/** [rule, pattern]: a match is a secret. Each pattern's first group (or the match) is the value. */
export const SECRET_PATTERNS = [
  ["aws-key", /\b(AKIA[0-9A-Z]{16})\b/g],
  ["github-token", /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ["anthropic-key", /\b(sk-ant-[A-Za-z0-9_-]{30,})/g],
  ["openai-key", /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})/g],
  ["google-key", /\b(AIza[0-9A-Za-z_-]{35})\b/g],
  ["slack-token", /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g],
  ["stripe-key", /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})/g],
  ["orrama-token", /\b(bslt_[0-9a-f]{48})\b/g],
  ["private-key", /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)/g],
  ["signing-key", /(untrusted comment: (?:rsign|minisign) encrypted secret key)/g],
  ["jwt", /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g],
  // A secret's value written beside its name: `ORRAMA_JWT_SECRET=…`, `"apiKey": "…"`, a plist's
  // <key>ORRAMA_SECRET_KEY</key><string>…</string>. Placeholders are dropped by `isPlaceholder`.
  [
    "named-secret",
    /\b[A-Z0-9_]*(?:SECRET|PASSWORD|PRIVATE_KEY|API_KEY|TOKEN|APP_PASSWORD)[A-Z0-9_]*\b(?:<\/key>\s*<string>|["']?\s*[:=]\s*["']?)([^\s"'<>`,;)}{]{12,})/g,
  ],
  ["app-password", /(?:app.?password|smtp_?pass(?:word)?)["'\s:=]+["']?([a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4})\b/gi],
  ["updater-key-path", /((?:~|\/Users\/[^/\s]+|%USERPROFILE%)[\\/]\.tauri[\\/][\w.-]+\.key)\b/g],
];

/** [rule, pattern]: a match is someone's data. */
export const PERSONAL_PATTERNS = [
  ["mailbox", /\b([A-Za-z0-9._%+-]+@(?:gmail|googlemail|hotmail|outlook|icloud|me|yahoo|live|proton(?:mail)?|scooperz|kawalearn)\.[a-z.]+)/gi],
  ["phone", /((?:\+|00)(?:31|32|33|44|49)[\s.-]?\(?0?\)?[\s.-]?[1-9](?:[\s.-]?\d){7,9})\b/g],
  ["vault-path", /((?:Orrama|Obsidian) Vault[\\/][^\s"'`)]+\.md)/g],
];

/** Paths whose existence in history is the finding. */
export const PATH_RULES = [
  ["secret", "env-file", /(^|\/)\.env(\.[\w-]+)?$/, /\.env\.(example|sample|template)$/],
  ["secret", "key-file", /(^|\/)(id_rsa|id_ed25519|[^/]+\.(pem|p12|pfx|key|keystore|jks))$/, /\.pub$/],
  ["personal", "database", /\.(db|sqlite3?|db-wal|db-shm)$/],
  ["personal", "mail", /\.(eml|mbox|msg|pst)$/],
  ["personal", "finance-export", /\.(ofx|qif|qfx|mt940|sta|camt|053)$/i],
  ["personal", "vault-file", /(^|\/)(Orrama Vault|Obsidian Vault)\//],
  ["look", "spreadsheet", /\.(csv|xlsx|xls|ods|numbers)$/i],
];

/** Values that only look like secrets. */
export function isPlaceholder(value) {
  const v = value.replace(/^["']|["']$/g, "");
  if (/^(REPLACE_ME|CHANGE_?ME|changeme|xxx+|\*+|\.\.\.|<[^>]*>|\$\{?[A-Za-z_][\w.]*\}?|%[\w]+%|process\.env\.\w+|env\.\w+)$/i.test(v)) return true;
  if (/^(.)\1{7,}$/.test(v)) return true; // aaaaaaaa, 00000000
  if (/(example|placeholder|your[-_]|dummy|fake|redacted|not[-_]a[-_]real|test[-_]?(secret|key|token|password)|secret[-_]?key[-_]?for|replace|change[-_]?me|ci[-_]only)/i.test(v)) return true;
  if (/[[\](){}]/.test(v)) return true; // code, not a value
  // An expression or a name, not a value: `opts.secret`, `crypto.randomBytes(32)`, `SOME_CONST`.
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+(\(.*)?$/.test(v) || /^[A-Z][A-Z_]+$/.test(v) || /^[a-z]+([A-Z][a-z]+)*$/.test(v)) return true;
  // Too regular to be random: a word or words, digits only, a path.
  if (/^\d+$/.test(v) || v.includes("/") || /^[a-z]+(-[a-z]+)+$/i.test(v)) return true;
  return false;
}

/** A valid IBAN checksum (ISO 13616 mod 97), so `NL00 0000 …` and ticket ids don't count. */
export function validIban(raw) {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const n = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of n) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

const COMPANY = /(^|\s)(LTD|BV|B\.V\.?|INC|GMBH|LLC|NV|SA|PLC|CO)(\s|$)/i;
const GENERIC = new Set(["EMPLOYER", "SALARY", "STUDENT", "JOB", "SAVINGS", "LANDLORD", "PARENT", "FRIEND", "RENT", "SHOP"]);
const DESCRIPTOR = /\b(?:PAYMENT FROM|TRANSFER TO|TRANSFER FROM|PAID TO)\s+([^"'`\n,;)]*)/gi;

/** Same rule as personal-data.test.ts's `namedDescriptors`: a bank line that names a person. */
export function namedDescriptors(src) {
  const out = [];
  for (const m of src.matchAll(DESCRIPTOR)) {
    const who = m[1].trim();
    if (who.includes("<") || COMPANY.test(who)) continue;
    const names = who.split(/\s+/).filter((w) => /^[A-Z][A-Z.'-]+$/.test(w) && !GENERIC.has(w));
    if (names.length >= 2) out.push(m[0].trim());
  }
  return out;
}

/** Findings in one file version's text: [{ level, rule, value }]. */
export function scanText(text) {
  const out = [];
  for (const [rule, re] of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = m[1] ?? m[0];
      if (rule === "named-secret" && isPlaceholder(value)) continue;
      if (rule === "openai-key" && isPlaceholder(value)) continue;
      out.push({ level: "secret", rule, value });
    }
  }
  for (const [rule, re] of PERSONAL_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = m[1] ?? m[0];
      if (rule === "mailbox" && /^you@/i.test(value)) continue;
      out.push({ level: "personal", rule, value });
    }
  }
  for (const m of text.matchAll(/\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?)\b/g)) {
    if (validIban(m[1])) out.push({ level: "personal", rule: "iban", value: m[1] });
  }
  for (const d of namedDescriptors(text)) out.push({ level: "personal", rule: "bank-descriptor", value: d });
  return out;
}

/** Findings from a file's path and size alone. */
export function scanPath(file, size) {
  const out = [];
  for (const [level, rule, re, except] of PATH_RULES) {
    if (re.test(file) && !(except && except.test(file))) out.push({ level, rule, value: file });
  }
  if (size > LARGE) out.push({ level: "look", rule: "large-file", value: `${file} (${(size / 1024 / 1024).toFixed(1)} MB)` });
  return out;
}

/** This check and its test: their sample strings are what the check looks for. */
const THE_CHECK_ITSELF = /^(scripts\/prepublic-check\.mjs|apps\/server\/test\/prepublic-check\.test\.ts)$/;

/**
 * Findings looked at and judged fine, each with its reason. A finding matches when its rule
 * is the same and its value (or `path`, when given) matches the pattern.
 */
export const ALLOWED = [
  { rule: "named-secret", value: /^(6f1c0b9a4d2e8f37a1b5c9d0e4f8a2b6(c3d7)?|9e3a7c1f5b0d2846ea9c3f7b1d5084a2)$/, why: "made-up secrets the env and server tests pass (env.test.ts, server.test.ts)" },
  { rule: "named-secret", value: /^dev-secret-key-32-bytes-change!!$/, why: "env.ts's --dev default, which the server refuses outside --dev (assertProductionSecrets)" },
  { rule: "named-secret", value: /^s3cret-value-that-must-never-be-printed-0123456789$/, why: "renamed-env.test.ts: a made-up value it checks is never printed" },
  { rule: "named-secret", value: /^bslt_secretvalue$/, why: "apps/mcp/test/env.test.ts: a made-up token, not the 48-hex shape" },
  { rule: "app-password", value: /^abcd efgh ijkl mnop$/, why: "Gmail's own example of an app password's shape" },
  { rule: "updater-key-path", value: /^~\/\.tauri\/orrama-updater\.key$/, why: "where the updater key is kept, documented for the release steps; the key itself is never in the repo (the signing-key rule reads every file)" },
  { rule: "phone", value: /^\+44 7700 900\d{3}$/, why: "Ofcom's range for fiction (seed.ts's demo people)" },
  { rule: "phone", value: /^\+31 (6 1234 5678|20 123 4567)$/, why: "made-up numbers in tests" },
  { rule: "phone", value: /^\+44 7911 123456$/, path: THE_CHECK_ITSELF, why: "the made-up number this check's test says is not allowed elsewhere" },
  { rule: "phone", value: /^\+31 \(6 1234 5678$/, path: THE_CHECK_ITSELF, why: "the text of the allow-list's own +31 pattern, read as a number" },
  { rule: "vault-path", value: /^Obsidian Vault.01-Me.x.md$/, path: THE_CHECK_ITSELF, why: "the made-up path this check's test passes" },
];

export function allowed(f, list = ALLOWED) {
  return list.some((a) => a.rule === f.rule && (a.value ? a.value.test(f.value) : true) && (a.path ? f.paths.some((p) => a.path.test(p)) : true));
}

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Every blob reachable from the refs, with one path it has, its size and type. */
function listBlobs(repo, refs) {
  const objects = git(repo, ["rev-list", "--objects", ...refs]).split("\n").filter(Boolean);
  const pathOf = new Map();
  for (const line of objects) {
    const sp = line.indexOf(" ");
    if (sp > 0) pathOf.set(line.slice(0, sp), line.slice(sp + 1));
  }
  const check = spawnSync("git", ["-C", repo, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: objects.map((l) => l.split(" ")[0]).join("\n") + "\n",
    encoding: "utf8",
    maxBuffer: 1 << 28,
  }).stdout;
  const blobs = [];
  for (const line of check.split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (type === "blob") blobs.push({ sha, path: pathOf.get(sha) ?? "?", size: Number(size) });
  }
  return blobs;
}

/** Streams each blob's content through `onBlob(sha, buffer)`, one at a time. */
function readBlobs(repo, shas, onBlob) {
  return new Promise((resolve, reject) => {
    const p = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"] });
    let buf = Buffer.alloc(0);
    p.stdout.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const [sha, , size] = buf.subarray(0, nl).toString().split(" ");
        const n = Number(size);
        if (buf.length < nl + 1 + n + 1) return;
        onBlob(sha, buf.subarray(nl + 1, nl + 1 + n));
        buf = buf.subarray(nl + 1 + n + 1);
      }
    });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git cat-file exited ${code}`))));
    p.stdin.end(shas.join("\n") + "\n");
  });
}

/** Commit messages are published too: scan them like files. */
function scanMessages(repo, refs, words) {
  const log = git(repo, ["log", "--format=%H%x00%B%x01", ...refs]);
  const out = [];
  for (const rec of log.split("\x01")) {
    const [sha, body] = rec.replace(/^\n/, "").split("\0");
    if (!sha || !body) continue;
    for (const f of [...scanText(body), ...scanWords(body, words)]) out.push({ ...f, where: `commit ${sha.slice(0, 7)} message` });
  }
  return out;
}

function authors(repo, refs) {
  const log = git(repo, ["log", "--format=%an <%ae>%n%cn <%ce>", ...refs]);
  const count = new Map();
  for (const a of log.split("\n").filter(Boolean)) count.set(a, (count.get(a) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]).map(([who, n]) => ({ who, n }));
}

/** Folds identical findings (same rule and value) together, keeping every path they're in. */
function fold(raw) {
  const by = new Map();
  for (const f of raw) {
    const key = `${f.level}\0${f.rule}\0${f.value}`;
    const e = by.get(key) ?? { level: f.level, rule: f.rule, value: f.value, paths: [], blobs: [] };
    if (f.where && !e.paths.includes(f.where)) e.paths.push(f.where);
    if (f.blob && !e.blobs.includes(f.blob)) e.blobs.push(f.blob);
    by.set(key, e);
  }
  return [...by.values()];
}

/** The first commit (oldest) that has this blob, for the report. */
function firstCommit(repo, refs, blob) {
  const out = git(repo, ["log", "--format=%h %ad", "--date=short", "--reverse", `--find-object=${blob}`, ...refs]).split("\n")[0];
  return out || "?";
}

/** Each private word (case-folded) found in a text: "look" findings, Jules judges them. */
export function scanWords(text, words) {
  const low = text.toLowerCase();
  return words.filter((w) => low.includes(w.toLowerCase())).map((w) => ({ level: "look", rule: "word", value: w }));
}

export async function check({ repo, refs, words = [] }) {
  const blobs = listBlobs(repo, refs);
  const raw = [];
  for (const b of blobs) for (const f of scanPath(b.path, b.size)) raw.push({ ...f, where: b.path, blob: b.sha });
  const textual = blobs.filter((b) => b.size <= MAX_TEXT);
  const byPath = new Map(textual.map((b) => [b.sha, b.path]));
  await readBlobs(repo, textual.map((b) => b.sha), (sha, data) => {
    if (data.subarray(0, 8000).includes(0)) return; // binary
    const text = data.toString("utf8");
    for (const f of [...scanText(text), ...scanWords(text, words)]) raw.push({ ...f, where: byPath.get(sha), blob: sha });
  });
  raw.push(...scanMessages(repo, refs, words));
  const findings = fold(raw);
  for (const f of findings) {
    f.allowed = allowed(f);
    if (!f.allowed && f.level !== "look" && f.blobs[0]) f.first = firstCommit(repo, refs, f.blobs[0]);
  }
  const commits = Number(git(repo, ["rev-list", "--count", ...refs]).trim());
  return { commits, blobs: blobs.length, findings, authors: authors(repo, refs) };
}

function gitleaks(repo) {
  const has = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  if (has.error) return "gitleaks: not installed (not run)";
  const r = spawnSync("gitleaks", ["git", "--no-banner", "--redact", repo], { encoding: "utf8", maxBuffer: 1 << 26 });
  return `gitleaks: exit ${r.status}\n${(r.stdout + r.stderr).trim()}`;
}

function report(res, repo, refs) {
  const lines = [`Pre-public check of ${repo} (${refs.join(" ")}): ${res.commits} commits, ${res.blobs} file versions.`, ""];
  for (const level of ["secret", "personal", "look"]) {
    const open = res.findings.filter((f) => f.level === level && !f.allowed);
    const ok = res.findings.filter((f) => f.level === level && f.allowed);
    lines.push(`## ${level}: ${open.length} to look at${ok.length ? `, ${ok.length} allowed` : ""}`);
    for (const f of open.sort((a, b) => a.rule.localeCompare(b.rule))) {
      const shown = level === "secret" && f.value.length > 16 ? `${f.value.slice(0, 10)}…(${f.value.length} chars)` : f.value;
      lines.push(`- [${f.rule}] ${shown}  in ${f.paths.slice(0, 3).join(", ")}${f.paths.length > 3 ? ` +${f.paths.length - 3}` : ""}${f.first ? `  (first ${f.first})` : ""}`);
    }
    lines.push("");
  }
  lines.push("## authors and committers (all public with the commits)");
  for (const a of res.authors) lines.push(`- ${a.who}: ${a.n}`);
  return lines.join("\n");
}

async function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = path.resolve(opt("--repo") ?? ".");
  const refs = opt("--refs")?.split(",") ?? ["--branches", "--tags"];
  const words = opt("--words") ? fs.readFileSync(opt("--words"), "utf8").split("\n").map((w) => w.trim()).filter((w) => w && !w.startsWith("#")) : [];
  const res = await check({ repo, refs, words });
  console.log(report(res, repo, refs));
  console.log("\n" + gitleaks(repo));
  if (opt("--json")) fs.writeFileSync(opt("--json"), JSON.stringify(res, null, 2));
  const open = res.findings.filter((f) => f.level !== "look" && !f.allowed);
  process.exitCode = open.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 2;
  });
}
