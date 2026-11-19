/**
 * The panel beside the Me page (ME): whatever you click opens here, the page stays in use, Esc
 * closes it and Back walks the trail of what you opened (on the phone it fills the screen, as
 * every panel does). A project, a place, a skill, a proof point, a person, an open question,
 * and Write as me. Every chip in it opens its own thing.
 */
import { useState, type ReactNode } from "react";
import type { Contact, PersonaWrite } from "@orrama/schema/responses";
import { api } from "../api.js";
import { Button } from "../ui/controls.js";
import { Bar } from "../ui/controls.js";
import { Icon } from "../ui/Icon.js";
import { Layer, toast } from "../ui/overlays.js";
import { navigate, routeHref } from "../ui/router.js";
import { useWrite } from "../ui/writes.js";
import { slugOf } from "../entity/links.js";
import { holdForComposer } from "../mail/compose.js";
import { useMe } from "./context.js";
import { contactFor, nameOf, pitchLanguages, shortOrg, sourceNote } from "./model.js";

export interface TreeNote {
  id: string;
  path: string;
  title: string;
}

interface SideProps {
  trail: string[];
  onBack: () => void;
  onClose: () => void;
  contacts: Contact[];
  tree: TreeNote[];
  ai: boolean;
  /** An answer was written: the page reads the note again. */
  onAnswered: () => void;
  /** Open Ask Orr with this question typed in. */
  onAsk: (text: string) => void;
}

export function Side({ trail, onBack, onClose, contacts, tree, ai, onAnswered, onAsk }: SideProps) {
  const key = trail[trail.length - 1]!;
  const view = useView(key, { contacts, tree, ai, onAnswered, onAsk, onClose });
  return (
    <Layer kind="panel" label={view.kind} modal={false} trap={false} onClose={onClose} className="ui ui-panel me-side">
      <div className="me-sh">
        {trail.length > 1 && (
          <button type="button" className="btn quiet icon sm" aria-label="Back" onClick={onBack}>
            <Icon name="chev-l" size={16} />
          </button>
        )}
        <span className="me-kind">{view.kind}</span>
        <button type="button" className="btn quiet icon sm" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="me-sb">{view.body}</div>
      {view.foot && <div className="me-sf">{view.foot}</div>}
    </Layer>
  );
}

function Chips({ title, keys }: { title: string; keys: string[] }) {
  const { p, open } = useMe();
  const named = keys.map((k) => ({ k, name: nameOf(p, k) })).filter((x) => x.name);
  if (named.length === 0) return null;
  return (
    <>
      <h4>{title}</h4>
      <div className="me-chips">
        {named.map(({ k, name }) => (
          <button key={k} type="button" className="chip" onClick={() => open(k)}>
            {name}
          </button>
        ))}
      </div>
    </>
  );
}

function NoteLink({ source, tree }: { source: string | null; tree: TreeNote[] }) {
  const note = sourceNote(source, tree);
  if (!note) return source ? <p className="me-org">From {source}</p> : null;
  const to = { kind: "notes" as const, path: note.path.replace(/\.md$/, "") };
  return (
    <a
      className="me-notelink"
      href={routeHref(to)}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      <Icon name="doc" size={15} />
      {note.title}
    </a>
  );
}

const Safe = ({ text }: { text: string }) =>
  text ? (
    <div className="me-safe">
      <b>Outside use</b>
      {text}
    </div>
  ) : null;

