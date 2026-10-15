/**
 * Find (⌘K; structure.md §2.12, board mockups/screens/find.html): typed results in groups —
 * places and actions, people, companies, projects, notes and conversations, settings — each with
 * its ring, square, progress ring or icon, its name, one line, and its type. Keyboard first:
 * arrows move, Enter opens, Tab cycles the type ("Any type", Person, Company…), and a type typed
 * first ("person ines") narrows to it. Picking a project opens the project, not its note. An
 * empty query offers what you opened lately and the places and actions, with Orr searching; a
 * query that finds nothing gets his shrug.
 *
 * Notes come from the server's search (`/api/vault/search`, which reads their text and keeps the
 * `tag:` `path:` `task:` `assignee:` filters); everything else from the lists the app reads
 * (People's, the Projects board's, the vault's map, R1's SETTINGS_INDEX).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PeopleContext, SearchHit } from "@orrama/schema/responses";
import { api, unlessAborted, type Me } from "../api.js";
import { useKnown, useLoad } from "../entity/known.js";
import { blankNote, createNote } from "../newNote.js";
import { findSettings, SECTIONS, SETTINGS_INDEX } from "../settings/parts.js";
import { readJson, writeKey } from "../storage.js";
import { Button, Kbd, ProgressRing, Ring, Square } from "../ui/controls.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { NameDialog } from "../ui/NameDialog.js";
import { Orr, HeadMark } from "../ui/orr/Orr.js";
import { Palette } from "../ui/overlays.js";
import { navigate, routeHref, type SettingsSection } from "../ui/router.js";
import { actionItems, entityItems, noteItems, placeItems, settingItems, type ActionDef, type Lists } from "./build.js";
import { flat, groupsOf, isFilterQuery, markOf, nextType, parseQuery, remember, TYPE_WORD, type FindType, type Group, type Item, type Lead, type Recent } from "./model.js";

const RECENT_KEY = "orrama-find-recent";

/** Tomorrow, as Planning's day address takes it. */
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export interface FindProps {
  me: Me;
  /** The theme on screen, so the action says which way it switches. */
  shown: "light" | "dark";
  onClose: () => void;
  onTheme: (choice: "light" | "dark") => void;
  onCapture: () => void;
  onAsk: () => void;
}

function LeadMark({ lead }: { lead: Lead }) {
  if (lead.kind === "ring") return <Ring name={lead.of} />;
  if (lead.kind === "square") return <Square name={lead.of} />;
  if (lead.kind === "progress") return <ProgressRing value={lead.value ?? 0} size={26} />;
  return (
    <span className="ic">
      <Icon name={lead.of as IconName} size={18} />
    </span>
  );
}

function Title({ title, words }: { title: string; words: string[] }) {
  const m = markOf(title, words);
  if (!m) return <span className="t">{title}</span>;
  return (
    <span className="t">
      {m[0]}
      <mark>{m[1]}</mark>
      {m[2]}
    </span>
  );
}

