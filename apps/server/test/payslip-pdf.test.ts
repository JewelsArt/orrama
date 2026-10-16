/**
 * A payslip PDF is read on the server, and pdf.js read it with no limit but
 * the 15 MB upload cap: every page, on the event loop. A 6.7 MB file of
 * 20,000 empty pages held the whole server for 48 s, and one page whose
 * content inflates to 100 MB took 6 s and 680 MB (audit README, "Leads noted
 * by reviewers", checked in S09). The file is still kept; only the reading
 * stops, and the answer says why.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-payslip-pdf-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { PDF_LIMITS } = await import("../src/pdfText.js");
const { pdf, textLine } = await import("./helpers/pdf.js");

let app: Awaited<ReturnType<typeof buildServer>>["app"];
let token = "";
const upload = async (name: string, data: Buffer) => {
  const res = await app.inject({
    method: "POST",
    url: "/api/finance/payslip",
    headers: signedIn(token),
    payload: { name, dataBase64: data.toString("base64") },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { name: string; stored: boolean; filed: boolean; reason?: string };
};

beforeAll(async () => {
  await import("../src/seed.js");
  app = (await buildServer()).app;
  token = sessionOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
});
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

it("an ordinary one-page PDF is read: its text reaches the payslip parser", async () => {
  const r = await upload("letter.pdf", pdf([textLine("Dear Jules, thank you for your letter")]));
  expect(r).toMatchObject({ stored: true, filed: false, reason: "unfamiliar payslip layout" });
});

it("a PDF with more pages than a payslip is kept, not read", async () => {
  const many = pdf(Array(PDF_LIMITS.pages * 20).fill(textLine("p")));
  const r = await upload("bundle.pdf", many);
  expect(r).toMatchObject({ stored: true, filed: false, reason: `it has ${PDF_LIMITS.pages * 20} pages, more than a payslip` });
  expect(fs.existsSync(path.join(process.env.ORRAMA_VAULT_DIR!, "02-Areas/finance/files", r.name))).toBe(true);
});

it("a read that runs past its time is stopped, and the upload answers", { timeout: 30_000 }, async () => {
  const before = PDF_LIMITS.readMs;
  PDF_LIMITS.readMs = 150;
  try {
    // One page whose content inflates to ~20 MB of text operators: ~1.2 s to read.
    const heavy = pdf([textLine("x").repeat(Math.ceil((20 * 1024 * 1024) / textLine("x").length))]);
    const t = performance.now();
    const r = await upload("heavy.pdf", heavy);
    expect(r).toMatchObject({ stored: true, filed: false, reason: "reading the PDF took too long" });
    expect(performance.now() - t).toBeLessThan(1000); // the read alone is ~1.2 s
  } finally {
    PDF_LIMITS.readMs = before;
  }
});

it("a heavy read happens off the event loop: the server keeps answering meanwhile", { timeout: 60_000 }, async () => {
  // ~1.2 s of parsing in one synchronous stretch, which held the server when it ran here.
  const heavy = pdf([textLine("x").repeat(Math.ceil((20 * 1024 * 1024) / textLine("x").length))]);
  const before = PDF_LIMITS.readMs;
  PDF_LIMITS.readMs = 50_000; // read to the end however loaded the machine is
  let maxGap = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  try {
    const t = performance.now();
    const r = await upload("heavy-but-in-time.pdf", heavy);
    const elapsed = performance.now() - t;
    maxGap = Math.max(maxGap, performance.now() - last);
    expect(r.reason).toBe("unfamiliar payslip layout"); // read to the end, then parsed
    // On this thread the parse was one stretch, nearly the whole upload; in the worker the timer keeps firing.
    expect(maxGap).toBeLessThan(elapsed / 2);
  } finally {
    clearInterval(tick);
    PDF_LIMITS.readMs = before;
  }
});
