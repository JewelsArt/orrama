/**
 * Obsidian-style live preview for the Orrama editor. The source of truth is the
 * raw Markdown; this layer only decorates it. Rules:
 *  - the line your cursor is on always shows its plain source (no surprises)
 *  - frontmatter collapses to a quiet "properties" row
 *  - checkboxes render as real, clickable checkboxes (clicking edits the text)
 *  - [[wiki links]] conceal their brackets and show the alias
 *  - #tags, @mentions, due: dates, !p priorities and ^block-ids become chips
 *  - heading markers (##) hide until you edit the line
 *  - **bold**, *italic* and `code` hide their marks, a list's dash is a bullet (§2.3: "the live
 *    preview finishes its job")
 *  - a due date reads as words ("today", "3 days late"); a done task is never late
 *  - tables render as tables, `---` as a rule, fenced code gets a slab
 */
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { daysTo, isoLocal } from "@orrama/core/dates";
// One tag grammar for the index and the chips: a chip drawn over half a tag
// would show a different tag from the one the note is filed under.
import { TAG_RE } from "@orrama/core";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

const LINK_RE = /\[\[([^\[\]\|#]+)(?:#([^\[\]\|]+))?(?:\|([^\[\]]+))?\]\]/g;

/**
 * The wiki links on one line, and how the preview draws each: everything but the label hidden,
 * the label marked, and the link's own target kept for a cmd-click (WEB-007). The label is what
 * you see — the alias when there is one — and used to be what the click asked for, so
 * `[[Graduation Thesis|thesis]]` looked for a note called "thesis" and `[[folder/Note]]` for one
 * titled with the whole path. The target is the note's name as written, before `#` and `|`,
 * which is what the server resolved (NoteDetail.links[].target).
 */
export interface WikiLinkSpan {
  /** Where the link starts and ends, `[[` to `]]`. */
  from: number;
  to: number;
  /** The label shown, trimmed, and where it sits. */
  label: string;
  labelFrom: number;
  labelTo: number;
  /** The note named, as written. */
  target: string;
  heading?: string;
}

export function wikiLinks(text: string, offset = 0): WikiLinkSpan[] {
  const out: WikiLinkSpan[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const from = offset + m.index!;
    const raw = m[3] ?? m[1]!;
    const label = raw.trim();
    // Where the label's first character is: after `|` for an alias, after `[[` otherwise, then
    // past any spaces the trim dropped — `[[Note| My alias]]` used to mark " My alia".
    const rawFrom = m[3] !== undefined ? from + m[0].indexOf("|") + 1 : from + 2;
    const labelFrom = rawFrom + (raw.length - raw.trimStart().length);
    out.push({ from, to: from + m[0].length, label, labelFrom, labelTo: labelFrom + label.length, target: m[1]!.trim(), ...(m[2] ? { heading: m[2].trim() } : {}) });
  }
  return out;
}
/** `[/]` in progress and `[b]` blocked are open tasks too (see core parse.ts). */
const TASK_RE = /^(\s*)- \[( |x|X|\/|b)\] /;
const HEADING_RE = /^(#{1,6}) /;
const MENTION_RE = /(^|\s)@([\w.-]+)/g;
const DUE_RE = /(^|\s)(due:)(\d{4}-\d{2}-\d{2})/g;
const PRIO_RE = /(^|\s)!p([123])\b/g;
const BLOCK_ID_RE = /\s\^[\w-]+\s*$/;
const FENCE_RE = /^(```|~~~)/;

const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
/** A list item that is not a task: its dash, star or plus becomes a bullet. */
const BULLET_RE = /^(\s*)([-*+]) (?!\[[ xX/b]\] )/;
const CODE_SPAN_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
/** `**strong**` / `__strong__`: the marks hug the words, never spaces. */
const STRONG_RE = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g;
/** `*em*` / `_em_`, not inside a word (snake_case stays as written). */
const EM_RE = /(?<![\w*])(\*|_)(?=[^\s*_])([^*_]*?[^\s*_])\1(?![\w*])/g;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A due date as the Notes board says it: "today", "tomorrow", "3 days late", a weekday within
 * the week ahead, else "19 Oct". A done task is never late: it says its day (§2.3, "Done tasks
 * lose their red overdue chip").
 */
export function dueWords(date: string, done: boolean, today: string = isoLocal()): { text: string; late: boolean } {
  const d = daysTo(today, date);
  const [y, m, day] = date.split("-").map(Number) as [number, number, number];
  const when = new Date(y, m - 1, day);
  const short = `${day} ${MONTHS[m - 1]}${String(y) === today.slice(0, 4) ? "" : ` ${y}`}`;
  if (!done && d < 0) return { text: `${-d} ${d === -1 ? "day" : "days"} late`, late: true };
  if (d === 0) return { text: "today", late: false };
  if (d === 1) return { text: "tomorrow", late: false };
  if (Math.abs(d) <= 6) return { text: DAYS[when.getDay()]!, late: false };
  return { text: short, late: false };
}

/**
 * Where the preview hides marks and marks text on one line of prose: strong, emphasis and
 * code spans, plus a list's bullet. Pure, so each rule has a test; ranges are line offsets.
 */
export interface InlineMarks {
  hide: [number, number][];
  marks: { from: number; to: number; cls: string }[];
  bullet?: [number, number];
}

export function inlineMarks(text: string): InlineMarks {
  const hide: [number, number][] = [];
  const marks: InlineMarks["marks"] = [];
  const code: [number, number][] = [];
  for (const m of text.matchAll(CODE_SPAN_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    code.push([from, to]);
    hide.push([from, from + m[1]!.length], [to - m[1]!.length, to]);
    marks.push({ from: from + m[1]!.length, to: to - m[1]!.length, cls: "cm-code-span" });
  }
  const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
  const pair = (re: RegExp, cls: string) => {
    for (const m of text.matchAll(re)) {
      const from = m.index!;
      const to = from + m[0].length;
      const w = m[1]!.length;
      if (inCode(from) || inCode(to - 1)) continue;
      hide.push([from, from + w], [to - w, to]);
      marks.push({ from: from + w, to: to - w, cls });
    }
  };
  pair(STRONG_RE, "cm-strong");
  // Emphasis is looked for where strong is not: `**a**` is not two empty emphases.
  const strongless = text.replace(STRONG_RE, (all) => " ".repeat(all.length));
  for (const m of strongless.matchAll(EM_RE)) {
    const from = m.index!;
    const to = from + m[0].length;
    if (inCode(from) || inCode(to - 1)) continue;
    hide.push([from, from + 1], [to - 1, to]);
    marks.push({ from: from + 1, to: to - 1, cls: "cm-em" });
  }
  const b = BULLET_RE.exec(text);
  return { hide, marks, ...(b ? { bullet: [b[1]!.length, b[1]!.length + 1] as [number, number] } : {}) };
}

/** A list's dash, drawn as a bullet. */
class BulletWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const b = document.createElement("span");
    b.className = "cm-bullet";
    b.textContent = "•";
    return b;
  }
}

/** A due date in words; the source (`due:2026-10-19`) is one click away on its line. */
class DueWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly late: boolean,
    private readonly date: string,
  ) {
    super();
  }
  override eq(other: DueWidget) {
    return other.text === this.text && other.late === this.late && other.date === this.date;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.late ? "cm-due late" : "cm-due";
    el.textContent = this.text;
    el.title = `Due ${this.date}`;
    return el;
  }
}
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Split a markdown row on unescaped pipes, dropping the outer ones. */
const cells = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
};

/** A markdown table, rendered. Text only — the source is one keystroke away. */
class TableWidget extends WidgetType {
  constructor(private readonly rows: string[][]) {
    super();
  }
  eq(other: TableWidget) {
    return JSON.stringify(other.rows) === JSON.stringify(this.rows);
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-table";
    const [head, ...body] = this.rows;
    if (head) {
      const thead = table.createTHead().insertRow();
      for (const c of head) {
        const th = document.createElement("th");
        th.textContent = c;
        thead.appendChild(th);
      }
    }
    const tbody = table.createTBody();
    for (const row of body) {
      const tr = tbody.insertRow();
      for (const c of row) tr.insertCell().textContent = c;
    }
    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

class RuleWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement("div");
    hr.className = "cm-hr";
    return hr;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    /** The character between the brackets: " ", "x", "X", "/" or "b". */
    private mark: string,
    private pos: number,
    private readOnly: boolean,
  ) {
    super();
  }
  private get checked() {
    return this.mark === "x" || this.mark === "X";
  }
  override eq(other: CheckboxWidget) {
    return other.mark === this.mark && other.pos === this.pos && other.readOnly === this.readOnly;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    const state = this.checked ? "checked" : this.mark === "/" ? "doing" : this.mark === "b" ? "blocked" : "";
    box.className = `cm-task-box ${state}`;
    box.setAttribute("role", "checkbox");
    // In progress / blocked read as "partly there" to a screen reader; a click completes them.
    box.setAttribute("aria-checked", this.checked ? "true" : state ? "mixed" : "false");
    if (state === "doing" || state === "blocked") box.title = state === "doing" ? "In progress" : "Blocked";
    if (!this.readOnly) {
      box.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({
          changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? " " : "x" },
        });
      });
    }
    return box;
  }
  override ignoreEvent() {
    return false;
  }
}

class PropsWidget extends WidgetType {
  constructor(
    private summary: string,
    private from: number,
  ) {
    super();
  }
  override eq(other: PropsWidget) {
    return other.summary === this.summary && other.from === this.from;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("button");
    el.className = "cm-props";
    el.textContent = this.summary;
    el.title = "Edit properties";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: Math.min(this.from + 4, view.state.doc.length) } });
      view.focus();
    });
    return el;
  }
  override ignoreEvent() {
    return false;
  }
}

interface Options {
  readOnly: boolean;
}

/** Frontmatter range, or null. Only scans the top of the doc. */
export function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return null;
  for (let i = 2; i <= Math.min(doc.lines, 40); i++) {
    if (doc.line(i).text.trim() === "---") return { from: doc.line(1).from, to: doc.line(i).to };
  }
  return null;
}

/**
 * Multi-line replace decorations must live in a StateField (CodeMirror forbids
 * them in view plugins) — so the frontmatter collapse is its own field.
 */
function frontmatterCollapse(): Extension {
  const compute = (state: EditorState): DecorationSet => {
    const range = frontmatterRange(state);
    if (!range) return Decoration.none;
    const head = state.selection.main.head;
    if (head >= range.from && head <= range.to) return Decoration.none; // editing it
    const raw = state.doc.sliceString(range.from, range.to);
    // Tags only: inline `tags: [a, b]` or the list items directly under `tags:`.
    const tags: string[] = [];
    const inline = /^tags:\s*\[([^\]]*)\]/m.exec(raw);
    if (inline) tags.push(...inline[1]!.split(",").map((t) => t.trim()).filter(Boolean));
    const block = /^tags:\s*$((?:\n\s+-\s+.+)+)/m.exec(raw);
    if (block) tags.push(...[...block[1]!.matchAll(/-\s+(\S+)/g)].map((m) => m[1]!));
    const summary = `properties${tags.length ? " · " + tags.map((t) => "#" + t).join(" ") : ""}`;
    return Decoration.set([
      Decoration.replace({ widget: new PropsWidget(summary, range.from), block: true }).range(range.from, range.to),
    ]);
  };
  return StateField.define<DecorationSet>({
    create: compute,
    update(deco, tr) {
      if (tr.docChanged || tr.selection) return compute(tr.state);
      return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

export function livePreview(opts: Options): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = this.build(u.view);
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const doc = view.state.doc;
        const sel = view.state.selection.main;
        // An unfocused editor is pure preview: no line is "being edited".
        const cursorLine = view.hasFocus ? doc.lineAt(sel.head).number : -1;

        // Frontmatter is handled by the frontmatterCollapse state field; the
        // per-line pass just skips those lines.
        const fm = frontmatterRange(view.state);
        const bodyStartLine = fm ? doc.lineAt(fm.to).number + 1 : 1;

        let inFence = false;
        for (let ln = 1; ln <= doc.lines; ln++) {
          const line = doc.line(ln);
          if (ln < bodyStartLine) continue;
          if (FENCE_RE.test(line.text.trimStart())) {
            inFence = !inFence;
            continue;
          }
          if (inFence) continue;
          if (line.from < view.viewport.from - 4000 || line.to > view.viewport.to + 4000) continue;

          const active = ln === cursorLine;
          const text = line.text;
          type Deco = { from: number; to: number; deco: Decoration };
          const decos: Deco[] = [];

          // heading markers conceal
          const hm = HEADING_RE.exec(text);
          if (hm && !active) {
            decos.push({ from: line.from, to: line.from + hm[0].length, deco: Decoration.replace({}) });
          }

          // checkbox
          const tm = TASK_RE.exec(text);
          const done = !!tm && (tm[2] === "x" || tm[2] === "X");
          if (tm) {
            const boxStart = line.from + tm[1]!.length;
            const checked = tm[2] === "x" || tm[2] === "X";
            if (!active) {
              decos.push({
                from: boxStart,
                to: boxStart + 6,
                deco: Decoration.replace({
                  widget: new CheckboxWidget(tm[2]!, boxStart + 3, opts.readOnly),
                }),
              });
            }
            if (checked) {
              decos.push({ from: boxStart + 6, to: line.to, deco: Decoration.mark({ class: "cm-task-done" }) });
            }
            // block id: pure plumbing, hide it unless editing the line
            const bid = BLOCK_ID_RE.exec(text);
            if (bid && !active) {
              decos.push({ from: line.from + bid.index, to: line.to, deco: Decoration.replace({}) });
            }
          }

          // wiki links: the label shows, the rest hides, the target rides along for the click
          for (const l of wikiLinks(text, line.from)) {
            const cursorIn = active && sel.head >= l.from && sel.head <= l.to;
            if (cursorIn) continue;
            decos.push({ from: l.from, to: l.labelFrom, deco: Decoration.replace({}) });
            decos.push({ from: l.labelFrom, to: l.labelTo, deco: Decoration.mark({ class: "cm-wikilink", attributes: { "data-target": l.target } }) });
            decos.push({ from: l.labelTo, to: l.to, deco: Decoration.replace({}) });
          }

          // chips: tags, mentions, due dates, priorities
          for (const m of text.matchAll(TAG_RE)) {
            const start = line.from + m.index! + m[1]!.length;
            decos.push({ from: start, to: start + m[2]!.length + 1, deco: Decoration.mark({ class: "cm-hashtag" }) });
          }
          for (const m of text.matchAll(MENTION_RE)) {
            const start = line.from + m.index! + m[1]!.length;
            decos.push({ from: start, to: start + m[2]!.length + 1, deco: Decoration.mark({ class: "cm-mention" }) });
          }
          for (const m of text.matchAll(DUE_RE)) {
            const start = line.from + m.index! + m[1]!.length;
            const end = start + 4 + m[3]!.length;
            if (active) {
              // Being edited: the source, marked, so you can see what you are changing.
              decos.push({ from: start, to: end, deco: Decoration.mark({ class: "cm-due-src" }) });
              continue;
            }
            // Local, not UTC (dueWords counts local days): for the first hour or two of a day in
            // Amsterdam the UTC date is still yesterday, and a task due today read as overdue.
            const w = dueWords(m[3]!, done);
            decos.push({ from: start, to: end, deco: Decoration.replace({ widget: new DueWidget(w.text, w.late, m[3]!) }) });
          }
          for (const m of text.matchAll(PRIO_RE)) {
            const start = line.from + m.index! + m[1]!.length;
            decos.push({ from: start, to: start + 3, deco: Decoration.mark({ class: `cm-prio p${m[2]}` }) });
          }

          // A list item or a task wraps under its own text, not under its bullet or box.
          if (tm || BULLET_RE.test(text)) {
            const depth = (tm ? tm[1]! : BULLET_RE.exec(text)![1]!).replace(/\t/g, "  ").length;
            decos.push({ from: line.from, to: line.from, deco: Decoration.line({ class: tm ? "cm-li cm-li-task" : "cm-li", attributes: { style: `--li-depth:${depth}` } }) });
          }

          // strong, emphasis, code spans and a list's bullet: marks hidden off the active line
          if (!active) {
            const im = inlineMarks(text);
            for (const [a, b] of im.hide) decos.push({ from: line.from + a, to: line.from + b, deco: Decoration.replace({}) });
            for (const mk of im.marks) if (mk.to > mk.from) decos.push({ from: line.from + mk.from, to: line.from + mk.to, deco: Decoration.mark({ class: mk.cls }) });
            if (im.bullet) decos.push({ from: line.from + im.bullet[0], to: line.from + im.bullet[1], deco: Decoration.replace({ widget: new BulletWidget() }) });
          }

          decos.sort((a, b) => a.from - b.from || a.to - b.to);
          let lastReplaceEnd = -1;
          for (const d of decos) {
            const isReplace = !d.deco.spec["class"];
            // CM forbids overlapping replace ranges; drop anything inside one.
            if (d.from < lastReplaceEnd) continue;
            builder.add(d.from, d.to, d.deco);
            if (isReplace) lastReplaceEnd = d.to;
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );

  /**
   * Block-level preview: tables, horizontal rules and fenced code. A StateField,
   * not a view plugin — CodeMirror only accepts block decorations from state,
   * and these span whole lines. A block yields to its source the moment the
   * cursor lands inside it.
   */
  const blockPreview = (): Extension => {
    const compute = (state: EditorState): DecorationSet => {
      const doc = state.doc;
      const cursorLine = doc.lineAt(state.selection.main.head).number;
      const fm = frontmatterRange(state);
      const bodyStartLine = fm ? doc.lineAt(fm.to).number + 1 : 1;
      const out: { from: number; to: number; deco: Decoration }[] = [];

      let ln = bodyStartLine;
      let inFence = false;
      while (ln <= doc.lines) {
        const line = doc.line(ln);
        const text = line.text;

        if (FENCE_RE.test(text.trimStart())) {
          inFence = !inFence;
          out.push({ from: line.from, to: line.from, deco: Decoration.line({ class: "cm-code-line cm-code-edge" }) });
          ln++;
          continue;
        }
        if (inFence) {
          out.push({ from: line.from, to: line.from, deco: Decoration.line({ class: "cm-code-line" }) });
          ln++;
          continue;
        }

        // table: a header row followed by a |---|---| separator
        const next = ln + 1 <= doc.lines ? doc.line(ln + 1) : null;
        if (text.includes("|") && next && next.text.includes("|") && TABLE_SEP_RE.test(next.text)) {
          let end = ln + 1;
          while (end + 1 <= doc.lines && doc.line(end + 1).text.includes("|") && doc.line(end + 1).text.trim() !== "") end++;
          if (cursorLine < ln || cursorLine > end) {
            const rows: string[][] = [cells(text)];
            for (let r = ln + 2; r <= end; r++) rows.push(cells(doc.line(r).text));
            out.push({ from: line.from, to: doc.line(end).to, deco: Decoration.replace({ widget: new TableWidget(rows), block: true }) });
          }
          ln = end + 1;
          continue;
        }

        if (HR_RE.test(text) && ln !== cursorLine) {
          out.push({ from: line.from, to: line.to, deco: Decoration.replace({ widget: new RuleWidget(), block: true }) });
        }
        ln++;
      }
      out.sort((a, b) => a.from - b.from || a.to - b.to);
      return Decoration.set(out.map((d) => d.deco.range(d.from, d.to)), true);
    };
    return StateField.define<DecorationSet>({
      create: compute,
      update(deco, tr) {
        if (tr.docChanged || tr.selection) return compute(tr.state);
        return deco.map(tr.changes);
      },
      provide: (f) => EditorView.decorations.from(f),
    });
  };

  // Follow wiki links with cmd/ctrl+click: the link's target, never its label (WEB-007).
  const linkClick = EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey)) return false;
      const link = (e.target as HTMLElement).closest(".cm-wikilink");
      if (!link) return false;
      const target = link.getAttribute("data-target") ?? link.textContent ?? "";
      view.dom.dispatchEvent(new CustomEvent("orrama-open-link", { bubbles: true, detail: target }));
      return true;
    },
  });

  return [frontmatterCollapse(), blockPreview(), plugin, linkClick];
}
