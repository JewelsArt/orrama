/**
 * The pre-public check (2G): `scripts/prepublic-check.mjs` reads every file version and commit
 * message in a repository's history before it goes public. A secret removed from the tree is
 * still published with the commit that had it, so the check must find it there.
 *
 * Every secret-shaped value below is built at run time, so this file never trips the check
 * itself when it runs over a history that contains it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

type Finding = { level: "secret" | "personal" | "look"; rule: string; value: string; paths?: string[]; allowed?: boolean; first?: string };
type Result = { commits: number; blobs: number; findings: Finding[]; authors: { who: string; n: number }[] };
const root = path.resolve(import.meta.dirname, "../../..");
const mod = (await import(pathToFileURL(path.join(root, "scripts/prepublic-check.mjs")).href)) as {
  scanText(text: string): Finding[];
  scanPath(file: string, size: number): Finding[];
  scanWords(text: string, words: string[]): Finding[];
  validIban(s: string): boolean;
  isPlaceholder(v: string): boolean;
  allowed(f: Finding & { paths: string[] }): boolean;
  check(o: { repo: string; refs: string[]; words?: string[] }): Promise<Result>;
};

const j = (...parts: string[]) => parts.join("");
const rules = (text: string) => mod.scanText(text).map((f) => `${f.level}:${f.rule}`);

describe("what a file's text gives away", () => {
  it("finds each kind of secret", () => {
    expect(rules(`key = "${j("AKIA", "ABCDEFGHIJKLMNOP")}"`)).toContain("secret:aws-key");
    expect(rules(j("gh", "p_", "a".repeat(20), "B".repeat(16)))).toContain("secret:github-token");
    expect(rules(j("sk-", "ant-", "api03-", "x1Y2".repeat(10)))).toContain("secret:anthropic-key");
    expect(rules(j("sk-", "proj-", "Zq9".repeat(15)))).toContain("secret:openai-key");
    expect(rules(j("AI", "za", "Sy", "k".repeat(33)))).toContain("secret:google-key");
    expect(rules(`Bearer ${j("bslt", "_", "0a1b2c3d".repeat(6))}`)).toContain("secret:orrama-token");
    expect(rules(j("-----BEGIN ", "OPENSSH PRIVATE KEY-----"))).toContain("secret:private-key");
    expect(rules(j("untrusted comment: ", "rsign encrypted secret key"))).toContain("secret:signing-key");
    expect(rules(j("eyJ", "hbGciOiJIUzI1NiJ9", ".eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N"))).toContain("secret:jwt");
    expect(rules(j("<key>ORRAMA_", "JWT_SECRET</key>\n    <string>", "q8Rt2vW9xYz4Lk7mN3pB6cD1fG5hJ0sA", "</string>"))).toContain("secret:named-secret");
    expect(rules(j("ORRAMA_SECRET", "_KEY=", "Hk29sLq8vXz3Wm7Nr4Tp6Yb1Cd5Fg0Ja"))).toContain("secret:named-secret");
    expect(rules(j("appPass", 'word: "', "qwer tyui opas dfgh", '"'))).toContain("secret:app-password");
    expect(rules(j("cat /Users/someone/", ".tauri/", "orrama-updater.key"))).toContain("secret:updater-key-path");
  });

  it("passes placeholders, expressions and the shipped defaults", () => {
    for (const v of ["REPLACE_ME", "change-me-please", "${ORRAMA_JWT_SECRET}", "process.env.ORRAMA_SECRET_KEY", "xxxxxxxxxxxx", "crypto.randomBytes(32)", "your-secret-here", "ci-only-jwt-secret-0123"]) {
      expect(mod.isPlaceholder(v), v).toBe(true);
    }
    expect(mod.isPlaceholder("Hk29sLq8vXz3Wm7Nr4Tp6Yb1Cd5Fg0Ja")).toBe(false);
    expect(rules(`<key>ORRAMA_${"JWT_SECRET"}</key>\n<string>REPLACE_ME</string>`)).toEqual([]);
    expect(rules("const jwtSecret = env.ORRAMA_JWT_SECRET ?? DEV_JWT_SECRET;")).toEqual([]);
    expect(rules("      ORRAMA_JWT_SECRET: ${ORRAMA_JWT_SECRET:-change-me-please}")).toEqual([]);
    expect(rules(`ORRAMA_SECRET_KEY=${"x".repeat(40)}`)).toEqual([]);
  });

  it("finds personal data: mailboxes, IBANs with a valid checksum, phones, bank lines that name someone", () => {
    expect(rules(j("write to jane.doe", "@", "gmail.com"))).toContain("personal:mailbox");
    expect(rules(j("you", "@", "gmail.com"))).toEqual([]);
    expect(mod.validIban(j("NL91 ABNA ", "0417 1643 00"))).toBe(true);
    expect(mod.validIban(j("NL92 ABNA ", "0417 1643 00"))).toBe(false);
    expect(rules(j("IBAN NL91ABNA", "0417164300"))).toContain("personal:iban");
    expect(rules(j("call +31 6 ", "2345 6789"))).toContain("personal:phone");
    expect(rules(j("PAYMENT ", "FROM MME JANE DOE"))).toContain("personal:bank-descriptor");
    expect(rules(j("PAYMENT ", "FROM KADE SOCIAL B.V."))).toEqual([]);
    expect(rules(j("see ~/Orrama ", "Vault/01-Me/Diary.md"))).toContain("personal:vault-path");
  });

  it("judges a path and a size", () => {
    const of = (file: string, size = 10) => mod.scanPath(file, size).map((f) => `${f.level}:${f.rule}`);
    expect(of("apps/server/.env")).toEqual(["secret:env-file"]);
    expect(of(".env.example")).toEqual([]);
    expect(of("keys/orrama-updater.key")).toEqual(["secret:key-file"]);
    expect(of("apps/server/data/basalt.db")).toEqual(["personal:database"]);
    expect(of("inbox/export.mbox")).toEqual(["personal:mail"]);
    expect(of("Obsidian Vault/01-Me/x.md")).toEqual(["personal:vault-file"]);
    expect(of("apps/web/src/test/statement.csv")).toEqual(["look:spreadsheet"]);
    expect(of("docs/big.png", 3 * 1024 * 1024)).toEqual(["look:large-file"]);
  });

  it("lists private words, case-folded, as things to look at", () => {
    expect(mod.scanWords("Work at ACME Corp", ["acme", "Initech"])).toEqual([{ level: "look", rule: "word", value: "acme" }]);
  });

  it("explains each allowed finding by its exact value, not by where it is", () => {
    expect(mod.allowed({ level: "personal", rule: "phone", value: "+44 7700 900021", paths: ["seed.ts"] })).toBe(true);
    expect(mod.allowed({ level: "personal", rule: "phone", value: "+44 7911 123456", paths: ["seed.ts"] })).toBe(false);
  });
});

describe("the whole history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepublic-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=Someone", "-c", "user.email=someone@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });

  it("finds a secret a later commit removed, names its first commit, and reads messages and authors", async () => {
    git("init", "-q", "-b", "main");
    const key = j("sk-", "ant-", "api03-", "Q7w".repeat(12));
    fs.writeFileSync(path.join(dir, "config.ts"), `export const KEY = "${key}";\n`);
    git("add", ".");
    git("commit", "-q", "-m", "Add config");
    const first = git("rev-parse", "--short", "HEAD").trim();
    fs.writeFileSync(path.join(dir, "config.ts"), "export const KEY = process.env.KEY;\n");
    fs.writeFileSync(path.join(dir, ".env"), "KEY=\n");
    git("add", ".");
    git("commit", "-q", "-m", j("Read the key from the environment (asked jane", "@", "hotmail.com)"));
    const res = await mod.check({ repo: dir, refs: ["--branches"], words: ["config"] });
    expect(res.commits).toBe(2);
    const key1 = res.findings.find((f) => f.rule === "anthropic-key");
    expect(key1?.paths).toEqual(["config.ts"]);
    expect(key1?.first?.split(" ")[0]).toBe(first);
    expect(key1?.allowed).toBe(false);
    expect(res.findings.find((f) => f.rule === "env-file")?.value).toBe(".env");
    expect(res.findings.find((f) => f.rule === "mailbox")?.paths?.[0]).toMatch(/^commit \w{7} message$/);
    expect(res.findings.some((f) => f.rule === "word" && f.value === "config")).toBe(true);
    expect(res.authors).toEqual([{ who: "Someone <someone@example.com>", n: 4 }]);
  });
});
