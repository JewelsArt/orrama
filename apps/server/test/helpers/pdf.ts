/**
 * PDFs built by hand for tests: one content stream per page, deflated, and
 * a correct xref, so pdf.js reads them like any other file.
 */
import zlib from "node:zlib";

/** A text-showing content stream for one line at the top of a page. */
export const textLine = (s: string, y = 720) => `BT /F1 12 Tf 72 ${y} Td (${s}) Tj ET\n`;

/** A PDF whose pages carry these content streams (each deflated). */
export function pdf(pages: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let len = parts[0]!.length;
  const add = (b: Buffer) => {
    parts.push(b);
    len += b.length;
  };
  const obj = (n: number, body: Buffer | string) => {
    offsets[n] = len;
    add(Buffer.from(`${n} 0 obj\n`));
    add(Buffer.isBuffer(body) ? body : Buffer.from(body));
    add(Buffer.from("\nendobj\n"));
  };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((content, i) => {
    const data = zlib.deflateSync(content);
    obj(3 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    obj(4 + i * 2, Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, Buffer.from("\nendstream")]));
  });
  const n = 3 + pages.length * 2;
  const xref = len;
  let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) x += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  add(Buffer.from(`${x}trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}
