/**
 * The Me page's other tabs (ME): the full tables, readable, each row opening its thing; kept
 * simple, the Overview is the design. Story is every place newest first; Work the projects as
 * tiles grouped by where they were done (a project can sit in two); Skills each with the work
 * that proves it, and what you want to learn; Voice the registers, each with "Try it", the rules Orr
 * writes by and the plain words for finance terms. Work's filter is in the address (`?group=`).
 */
import { useState, type CSSProperties } from "react";
import { Bar } from "../ui/controls.js";
import { navigate } from "../ui/router.js";
import { useLink, useMe } from "./context.js";
import { laneColor, newestFirst, shortOrg, thisMonth, workGroups } from "./model.js";

export function StoryView() {
  const { p, lanes } = useMe();
  return (
    <>
      <div className="me-vh">
        <h2>Story</h2>
        <p>Every place you studied and worked, newest first. Click one to see what came out of it.</p>
      </div>
      <section className="mod">
        {newestFirst(p, thisMonth()).map((e) => (
          <XpRow key={e.key} k={`exp:${e.key}`} period={e.period} role={e.role} org={e.org} what={e.what} color={laneColor(e.lane, lanes)} />
        ))}
      </section>
    </>
  );
}

function XpRow({ k, period, role, org, what, color }: { k: string; period: string; role: string; org: string; what: string; color: string }) {
  const link = useLink(k);
  return (
    <button type="button" {...link} className={`me-xp ${link.className}`} style={{ "--lc": color } as CSSProperties}>
      <span className="w">{period}</span>
      <span>
        <b>{role || shortOrg(org)}</b>
        <span className="me-org">{org}</span>
        {what && <span className="me-what">{what}</span>}
      </span>
    </button>
  );
}

export function WorkView() {
  const { p, g, lanes } = useMe();
  const groups = workGroups(p, g.expsOfProject);
  const [on, setOnState] = useState<string>(() => {
    const want = new URLSearchParams(location.search).get("group");
    return want && (want === "strongest" || groups.some((x) => x.name === want)) ? (want === "strongest" ? "★" : want) : "all";
  });
  const setOn = (v: string) => {
    setOnState(v);
    navigate(v === "all" ? "/me/work" : `/me/work?group=${encodeURIComponent(v === "★" ? "strongest" : v)}`, { replace: true });
  };
  const star = p.projects.some((x) => x.star);
  const shown = p.projects.filter((pr) => on === "all" || (on === "★" ? pr.star : groups.find((x) => x.name === on)?.keys.has(pr.key)));
  return (
    <>
      <div className="me-vh">
        <h2>Work</h2>
        <p>What you built and what it led to. Each one says what can be said outside.</p>
      </div>
      <div className="me-filters" role="radiogroup" aria-label="Show">
        <button type="button" role="radio" aria-checked={on === "all"} className="chip" onClick={() => setOn("all")}>
          All {p.projects.length}
        </button>
        {groups.map((x) => (
          <button key={x.name} type="button" role="radio" aria-checked={on === x.name} className="chip" onClick={() => setOn(x.name)}>
            {x.name}
          </button>
        ))}
        {star && (
          <button type="button" role="radio" aria-checked={on === "★"} className="chip" onClick={() => setOn("★")}>
            The strongest
          </button>
        )}
      </div>
      <div className="me-wk">
        {shown.map((pr) => {
          const k = `project:${pr.key}`;
          return <WorkTile key={pr.key} k={k} color={laneColor(g.laneOf(k), lanes)} when={pr.period} where={g.expsOfProject(pr.key).map((e) => shortOrg(p.experience.find((x) => x.key === e)!.org))[0] ?? pr.partOf[0] ?? ""} name={pr.name} star={pr.star} what={pr.what} outcome={pr.outcome} />;
        })}
      </div>
    </>
  );
}

