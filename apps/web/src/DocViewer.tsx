import { useEffect, useState } from "react";
import { api, apiBlob, ApiError, isAbort } from "./api.js";
import type { Deck, Sheet } from "@basalt/schema/responses";
import { Button, Tabs } from "./ui/controls.js";
import { Sheet as SheetLayer } from "./ui/overlays.js";
import { Notice } from "./ui/states.js";

/**
 * Read a project document without leaving Basalt.
 *
 * PDFs go to the webview's own viewer through a blob URL (the file lives behind
 * a bearer token, so a plain src= would 401). DOCX and XLSX are parsed on the
 * server — mammoth keeps headings, lists, tables and emphasis; exceljs returns
 * capped rows per sheet — so the browser only ever receives text. PPTX comes
 * back as slides of plain strings plus sniffed raster images, and is drawn here
 * with ordinary elements: no markup from the deck is ever injected. Anything
 * else offers a download instead of pretending it can render it.
 *
 * It is a Sheet in the overlay stack (structure.md §1.4: "a thing you look at without
 * leaving"), wide enough for a page: Escape, the scrim and the close button shut it, focus
 * comes back to whatever opened it. A file that can't be read says why in plain words and
 * offers the download, never the server's own text.
 */

/** What went wrong, in words a person can act on. */
export function readerError(err: unknown): string {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 404) return "It isn't in the folder any more.";
  if (status === 403) return "You can't open this file.";
  if (status === 413) return "It's too big to show here.";
  if (status === 415 || status === 422) return "Its contents couldn't be read.";
  return "The server couldn't read it just now.";
}

/** One card per slide, in deck order: title, text, tables, pictures, then the speaker notes. */
function DeckView({ deck }: { deck: Deck }) {
  const meta = [
    `${deck.slideCount} ${deck.slideCount === 1 ? "slide" : "slides"}`,
    deck.truncated ? `showing the first ${deck.slides.length}` : "",
    deck.omittedImages ? `${deck.omittedImages} ${deck.omittedImages === 1 ? "picture" : "pictures"} not shown` : "",
  ].filter(Boolean);
  return (
    <div className="doc-deck">
      <div className="doc-sheet-meta">{meta.join(" · ")}</div>
      {deck.slides.map((s) => (
        <section key={s.n} className={`doc-slide ${s.hidden ? "hidden" : ""}`} aria-label={`Slide ${s.n}`}>
          <header className="doc-slide-head">
            <span className="doc-slide-n">{s.n}</span>
            <h3>{s.title || `Slide ${s.n}`}</h3>
            {s.hidden && <span className="doc-slide-tag">hidden</span>}
          </header>
          {s.blocks.map((b, i) =>
            b.kind === "p" ? (
              <p key={i} className="doc-slide-p" style={{ paddingLeft: b.level * 18 }}>
                {b.text}
              </p>
            ) : (
              <table key={i} className="doc-slide-table">
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((c, j) => (r === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ),
          )}
          {s.images.length > 0 && (
            <div className="doc-slide-imgs">
              {s.images.map((im, i) => deck.media[im.ref] && <img key={i} src={deck.media[im.ref]} alt={im.alt} />)}
            </div>
          )}
          {!s.title && s.blocks.length === 0 && s.images.length === 0 && <p className="doc-slide-empty">No text on this slide.</p>}
          {s.notes && (
            <div className="doc-slide-notes">
              <span>Notes</span>
              <p>{s.notes}</p>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** First row as the header — the convention every export on disk follows. */
function SheetTable({ sheet }: { sheet: Sheet }) {
  const [head, ...body] = sheet.rows;
  return (
    <>
      <div className="doc-sheet-meta">
        {sheet.totalRows.toLocaleString("en-GB")} rows{sheet.truncated ? " · showing the first 500" : ""}
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
   * unchanged; both collections expose the raw file and `/sheet` (projects
   * add `/html` and `/slides`).
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
  const [deck, setDeck] = useState<Deck | null>(null);
  const [tab, setTab] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    let objectUrl: string | null = null;
    // Another document chosen before this one arrived: this one must not land.
    const ac = new AbortController();
    const { signal } = ac;
    void (async () => {
      try {
        if (ext === ".xlsx" || ext === ".xlsm") {
          const res = await api<{ sheets: Sheet[] }>(
            "GET",
            `${base}/${encodeURIComponent(name)}/sheet`,
            undefined,
            { signal },
          );
          setBook(res.sheets);
          return;
        }
        if (ext === ".pptx") {
          setDeck(await api<Deck>("GET", `${base}/${encodeURIComponent(name)}/slides`, undefined, { signal }));
          return;
        }
        if (ext === ".docx") {
          const res = await api<{ html: string }>(
            "GET",
            `${base}/${encodeURIComponent(name)}/html`,
            undefined,
            { signal },
          );
          setHtml(res.html);
          return;
        }
        const blob = await apiBlob(`${base}/${encodeURIComponent(name)}`, { signal });
        if ([".txt", ".md", ".csv", ".json"].includes(ext)) {
          const text = await blob.text();
          if (signal.aborted) return;
          setText(text);
        } else {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      } catch (err) {
        if (isAbort(err)) return;
        setError(readerError(err));
      }
    })();
    return () => {
      ac.abort();
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
    ext === ".pptx" ||
    ext === ".xlsx" ||
    ext === ".xlsm" ||
    [".txt", ".md", ".csv", ".json"].includes(ext) ||
    ext.match(/\.(png|jpe?g|gif|webp)$/);

  return (
    <SheetLayer
      title={name}
      onClose={onClose}
      className="doc-reader"
      head={
        <>
          <span className="doc-ext" aria-hidden="true">
            {(ext || ".?").slice(1).toUpperCase()}
          </span>
          <Button size="sm" icon="down" onClick={() => void download()}>
            Download
          </Button>
        </>
      }
    >
        <div className="doc-body">
          {error && <Notice title={`Couldn't open “${name}”.`} text={error} actions={<Button size="sm" onClick={() => void download()}>Download it instead</Button>} />}
          {!error && !readable && (
            <p className="doc-none">
              No reader for {ext || "this kind of file"} yet. Download it to open it in its own app.
            </p>
          )}
          {html !== null && <article className="doc-docx" dangerouslySetInnerHTML={{ __html: html }} />}
          {book && book.length > 0 && (
            <div className="doc-sheet">
              {book.length > 1 && (
                <div className="doc-tabs">
                  <Tabs label="Sheets" items={book.map((s, i) => ({ id: String(i), label: s.name }))} value={String(Math.min(tab, book.length - 1))} onChange={(id) => setTab(Number(id))} />
                </div>
              )}
              <SheetTable sheet={book[Math.min(tab, book.length - 1)]!} />
            </div>
          )}
          {book && book.length === 0 && <p className="doc-none">This workbook has no sheets.</p>}
          {deck && (deck.slides.length > 0 ? <DeckView deck={deck} /> : <p className="doc-none">This presentation has no slides.</p>)}
          {text !== null && <pre className="doc-text">{text}</pre>}
          {url && ext === ".pdf" && <iframe className="doc-frame" src={url} title={name} />}
          {url && ext.match(/\.(png|jpe?g|gif|webp)$/) && <img className="doc-img" src={url} alt={name} />}
          {!error && readable && html === null && text === null && book === null && deck === null && !url && <p className="doc-none">Opening…</p>}
        </div>
    </SheetLayer>
  );
}
