/**
 * A plain-text mail, drawn: the reading itself (image-only lines dropped, links by host) is
 * core's `plainLines` (packages/core/src/mailText.ts), shared with the note a mail is made into.
 */
import { plainLines } from "@orrama/core";

export { isImageOnly, plainLines, type PlainLine, type PlainPart } from "@orrama/core";

export function PlainText({ text }: { text: string }) {
  return (
    <>
      {plainLines(text).map((parts, i) => {
        const blank = parts.every((p) => typeof p === "string" && p.trim() === "");
        return (
          <p key={i} className={blank ? "mail-gap" : undefined}>
            {parts.length
              ? parts.map((p, j) =>
                  typeof p === "string" ? (
                    p
                  ) : (
                    <a key={j} href={p.href} target="_blank" rel="noreferrer noopener" title={p.href}>
                      {p.label}
                    </a>
                  ),
                )
              : " "}
          </p>
        );
      })}
    </>
  );
}
