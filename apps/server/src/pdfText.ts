/**
 * A PDF's text, read in a worker thread that is stopped when its time is up.
 *
 * pdf.js parses a page's content in one synchronous stretch, on whatever
 * thread calls it, and a PDF had no limit but its 15 MB upload cap: a 6.7 MB
 * file of 20,000 empty pages held the whole server for 48 s, and one page
 * whose content inflates to 100 MB for 6 s and 680 MB (audit README, a lead
 * checked in S09). A timer on the main thread cannot interrupt that, and a
 * scan for oversized streams is a race against every filter pdf.js decodes.
 * A worker can simply be terminated, and its heap is capped.
 */
import { Worker } from "node:worker_threads";

/** Mutable for tests only. */
export const PDF_LIMITS = { pages: 10, readMs: 5_000, heapMb: 512 };

export type PdfText = { text: string } | { reason: string };

export function readPdfText(data: Buffer): Promise<PdfText> {
  const worker = new Worker(new URL("./pdfText.worker.mjs", import.meta.url), {
    workerData: { data, maxPages: PDF_LIMITS.pages },
    resourceLimits: { maxOldGenerationSizeMb: PDF_LIMITS.heapMb },
  });
  return new Promise((resolve) => {
    const done = (r: PdfText) => {
      clearTimeout(timer);
      resolve(r);
      void worker.terminate();
    };
    const timer = setTimeout(() => done({ reason: "reading the PDF took too long" }), PDF_LIMITS.readMs);
    worker.once("message", (m: { text?: string; pages?: number }) =>
      done(typeof m.text === "string" ? { text: m.text } : { reason: `it has ${m.pages} pages, more than a payslip` }),
    );
    worker.once("error", (err: NodeJS.ErrnoException) =>
      done({ reason: err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "the PDF needs too much memory to read" : "could not read the PDF's text" }),
    );
    worker.once("exit", () => done({ reason: "could not read the PDF's text" }));
  });
}
