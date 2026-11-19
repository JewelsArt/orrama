/**
 * The Me page's Overview (ME, mockup approved 5 Nov 2026): the story full width, then In short
 * (the Clay hero), proof points as tiles, and on the right Check with you, Skills and Who
 * vouches. A section the note doesn't have is not drawn. Colour means the lane: Study, Work and
 * Built take the life-area colours, and whatever belongs to a lane is tinted with it.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { storyOf } from "@orrama/core/persona-graph";
import { Icon } from "../ui/Icon.js";
import { Bar } from "../ui/controls.js";
import { CountUp } from "../ui/CountUp.js";
import { toast } from "../ui/overlays.js";
import { initials } from "../ui/controls.js";
import { useLink, useMe } from "./context.js";
import { laneColor, openQuestions, pitchLanguages, relationOf, thisMonth, vouches } from "./model.js";
import { Story } from "./Story.js";

type Len = "line" | "s30" | "min2";
const LENGTHS: { id: Len; label: string }[] = [
  { id: "line", label: "One line" },
  { id: "s30", label: "30 seconds" },
  { id: "min2", label: "2 minutes" },
];

export function Overview({ notePath, onTab, onOpenNote }: { notePath: string | null; onTab: (t: "story" | "skills") => void; onOpenNote: () => void }) {
  const { p } = useMe();
  const story = useMemo(() => storyOf(p as never, thisMonth()), [p]);
  const proofs = p.proof.slice(0, 6);
  const questions = openQuestions(p);
  const who = vouches(p);
  const skills = [...p.skills].filter((s) => s.level !== null).sort((a, b) => b.level! - a.level!).slice(0, 8);
  const right = questions.length > 0 || skills.length > 0 || who.length > 0;
  return (
    <>
      {story && (
        <section className="mod me-storymod" aria-label="Story">
          <div className="mh">
            <h2>Story</h2>
            <span className="c">
              {story.years[0]!.year} – now
            </span>
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
      <div className={right ? "me-ov" : "me-ov one"}>
        <div className="me-col">
          <InShort />
          {proofs.length > 0 && (
            <section className="mod" aria-label="Proof points">
              <div className="mh">
                <h2>Proof points</h2>
                <span className="c">safe to share</span>
              </div>
              <div className="me-proof">
                {proofs.map((f) => (
                  <ProofTile key={f.key} k={`proof:${f.key}`} number={f.number} what={f.what} />
                ))}
              </div>
            </section>
          )}
        </div>
        {right && (
          <div className="me-col">
            {questions.length > 0 && (
              <section className="mod tiles me-checks" aria-label="Check with you">
                <div className="mh">
                  <h2>Check with you</h2>
                  <span className="c">{questions.length}</span>
                </div>
                {questions.map((q) => (
                  <Question key={q.key} index={q.index} name={q.name} detail={q.detail} />
                ))}
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
            {who.length > 0 && (
              <section className="mod tiles" aria-label="Who vouches">
                <div className="mh">
                  <h2>Who vouches</h2>
                  <span className="c">{who.length}</span>
                </div>
                {who.map((x) => (
                  <PersonRow key={x.key} k={`person:${x.key}`} name={x.name} role={x.role} rel={relationOf(x.how)} />
                ))}
              </section>
            )}
            {notePath && (
              <p className="me-built">
                Orr reads all of this from one note you can edit:{" "}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenNote();
                  }}
                >
                  {notePath.replace(/\.md$/, "").split("/").pop()}
                </a>
                .
              </p>
            )}
          </div>
        )}
      </div>
    </>
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

/** In short: the pitch at three lengths, in each language the note has it. */
function InShort() {
  const { p, open } = useMe();
  const langs = pitchLanguages(p);
  const lens = LENGTHS.filter((l) => Object.keys(p.short[l.id]).length > 0);
  const [len, setLen] = useState<Len>(lens.find((l) => l.id === "s30")?.id ?? lens[0]?.id ?? "s30");
  const [lang, setLang] = useState(langs[0] ?? "EN");
  if (lens.length === 0) return null;
  const text = p.short[len][lang] ?? p.short[len]["EN"] ?? Object.values(p.short[len])[0] ?? "";
  const fallback = !p.short[len][lang];
  return (
    <section className="mod hero me-pitch" aria-label="In short">
      <div className="mh">
        <h2>In short</h2>
        <div className="me-segs">
          <span className="me-seg" role="radiogroup" aria-label="Length">
            {lens.map((l) => (
              <button key={l.id} type="button" role="radio" aria-checked={len === l.id} onClick={() => setLen(l.id)}>
                {l.label}
              </button>
            ))}
          </span>
          {langs.length > 1 && (
            <span className="me-seg" role="radiogroup" aria-label="Language">
              {langs.map((l) => (
                <button key={l} type="button" role="radio" aria-checked={lang === l} onClick={() => setLang(l)}>
                  {l}
                </button>
              ))}
            </span>
          )}
        </div>
      </div>
      <p className="me-pitch-text">{text}</p>
      <div className="me-pitch-foot">
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(
              () => toast("Copied."),
              () => toast("It couldn't be copied. Select the text instead."),
            );
          }}
        >
          Copy
        </button>
        <button type="button" className="btn sm" onClick={() => open("write:")}>
          Use in an email
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
    <button type="button" {...link} className={`me-sk ${link.className}`}>
      <span className="me-sk-x">
        <span className="t">{name}</span>
        <span className="m">{proved.length ? proved.slice(0, 2).join(", ") + (proved.length > 2 ? ` +${proved.length - 2}` : "") : " "}</span>
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
        <span className="m">{role}</span>
      </span>
      <span className="end">
        <span className="r">{rel}</span>
      </span>
    </button>
  );
}

function Question({ index, name, detail }: { index: number; name: string; detail: string }) {
  const { open } = useMe();
  return (
    <button type="button" className="row me-chk" onClick={() => open(`question:${index}`)}>
      <span className="lead">
        <Icon name="warn" size={18} />
      </span>
      <span className="x">
        <span className="t">{name}</span>
        {detail && <span className="m">{detail}</span>}
      </span>
      <span className="end">
        <span className="r">Answer</span>
      </span>
    </button>
  );
}
