/**
 * An answer's Markdown as elements (markdown.ts reads it). Citations are drawn by the caller,
 * which knows which note each names; a web link opens in the browser, never in the app's
 * window; anything else that looks like a link is said as text.
 */
import { Fragment, type ReactNode } from "react";
import { parseBlocks, type Inline } from "./markdown.js";

/** Draws a `[[citation]]`: a link when the note is known, text when it is not. */
export type CiteRender = (target: string, label: string) => ReactNode;

const WEB = /^(https?:|mailto:)/i;
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function inline(nodes: Inline[], cite: CiteRender): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <Fragment key={i}>{n.s}</Fragment>;
      case "b":
        return <strong key={i}>{inline(n.c, cite)}</strong>;
      case "i":
        return <em key={i}>{inline(n.c, cite)}</em>;
      case "code":
        return <code key={i}>{n.s}</code>;
      case "cite":
        return <Fragment key={i}>{cite(n.target, n.label)}</Fragment>;
      case "link": {
        if (WEB.test(n.href))
          return (
            <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
              {inline(n.c, cite)}
            </a>
          );
        // A link to a note by its path ([plan](04-Projects/plan.md)) is a citation of it.
        if (!/^[a-z][a-z0-9+.-]*:/i.test(n.href)) {
          const label = n.c.map((c) => (c.t === "text" ? c.s : "")).join("") || n.href;
          return <Fragment key={i}>{cite(decode(n.href).replace(/\.md$/i, ""), label)}</Fragment>;
        }
        return <Fragment key={i}>{inline(n.c, cite)}</Fragment>;
      }
    }
  });
}

export function Markdown({ text, cite }: { text: string; cite: CiteRender }) {
  return (
    <>
      {parseBlocks(text).map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i}>{inline(b.c, cite)}</p>;
          case "h":
            return b.level === 1 ? <h3 key={i}>{inline(b.c, cite)}</h3> : <h4 key={i}>{inline(b.c, cite)}</h4>;
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, cite)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} start={b.start === 1 ? undefined : b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, cite)}</li>
                ))}
              </ol>
            );
          case "quote":
            return <blockquote key={i}>{inline(b.c, cite)}</blockquote>;
          case "code":
            return (
              <pre key={i}>
                <code>{b.s}</code>
              </pre>
            );
          case "hr":
            return <hr key={i} />;
        }
      })}
    </>
  );
}
