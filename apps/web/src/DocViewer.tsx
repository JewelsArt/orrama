import { useEffect, useState } from "react";
import { api, apiBlob } from "./api.js";

/**
 * Read a project document without leaving Basalt.
 *
 * PDFs go to the webview's own viewer through a blob URL (the file lives behind
 * a bearer token, so a plain src= would 401). DOCX and XLSX are parsed on the
 * server — mammoth keeps headings, lists, tables and emphasis; exceljs returns
 * capped rows per sheet — so the browser only ever receives text. Anything else
 * offers a download instead of pretending it can render it.
 */
interface Sheet {
  name: string;
  rows: string[][];
  truncated: boolean;
  totalRows: number;
}

/** First row as the header — the convention every export on disk follows. */
function SheetTable({ sheet }: { sheet: Sheet }) {
  const [head, ...body] = sheet.rows;
  return (
    <>
      <div className="doc-sheet-meta">
        {sheet.totalRows.toLocaleString()} rows{sheet.truncated ? " · showing the first 500" : ""}
      </div>
      <div className="doc-sheet-scroll">
        <table className="doc-table">
          {head && (
            <thead>
              <tr>
                <th className="rownum" />
                {head.map((c, i) => (
                  <th key={i}>{c ?? ""}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                <td className="rownum">{r + 2}</td>
                {row.map((c, i) => (
                  <td key={i} title={c && c.length > 24 ? c : undefined}>
                    {c ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function DocViewer({
  base,
  name,
  onClose,
}: {
  /**
   * The collection this file lives in, as an API path with no trailing slash —
   * `/api/projects/<slug>/files` or `/api/finance/files`. Passing the prefix
   * rather than a project slug is what lets the Finance area reuse this viewer
   * unchanged; both collections expose the same three routes (the raw file,
   * `/html`, `/sheet`).
   */
  base: string;
  name: string;
  onClose: () => void;
}) {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const [url, setUrl] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [book, setBook] = useState<Sheet[] | null>(null);
  const [tab, setTab] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let objectUrl: string | null = null;
    void (async () => {
      try {
        if (ext === ".xlsx" || ext === ".xlsm") {
          const res = await api<{ sheets: Sheet[] }>(
            "GET",
            `${base}/${encodeURIComponent(name)}/sheet`,
          );
          setBook(res.sheets);
          return;
        }
        if (ext === ".docx") {
          const res = await api<{ html: string }>(
            "GET",
            `${base}/${encodeURIComponent(name)}/html`,
          );
          setHtml(res.html);
          return;
        }
        const blob = await apiBlob(`${base}/${encodeURIComponent(name)}`);
        if ([".txt", ".md", ".csv", ".json"].includes(ext)) {
          setText(await blob.text());
        } else {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "could not open this file");
      }
    })();
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [base, name, ext]);

  const download = async () => {
    const blob = await apiBlob(`${base}/${encodeURIComponent(name)}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  };

  const readable =
    ext === ".pdf" ||
    ext === ".docx" ||
    ext === ".xlsx" ||
    ext === ".xlsm" ||
    [".txt", ".md", ".csv", ".json"].includes(ext) ||
    ext.match(/\.(png|jpe?g|gif|webp)$/);

  return (
    <div className="doc-backdrop" onClick={onClose}>
      <div className="doc-modal" onClick={(e) => e.stopPropagation()}>
        <header className="doc-head">
          <span className="doc-ext">{(ext || ".?").slice(1).toUpperCase()}</span>
          <span className="doc-name" title={name}>
            {name}
          </span>
          <button className="ct-btn" onClick={() => void download()}>
            Download
          </button>
          <button className="doc-close" onClick={onClose} aria-label="Close document">
            ✕
          </button>
        </header>

        <div className="doc-body">
          {error && <p className="form-error">{error}</p>}
          {!error && !readable && (
            <p className="empty">
              No reader for {ext} yet — download it to open in its own app.
            </p>
          )}
          {html !== null && <article className="doc-docx" dangerouslySetInnerHTML={{ __html: html }} />}
          {book && book.length > 0 && (
            <div className="doc-sheet">
              {book.length > 1 && (
                <div className="doc-tabs" role="tablist">
                  {book.map((s, i) => (
                    <button key={s.name} role="tab" aria-selected={i === tab} className={i === tab ? "active" : ""} onClick={() => setTab(i)}>
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              <SheetTable sheet={book[Math.min(tab, book.length - 1)]!} />
            </div>
          )}
          {book && book.length === 0 && <p className="empty">This workbook has no sheets.</p>}
          {text !== null && <pre className="doc-text">{text}</pre>}
          {url && ext === ".pdf" && <iframe className="doc-frame" src={url} title={name} />}
          {url && ext.match(/\.(png|jpe?g|gif|webp)$/) && <img className="doc-img" src={url} alt={name} />}
          {!error && readable && html === null && text === null && book === null && !url && <p className="empty">Opening…</p>}
        </div>
      </div>
    </div>
  );
}
