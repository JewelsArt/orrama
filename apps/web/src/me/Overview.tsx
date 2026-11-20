/**
 * The Me page's Overview (ME, mockup approved 5 Nov 2026): the story full width, then two columns.
 * Left: In short (the Clay hero), what else is true now (a thesis, what you're looking for),
 * every proof point, what others said, and life outside work. Right, in the mockup's order: what
 * Orr still needs to check with you, Skills, and who vouches. A section the note doesn't have is not drawn. Colour
 * means the lane: Study, Work and Built take the life-area colours, and whatever belongs to a lane
 * is tinted with it.
 *
 * Review, 20 Nov: the left column used to end after six proof tiles while the right ran on, so
 * the long lists open short ("Show all") and the left carries the content the note had but the
 * page never showed.
 */
import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { storyOf } from "@orrama/core/persona-graph";
import { Icon } from "../ui/Icon.js";
import { Bar } from "../ui/controls.js";
import { CountUp } from "../ui/CountUp.js";
import { toast } from "../ui/overlays.js";
import { initials } from "../ui/controls.js";
import { navigate } from "../ui/router.js";
import { readJson, writeKey } from "../storage.js";
import { holdForComposer } from "../mail/compose.js";
import { useLink, useMe } from "./context.js";
import { copyText } from "./copy.js";
import { answeredQuestions, laneColor, openQuestions, otherNow, pitchLanguages, relationOf, thisMonth, vouches } from "./model.js";
import { Story } from "./Story.js";

type Len = "line" | "s30" | "min2";
const LENGTHS: { id: Len; label: string }[] = [
  { id: "line", label: "One line" },
  { id: "s30", label: "30 seconds" },
  { id: "min2", label: "2 minutes" },
];
/** How many of a long list show before "Show all". */
const FIRST = { proof: 6, questions: 5 };
const PITCH_KEY = "orrama-me-pitch";

