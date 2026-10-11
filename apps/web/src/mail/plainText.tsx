/**
 * A plain-text mail, made readable: lines that are nothing but an image URL go (the text twin
 * of a marketing mail is full of them), and every other link shows its host rather than 300
 * characters of tracking parameters. The href keeps the full URL; only the label is short.
 *
 * `plainLines` is the reading, as data; `PlainText` draws it.
 */

/** Every URL in a line, for matchAll. Global: never call .test() on it (WEB-021). */
const URL_RE = /https?:\/\/[^\s<>()\[\]]+/g;
/**
 * The same pattern without the g flag, for asking whether a line holds a URL. `.test()` on a
 * global regex moves its lastIndex and leaves it there, so the next line's test started
 * mid-string and missed: an image-only line after an ordinary link line survived (WEB-021).
 */
const HAS_URL = new RegExp(URL_RE.source);
const IMAGE_URL = /\.(png|jpe?g|gif|webp|svg)(\?|$)/i;

export type PlainPart = string | { href: string; label: string };
/** One line of the message; an empty one is the gap between paragraphs. */
export type PlainLine = PlainPart[];

const host = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Is this line only an image's URL (bracketed or bare)? Then it is clutter. */
export function isImageOnly(line: string): boolean {
  const bare = line.trim().replace(/^\[|\]$/g, "");
  return HAS_URL.test(bare) && IMAGE_URL.test(bare) && bare.replace(URL_RE, "").trim() === "";
}

/** The message's lines, image-only ones dropped, links as their host. */
export function plainLines(text: string): PlainLine[] {
  return text
    .split("\n")
    .filter((line) => !isImageOnly(line))
    .map((line) => {
      const parts: PlainPart[] = [];
      let last = 0;
      for (const m of line.matchAll(URL_RE)) {
        const start = m.index ?? 0;
        const before = line.slice(last, start).replace(/\[$/, "");
        if (before) parts.push(before);
        parts.push({ href: m[0], label: host(m[0]) });
        last = start + m[0].length;
        if (line[last] === "]") last++;
      }
      const rest = line.slice(last);
      if (rest) parts.push(rest);
      return parts;
    });
}

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
