// The worker half of pdfText.ts: one PDF's text, read off the main thread.
// Plain JavaScript so it starts the same under tsx, vitest and plain Node.
import { parentPort, workerData } from "node:worker_threads";
import { extractText, getDocumentProxy } from "unpdf";

const { data, maxPages } = workerData;
const doc = await getDocumentProxy(new Uint8Array(data));
if (doc.numPages > maxPages) {
  parentPort.postMessage({ pages: doc.numPages });
} else {
  const { text } = await extractText(doc, { mergePages: true });
  parentPort.postMessage({ text });
}
