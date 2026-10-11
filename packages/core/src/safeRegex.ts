/**
 * Regexes from the vault, run in time linear in the text (audit INP-003).
 *
 * A `#vault-categories` rule may be a `/regex/`, and it is note text: Obsidian
 * sync, a shared folder or the agent's `write_note` can put one there. Run by
 * JavaScript's backtracking engine, `/^([^~]+)+~/` against a 40-character path
 * runs for minutes, once per note per tree load, and nothing can interrupt a
 * RegExp in progress — the server stops answering. So the pattern is compiled
 * here into a Thompson NFA and simulated a state set at a time (Pike's
 * method): every pattern costs at most its size times the text's length.
 *
 * The subset is what a rule needs: literals, `.`, classes (`[a-z]`, `[^…]`,
 * `\d \w \s` and their negations), `^ $ \b \B`, groups (`(…)`, `(?:…)`,
 * `(?<name>…)`), `|`, and the quantifiers `* + ? {n} {n,} {n,m}` (lazy or
 * not — only whether it matches counts). JavaScript's own parser checks the
 * syntax first and never runs the pattern. Anything else — backreferences,
 * lookaround, `\p{…}` — is refused (null), as a pattern that does not compile
 * was already: the rule item is dropped, never run.
 *
 * Matching is always case-insensitive (the rules are), and the `g`/`y` flags
 * mean nothing here: one match object is reused across every note, and a
 * native `g` regex carried `lastIndex` from one note to the next (COR-020).
 */

export interface SafeRegex {
  readonly source: string;
  readonly flags: string;
  /** Instructions in the compiled program: what one character of text costs, at most. */
  readonly size: number;
  test(text: string): boolean;
  toString(): string;
}

/** A character test, case-insensitive already (`ci`). */
type Pred = (c: string) => boolean;
type Node =
  | { t: "char"; p: Pred }
  | { t: "assert"; k: "^" | "$" | "b" | "B" }
  | { t: "cat"; xs: Node[] }
  | { t: "alt"; xs: Node[] }
  | { t: "rep"; x: Node; min: number; max: number }; // max: Infinity for unbounded

type Inst =
  | { op: "char"; p: Pred }
  | { op: "assert"; k: "^" | "$" | "b" | "B" }
  | { op: "split"; a: number; b: number }
  | { op: "jmp"; to: number }
  | { op: "match" };

/**
 * The largest program one pattern may compile to (`{1000}` repeats its atom
 * 1,000 times). A step of the simulation costs at most this much.
 */
export const MAX_PROGRAM = 500;

class Unsupported extends Error {}

const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isSpace = (c: string) => /\s/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";
/** Case-insensitive, as JavaScript's `i` canonicalises: either case of the character passes. */
const ci = (p: Pred): Pred => (x) => p(x) || p(x.toLowerCase()) || p(x.toUpperCase());

/** `\d \D \w \W \s \S`, or null for any other letter. */
function classEscape(c: string): Pred | null {
  switch (c) {
    case "d": return isDigit;
    case "D": return (x) => !isDigit(x);
    case "w": return (x) => isWord(x);
    case "W": return (x) => !isWord(x);
    case "s": return isSpace;
    case "S": return (x) => !isSpace(x);
    default: return null;
  }
}

class Parser {
  i = 0;
  constructor(private readonly s: string) {}

  private peek(n = 0) {
    return this.s[this.i + n];
  }
  private eat(c: string) {
    if (this.s[this.i] !== c) throw new Unsupported(c);
    this.i++;
  }

  parse(): Node {
    const n = this.alt();
    if (this.i !== this.s.length) throw new Unsupported("trailing");
    return n;
  }

  private alt(): Node {
    const xs = [this.seq()];
    while (this.peek() === "|") {
      this.i++;
      xs.push(this.seq());
    }
    return xs.length === 1 ? xs[0]! : { t: "alt", xs };
  }

  private seq(): Node {
    const xs: Node[] = [];
    while (this.i < this.s.length && this.peek() !== "|" && this.peek() !== ")") {
      const atom = this.atom();
      xs.push(this.quantified(atom));
    }
    return { t: "cat", xs };
  }

  /** `{n}`, `{n,}` or `{n,m}` at the cursor, or null (then `{` is a literal, as in JavaScript). */
  private braces(): { min: number; max: number; len: number } | null {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(this.s.slice(this.i));
    if (!m) return null;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
    return { min, max, len: m[0].length };
  }

