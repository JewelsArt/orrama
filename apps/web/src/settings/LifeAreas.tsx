/**
 * Settings → Notes → Life areas (1D): the person's own areas, in the order Planning, Projects,
 * Notes and the Orrery draw them. Add, rename, move up or down, remove (its notes and projects go
 * to the catch-all, and the Confirm says how many), and, for whoever wants it, the words that
 * also put a note in an area when its folder or tags contain them. One area takes everything
 * else: it can be renamed, never removed. Every change writes the whole list (`PUT /api/areas`),
 * which makes the areas note the first time; the note stays a way in, never the only one.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { LifeAreas as AreasData } from "@orrama/schema/responses";
import { api } from "../api.js";
import { areaColorAt, loadAreas } from "../categories.js";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { Button, Dot } from "../ui/controls.js";
import { Field, Form, Input } from "../ui/fields.js";
import { Icon } from "../ui/Icon.js";
import { Dialog, Menu, toast, type MenuItem } from "../ui/overlays.js";
import { navigate, routeHref, type Route } from "../ui/router.js";
import { Skeleton } from "../ui/states.js";
import { attempt } from "../ui/writes.js";
import { SubHead } from "./parts.js";

type Area = AreasData["areas"][number];
/** One area as it is sent back: `was` is the id it had, so a rename takes its projects. */
interface Draft {
  name: string;
  words: string[];
  catchAll: boolean;
  was?: string;
}

const draftOf = (a: Area): Draft => ({ name: a.name, words: a.words, catchAll: a.catchAll, was: a.id });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const plain = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** "4 notes · 1 project" — the projects counted apart from the other notes. */
export function holds(a: Pick<Area, "notes" | "projects">): string {
  const notes = a.notes - a.projects;
  if (notes === 0 && a.projects === 0) return "Nothing yet";
  return [notes > 0 ? plural(notes, "note") : "", a.projects > 0 ? plural(a.projects, "project") : ""].filter(Boolean).join(" · ");
}

/** What removing an area does, said before it happens: "Its 2 notes and 1 project go to Home." */
export function removalWords(a: Pick<Area, "name" | "notes" | "projects">, rest: string): string {
  if (a.notes === 0) return `Nothing is in ${a.name} yet.`;
  const notes = a.notes - a.projects;
  const what = [notes > 0 ? plural(notes, "note") : "", a.projects > 0 ? plural(a.projects, "project") : ""].filter(Boolean).join(" and ");
  return `Its ${what} ${a.notes === 1 ? "goes" : "go"} to ${rest}. Nothing is deleted.`;
}

