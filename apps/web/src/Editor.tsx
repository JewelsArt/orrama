import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

/** Markdown highlight tuned to the theme tokens; live-preview styling, source stays visible. */
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.5em", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "1.25em", fontWeight: "650" },
  { tag: tags.heading3, fontSize: "1.1em", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--accent)" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  { tag: tags.quote, color: "var(--text-dim)", fontStyle: "italic" },
  { tag: tags.meta, color: "var(--text-faint)" },
  { tag: tags.processingInstruction, color: "var(--text-faint)" },
]);

export interface EditorProps {
  noteId: string;
  content: string;
  readOnly: boolean;
  /** Titles for [[ autocomplete, usernames for @, tags for #. */
  completions: { titles: string[]; users: string[]; tags: string[] };
  onChange: (content: string) => void;
}

export function Editor({ noteId, content, readOnly, completions, onChange }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const completionsRef = useRef(completions);
  completionsRef.current = completions;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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

    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(mdHighlight),
          autocompletion({ override: [vaultComplete], icons: false }),
          placeholder("Write…"),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "15px" },
            ".cm-scroller": { fontFamily: "var(--font-ui)", lineHeight: "var(--editor-line-height)", padding: "0 4px 40vh" },
            ".cm-content": { caretColor: "var(--accent)", maxWidth: "760px", margin: "0 auto" },
            "&.cm-focused": { outline: "none" },
            ".cm-cursor": { borderLeftColor: "var(--accent)" },
            ".cm-activeLine": { background: "transparent" },
            ".cm-tooltip": {
              background: "var(--bg-raised)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              boxShadow: "var(--shadow)",
            },
            ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--accent-dim)", color: "var(--text)" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => view.destroy();
    // Recreate the editor per note (content prop is initial-only after that).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, readOnly]);

  // External content updates (e.g. checkbox toggled from the note panel) — only
  // apply when the doc actually differs to avoid clobbering the caret.
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== content && !view.hasFocus) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    }
  }, [content]);

  return <div className="editor-host" ref={host} />;
}