  /** The atom with its quantifier, if one follows. A second (`a**`) JavaScript's parser already refused. */
  private quantified(atom: Node): Node {
    const c = this.peek();
    const b = c === "{" ? this.braces() : null;
    let min: number;
    let max: number;
    if (c === "*") [min, max] = [0, Infinity];
    else if (c === "+") [min, max] = [1, Infinity];
    else if (c === "?") [min, max] = [0, 1];
    else if (b) [min, max] = [b.min, b.max];
    else return atom;
    this.i += b ? b.len : 1;
    if (this.peek() === "?") this.i++; // lazy: the same answer to "does it match"
    if (atom.t === "assert") throw new Unsupported("quantified assertion");
    return { t: "rep", x: atom, min, max };
  }

  private atom(): Node {
    const c = this.peek()!;
    if (c === "(") {
      this.i++;
      if (this.peek() === "?") {
        if (this.peek(1) === ":") this.i += 2;
        else if (this.peek(1) === "<" && this.peek(2) !== "=" && this.peek(2) !== "!") {
          const end = this.s.indexOf(">", this.i);
          if (end < 0) throw new Unsupported("group name");
          this.i = end + 1;
        } else throw new Unsupported("lookaround");
      }
      const inner = this.alt();
      this.eat(")");
      return inner;
    }
    if (c === "[") return this.charClass();
    if (c === ".") {
      this.i++;
      return { t: "char", p: (x) => x !== "\n" && x !== "\r" && x !== " " && x !== " " };
    }
    if (c === "^" || c === "$") {
      this.i++;
      return { t: "assert", k: c };
    }
    if (c === "\\") {
      this.i++;
      const e = this.peek();
      if (e === "b" || e === "B") {
        this.i++;
        return { t: "assert", k: e };
      }
      return { t: "char", p: ci(this.escape(false)) };
    }
    if (c === "*" || c === "+" || c === "?") throw new Unsupported("nothing to repeat");
    this.i++;
    return { t: "char", p: ci((x) => x === c) };
  }

  /** After a backslash: a class escape, or the one character it stands for. */
  private escape(inClass: boolean): Pred {
    const e = this.peek();
    if (e === undefined) throw new Unsupported("trailing backslash");
    this.i++;
    const cls = classEscape(e);
    if (cls) return cls;
    const lit = this.escapedChar(e, inClass);
    return (x) => x === lit;
  }

  private escapedChar(e: string, inClass: boolean): string {
    const simple: Record<string, string> = { t: "\t", n: "\n", r: "\r", f: "\f", v: "\v" };
    if (simple[e]) return simple[e]!;
    if (e === "b" && inClass) return "\b";
    if (e === "0" && !isDigit(this.peek() ?? "")) return "\0";
    if (e === "x" && /^[0-9a-fA-F]{2}/.test(this.s.slice(this.i))) {
      this.i += 2;
      return String.fromCharCode(parseInt(this.s.slice(this.i - 2, this.i), 16));
    }
    if (e === "u" && /^[0-9a-fA-F]{4}/.test(this.s.slice(this.i))) {
      this.i += 4;
      return String.fromCharCode(parseInt(this.s.slice(this.i - 4, this.i), 16));
    }
    // Backreferences, \k<…>, \p{…}, \c, octal: not in the subset.
    if (/[0-9a-zA-Z]/.test(e)) throw new Unsupported(`\\${e}`);
    return e; // an escaped punctuation character is itself
  }

  private charClass(): Node {
    this.eat("[");
    let negate = false;
    if (this.peek() === "^") {
      negate = true;
      this.i++;
    }
    const parts: Pred[] = [];
    // One member: a class escape (no range), or a single character (may start a range).
    const member = (): { p: Pred; ch: string | null } => {
      if (this.peek() === "\\") {
        this.i++;
        const e = this.peek();
        if (e !== undefined && classEscape(e)) {
          this.i++;
          return { p: classEscape(e)!, ch: null };
        }
        if (e === undefined) throw new Unsupported("trailing backslash");
        this.i++;
        const ch = this.escapedChar(e, true);
        return { p: (x) => x === ch, ch };
      }
      const ch = this.peek()!;
      this.i++;
      return { p: (x) => x === ch, ch };
    };
    while (this.peek() !== "]") {
      if (this.i >= this.s.length) throw new Unsupported("unclosed class");
      const a = member();
      if (a.ch !== null && this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== undefined) {
        const save = this.i;
        this.i++;
        const b = member();
        if (b.ch !== null) {
          const lo = a.ch;
          const hi = b.ch;
          parts.push((x) => x >= lo && x <= hi);
          continue;
        }
        // `[a-\d]`: the dash is a literal (JavaScript's Annex B reading).
        this.i = save;
      }
      parts.push(a.p);
    }
    this.eat("]");
    // Folded before negating: /[^a]/i does not match "A".
    const any = ci((x: string) => parts.some((p) => p(x)));
    return { t: "char", p: negate ? (x) => !any(x) : any };
  }
}

