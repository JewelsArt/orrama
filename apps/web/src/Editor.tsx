import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { lineHunks } from "@basalt/sync/merge";
import type { NoteSync } from "@basalt/sync/client";
import { useEffect, useRef } from "react";
import { livePreview } from "./livePreview.js";

/**
 * Markdown highlight on Orrama's tokens and the Notes board's type: headings at 26/20/17 px on
 * a 16 px body, ink for text, ultramarine for links, the system mono for code only.
 */
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.625em", fontWeight: "750", lineHeight: "1.3", letterSpacing: "-0.015em" },
  { tag: tags.heading2, fontSize: "1.25em", fontWeight: "750", lineHeight: "1.4" },
  { tag: tags.heading3, fontSize: "1.0625em", fontWeight: "700" },
  { tag: tags.heading4, fontSize: "1em", fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--accent)" },
  { tag: tags.monospace, fontFamily: "var(--mono)", fontSize: "0.88em" },
  { tag: tags.quote, color: "var(--ink-2)", fontStyle: "italic" },
  { tag: tags.meta, color: "var(--ink-3)" },
  { tag: tags.processingInstruction, color: "var(--ink-3)" },
]);

/** Marks a change that came from someone else, so it is not reported as typing. */
const remoteEdit = Annotation.define<boolean>();

export interface EditorProps {
  noteId: string;
  content: string;
  readOnly: boolean;
  /** Titles for [[ autocomplete, usernames for @, tags for #. */
  completions: { titles: string[]; users: string[]; tags: string[] };
  onChange: (content: string) => void;
  /** Called when the user cmd+clicks a [[wiki link]] in the preview, with the link's target as written (not its alias). */
  onFollowLink?: (target: string) => void;
  /**
   * The note's sync. With it, other people's edits arrive through the sync
   * and are applied even while you type, and `content` is only the text to
   * open with. Without it, `content` is re-applied whenever the editor is not
   * focused — the old behaviour, which kept a focused editor's text stale.
   */
  sync?: NoteSync | null;
}

export function Editor({ noteId, content, readOnly, completions, onChange, onFollowLink, sync }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const completionsRef = useRef(completions);
  completionsRef.current = completions;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onFollowLinkRef = useRef(onFollowLink);
  onFollowLinkRef.current = onFollowLink;

  useEffect(() => {
    if (!host.current) return;

    const vaultComplete = (ctx: CompletionContext): CompletionResult | null => {
      const link = ctx.matchBefore(/\[\[([^\[\]]*)$/);
      if (link) {
        return {
          from: link.from + 2,
          options: completionsRef.current.titles.map((t) => ({ label: t, apply: `${t}]]`, type: "class" })),
          validFor: /^[^\[\]]*$/,
        };
      }
      const mention = ctx.matchBefore(/@([\w.-]*)$/);
      if (mention) {
        return {
          from: mention.from + 1,
          options: completionsRef.current.users.map((u) => ({ label: u, type: "constant" })),
          validFor: /^[\w.-]*$/,
        };
      }
      const tag = ctx.matchBefore(/(^|\s)#([\w/-]*)$/);
      if (tag) {
        const hashAt = ctx.state.doc.sliceString(tag.from, ctx.pos).indexOf("#") + tag.from;
        return {
          from: hashAt + 1,
          options: completionsRef.current.tags.map((t) => ({ label: t, type: "keyword" })),
          validFor: /^[\w/-]*$/,
        };
      }
      return null;
    };

    // Start the caret just below the frontmatter so the properties row renders
    // collapsed on open instead of greeting the reader with raw YAML.
    const fmMatch = /^---\n[\s\S]*?\n---\n?/.exec(content);
    const initialPos = Math.min(fmMatch ? fmMatch[0].length : 0, content.length);

    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: content,
        selection: { anchor: initialPos },
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(mdHighlight),
          livePreview({ readOnly }),
          autocompletion({ override: [vaultComplete], icons: false }),
          placeholder("Write…"),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(remoteEdit))) onChangeRef.current(u.state.doc.toString());
          }),
          // The note's type (the Notes board: 16 px on 27 px). The page decides the width and the
          // room below; the editor adds no frame of its own.
          EditorView.theme({
            "&": { height: "100%", fontSize: "16px", color: "var(--ink)" },
            ".cm-scroller": { fontFamily: "var(--font)", lineHeight: "var(--editor-line-height)", padding: "0" },
            ".cm-content": { caretColor: "var(--accent)", padding: "0 0 8px" },
            ".cm-line": { padding: "0" },
            "&.cm-focused": { outline: "none" },
            ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
            ".cm-activeLine": { background: "transparent" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { background: "var(--accent-wash)" },
            ".cm-placeholder": { color: "var(--ink-3)" },
            ".cm-tooltip": {
              background: "var(--surface)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--r-2)",
              boxShadow: "var(--shadow-pop)",
              color: "var(--ink)",
              fontFamily: "var(--font)",
            },
            ".cm-tooltip-autocomplete ul li": { padding: "4px 10px" },
            ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--accent-wash)", color: "var(--ink)" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    const onLink = (e: Event) => onFollowLinkRef.current?.((e as CustomEvent<string>).detail);
    view.dom.addEventListener("basalt-open-link", onLink);

    // Someone else's edit, merged by the sync into what you are typing. Applied
    // as the changed lines only, so the caret and selection map through it,
    // and kept out of undo history: cmd+z undoes your typing, not their edit.
    const detach = sync?.attach((next) => {
      const current = view.state.doc.toString();
      if (current === next) return;
      view.dispatch({
        changes: lineHunks(current, next).map((h) => ({ from: h.start, to: h.end, insert: h.insert })),
        annotations: [remoteEdit.of(true), Transaction.addToHistory.of(false)],
      });
    });
    return () => {
      detach?.();
      view.dom.removeEventListener("basalt-open-link", onLink);
      view.destroy();
    };
    // Recreate the editor per note (content prop is initial-only after that).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, readOnly, sync]);

  // External content updates (e.g. checkbox toggled from the note panel) — only
  // apply when the doc actually differs to avoid clobbering the caret.
  useEffect(() => {
    const view = viewRef.current;
    if (sync) return; // the sync owns the text
    if (view && view.state.doc.toString() !== content && !view.hasFocus) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    }
  }, [content, sync]);

  return <div className="editor-host" ref={host} />;
}