export function Overview({ onTab }: { onTab: (t: "story" | "skills") => void }) {
  const { p } = useMe();
  const story = useMemo(() => storyOf(p as never, thisMonth()), [p]);
  const questions = openQuestions(p);
  const answered = answeredQuestions(p);
  const { vouch, rest } = vouches(p);
  const skills = [...p.skills].filter((s) => s.level !== null).sort((a, b) => b.level! - a.level!).slice(0, 8);
  const now = otherNow(p);
  const [allProof, setAllProof] = useState(false);
  const [allQs, setAllQs] = useState(false);
  const [everyone, setEveryone] = useState(false);
  const proofs = allProof ? p.proof : p.proof.slice(0, FIRST.proof);
  const shownQs = allQs ? questions : questions.slice(0, FIRST.questions);
  const people = vouch.length ? [...vouch, ...(everyone ? rest : [])] : p.people;
  const right = questions.length > 0 || answered.length > 0 || skills.length > 0 || p.people.length > 0;
  const left = Object.values(p.short).some((l) => Object.keys(l).length > 0) || now.length > 0 || p.proof.length > 0 || !!p.proofWords || !!p.interests;
  if (!story && !left && !right) return <EmptyNote />;
  return (
    <>
      {story && (
        <section className="mod me-storymod" aria-label="Story">
          <div className="mh">
            <h2>Story</h2>
            <span className="c">{story.years[0]!.year} – now</span>
            <Legend />
            <a
              className="go"
              href="/me/story"
              onClick={(e) => {
                e.preventDefault();
                onTab("story");
              }}
            >
              Open
            </a>
          </div>
          <Story story={story} />
        </section>
      )}
      <div className={right && left ? "me-ov" : "me-ov one"}>
        {left && (
          <div className="me-col">
            <InShort />
            {now.length > 0 && (
              <section className="mod" aria-label="Now">
                <div className="mh">
                  <h2>Now</h2>
                </div>
                <dl className="me-now">
                  {now.map((n) => (
                    <div key={n.label}>
                      <dt>{n.label}</dt>
                      <dd>{n.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            {p.proof.length > 0 && (
              <section className="mod" aria-label="Proof points">
                <div className="mh">
                  <h2>Proof points</h2>
                  <span className="c">safe to share · {p.proof.length}</span>
                </div>
                <div className="me-proof">
                  {proofs.map((f) => (
                    <ProofTile key={f.key} k={`proof:${f.key}`} number={f.number} what={f.what} />
                  ))}
                </div>
                {p.proof.length > FIRST.proof && <More open={allProof} onToggle={() => setAllProof((x) => !x)} all={`Show all ${p.proof.length}`} />}
              </section>
            )}
            {p.proofWords && (
              <section className="mod" aria-label="What others said">
                <div className="mh">
                  <h2>What others said</h2>
                </div>
                <p className="me-words">{p.proofWords}</p>
              </section>
            )}
            {p.interests && (
              <section className="mod" aria-label="Outside work">
                <div className="mh">
                  <h2>Outside work</h2>
                </div>
                <p className="me-words">{p.interests}</p>
              </section>
            )}
          </div>
        )}
        {right && (
          <div className="me-col">
            {(questions.length > 0 || answered.length > 0) && (
              <section className="mod tiles me-checks" aria-label="Check with you">
                <div className="mh">
                  <h2>Check with you</h2>
                  <span className="c">{questions.length ? questions.length : "all settled"}</span>
                </div>
                {questions.length > 0 && <p className="me-hint">Things your sources disagree on. Until you answer, Orr goes by the first option.</p>}
                {shownQs.map((q) => (
                  <Question key={q.key} index={q.index} name={q.name} detail={q.detail} more={q.evidence.length} />
                ))}
                {questions.length > FIRST.questions && <More open={allQs} onToggle={() => setAllQs((x) => !x)} all={`Show all ${questions.length}`} />}
                {answered.length > 0 && (
                  <details className="me-answered">
                    <summary>Answered ({answered.length})</summary>
                    {answered.map((q) => (
                      <Question key={q.key} index={q.index} name={q.name} detail={q.answer ?? ""} answered />
                    ))}
                  </details>
                )}
              </section>
            )}
            {skills.length > 0 && (
              <section className="mod" aria-label="Skills">
                <div className="mh">
                  <h2>Skills</h2>
                  <span className="c">out of 10</span>
                  <a
                    className="go"
                    href="/me/skills"
                    onClick={(e) => {
                      e.preventDefault();
                      onTab("skills");
                    }}
                  >
                    All
                  </a>
                </div>
                {skills.map((s) => (
                  <SkillRow key={s.key} k={`skill:${s.key}`} name={s.name} level={s.level!} />
                ))}
              </section>
            )}
            {p.people.length > 0 && (
              <section className="mod tiles" aria-label={vouch.length ? "Who vouches" : "People"}>
                <div className="mh">
                  <h2>{vouch.length ? "Who vouches" : "People"}</h2>
                  <span className="c">{vouch.length || p.people.length}</span>
                </div>
                {people.map((x) => (
                  <PersonRow key={x.key} k={`person:${x.key}`} name={x.name} role={x.role} rel={relationOf(x.how)} />
                ))}
                {vouch.length > 0 && rest.length > 0 && <More open={everyone} onToggle={() => setEveryone((x) => !x)} all={`Everyone you work with (${p.people.length})`} />}
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** A note with headings and nothing in them yet ("Start from a blank one"). */
function EmptyNote() {
  const { openNote } = useMe();
  return (
    <section className="mod me-blank">
      <h2>Your note is ready to fill in</h2>
      <p>Write who you are under its headings: what you do now, where you studied and worked, your projects, skills and proof points. Each part shows here as soon as it has something in it.</p>
      <button type="button" className="btn solid" onClick={openNote}>
        <Icon name="pen" size={16} />
        Open the note
      </button>
    </section>
  );
}

function More({ open, onToggle, all }: { open: boolean; onToggle: () => void; all: string }) {
  return (
    <button type="button" className="me-more" aria-expanded={open} onClick={onToggle}>
      {open ? "Show fewer" : all}
    </button>
  );
}

function Legend() {
  const { lanes } = useMe();
  return (
    <span className="me-lgd" aria-hidden="true">
      {lanes.map((l) => (
        <span key={l}>
          <i style={{ "--lc": laneColor(l, lanes) } as CSSProperties} />
          {l}
        </span>
      ))}
    </span>
  );
}

/** Arrow keys move a radio group's choice, as a native one does. */
export function radioKeys(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const at = items.findIndex((b) => b === document.activeElement);
  if (at < 0) return;
  e.preventDefault();
  const next = items[(at + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? items.length - 1 : 1)) % items.length]!;
  next.focus();
  next.click();
}

/** In short: the pitch at three lengths, in each language the note has it; the choice is kept on this device. */
function InShort() {
  const { p, mail } = useMe();
  const langs = pitchLanguages(p);
  const lens = LENGTHS.filter((l) => Object.keys(p.short[l.id]).length > 0);
  const kept = readJson<{ len?: Len; lang?: string }>(PITCH_KEY, {});
  const [len, setLenState] = useState<Len>(lens.find((l) => l.id === kept.len)?.id ?? lens.find((l) => l.id === "s30")?.id ?? lens[0]?.id ?? "s30");
  const [lang, setLangState] = useState(kept.lang && langs.includes(kept.lang) ? kept.lang : (langs[0] ?? "EN"));
  const keep = (next: { len: Len; lang: string }) => writeKey(PITCH_KEY, JSON.stringify(next));
  const setLen = (l: Len) => {
    setLenState(l);
    keep({ len: l, lang });
  };
  const setLang = (l: string) => {
    setLangState(l);
    keep({ len, lang: l });
  };
  if (lens.length === 0) return null;
  const text = p.short[len][lang] ?? p.short[len]["EN"] ?? Object.values(p.short[len])[0] ?? "";
  const fallback = !p.short[len][lang];
  const email = () => {
    // The pitch is already written: it goes straight into the composer, no AI needed.
    if (mail) {
      holdForComposer({ subject: "", body: text });
      navigate("/mail?write=new");
    } else {
      void copyText(text).then((ok) => ok && toast("Copied. Mail isn't connected in Orrama, so paste it where you write."));
    }
  };
  return (
    <section className="mod hero me-pitch" aria-label="In short">
      <div className="mh">
        <h2>In short</h2>
        <div className="me-segs">
          <span className="me-seg" role="radiogroup" aria-label="Length" onKeyDown={radioKeys}>
            {lens.map((l) => (
              <button key={l.id} type="button" role="radio" aria-checked={len === l.id} tabIndex={len === l.id ? 0 : -1} onClick={() => setLen(l.id)}>
                {l.label}
              </button>
            ))}
          </span>
          {langs.length > 1 && (
            <span className="me-seg" role="radiogroup" aria-label="Language" onKeyDown={radioKeys}>
              {langs.map((l) => (
                <button key={l} type="button" role="radio" aria-checked={lang === l} tabIndex={lang === l ? 0 : -1} onClick={() => setLang(l)}>
                  {l}
                </button>
              ))}
            </span>
          )}
        </div>
      </div>
      <p className="me-pitch-text">{text}</p>
      <div className="me-pitch-foot">
        <button type="button" className="btn sm" onClick={() => void copyText(text)}>
          Copy
        </button>
        <button type="button" className="btn sm" onClick={email}>
          {mail ? "Use in an email" : "Copy for an email"}
        </button>
        <span className="me-from">{fallback ? `No ${lang} version yet: this is the English one.` : `From your persona note${p.updated ? ` · ${p.updated}` : ""}`}</span>
      </div>
    </section>
  );
}

function ProofTile({ k, number, what }: { k: string; number: string; what: string }) {
  const { g, lanes } = useMe();
  const link = useLink(k);
  const [title, sub] = what.split(/,\s|\s\(|\s—\s/);
  return (
    <button type="button" {...link} className={`me-pt ${link.className}`} style={{ "--lc": laneColor(g.laneOf(k), lanes) } as CSSProperties}>
      <b>
        <CountUp text={number} />
      </b>
      <span>{title}</span>
      {sub && <small>{sub.replace(/\)$/, "")}</small>}
    </button>
  );
}

function SkillRow({ k, name, level }: { k: string; name: string; level: number }) {
  const { g, p } = useMe();
  const link = useLink(k);
  const proved = g.projectsOfSkill(k.slice(6)).map((x) => p.projects.find((pr) => pr.key === x)!.name);
  return (
    <button type="button" {...link} className={`me-sk ${link.className}`} title={proved.join(", ")}>
      <span className="me-sk-x">
        <span className="t">{name}</span>
        <span className="m">
          {proved.length > 0 && <span className="me-sk-p">{proved.slice(0, 2).join(", ")}</span>}
          {proved.length > 2 && <span className="me-sk-n">+{proved.length - 2}</span>}
        </span>
      </span>
      <Bar value={level / 10} label={`${name}: ${level} out of 10`} />
      <span className="me-lv">{level}</span>
    </button>
  );
}

function PersonRow({ k, name, role, rel }: { k: string; name: string; role: string; rel: string }) {
  const { g, lanes } = useMe();
  const link = useLink(k);
  return (
    <button type="button" {...link} className={`row me-who ${link.className}`} style={{ "--lc": laneColor(g.laneOf(k), lanes) } as CSSProperties}>
      <span className="lead">
        <span className="ring sm" aria-hidden="true">
          {initials(name)}
        </span>
      </span>
      <span className="x">
        <span className="t">{name}</span>
        <span className="m">{[role, rel].filter(Boolean).join(" · ")}</span>
      </span>
    </button>
  );
}

function Question({ index, name, detail, more = 0, answered = false }: { index: number; name: string; detail: string; more?: number; answered?: boolean }) {
  const { open } = useMe();
  return (
    <button type="button" className={answered ? "row me-chk done" : "row me-chk"} onClick={() => open(`question:${index}`)}>
      <span className="lead">
        <Icon name={answered ? "check" : "flag"} size={16} />
      </span>
      <span className="x">
        <span className="t">{name}</span>
        {detail && <span className="m">{detail}</span>}
        {more > 0 && <span className="m me-ev">+ {more === 1 ? "one more thing found" : `${more} more things found`}</span>}
      </span>
      <span className="end">
        <span className="r">{answered ? "Change" : "Answer"}</span>
      </span>
    </button>
  );
}
