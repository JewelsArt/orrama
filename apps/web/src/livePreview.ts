/**
 * Obsidian-style live preview for the Basalt editor. The source of truth is the
 * raw Markdown; this layer only decorates it. Rules:
 *  - the line your cursor is on always shows its plain source (no surprises)
 *  - frontmatter collapses to a quiet "properties" row
 *  - checkboxes render as real, clickable checkboxes (clicking edits the text)
 *  - [[wiki links]] conceal their brackets and show the alias
 *  - #tags, @mentions, due: dates, !p priorities and ^block-ids become chips
 *  - heading markers (##) hide until you edit the line
 *  - tables render as tables, `---` as a rule, fenced code gets a slab
 */
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { isoLocal } from "@basalt/core/dates";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

const LINK_RE = /\[\[([^\[\]\|#]+)(?:#([^\[\]\|]+))?(?:\|([^\[\]]+))?\]\]/g;
const TAG_RE = /(^|[\s(])#([A-Za-z][\w-]*(?:\/[\w-]+)*)/g;
const TASK_RE = /^(\s*)- \[( |x|X)\] /;
const HEADING_RE = /^(#{1,6}) /;
const MENTION_RE = /(^|\s)@([\w.-]+)/g;
const DUE_RE = /(^|\s)(due:)(\d{4}-\d{2}-\d{2})/g;
const PRIO_RE = /(^|\s)!p([123])\b/g;
const BLOCK_ID_RE = /\s\^[\w-]+\s*$/;
const FENCE_RE = /^(```|~~~)/;

const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
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
    private checked: boolean,
    private pos: number,
    private readOnly: boolean,
  ) {
    super();
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos && other.readOnly === this.readOnly;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = `cm-task-box ${this.checked ? "checked" : ""}`;
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
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
          if (tm) {
            const boxStart = line.from + tm[1]!.length;
            const checked = tm[2] !== " ";
            if (!active) {
              decos.push({
                from: boxStart,
                to: boxStart + 6,
                deco: Decoration.replace({
                  widget: new CheckboxWidget(checked, boxStart + 3, opts.readOnly),
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

          // wiki links
          for (const m of text.matchAll(LINK_RE)) {
            const start = line.from + m.index!;
            const end = start + m[0].length;
            const cursorIn = active && sel.head >= start && sel.head <= end;
            if (cursorIn) continue;
            const label = (m[3] ?? m[1]!).trim();
            const labelStart = m[3] ? start + m[0].indexOf("|") + 1 : start + 2;
            decos.push({ from: start, to: labelStart, deco: Decoration.replace({}) });
            decos.push({ from: labelStart, to: labelStart + label.length, deco: Decoration.mark({ class: "cm-wikilink" }) });
            decos.push({ from: labelStart + label.length, to: end, deco: Decoration.replace({}) });
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
            // Local, not UTC: for the first hour or two of a day in Amsterdam the
            // UTC date is still yesterday, and a task due today read as overdue.
            const overdue = m[3]! < isoLocal();
            if (!active) {
              decos.push({ from: start, to: start + 4, deco: Decoration.replace({}) }); // hide "due:"
            }
            decos.push({
              from: start + (active ? 0 : 4),
              to: start + 4 + m[3]!.length,
              deco: Decoration.mark({ class: `cm-due ${overdue ? "overdue" : ""}` }),
            });
          }
          for (const m of text.matchAll(PRIO_RE)) {
            const start = line.from + m.index! + m[1]!.length;
            decos.push({ from: start, to: start + 3, deco: Decoration.mark({ class: `cm-prio p${m[2]}` }) });
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

  // Follow wiki links with cmd/ctrl+click.
  const linkClick = EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey)) return false;
      const target = (e.target as HTMLElement).closest(".cm-wikilink");
      if (!target) return false;
      const title = target.textContent ?? "";
      view.dom.dispatchEvent(new CustomEvent("basalt-open-link", { bubbles: true, detail: title }));
      return true;
    },
  });

  return [frontmatterCollapse(), blockPreview(), plugin, linkClick];
}
