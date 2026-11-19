/**
 * The Me page with no persona note (ME, Jules 5 Nov: "a button if it has never been generated
 * before … it needs to use AI, so the person needs to have used it before"). One card: Orr
 * reading, what he reads as switches with real counts, the two things Generate needs (AI, and
 * enough to read: at least 3 projects or 20 notes), each said with its fix, Generate my persona
 * and Start from a blank one. While Orr writes, the steps with Stop; you can leave the page and
 * are told when the draft is ready (generation.ts). Then what he found, and Review the draft.
 */
import { useState } from "react";
import type { PersonaData, PersonaJob } from "@orrama/schema/responses";
import { Button } from "../ui/controls.js";
import { Switch } from "../ui/fields.js";
import { Icon } from "../ui/Icon.js";
import { Orr } from "../ui/orr/Orr.js";
import { navigate } from "../ui/router.js";

export type Sources = { projects: boolean; notes: boolean; people: boolean; chats: boolean };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const PROVIDER: Record<string, string> = { chatgpt: "ChatGPT", anthropic: "Anthropic", google: "Gemini", "openai-compatible": "your own AI server" };

export function Empty({
  data,
  job,
  busy,
  error,
  onGenerate,
  onBlank,
  onStop,
  onAgain,
  onReview,
}: {
  data: PersonaData;
  job: PersonaJob;
  busy: boolean;
  error: string | null;
  onGenerate: (s: Sources) => void;
  onBlank: () => void;
  onStop: () => void;
  onAgain: () => void;
  onReview: () => void;
}) {
  const [on, setOn] = useState<Sources>({ projects: true, notes: true, people: true, chats: false });
  const s = data.sources!;
  const rows: { id: keyof Sources; name: string; count: string; none: boolean }[] = [
    { id: "projects", name: "Projects", count: plural(s.projects, "project", "projects"), none: s.projects === 0 },
    { id: "notes", name: "Notes", count: plural(s.notes, "note", "notes"), none: s.notes === 0 },
    { id: "people", name: "People", count: s.people ? plural(s.people, "person or company", "people and companies") : "none yet", none: s.people === 0 },
    { id: "chats", name: "Saved chats", count: s.chats ? plural(s.chats, "conversation", "conversations") : "none yet", none: s.chats === 0 },
  ];
  const enough = (on.projects ? s.projects : 0) >= 3 || (on.notes ? s.notes : 0) >= 20;
  const ready = data.ai.configured && enough;

  let body;
  if (job?.state === "running") {
    body = (
      <>
        <h2>Orr is writing your page</h2>
        <p>You can keep using Orrama. Orr tells you when the draft is ready.</p>
        <ol className="me-steps" aria-label="Steps">
          {job.steps
            .filter((x) => x.state !== "skipped")
            .map((x) => (
              <li key={x.id} className={x.state}>
                <Icon name={x.state === "done" ? "check" : x.state === "running" ? "progress" : "clock"} size={18} />
                <span>{x.label}</span>
                <small>{x.state === "done" && x.ms !== null ? `${Math.max(1, Math.round(x.ms / 1000))} s` : ""}</small>
              </li>
            ))}
        </ol>
        <div className="me-gacts">
          <Button kind="quiet" onClick={onStop}>
            Stop
          </Button>
        </div>
      </>
    );
  } else if (job?.state === "done" && job.found) {
    const f = job.found;
    body = (
      <>
        <h2>Your draft is ready</h2>
        <p>Orr found this. Check it on the page: nothing is saved until you keep it, and what Orr couldn't settle waits in Check with you.</p>
        <div className="me-found">
          <span>{plural(f.places, "place", "places")}</span>
          <span>{plural(f.projects, "project", "projects")}</span>
          <span>{plural(f.skills, "skill", "skills")}</span>
          <span>{plural(f.proof, "proof point", "proof points")}</span>
          <span>{plural(f.people, "person", "people")}</span>
          <span>{plural(f.questions, "question for you", "questions for you")}</span>
        </div>
        <div className="me-gacts">
          <Button kind="solid" icon="eye" onClick={onReview}>
            Review the draft
          </Button>
          <Button onClick={onAgain}>Start again</Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <h2>Let Orr write your page</h2>
        <p>
          Orr reads what is already in Orrama and drafts who you are: your experience, projects, skills, proof points, the people you work with and how you write. You check the draft before anything is
          saved, and you can change any line later.
        </p>
        {job && job.state !== "done" && <p className="me-err">{job.state === "stopped" ? "You stopped Orr. Nothing was saved." : `Orr couldn't finish. ${job.error ?? ""}`}</p>}
        <h4>What Orr reads</h4>
        <div className="me-srcs">
          {rows.map((r) => (
            <div key={r.id} className={on[r.id] && !r.none ? "me-src" : "me-src off"}>
              <span>
                <b>{r.name}</b>
                <small>{r.count}</small>
              </span>
              {!r.none && <Switch checked={on[r.id]} label={r.name} onChange={(v) => setOn({ ...on, [r.id]: v })} />}
            </div>
          ))}
        </div>
        <div className="me-need">
          {data.ai.configured ? (
            <div className="ok">
              <Icon name="check" size={18} />
              AI is set up{data.ai.provider && PROVIDER[data.ai.provider] ? `: ${PROVIDER[data.ai.provider]}` : ""}
            </div>
          ) : (
            <div className="no">
              <Icon name="warn" size={18} />
              <span>
                Orr needs AI to write this.{" "}
                <a
                  href="/settings/ai"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate({ kind: "settings", section: "ai" });
                  }}
                >
                  Connect AI in Settings
                </a>
              </span>
            </div>
          )}
          {enough ? (
            <div className="ok">
              <Icon name="check" size={18} />
              Enough to read: {plural(s.projects, "project", "projects")} and {plural(s.notes, "note", "notes")}
            </div>
          ) : (
            <div className="no">
              <Icon name="warn" size={18} />
              Not much to read yet: {plural(s.projects, "project", "projects")} and {plural(s.notes, "note", "notes")}. Orr needs at least 3 projects or 20 notes.
            </div>
          )}
        </div>
        <div className="me-gacts">
          <Button kind="solid" icon="bolt" disabled={!ready || busy} onClick={() => onGenerate(on)}>
            Generate my persona
          </Button>
          <Button disabled={busy} onClick={onBlank}>
            Start from a blank one
          </Button>
          {ready && <small>About a minute. Uses your AI.</small>}
        </div>
        {error && <p className="me-err">{error}</p>}
        <p className="me-privacy">Orr leaves out money, your address, health and family matters, and only reads what you switch on above. The draft stays here until you keep it.</p>
      </>
    );
  }
  return (
    <section className="mod me-gen" aria-label="Your page">
      <div className="me-gen-orr">
        <Orr pose={job?.state === "running" ? "write" : job?.state === "done" ? "jump" : "read"} size={96} />
      </div>
      <div>{body}</div>
    </section>
  );
}