function WorkTile(props: { k: string; color: string; when: string; where: string; name: string; star: boolean; what: string; outcome: string }) {
  const link = useLink(props.k);
  return (
    <button type="button" {...link} className={`me-wt ${link.className}`} style={{ "--lc": props.color } as CSSProperties}>
      <span className="w">{[props.when, props.where].filter(Boolean).join(" · ")}</span>
      {props.star && <span className="me-strong">Strongest</span>}
      <b>{props.name}</b>
      {props.what && <span className="me-what">{props.what}</span>}
      {props.outcome && <span className="o">{props.outcome}</span>}
    </button>
  );
}

export function SkillsView() {
  const { p, g, open } = useMe();
  return (
    <>
      <div className="me-vh">
        <h2>Skills</h2>
        <p>Each skill with the work that proves it.</p>
      </div>
      <section className="mod">
        {p.skills.map((s) => (
          <div key={s.key} className="me-skr">
            <button type="button" className="me-skn" onClick={() => open(`skill:${s.key}`)}>
              {s.name}
            </button>
            {s.level !== null ? <Bar value={s.level / 10} label={`${s.level} out of 10`} /> : <span className="me-org">Not rated</span>}
            <b>{s.level ?? ""}</b>
            <span className="me-chips">
              {g.projectsOfSkill(s.key).map((x) => (
                <button key={x} type="button" className="chip" onClick={() => open(`project:${x}`)}>
                  {p.projects.find((pr) => pr.key === x)!.name}
                </button>
              ))}
            </span>
          </div>
        ))}
        {p.skillsAlso && <p className="me-also">Also: {p.skillsAlso}</p>}
        {p.skillNotes.map((n) => (
          <p key={n} className="me-also">
            {n}
          </p>
        ))}
      </section>
      {p.growing.length > 0 && (
        <section className="mod">
          <div className="mh">
            <h2>Growing</h2>
          </div>
          <ul className="me-rules">
            {p.growing.map((v) => (
              <li key={v.text}>
                {v.label && <b>{v.label}: </b>}
                {v.text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** A register Orr may try: not one the note says not to write in ("don't write in Dutch for me unless I ask"). */
const tryable = (text: string) => !/\b(don't|do not|never) write\b/i.test(text);

export function VoiceView({ onTry }: { onTry: (register: string) => void }) {
  const { p } = useMe();
  const registers = p.voice.filter((v) => v.label);
  const general = p.voice.filter((v) => !v.label);
  return (
    <>
      <div className="me-vh">
        <h2>Voice</h2>
        <p>How Orr writes when it writes as you.</p>
      </div>
      {general.length > 0 && (
        <section className="mod">
          <ul className="me-rules">
            {general.map((v) => (
              <li key={v.text}>{v.text}</li>
            ))}
          </ul>
        </section>
      )}
      {registers.length > 0 && (
        <div className="me-vc">
          {registers.map((v) => (
            <section key={v.label} className="mod">
              <div className="mh">
                <h2>{v.label}</h2>
                {tryable(v.text) && (
                  <button type="button" className="go me-try" onClick={() => onTry(v.label!)}>
                    Try it
                  </button>
                )}
              </div>
              <p>{v.text}</p>
            </section>
          ))}
        </div>
      )}
      {p.rules.length > 0 && (
        <section className="mod">
          <div className="mh">
            <h2>Rules for outside use</h2>
          </div>
          <ul className="me-rules">
            {p.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      )}
      {p.proofInternal && (
        <section className="mod">
          <div className="mh">
            <h2>Never outside</h2>
          </div>
          <p>{p.proofInternal}</p>
        </section>
      )}
      {p.terms.length > 0 && (
        <section className="mod">
          <div className="mh">
            <h2>In plain words</h2>
            <span className="c">for readers outside finance</span>
          </div>
          <dl className="me-now me-terms">
            {p.terms.map((t) => (
              <div key={t.term}>
                <dt>{t.term}</dt>
                <dd>{t.plain}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </>
  );
}
