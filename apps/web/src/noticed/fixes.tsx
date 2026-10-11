/**
 * A warning as Orr says it, and its fix (structure.md §2.15, §2.6): the row Orr noticed lists and
 * an entity page puts at its top. Nothing changes until a fix is clicked. A company with no note
 * opens People's New company prefilled; a project's status goes through the project's own PATCH;
 * a tag naming a project with no note creates that project's note; anything else opens the note
 * to change by hand.
 */
import { useState, type ReactNode } from "react";
import type { Me } from "@basalt/schema/responses";
import { api } from "../api.js";
import { StatusMenu } from "../entity/StatusMenu.js";
import { linkTo, notePath, routeOf, type Known } from "../entity/links.js";
import { NewCompany } from "../people/NewDialogs.js";
import { Button, NameLink, Ring, Square } from "../ui/controls.js";
import { Icon } from "../ui/Icon.js";
import { toast } from "../ui/overlays.js";
import { navigate } from "../ui/router.js";
import { statusWord, type Fix, type Item, type Part } from "./model.js";

/** "pitch-deck" → "Pitch deck", when the server's slug of that name is the tag's key again. */
export function projectNameFor(slug: string): string | null {
  const name = slug.replace(/[-_]+/g, " ").trim();
  const words = name.charAt(0).toUpperCase() + name.slice(1);
  const back = words.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return back === slug ? words : null;
}

/** Runs a warning's fix; `dialog` is New company when one is open. */
export function useFixes(me: Me, known: Known | null, done: () => void): { run: (it: Item, fix: Fix, value?: string) => Promise<void>; dialog: ReactNode } {
  const [creating, setCreating] = useState<string | null>(null);
  const openNote = (it: Item) => navigate({ kind: "notes", path: notePath(it.note.path) });
  const run = async (it: Item, fix: Fix, value?: string) => {
    try {
      if (fix.kind === "create-company") return setCreating(fix.name);
      if (fix.kind === "open") return openNote(it);
      if (fix.kind === "create-project") {
        const name = projectNameFor(fix.slug);
        if (!name) return openNote(it);
        await api("POST", "/api/projects", { name });
        toast(`${name} is a project now.`);
        return done();
      }
      const status = fix.kind === "status" ? fix.value : value;
      const project = known?.projects.get(it.note.id);
      if (!status || !project) return openNote(it);
      await api("PATCH", `/api/projects/${encodeURIComponent(project)}`, { status });
      toast(`${it.note.title} is ${statusWord(status)} now.`);
      done();
    } catch {
      toast("That didn't change. The server didn't answer; try again.");
    }
  };
  const dialog =
    creating === null ? null : (
      <NewCompany
        me={me}
        name={creating}
        onClose={() => setCreating(null)}
        onSaved={() => {
          setCreating(null);
          done();
        }}
      />
    );
  return { run, dialog };
}

const leadOf = (type: string, title: string) =>
  type === "person" ? <Ring name={title} small /> : type === "company" ? <Square name={title} small /> : <Icon name={type === "conversation" ? "chat" : type === "project" ? "projects" : "notes"} size={18} />;

/** A sentence whose names open their things (§1.7 #1); on a thing's own page (`self`) its name is just its name. */
export function Sentence({ parts, known, self }: { parts: Part[]; known: Known | null; self?: string }) {
  return (
    <p>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : known && p.note.path && p.note.id !== self ? (
          <NameLink key={i} {...linkTo(routeOf({ id: p.note.id, path: p.note.path, type: p.note.type }, known))}>
            {p.name}
          </NameLink>
        ) : (
          <b key={i}>{p.name}</b>
        ),
      )}
    </p>
  );
}

/** The fixes, as buttons; "Set a status" is the status menu itself when the project is known. */
export function Fixes({ item, known, onFix }: { item: Item; known: Known | null; onFix: (f: Fix, value?: string) => void }) {
  const canStatus = !!known?.projects.has(item.note.id);
  return (
    <div className="acts">
      {item.fixes.map((f) =>
        f.kind === "pick-status" ? (
          canStatus ? (
            <span key={f.label} className="noti-status">
              Set a status: <StatusMenu value={null} canEdit onPick={(id) => onFix(f, id)} />
            </span>
          ) : (
            <Button key={f.label} size="sm" onClick={() => onFix({ kind: "open", label: "Open the note" })}>
              Open the note
            </Button>
          )
        ) : (
          <Button key={f.label} size="sm" kind={f.kind === "open" ? "quiet" : undefined} onClick={() => onFix(f)}>
            {f.label}
          </Button>
        ),
      )}
    </div>
  );
}

/** One row of Orr noticed: what it is about, the sentence, the fix. */
export function NoticeRow({ item, known, onFix }: { item: Item; known: Known | null; onFix: (f: Fix, value?: string) => void }) {
  return (
    <li className="noti-item">
      <span className="noti-lead">{leadOf(item.note.type, item.note.title)}</span>
      <div className="noti-x">
        <Sentence parts={item.parts} known={known} />
        <Fixes item={item} known={known} onFix={onFix} />
      </div>
    </li>
  );
}
