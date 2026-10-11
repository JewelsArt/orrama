/**
 * No personal data in the tree (audit REG-004, REG-005; prior B6).
 *
 * Comments once quoted the owner's bank statement — a relative's full name as
 * the bank wrote it, the amount and how often — and CLAUDE.md carried the live
 * account's login address. History has to be rewritten to take such things
 * back, so this catches the shapes before they are committed: a statement
 * descriptor that names a person, a real mailbox, an address in the guides.
 * It cannot know a name it has never seen; it knows what a leak looks like.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
// The audit quotes what it found, redacted; everything else is ours.
const files = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && !f.startsWith("docs/audit/") && f !== "pnpm-lock.yaml" && /\.(ts|tsx|mts|js|mjs|md|json|yml|yaml|css|html)$/.test(f))
  .filter((f) => fs.existsSync(path.join(root, f)));
const text = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

/** A company suffix or a placeholder: what a fixture's counterparty looks like. */
const COMPANY = /(^|\s)(LTD|BV|B\.V\.?|INC|GMBH|LLC|NV|SA|PLC|CO)(\s|$)/i;
/** Words a fixture uses for a role, not a person. */
const GENERIC = new Set(["EMPLOYER", "SALARY", "STUDENT", "JOB", "SAVINGS", "LANDLORD", "PARENT", "FRIEND", "RENT", "SHOP"]);
const DESCRIPTOR = /\b(?:PAYMENT FROM|TRANSFER TO|TRANSFER FROM|PAID TO)\s+([^"'`\n,;)]*)/gi;

/**
 * Statement descriptors that name someone, the way a bank prints them: two or
 * more upper-case words that are not a company suffix, a placeholder or a
 * role. Prose ("a transfer to the landlord") is lower-case and passes.
 */
export function namedDescriptors(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(DESCRIPTOR)) {
    const who = m[1]!.trim();
    if (who.includes("<") || COMPANY.test(who)) continue;
    const names = who.split(/\s+/).filter((w) => /^[A-Z][A-Z.'-]+$/.test(w) && !GENERIC.has(w));
    if (names.length >= 2) out.push(m[0]);
  }
  return out;
}

describe("personal data", () => {
  it("knows a named descriptor from a placeholder or a company", () => {
    // Joined at run time, so this file does not trip the scan below.
    const from = ["PAYMENT", "FROM"].join(" ");
    const to = ["TRANSFER", "TO"].join(" ");
    expect(namedDescriptors(`"${from} MME JANE DOE" and "${to} JANE MARY DOE"`)).toHaveLength(2);
    expect(namedDescriptors(`"Payment from EMPLOYER BV", "PAYMENT FROM KADE SOCIAL B.V.", "PAYMENT FROM <NAME>", "Payment from STUDENT JOB", "a transfer to the landlord"`)).toEqual([]);
  });

  it("no statement descriptor in the tree names a person", () => {
    const hits = files.flatMap((f) => namedDescriptors(text(f)).map((d) => `${f}: ${d}`));
    expect(hits).toEqual([]);
  });

  it("no real mailbox: tests use example.com, placeholders say you@", () => {
    const mailbox = /[A-Za-z0-9._%+-]+@(gmail|googlemail|hotmail|outlook|icloud|yahoo|live|proton(mail)?)\.[a-z.]+/gi;
    const hits = files.flatMap((f) => [...text(f).matchAll(mailbox)].map((m) => m[0]).filter((a) => !/^you@/i.test(a)).map((a) => `${f}: ${a}`));
    expect(hits).toEqual([]);
  });

  it("the guides name no account: only the demo's @basalt.dev and example domains", () => {
    for (const f of ["CLAUDE.md", "README.md", "INSTALL.md"]) {
      const addresses = [...text(f).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z]{2,})+/g)].map((m) => m[0]);
      expect(addresses.filter((a) => !/@(basalt\.dev|example\.(com|org|net))$/i.test(a)), f).toEqual([]);
    }
  });

  // The seed's stand-ins kept a real employer, school, roles and a real-looking
  // profile, which re-identify people as surely as a name (REG-004). Demo
  // organisations live on reserved .example domains, and nobody has a profile.
  it("the demo vault's contacts point at no real site or profile", () => {
    const seed = text("apps/server/src/seed.ts");
    const sites = [...seed.matchAll(/^website: "?([^"\n]*)"?$/gm)].map((m) => m[1]!);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.filter((w) => !/\.example$/.test(w))).toEqual([]);
    const profiles = [...seed.matchAll(/^linkedin: "?([^"\n]*)"?$/gm)].map((m) => m[1]!).filter(Boolean);
    expect(profiles.filter((l) => !/example/.test(l))).toEqual([]);
  });
});