export function LifeAreasSection() {
  const [data, setData] = useState<AreasData | null | "failed">(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [wording, setWording] = useState<number | null>(null);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);

  const load = useCallback(
    () =>
      api<AreasData>("GET", "/api/areas")
        .then(setData)
        .catch(() => setData("failed")),
    [],
  );
  useEffect(() => void load(), [load]);

  if (data === null) return <Skeleton rows={2} label="Loading life areas" />;
  if (data === "failed") return <p className="set-help">The life areas couldn't be read. Reload the page to try again.</p>;
  const areas = data.areas;
  const rest = areas.find((a) => a.catchAll)?.name ?? "the rest";

  /** Writes the list; the answer says how many projects moved. Throws, for the dialogs to say why. */
  const save = async (next: Draft[]) => {
    const res = await api<{ projects: number; unmoved: number }>("PUT", "/api/areas", { areas: next, ...(data.note ? { baseHash: data.note.hash } : {}) });
    await Promise.all([load(), loadAreas()]);
    return res;
  };
  const drafts = () => areas.map(draftOf);
  const move = (i: number, by: -1 | 1) =>
    void attempt("The areas weren't reordered.", () => {
      const next = drafts();
      const [a] = next.splice(i, 1);
      next.splice(i + by, 0, a!);
      return save(next);
    });
  const remove = (i: number) => {
    const a = areas[i]!;
    setAsk({
      title: `Remove ${a.name}?`,
      body: removalWords(a, rest),
      confirmLabel: `Remove ${a.name}`,
      danger: true,
      failed: `${a.name} wasn't removed.`,
      onConfirm: async () => {
        const res = await save(drafts().filter((_, k) => k !== i));
        const moved = res.projects > 0 ? ` ${res.projects === 1 ? "Its project is" : `Its ${res.projects} projects are`} in ${rest} now.` : "";
        toast(res.unmoved > 0 ? `${a.name} is gone. ${plural(res.unmoved, "project")} couldn't be moved: open ${res.unmoved === 1 ? "it" : "them"} to pick an area.` : `${a.name} is gone.${moved}`);
      },
    });
  };

  const noteRoute: Route | null = data.note ? { kind: "notes", path: data.note.path.replace(/\.md$/i, "") } : null;
  return (
    <div>
      <SubHead
        aside={
          noteRoute && (
            <a
              className="set-link"
              href={routeHref(noteRoute)}
              onClick={(e) => {
                if (!plain(e)) return;
                e.preventDefault();
                navigate(noteRoute);
              }}
            >
              Open the note
            </a>
          )
        }
      >
        Life areas
      </SubHead>
      <div className="set-rows" role="list" aria-label="Life areas">
        {areas.map((a, i) => (
          <AreaRow
            key={a.id}
            area={a}
            color={areaColorAt(i)}
            canEdit={data.canEdit}
            first={i === 0}
            last={i === areas.length - 1}
            onRename={() => setRenaming(i)}
            onWords={() => setWording(i)}
            onMove={(by) => move(i, by)}
            onRemove={() => remove(i)}
          />
        ))}
      </div>
      {data.canEdit && (
        <div className="set-actions">
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add an area
          </Button>
        </div>
      )}
      <p className="set-help">
        Planning, Projects and Notes show your areas in this order, the first five each in its own colour. A project picks its area in its
        header; anything else is in {rest} unless an area's words say otherwise.
      </p>

      {adding && (
        <NameAreaDialog
          title="Add an area"
          confirm="Add"
          initial=""
          onClose={() => setAdding(false)}
          onSubmit={async (name) => {
            // A new area goes just above the catch-all, which usually closes the list.
            const next = drafts();
            const at = next.findIndex((d) => d.catchAll);
            next.splice(at === next.length - 1 ? at : next.length, 0, { name, words: [], catchAll: false });
            await save(next);
          }}
        />
      )}
      {renaming !== null && areas[renaming] && (
        <NameAreaDialog
          title={`Rename ${areas[renaming]!.name}`}
          confirm="Rename"
          initial={areas[renaming]!.name}
          help={areas[renaming]!.projects > 0 ? `Its ${plural(areas[renaming]!.projects, "project")} keep${areas[renaming]!.projects === 1 ? "s" : ""} the area under its new name.` : undefined}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            const next = drafts();
            next[renaming] = { ...next[renaming]!, name };
            await save(next);
          }}
        />
      )}
      {wording !== null && areas[wording] && (
        <WordsDialog
          area={areas[wording]!}
          onClose={() => setWording(null)}
          onSubmit={async (words) => {
            const next = drafts();
            next[wording] = { ...next[wording]!, words };
            await save(next);
          }}
        />
      )}
      <Confirm request={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

function AreaRow({
  area,
  color,
  canEdit,
  first,
  last,
  onRename,
  onWords,
  onMove,
  onRemove,
}: {
  area: Area;
  color: string;
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onRename: () => void;
  onWords: () => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  const items: (MenuItem | "-")[] = [
    { label: "Rename…", icon: <Icon name="pen" size={16} />, onSelect: onRename },
    ...(area.catchAll ? [] : [{ label: "Words…", icon: <Icon name="tag" size={16} />, onSelect: onWords }]),
    "-",
    { label: "Move up", icon: <Icon name="up" size={16} />, disabled: first, onSelect: () => onMove(-1) },
    { label: "Move down", icon: <Icon name="down" size={16} />, disabled: last, onSelect: () => onMove(1) },
    ...(area.catchAll ? [] : (["-", { label: `Remove ${area.name}…`, icon: <Icon name="trash" size={16} />, danger: true, onSelect: onRemove }] as const)),
  ];
  const words = area.catchAll ? "Everything no other area takes" : area.words.length ? `Also notes with ${area.words.join(", ")}` : null;
  return (
    <div className="set-fact set-arow" role="listitem">
      <Dot color={color} />
      <span>
        <b>{area.name}</b>
        <small>
          {" "}
          · {holds(area)}
          {words && <span className="set-awords"> · {words}</span>}
        </small>
      </span>
      {canEdit ? (
        <>
          <Button ref={at} kind="quiet" size="sm" icon="dots" aria-label={`Change ${area.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
          {open && <Menu anchor={at} label={area.name} onClose={() => setOpen(false)} items={items} align="end" />}
        </>
      ) : (
        <span />
      )}
    </div>
  );
}

/** A name for an area, new or renamed: one field, the server's refusal under it. */
function NameAreaDialog({ title, confirm, initial, help, onSubmit, onClose }: { title: string; confirm: string; initial: string; help?: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const same = name.trim() === initial.trim();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "That didn't work. Try again.");
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <Form
        onSubmit={() => void submit()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={busy || !name.trim() || same}>
              {confirm}
            </Button>
          </>
        }
      >
        <Field label="What is the area called?" help={help} error={error}>
          <Input
            data-autofocus
            value={name}
            placeholder="Family"
            maxLength={40}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </Field>
      </Form>
    </Dialog>
  );
}

/** An area's words: a list, one removed with its button, one added with the field. */
function WordsDialog({ area, onSubmit, onClose }: { area: Area; onSubmit: (words: string[]) => Promise<void>; onClose: () => void }) {
  const [words, setWords] = useState(area.words);
  const [word, setWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = () => {
    const w = word.trim();
    if (!w) return;
    if (!words.some((x) => x.toLowerCase() === w.toLowerCase())) setWords([...words, w]);
    setWord("");
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(word.trim() && !words.includes(word.trim()) ? [...words, word.trim()] : words);
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "That didn't work. Try again.");
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Words for ${area.name}`} onClose={onClose}>
      <Form
        onSubmit={() => void submit()}
        actions={
          <>
            <Button kind="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="solid" disabled={busy}>
              Save
            </Button>
          </>
        }
      >
        <p className="set-help set-lead">Also put notes in {area.name} when their folder or tags contain one of these words. A project's own area always wins.</p>
        {words.length > 0 && (
          <ul className="set-words" aria-label={`Words for ${area.name}`}>
            {words.map((w) => (
              <li key={w}>
                <span>{w}</span>
                <Button kind="quiet" size="sm" icon="x" aria-label={`Remove ${w}`} onClick={() => setWords(words.filter((x) => x !== w))} />
              </li>
            ))}
          </ul>
        )}
        <div className="set-add">
          <Field label="Add a word" error={error}>
            <Input
              data-autofocus
              value={word}
              placeholder="recipes"
              maxLength={80}
              onChange={(e) => {
                setWord(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                add();
              }}
            />
          </Field>
          <Button size="sm" onClick={add} disabled={!word.trim()}>
            Add
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