function useView(
  key: string,
  ctx: { contacts: Contact[]; tree: TreeNote[]; ai: boolean; onAnswered: () => void; onAsk: (text: string) => void; onClose: () => void },
): { kind: string; body: ReactNode; foot?: ReactNode } {
  const { p, g, open } = useMe();
  const [t, id = ""] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const mailButton = (about: string) => (
    <Button kind="solid" size="sm" icon="pen" onClick={() => open(`write:${about}`)}>
      Use in an email
    </Button>
  );
  const proofsOf = (keys: string[]) => keys.flatMap((k) => g.proofsOf(k)).map((f) => `proof:${f}`);

  if (t === "project") {
    const pr = p.projects.find((x) => x.key === id);
    if (pr) {
      const exps = g.expsOfProject(id);
      return {
        kind: `Project${pr.period ? ` · ${pr.period}` : ""}`,
        foot: mailButton(key),
        body: (
          <>
            <h2>{pr.name}</h2>
            <p className="me-org">{exps.length ? exps.map((e) => nameOf(p, `exp:${e}`)).join(" · ") : pr.partOf.join(" · ") || "On my own time"}</p>
            {pr.what && <p>{pr.what}</p>}
            {(pr.part || pr.outcome) && (
              <div className="me-kv">
                {pr.part && (
                  <>
                    <b>My part</b>
                    <span>{pr.part}</span>
                  </>
                )}
                {pr.outcome && (
                  <>
                    <b>Outcome</b>
                    <span>{pr.outcome}</span>
                  </>
                )}
              </div>
            )}
            <Chips title="Proof" keys={proofsOf([key])} />
            <Chips title="Built with" keys={g.skillsOfProject(id).map((s) => `skill:${s}`)} />
            <Chips title="People" keys={pr.people.map((n) => p.people.find((x) => x.name === n)).filter((x) => !!x).map((x) => `person:${x!.key}`)} />
            <Chips title="Part of" keys={exps.map((e) => `exp:${e}`)} />
            <Safe text={pr.outside} />
            <NoteLink source={pr.source} tree={ctx.tree} />
          </>
        ),
      };
    }
  }
  if (t === "exp") {
    const e = p.experience.find((x) => x.key === id);
    if (e) {
      const prs = g.projectsOfExp(id);
      const people = new Set(prs.flatMap((x) => g.related(`project:${x}`).filter((k) => k.startsWith("person:"))));
      const skills = new Set(prs.flatMap((x) => g.skillsOfProject(x)));
      return {
        kind: `${e.lane}${e.period ? ` · ${e.period}` : ""}`,
        foot: mailButton(key),
        body: (
          <>
            <h2>{e.role || shortOrg(e.org)}</h2>
            <p className="me-org">{e.org}</p>
            {e.what && <p>{e.what}</p>}
            <Chips title="Proof" keys={proofsOf([key, ...prs.map((x) => `project:${x}`)])} />
            <Chips title="Projects" keys={prs.map((x) => `project:${x}`)} />
            <Chips title="Skills used" keys={[...skills].map((s) => `skill:${s}`)} />
            <Chips title="People" keys={[...people]} />
            <NoteLink source={e.source} tree={ctx.tree} />
          </>
        ),
      };
    }
  }
  if (t === "skill") {
    const s = p.skills.find((x) => x.key === id);
    if (s) {
      const prs = g.projectsOfSkill(id);
      return {
        kind: "Skill",
        body: (
          <>
            <h2>{s.name}</h2>
            {s.level !== null ? (
              <>
                <div className="me-lvl">
                  <Bar value={s.level / 10} label={`${s.level} out of 10`} />
                  <b>{s.level}</b>
                </div>
                <p className="me-org">Out of 10, your own rating</p>
              </>
            ) : (
              <p className="me-org">Not rated</p>
            )}
            <Chips title="Proved by" keys={prs.map((x) => `project:${x}`)} />
            <Chips title="Where" keys={[...new Set(prs.flatMap((x) => g.expsOfProject(x)))].map((e) => `exp:${e}`)} />
            <Chips title="Proof" keys={proofsOf(prs.map((x) => `project:${x}`))} />
          </>
        ),
      };
    }
  }
  if (t === "proof") {
    const f = p.proof.find((x) => x.key === id);
    if (f) {
      return {
        kind: "Proof point · safe to share",
        foot: f.source ? mailButton(f.source) : undefined,
        body: (
          <>
            <div className="me-big">{f.number}</div>
            <h2>{f.what}</h2>
            {f.source ? <Chips title="From" keys={[f.source]} /> : <p className="me-org">The note doesn't say where it comes from.</p>}
            <p className="me-note">Orr only quotes numbers from your proof points when it writes as you.</p>
          </>
        ),
      };
    }
  }
  if (t === "person") {
    const h = p.people.find((x) => x.key === id);
    if (h) {
      const page = contactFor(h.name, ctx.contacts);
      const prs = g.projectsOfPerson(id);
      const to = page ? { kind: "person" as const, slug: slugOf(page.path) } : null;
      return {
        kind: "Person",
        foot: to ? (
          <a
            className="btn sm"
            href={routeHref(to)}
            onClick={(e) => {
              e.preventDefault();
              navigate(to);
            }}
          >
            <Icon name="person" size={16} />
            Open their page
          </a>
        ) : undefined,
        body: (
          <>
            <h2>{h.name}</h2>
            {h.role && <p className="me-org">{h.role}</p>}
            {h.how && <p>{h.how}</p>}
            <Chips title="Together on" keys={prs.map((x) => `project:${x}`)} />
            <Chips title="Where" keys={[...new Set(prs.flatMap((x) => g.expsOfProject(x)))].map((e) => `exp:${e}`)} />
          </>
        ),
      };
    }
  }
  if (t === "question") {
    const q = p.questions[Number(id)];
    if (q) return { kind: "Check with you", body: <Answer index={Number(id)} q={q} onAnswered={ctx.onAnswered} onAsk={ctx.onAsk} /> };
  }
  if (t === "write") return { kind: "Write as me", body: <WriteAsMe about={id} ai={ctx.ai} onClose={ctx.onClose} /> };
  return { kind: "Gone", body: <p className="me-org">This isn't in your persona note any more.</p> };
}

function Answer({ index, q, onAnswered, onAsk }: { index: number; q: { raw: string; name: string; detail: string; options: string[]; answer: string | null }; onAnswered: () => void; onAsk: (text: string) => void }) {
  const { draft } = useMe();
  const [text, setText] = useState("");
  const w = useWrite();
  const save = (answer: string) =>
    void w
      .run("The answer wasn't saved.", () => api("POST", "/api/persona/answer", { index, raw: q.raw, answer }))
      .then((ok) => {
        if (!ok) return;
        toast("Saved in your persona note.");
        onAnswered();
      });
  return (
    <>
      <h2>{q.name}</h2>
      {q.detail && <p>{q.detail}</p>}
      {q.answer ? (
        <p className="me-org">Answered: {q.answer}</p>
      ) : draft ? (
        <p className="me-org">Answer it once the draft is kept.</p>
      ) : (
        <>
          <h4>Your answer</h4>
          {q.options.length > 0 && (
            <div className="me-opt">
              {q.options.map((o) => (
                <button key={o} type="button" disabled={w.busy} onClick={() => save(o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <form
            className="me-ans"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) save(text.trim());
            }}
          >
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={q.options.length ? "Or in your own words" : "In your own words"} aria-label="Your answer" />
            <Button type="submit" size="sm" disabled={w.busy || !text.trim()}>
              Save
            </Button>
          </form>
          {w.error && <p className="me-err">{w.error}</p>}
          <p className="me-note">Your answer is written into your persona note, on the question's line, and Orr stops asking.</p>
          <Button size="sm" orr onClick={() => onAsk(`Help me answer this question about me: ${q.name}${q.detail ? `: ${q.detail}` : ""}`)}>
            Talk it over with Orr
          </Button>
        </>
      )}
    </>
  );
}

const AUDIENCES = [
  ["recruiter", "Recruiter"],
  ["lecturer", "Lecturer"],
  ["client", "Client"],
  ["colleague", "Colleague"],
  ["other", "Other"],
] as const;
const LENGTHS = [
  ["line", "One line"],
  ["s30", "30 s"],
  ["min2", "2 min"],
] as const;

export function Seg<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <span className="me-seg2" role="radiogroup" aria-label={label}>
      {items.map(([id, text]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </span>
  );
}

/** Write as me: an email in your voice, from the persona alone, then into Mail's composer. */
function WriteAsMe({ about, ai, onClose }: { about: string; ai: boolean; onClose: () => void }) {
  const { p } = useMe();
  const langs = [...new Set(["EN", ...pitchLanguages(p), "FR"])];
  const [who, setWho] = useState<(typeof AUDIENCES)[number][0]>("recruiter");
  const [len, setLen] = useState<(typeof LENGTHS)[number][0]>("s30");
  const [lang, setLang] = useState("EN");
  const [purpose, setPurpose] = useState("");
  const [out, setOut] = useState<PersonaWrite | null>(null);
  const w = useWrite();
  const aboutName = about ? nameOf(p, about) : "";
  const write = () =>
    void w.run("Orr couldn't write it.", async () => {
      setOut(await api<PersonaWrite>("POST", "/api/persona/write", { kind: "email", audience: who, length: len, language: lang, ...(purpose.trim() ? { purpose: purpose.trim() } : {}), ...(aboutName ? { about: aboutName } : {}) }));
    });
  if (!ai)
    return (
      <>
        <h2>An email in your voice</h2>
        <p>Orr needs AI to write as you.</p>
        <a
          className="me-notelink"
          href="/settings/ai"
          onClick={(e) => {
            e.preventDefault();
            navigate({ kind: "settings", section: "ai" });
          }}
        >
          Connect AI in Settings
        </a>
      </>
    );
  return (
    <>
      <h2>An email in your voice</h2>
      <h4>To</h4>
      <Seg label="To" value={who} items={AUDIENCES} onChange={setWho} />
      <h4>Length and language</h4>
      <div className="me-segrow">
        <Seg label="Length" value={len} items={LENGTHS} onChange={setLen} />
        <Seg label="Language" value={lang} items={langs.map((l) => [l, l] as const)} onChange={setLang} />
      </div>
      {aboutName && (
        <>
          <h4>About</h4>
          <div className="me-chips">
            <span className="chip">{aboutName}</span>
          </div>
        </>
      )}
      <h4>What it's for</h4>
      <input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Ask for an interview, say thank you…" aria-label="What it's for" />
      <div className="me-wacts">
        <Button kind="solid" size="sm" orr disabled={w.busy} onClick={write}>
          {w.busy ? "Writing…" : out ? "Write it again" : "Write it"}
        </Button>
      </div>
      {w.error && <p className="me-err">{w.error}</p>}
      {out && (
        <>
          <h4>Draft</h4>
          {out.subject && <p className="me-subj">{out.subject}</p>}
          <div className="me-draft">{out.text}</div>
          {out.unsourced.length > 0 && (
            <p className="me-err">
              Check before sending: {out.unsourced.join(", ")} {out.unsourced.length === 1 ? "isn't" : "aren't"} in your persona note.
            </p>
          )}
          <p className="me-note">Facts only from your persona note, in your voice.</p>
          <div className="me-wacts">
            <Button
              size="sm"
              onClick={() =>
                void navigator.clipboard?.writeText(out.subject ? `${out.subject}\n\n${out.text}` : out.text).then(
                  () => toast("Copied."),
                  () => toast("It couldn't be copied. Select the text instead."),
                )
              }
            >
              Copy
            </Button>
            <Button
              kind="solid"
              size="sm"
              icon="mail"
              onClick={() => {
                holdForComposer({ subject: out.subject, body: out.text });
                onClose();
                navigate("/mail?write=new");
              }}
            >
              Open in Mail
            </Button>
          </div>
        </>
      )}
    </>
  );
}