/** Compile the tree to a program; throws Unsupported past MAX_PROGRAM. */
function compile(root: Node): Inst[] {
  const prog: Inst[] = [];
  const emit = (i: Inst) => {
    if (prog.length >= MAX_PROGRAM) throw new Unsupported("too large");
    prog.push(i);
    return prog.length - 1;
  };
  const gen = (n: Node): void => {
    switch (n.t) {
      case "char":
        emit({ op: "char", p: n.p });
        return;
      case "assert":
        emit({ op: "assert", k: n.k });
        return;
      case "cat":
        for (const x of n.xs) gen(x);
        return;
      case "alt": {
        // split L1, next; L1: x0; jmp end; next: split L2, … ; last: xn
        const jumps: number[] = [];
        for (let k = 0; k < n.xs.length - 1; k++) {
          const split = emit({ op: "split", a: 0, b: 0 });
          (prog[split] as { a: number }).a = prog.length;
          gen(n.xs[k]!);
          jumps.push(emit({ op: "jmp", to: 0 }));
          (prog[split] as { b: number }).b = prog.length;
        }
        gen(n.xs[n.xs.length - 1]!);
        for (const j of jumps) (prog[j] as { to: number }).to = prog.length;
        return;
      }
      case "rep": {
        for (let k = 0; k < n.min; k++) gen(n.x);
        if (n.max === Infinity) {
          const split = emit({ op: "split", a: 0, b: 0 });
          (prog[split] as { a: number }).a = prog.length;
          gen(n.x);
          emit({ op: "jmp", to: split });
          (prog[split] as { b: number }).b = prog.length;
        } else {
          const splits: number[] = [];
          for (let k = n.min; k < n.max; k++) {
            const split = emit({ op: "split", a: 0, b: 0 });
            (prog[split] as { a: number }).a = prog.length;
            splits.push(split);
            gen(n.x);
          }
          for (const s of splits) (prog[s] as { b: number }).b = prog.length;
        }
        return;
      }
    }
  };
  gen(root);
  emit({ op: "match" });
  return prog;
}

/** Does `prog` match anywhere in `text`? One pass, a set of states per position. */
function run(prog: Inst[], text: string): boolean {
  const seen = new Int32Array(prog.length).fill(-1);
  let mark = 0;
  // Follow jumps, splits and assertions from `pc` at position `at`; returns true on reaching match.
  const add = (list: number[], pc: number, at: number): boolean => {
    const stack = [pc];
    while (stack.length) {
      const k = stack.pop()!;
      if (seen[k] === mark) continue;
      seen[k] = mark;
      const ins = prog[k]!;
      switch (ins.op) {
        case "match":
          return true;
        case "jmp":
          stack.push(ins.to);
          break;
        case "split":
          stack.push(ins.b, ins.a);
          break;
        case "assert": {
          const prev = text[at - 1];
          const next = text[at];
          const ok =
            ins.k === "^" ? at === 0 : ins.k === "$" ? at === text.length : ins.k === "b" ? isWord(prev) !== isWord(next) : isWord(prev) === isWord(next);
          if (ok) stack.push(k + 1);
          break;
        }
        case "char":
          list.push(k);
          break;
      }
    }
    return false;
  };
  let clist: number[] = [];
  mark++;
  if (add(clist, 0, 0)) return true;
  for (let at = 0; at < text.length; at++) {
    mark++;
    const c = text[at]!;
    const nlist: number[] = [];
    for (const k of clist) {
      if ((prog[k] as { p: Pred }).p(c) && add(nlist, k + 1, at + 1)) return true;
    }
    // A new attempt starts at every position: the search is unanchored.
    if (add(nlist, 0, at + 1)) return true;
    clist = nlist;
  }
  return false;
}

/** `source`/`flags` as a SafeRegex, or null when JavaScript refuses it or it is outside the subset. */
export function compileSafeRegex(source: string, flags = ""): SafeRegex | null {
  try {
    new RegExp(source, flags); // syntax only: compiling never runs the pattern
  } catch {
    return null;
  }
  let prog: Inst[];
  try {
    prog = compile(new Parser(source).parse());
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
  const kept = [...new Set(`${flags.replace(/[gy]/g, "")}i`)].sort().join("");
  return {
    source,
    flags: kept,
    size: prog.length,
    test: (text: string) => run(prog, text),
    toString: () => `/${source}/${kept}`,
  };
}
