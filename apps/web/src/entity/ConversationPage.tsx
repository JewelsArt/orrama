/**
 * A saved conversation's entity page (structure.md §2.6): its title, date, length and with whom;
 * what it is about (the graph's `about`, links on a vault without an ontology); who mentions it;
 * then the transcript as speaker turns, never as `**Jules:**` markup. A note that has no turns
 * is shown in the editor like any note.
 */
import type { Me, TreeNote } from "@orrama/schema/responses";
import { Icon } from "../ui/Icon.js";
import { LinkButton } from "../ui/controls.js";
import { dateLabel } from "../ui/dates.js";
import { EntityHeader } from "./EntityHeader.js";
import { WarningsBox, orreryRoute, plainLinks } from "./shared.js";
import { useNotesTick, type KnownData } from "./known.js";
import { anchor, linkTo, notePath, type Known } from "./links.js";
import { relationGroups, turnsOf, wordsIn } from "./model.js";
import { Facts, NoteBlock, RelationsBlock, Turns, useAreaColor, useHref, useNote, type FactItem } from "./parts.js";
import { useRelations } from "./relations.js";
import { folderName } from "../notes/read.js";

/** The front matter's `date:` (YYYY-MM-DD), read off the note's text. */
export function dateOf(content: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const m = fm && /^date:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(fm[1]!);
  return m ? m[1]! : null;
}

/** The text after the front matter. */
const bodyOf = (content: string) => content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ConversationPage({ me, note: tn, data, known }: { me: Me; note: TreeNote; data: KnownData; known: Known }) {
  const [tick, bump] = useNotesTick();
  const rel = useRelations(tn.id, tick);
  const { note, sync, state } = useNote(tn.id);
  const hrefOf = useHref(data, known);
  const colorOf = useAreaColor(data);
  const turns = note ? turnsOf(bodyOf(note.content)) : [];
  const date = note ? dateOf(note.content) : null;
  const you = me.displayName.split(/\s+/)[0] ?? "";
  // Who else speaks: Claude, mostly. You are the account's first name, or "Jules", whose turns
  // the saved transcripts carry (core describe.ts reads the same speaker as the opening one).
  const others = [...new Set(turns.map((t) => t.speaker).filter((s) => s.toLowerCase() !== you.toLowerCase() && s.toLowerCase() !== "jules"))];
  const { mentions, links } = plainLinks(note, data, known);
  const groups = relationGroups({ relations: rel.by, mentions, links });
  const about = rel.by.get("about") ?? [];

  const facts: FactItem[] = [];
  if (about.length) facts.push({ k: "About", v: <span className="ent-list">{about.map((b) => <a key={b.id} className="ent-v" {...anchor(linkTo(hrefOf(b) ?? { kind: "notes", id: b.id }))}>{b.title}</a>)}</span> });
  if (date) facts.push({ k: "Date", v: <b>{dateLabel(date)}</b> });
  if (turns.length) facts.push({ k: "Length", v: <b>{`${plural(turns.length, "turn")} · ${plural(wordsIn(turns), "word")}`}</b> });
  facts.push({ k: "Folder", v: <b>{tn.folder ? tn.folder.split("/").map(folderName).join(" / ") : "The top of your notes"}</b> });

  const meta = [date ? dateLabel(date) : null, turns.length ? plural(turns.length, "turn") : null, others.length ? `with ${others.join(" and ")}` : null].filter(Boolean).join(" · ");

  return (
    <div className="ui ent-page ent-conversation">
      <EntityHeader
        crumbs={[{ label: "Notes", ...linkTo({ kind: "notes" }) }, { label: tn.title }]}
        lead={
          <span className="ent-badge" aria-hidden="true">
            <Icon name="chat" size={22} />
          </span>
        }
        title={tn.title}
        meta={meta ? <span className="ent-sub">{meta}</span> : undefined}
        actions={
          <>
            <LinkButton className="ent-wide" icon="orbit" {...anchor(linkTo(orreryRoute(tn.path)))}>
              Show in the Orrery
            </LinkButton>
            <LinkButton icon="notes" aria-label="Open the note" data-tip="Open the note" {...anchor(linkTo({ kind: "notes", path: notePath(tn.path) }))} />
          </>
        }
      />
      <div className="ent-cols">
        <div className="ent-main">
          <Facts items={facts} />
          <RelationsBlock title="What it's about" groups={groups} hrefOf={hrefOf} colorOf={colorOf} plain={rel.by.size === 0} />
        </div>
        <aside className="ent-side">
          <WarningsBox me={me} id={tn.id} tick={tick} known={known} onFixed={bump} />
        </aside>
        <div className="ent-notecol">{turns.length > 0 ? <Turns turns={turns} you={you || "Jules"} /> : <NoteBlock title="The note" note={note} sync={sync} state={state} data={data} known={known} />}</div>
      </div>
    </div>
  );
}
