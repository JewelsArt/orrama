/**
 * Read a message the way it was written (CLAUDE.md "Reading mail").
 *
 * HTML wins when the message has it: the plain-text alternative of a marketing mail is a wall
 * of bracketed tracking URLs. The HTML goes into an iframe that cannot run scripts and whose
 * CSP blocks everything except images, styles and fonts; links open in the real browser.
 *
 * `allow-same-origin` is there so we can *measure* the rendered document and size the frame to
 * it: one scrollbar for the whole message, like a mail client, instead of a fixed box with dead
 * space. It is safe precisely because `allow-scripts` is absent: nothing inside can execute, so
 * nothing can use that origin. The frame's attributes are SANDBOX and frameDoc below, and
 * MessageBody.dom.test.tsx holds them to that (OPS-008, the web half).
 */
import { useEffect, useRef, useState } from "react";
import type { MailMessage } from "@orrama/schema/responses";
import { readKey, writeKey } from "../storage.js";
import { PlainText } from "./plainText.js";

/** No allow-scripts, ever: allow-same-origin is only safe without it. */
export const SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

const IMAGES_KEY = "orrama-mail-images";
/** Images load by default (what every mail client does); blocking is remembered. */
export const imagesAllowed = () => readKey(IMAGES_KEY) !== "off";
export const setImagesAllowed = (on: boolean) => writeKey(IMAGES_KEY, on ? "on" : "off");

/** The policy inside the frame: images from the sender only when allowed; never a script. */
export function frameCsp(images: boolean): string {
  return images
    ? "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data: https:"
    : "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
}

/**
 * The frame's document. As little CSS as possible: img and table get max-width:100% and
 * nothing else, because a universal max-width forces mail tables into a stacked mobile layout.
 * The message is drawn on white, as its sender designed it, in both themes.
 */
export function frameDoc(html: string, images: boolean): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(images)}"><base target="_blank"><style>html,body{background:#fff;color:#111;overflow-x:hidden;} body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:12px 14px;} img{max-width:100%;height:auto;} a{color:#1967d4;} table{max-width:100%;}</style>${html}`;
}

const MIN_HEIGHT = 120;

export function MessageBody({ message, images, onShowImages }: { message: MailMessage; images: boolean; onShowImages: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);

  /** Grow the frame to its content, and again as images arrive. */
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    // Start each document short: its scrollHeight is never less than the frame it sits in, so
    // a frame left tall by the last message (or by images, now blocked) would never shrink.
    setHeight(MIN_HEIGHT);
    let stop = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    /*
     * The body's own height, margins included. Not the document's: its scrollHeight is never
     * less than the frame, so measuring it and adding a margin grew the frame by that margin at
     * every re-measure (40 px of white under every HTML mail).
     */
    const measure = () => {
      const doc = el.contentDocument;
      if (!doc?.body || stop) return;
      const cs = doc.defaultView?.getComputedStyle(doc.body);
      const margins = cs ? (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0) : 0;
      const next = Math.ceil(Math.max(doc.body.scrollHeight, doc.body.getBoundingClientRect().height) + margins);
      if (next > 0) setHeight(next);
    };
    const onLoad = () => {
      measure();
      for (const img of el.contentDocument?.images ?? []) img.addEventListener("load", measure, { once: true });
      // Late reflows (web fonts, slow images): a few cheap re-measures.
      for (const t of [150, 500, 1200, 2500]) timers.push(setTimeout(measure, t));
    };
    el.addEventListener("load", onLoad);
    return () => {
      stop = true;
      timers.forEach(clearTimeout);
      el.removeEventListener("load", onLoad);
    };
  }, [message.uid, images]);

  if (message.html) {
    return (
      <div className="mbody-wrap">
        {!images && (
          <p className="mimages">
            Images are blocked: they can tell the sender you opened this.
            <button type="button" className="btn sm quiet" onClick={onShowImages}>
              Show images
            </button>
          </p>
        )}
        <iframe
          key={`${message.uid}-${images}`}
          ref={frame}
          className="mbody-html"
          style={{ height }}
          sandbox={SANDBOX}
          referrerPolicy="no-referrer"
          title="Message content"
          srcDoc={frameDoc(message.html, images)}
        />
      </div>
    );
  }
  if (message.text.trim())
    return (
      <div className="mbody">
        <PlainText text={message.text} />
      </div>
    );
  return <p className="mbody mempty">This message has no text.</p>;
}
