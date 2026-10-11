/**
 * Orr's answers are Markdown (structure.md §2.11). This reads the part of it a model writes in
 * an answer — paragraphs, headings, lists, quotes, code, bold, italic, links and the vault's
 * own `[[Note]]` citations — into a small tree the panel turns into elements. Nothing is ever
 * set as HTML: a model's text, and whatever a note or a mail it read put into it, stays text.
 *
 * It is read again on every streamed chunk, so a half-written answer must read sensibly: an
 * unclosed `**` or `[[` is plain text until its other half arrives.
 */

export type Inline =
  | { t: "text"; s: string }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "code"; s: string }
  /** `[[target]]`, `[[target|label]]`, `[[target#heading]]`: a note the answer cites. */
  | { t: "cite"; target: string; label: string }
  /** `[label](href)`: a web address, or a note by its path. */
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] }
  | { t: "quote"; c: Inline[] }
  | { t: "code"; s: string }
  | { t: "hr" };

const BULLET = /^\s{0,6}[-*+]\s+(.*)$/;
const NUMBER = /^\s{0,6}(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** The answer's blocks, in order. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", c: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      const close = new RegExp(`^\\s{0,3}${fence[1]![0] === "`" ? "`" : "~"}{${fence[1]!.length},}\\s*$`);
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
      out.push({ t: "code", s: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      out.push({ t: "h", level: Math.min(3, h[1]!.length) as 1 | 2 | 3, c: parseInline(h[2]!) });
      continue;
    }
    if (RULE.test(line) && !para.length) {
      out.push({ t: "hr" });
      continue;
    }
    const bullet = BULLET.exec(line);
    const number = bullet ? null : NUMBER.exec(line);
    if (bullet || number) {
      flush();
      const ordered = !!number;
      const items: string[] = [bullet ? bullet[1]! : number![2]!];
      // The list goes on through its items and their wrapped lines, and ends at a blank line
      // followed by something that is not one of its items.
      for (i++; i < lines.length; i++) {
        const next = lines[i]!;
        const b = BULLET.exec(next);
        const n = b ? null : NUMBER.exec(next);
        if ((ordered && n) || (!ordered && b)) items.push(ordered ? n![2]! : b![1]!);
        else if (next.trim() && /^\s+\S/.test(next)) items[items.length - 1] += `\n${next.trim()}`;
        else if (!next.trim() && i + 1 < lines.length && (ordered ? NUMBER : BULLET).test(lines[i + 1]!)) continue;
        else break;
      }
      i--;
      const parsed = items.map((s) => parseInline(s));
      out.push(ordered ? { t: "ol", start: Number(number![1]), items: parsed } : { t: "ul", items: parsed });
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      flush();
      const body = [q[1]!];
      for (i++; i < lines.length && QUOTE.test(lines[i]!); i++) body.push(QUOTE.exec(lines[i]!)![1]!);
      i--;
      out.push({ t: "quote", c: parseInline(body.join("\n")) });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

/** One block's text as runs: plain, bold, italic, code, citations and links. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const push = (node: Inline) => {
    if (plain) out.push({ t: "text", s: plain });
    plain = "";
    out.push(node);
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    // `code`: nothing inside it is read.
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        push({ t: "code", s: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // [[target]], [[target|label]], [[target#heading]]
    if (rest.startsWith("[[")) {
      const end = s.indexOf("]]", i + 2);
      const inner = end === -1 ? "" : s.slice(i + 2, end);
      if (inner.trim() && !inner.includes("\n") && !inner.includes("[[")) {
        const bar = inner.indexOf("|");
        const ref = (bar === -1 ? inner : inner.slice(0, bar)).trim();
        const target = ref.split("#")[0]!.trim() || ref;
        const label = (bar === -1 ? ref.replace(/#/, " › ") : inner.slice(bar + 1)).trim() || target;
        push({ t: "cite", target, label });
        i = end + 2;
        continue;
      }
    }
    // [label](href)
    if (s[i] === "[") {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (m) {
        push({ t: "link", href: m[2]!, c: parseInline(m[1]!) });
        i += m[0].length;
        continue;
      }
    }
    // **bold** / __bold__
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const mark = rest.slice(0, 2);
      const end = s.indexOf(mark, i + 2);
      if (end > i + 2 && s[i + 2] !== " ") {
        push({ t: "b", c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    // *italic* / _italic_ (an underscore only at a word's edge, so snake_case stays text)
    if ((s[i] === "*" || (s[i] === "_" && !/\w/.test(s[i - 1] ?? ""))) && s[i + 1] && s[i + 1] !== " " && s[i + 1] !== s[i]) {
      const mark = s[i]!;
      let end = s.indexOf(mark, i + 1);
      while (end !== -1 && mark === "_" && /\w/.test(s[end + 1] ?? "")) end = s.indexOf(mark, end + 1);
      if (end > i + 1 && s[end - 1] !== " " && !s.slice(i + 1, end).includes("\n\n")) {
        push({ t: "i", c: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    plain += s[i];
    i++;
  }
  if (plain) out.push({ t: "text", s: plain });
  return out;
}