export function Find({ me, shown, onClose, onTheme, onCapture, onAsk }: FindProps) {
  const [q, setQ] = useState("");
  const [type, setType] = useState<FindType | null>(null);
  const [sel, setSel] = useState(0);
  const [naming, setNaming] = useState(false);
  const [recent, setRecent] = useState<Recent[]>(() => {
    const r = readJson<unknown>(RECENT_KEY, []);
    return Array.isArray(r) ? (r as Recent[]).slice(0, 6) : [];
  });
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { data } = useKnown();
  const ctx = useLoad((signal) => api<PeopleContext>("GET", "/api/people/context", undefined, { signal }), []);

  const filter = isFilterQuery(q);
  const parsed = parseQuery(filter ? "" : q, type);
  const words = parsed.words;
  const asked = filter ? q.trim() : parsed.raw;
  const kind = filter ? "note" : parsed.type;

  // Notes: the server's search. The debounce drops keystrokes not yet sent; the abort drops a
  // search already sent, so "ab"'s results cannot land after "abc"'s.
  const [hits, setHits] = useState<{ for: string; hits: SearchHit[] } | null>(null);
  const wantsNotes = !!asked && (!kind || kind === "note" || kind === "conversation");
  useEffect(() => {
    if (!wantsNotes) return setHits(null);
    const ac = new AbortController();
    const t = setTimeout(() => {
      api<SearchHit[]>("GET", `/api/vault/search?q=${encodeURIComponent(asked)}`, undefined, { signal: ac.signal }).then((res) => setHits({ for: asked, hits: res }), unlessAborted);
    }, 120);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [asked, wantsNotes]);

  const actions = useMemo<ActionDef[]>(() => {
    const out: ActionDef[] = [
      { id: "new-note", title: "New note", meta: "A note, named with its folder", icon: "plus", words: "create add page write" },
      { id: "new-task", title: "New task", meta: "One line into your inbox, with a date if you type one", icon: "inbox", words: "capture todo step add" },
      { id: "plan-tomorrow", title: "Plan tomorrow", meta: "Tomorrow in Planning, hour by hour", icon: "calendar", words: "planning day schedule" },
      { id: "theme", title: shown === "dark" ? "Switch to light" : "Switch to dark", meta: "On every device you sign in on", icon: shown === "dark" ? "sun" : "moon", words: "theme dark light night day mode appearance" },
      { id: "orrery", title: "Open the Orrery", meta: "Your notes as a map, Orr in the middle", icon: "orbit", words: "map graph" },
      { id: "ask", title: "Ask Orr", meta: "A question about your notes", icon: "ask", words: "question chat ai" },
    ];
    if (me.isOwner) out.splice(4, 0, { id: "settings-ai", title: "Open Settings → Orr & AI", meta: "The model Orr uses and its key", icon: "settings", words: "ai model key provider" });
    return out;
  }, [shown, me.isOwner]);

  const groups = useMemo<Group[]>(() => {
    const lists: Lists | null = data ? { ...data, context: ctx.state === "ok" ? ctx.data : null } : null;
    const want = (t: FindType) => !kind || kind === t;
    // Nothing typed: what you opened lately, the places, the things to do.
    if (!asked && !kind) {
      const out: Group[] = [];
      if (recent.length) out.push({ id: "recent", label: "Recent", note: "", items: recent.map((r) => ({ ...r, score: 1 })) });
      out.push({ id: "places", label: "Places", note: "", items: placeItems([]) });
      out.push({ id: "actions", label: "Actions", note: "", items: actionItems([], actions).filter((a) => a.action !== "ask") });
      return out;
    }
    const items: Item[] = [];
    let via: Record<string, string> = {};
    if (lists && !filter) {
      // A type with nothing typed lists that type, by name.
      if (words.length === 0) {
        // A type picked, nothing typed: every one of that type, by name.
        items.push(...entityItems([""], lists).items.filter((i) => i.type === kind).map((i) => ({ ...i, score: 1, via: undefined })));
      } else {
        const ent = entityItems(words, lists);
        via = ent.via;
        items.push(...ent.items.filter((i) => want(i.type)));
      }
    }
    if (!filter) {
      if (want("place")) items.push(...placeItems(words));
      if (want("setting")) {
        const visible = new Set<SettingsSection>(SECTIONS.filter((s) => (s.id === "ai" ? me.isOwner : s.id !== "access")).map((s) => s.id));
        const found = words.length ? findSettings(words.join(" "), visible) : SETTINGS_INDEX.filter((x) => visible.has(x.section));
        items.push(...settingItems(words, found.map((s) => ({ ...s, sectionLabel: SECTIONS.find((x) => x.id === s.section)!.label }))));
      }
      if (want("action")) items.push(...actionItems(words, actions));
    }
    if (lists && hits && hits.for === asked && (kind === null || kind === "note" || kind === "conversation")) {
      const taken = new Set(items.map((i) => i.key));
      items.push(...noteItems(hits.hits, lists, taken, words).filter((i) => want(i.type)));
    }
    // The best person, company, project or note found can be shown in the Orrery.
    const top = [...items].filter((i) => i.route && ["person", "company", "project", "note", "conversation"].includes(i.type)).sort((a, b) => b.score - a.score)[0];
    if (top?.route && want("action")) {
      const center = top.route.kind === "project" ? top.route.slug : routeHref(top.route).split("/").pop()!.split("?")[0]!;
      items.push({ key: `action:orrery:${top.key}`, type: "action", title: `Show ${top.title} in the Orrery`, meta: `Steps, with ${top.title} in the middle`, lead: { kind: "icon", of: "orbit" }, route: { kind: "orrery", center: decodeURIComponent(center) }, score: 0.5 });
    }
    return groupsOf(items, { limit: kind ? undefined : 5, viaNote: via });
  }, [data, ctx, asked, kind, words, filter, hits, recent, actions, me.isOwner]);

  const rows = flat(groups);
  const loading = !!asked && wantsNotes && (!hits || hits.for !== asked);
  useEffect(() => setSel(0), [q, type]);
  const current = rows[Math.min(sel, rows.length - 1)];
  const optionId = (i: number) => `${listId}-o${i}`;
  useEffect(() => {
    document.getElementById(optionId(sel))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const makeNote = async (name: string) => {
    if (name.endsWith("/")) throw new Error("Add the note's name after the folder.");
    const path = name.endsWith(".md") ? name : `${name}.md`;
    // Create-only: a note already at this path is a 409, said under the field, never replaced.
    const res = await createNote(path, blankNote(path.split("/").pop()!.replace(/\.md$/, "")));
    onClose();
    navigate({ kind: "notes", id: res.id });
  };

  const pick = (it: Item | undefined) => {
    if (!it) return;
    if (it.route) {
      const next = remember(recent, it);
      setRecent(next);
      writeKey(RECENT_KEY, JSON.stringify(next));
      onClose();
      navigate(it.route);
      return;
    }
    switch (it.action) {
      case "new-note":
        return setNaming(true);
      case "new-task":
        return onCapture();
      case "plan-tomorrow":
        onClose();
        return navigate({ kind: "planning", scale: "day", at: tomorrow() });
      case "theme":
        onClose();
        return onTheme(shown === "dark" ? "light" : "dark");
      case "settings-ai":
        onClose();
        return navigate({ kind: "settings", section: "ai" });
      case "orrery":
        onClose();
        return navigate({ kind: "orrery" });
      case "ask":
        return onAsk();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(current);
    } else if (e.key === "Tab") {
      e.preventDefault();
      setType((t) => nextType(t, e.shiftKey));
    } else if (e.key === "Backspace" && !q && type) {
      setType(null);
    }
  };

  if (naming) return <NameDialog title="New note" label="Path" help="A folder and a name, like Ideas/Reading list" onSubmit={makeNote} onClose={onClose} />;

  let n = -1;
  return (
    <Palette label="Find" onClose={onClose}>
      <div className="find-in">
        <Icon name="search" size={18} />
        <input
          ref={input}
          autoFocus
          role="combobox"
          aria-label="Find"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={current ? optionId(Math.min(sel, rows.length - 1)) : undefined}
          aria-autocomplete="list"
          placeholder="Find a person, a project, a note, a setting…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <button type="button" className="find-type" aria-label={`Type: ${type ? TYPE_WORD[type] : "any"}. Change it`} onClick={() => setType((t) => nextType(t))}>
          {type ? TYPE_WORD[type] : parsed.type && !filter ? TYPE_WORD[parsed.type] : "Any type"} <Kbd>Tab</Kbd>
        </button>
        <button type="button" className="find-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
      <div className="find-res" id={listId} role="listbox" aria-label="Results">
        {!asked && !kind && (
          <div className="find-hello">
            <span className="orrbox">
              <Orr pose="search" size={48} />
            </span>
            <span>Find a person, a company, a project, a note, a setting, or something to do.</span>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.id} role="group" aria-label={g.label}>
            <div className="find-h" aria-hidden="true">
              {g.label} {g.note && <span>{g.note}</span>}
            </div>
            {g.items.map((it) => {
              n += 1;
              const i = n;
              const on = i === sel;
              return (
                <div
                  key={it.key}
                  id={optionId(i)}
                  role="option"
                  aria-selected={on}
                  className={`find-row${on ? " sel" : ""}`}
                  onMouseMove={() => sel !== i && setSel(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(it)}
                >
                  <span className="lead">
                    <LeadMark lead={it.lead} />
                  </span>
                  <span className="x">
                    <Title title={it.title} words={words} />
                    <span className="m">
                      {it.meta}
                      {it.folder && <span className="find-folder"> · {it.folder}</span>}
                    </span>
                  </span>
                  <span className="ty">
                    {TYPE_WORD[it.type]}
                    {on && it.type === "project" && " · opens the project"}
                    {it.keycap && <Kbd>{it.keycap}</Kbd>}
                    {on && <Kbd>Enter</Kbd>}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {!!asked && !loading && rows.length === 0 && (
          <div className="find-none">
            <Orr pose="shrug" size={64} />
            <p>
              Nothing {kind ? `of type ${TYPE_WORD[kind].toLowerCase()} ` : ""}called “{asked}”.
            </p>
            <Button size="sm" orr onClick={onAsk}>
              Ask Orr instead
            </Button>
          </div>
        )}
      </div>
      <div className="find-ft" aria-hidden="true">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span>
          <Kbd>Enter</Kbd> open
        </span>
        <span>
          <Kbd>Tab</Kbd> type: person, company, project…
        </span>
        <span className="sp" />
        <button type="button" tabIndex={-1} onClick={onAsk}>
          <HeadMark size={14} />
          <Kbd>⌘J</Kbd> ask Orr instead
        </button>
      </div>
    </Palette>
  );
}
