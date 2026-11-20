/**
 * Your page (ME, Jules's Persona project; mockup approved 5 Nov 2026): who you are, from one
 * note tagged #persona, so Orr knows you when he introduces you or writes as you. Reached from
 * the account menu ("Your page") and People's first row; it lives with People. `/me` is the
 * Overview, `/me/story`, `/me/work`, `/me/skills` and `/me/voice` the full tables.
 *
 * Everything is the note: Edit opens it in Notes, an answer is written into it, and there is no
 * second store. Click anything and it opens in the panel beside the page (the page stays in use,
 * Esc closes, Back walks the trail); point at anything and what it connects to lights up.
 *
 * With no note the page offers Generate my persona (AI, and enough to read) or a blank one. This
 * file holds the state and every request; the pieces are in me/.
 *
 * What is open in the panel is in the address (`?open=<key>`), so Back from a person's page comes
 * back to it; the page follows the note live (an edit in Obsidian or by an agent redraws it).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LANE_ORDER, personaGraph } from "@orrama/core/persona-graph";
import type { Contact, PersonaData, PersonaJob } from "@orrama/schema/responses";
import { api, type Me as Account } from "./api.js";
import { onWs } from "./ws.js";
import { Button, Tabs } from "./ui/controls.js";
import { Icon } from "./ui/Icon.js";
import { Menu, toast, topLayer } from "./ui/overlays.js";
import { Avatar } from "./ui/orr/Orr.js";
import { navigate, routeHref, type MeTab } from "./ui/router.js";
import { EmptyState, Notice, Skeleton } from "./ui/states.js";
import { attempt, useWrite } from "./ui/writes.js";
import { SectionBar } from "./ui/shell/SectionBar.js";
import { MeContext, type MeShared } from "./me/context.js";
import { Empty, type Sources } from "./me/Empty.js";
import { watchGeneration } from "./me/generation.js";
import { Introduce } from "./me/Introduce.js";
import { headerFacts, laneColor, pitchLanguages, thisMonth } from "./me/model.js";
import { Overview } from "./me/Overview.js";
import { Side, type TreeNote } from "./me/Side.js";
import { SkillsView, StoryView, VoiceView, WorkView } from "./me/Views.js";

type Tab = "overview" | MeTab;
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "story", label: "Story" },
  { id: "work", label: "Work" },
  { id: "skills", label: "Skills" },
  { id: "voice", label: "Voice" },
];
const hrefOf = (t: Tab) => routeHref(t === "overview" ? { kind: "me" } : { kind: "me", tab: t });

export function Me({ me, tab = "overview", onAsk }: { me: Account; tab?: Tab; onAsk: (text: string) => void }) {
  const [data, setData] = useState<PersonaData | null | undefined>(undefined);
  const [job, setJob] = useState<PersonaJob>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tree, setTree] = useState<TreeNote[]>([]);
  const [lit, setLit] = useState<Set<string> | null>(null);
  // What the panel shows comes back from the address: Back from a person's page returns to it.
  const [trail, setTrail] = useState<string[]>(() => {
    const open = new URLSearchParams(location.search).get("open");
    return open ? [open] : [];
  });
  const [intro, setIntro] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const w = useWrite();

  const load = useCallback(async () => {
    try {
      setData(await api<PersonaData>("GET", "/api/persona"));
    } catch {
      setData(null);
    }
  }, []);
  const loadJob = useCallback(async () => {
    setJob(await api<PersonaJob>("GET", "/api/persona/generate").catch(() => null));
  }, []);
  useEffect(() => {
    void load();
    void loadJob();
    void api<Contact[]>("GET", "/api/contacts").then(setContacts, () => {});
    void api<TreeNote[]>("GET", "/api/vault/tree").then(setTree, () => {});
  }, [load, loadJob]);

  // The note changed elsewhere (Obsidian, an agent, another window): read it again, quietly.
  const noteId = data?.note?.id ?? null;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onWs((m) => {
      if (m.type !== "note-changed") return;
      if (!(m.resync || (noteId ? m.noteId === noteId : true))) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [load, noteId]);

  // The panel's top in the address, replaced (never a history entry of its own).
  const top = trail[trail.length - 1] ?? null;
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if ((q.get("open") ?? null) === top || top?.startsWith("write:")) return;
    if (top) q.set("open", top);
    else q.delete("open");
    const search = q.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, { replace: true });
  }, [top]);

  // Esc closes the panel even when focus is on the page (the stack only hands a panel the keys
  // pressed inside it, and following a chip replaces the chip that had focus).
  const panelOpen = trail.length > 0;
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || topLayer()?.kind !== "panel") return;
      setTrail([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  // While Orr writes, the page follows the job; elsewhere generation.ts does.
  useEffect(() => {
    if (job?.state !== "running") return;
    const t = setTimeout(() => void loadJob(), 1500);
    return () => clearTimeout(t);
  }, [job, loadJob]);

  const draft = reviewing && job?.state === "done" && job.persona ? job.persona : null;
  const p = draft ?? data?.persona ?? null;
  const shared = useMemo<MeShared | null>(() => {
    if (!p) return null;
    const g = personaGraph(p as never, thisMonth());
    const lanes = [...new Set(p.experience.map((e) => e.lane))].sort((a, b) => {
      const ia = LANE_ORDER.indexOf(a);
      const ib = LANE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return {
      p,
      g,
      lanes,
      lit,
      light: (key) => setLit(key ? new Set(g.related(key)) : null),
      open: (key) => setTrail((t) => (t[t.length - 1] === key ? t : [...t, key])),
      draft: !!draft,
      draftId: draft ? (job?.id ?? null) : null,
      mail: !!data?.mail,
      ai: !!data?.ai.configured,
      openNote: () => {
        if (data?.note) navigate({ kind: "notes", path: data.note.path.replace(/\.md$/, "") });
      },
    };
  }, [p, lit, draft, job?.id, data]);

  const openNote = () => shared?.openNote();

  if (data === undefined) return <div className="me-page"><Skeleton rows={6} label="Opening your page" /></div>;
  if (data === null)
    return (
      <div className="me-page">
        <EmptyState pose="shrug" title="Your page didn't open." text="The server didn't answer." actions={<Button onClick={() => void load()}>Try again</Button>} />
      </div>
    );

  const name = p?.name || me.displayName;
  const facts = p ? headerFacts(p, thisMonth()) : [];

  // ---- no note yet: Generate my persona, or a blank one ----
  if (!p || !shared) {
    const generate = (sources: Sources) =>
      void w.run("Orr couldn't start.", async () => {
        setJob(await api<PersonaJob>("POST", "/api/persona/generate", { sources }));
        watchGeneration();
      });
    return (
      <div className="me-page">
        <Header name={name} avatar={me.avatar} facts={<span>Your page in Orrama. Nothing here yet.</span>} />
        <Empty
          data={data}
          job={job}
          busy={w.busy}
          error={w.error}
          onGenerate={generate}
          onBlank={() =>
            void w.run("The note wasn't made.", async () => {
              await api("POST", "/api/persona/blank");
              await load();
              toast("Your persona note is ready: fill it in and the page follows.");
            })
          }
          onStop={() => void attempt("Orr didn't stop.", async () => setJob(await api<PersonaJob>("POST", "/api/persona/generate/stop")))}
          onAgain={() =>
            void attempt("The draft wasn't thrown away.", async () => {
              await api("DELETE", "/api/persona/generate");
              setJob(null);
            })
          }
          onReview={() => setReviewing(true)}
        />
      </div>
    );
  }

  const keep = () =>
    void w.run("The draft wasn't kept.", async () => {
      const r = await api<{ id: string; path: string }>("POST", "/api/persona/accept", { id: job!.id });
      setReviewing(false);
      setJob(null);
      await load();
      toast(`Kept in ${r.path.replace(/\.md$/, "")}.`);
    });

  return (
    <MeContext.Provider value={shared}>
      {/* Pointing at nothing lights nothing. */}
      <div
        className={["me-page", lit && "linking", trail.length > 0 && "side-open"].filter(Boolean).join(" ")}
        onPointerLeave={() => setLit(null)}
        onPointerOver={(e) => {
          if (lit && !(e.target as Element).closest("[data-key]")) setLit(null);
        }}
      >
        {!draft && (
          <SectionBar>
            <Tabs
              label="Your page"
              value={tab}
              onChange={(t) => navigate(hrefOf(t))}
              items={TABS.map((t) => ({ id: t.id, label: t.label, href: hrefOf(t.id), ...(t.id === "work" ? { count: p.projects.length } : {}) }))}
            />
          </SectionBar>
        )}
        {draft && (
          <Notice
            title="This is Orr's draft. Nothing is saved until you keep it."
            text="Click anything to see where it came from. What Orr couldn't settle is in Check with you."
            actions={
              <>
                <Button kind="solid" disabled={w.busy} onClick={keep}>
                  Keep it
                </Button>
                <Button
                  disabled={w.busy}
                  onClick={() =>
                    void attempt("The draft wasn't thrown away.", async () => {
                      await api("DELETE", "/api/persona/generate");
                      setReviewing(false);
                      setJob(null);
                    })
                  }
                >
                  Start again
                </Button>
              </>
            }
          />
        )}
        {w.error && <p className="me-err">{w.error}</p>}
        <Header
          name={name}
          avatar={me.avatar}
          headline={p.headline}
          facts={facts.map((f) =>
            f.key ? (
              <button key={f.full} type="button" className="me-lchip" title={f.full} style={{ "--lc": laneColor(f.lane ?? "", shared.lanes) } as CSSProperties} onClick={() => shared.open(f.key!)}>
                {f.text}
              </button>
            ) : (
              <span key={f.full} title={f.full}>
                {f.text}
              </span>
            ),
          )}
          actions={
            <>
              <Button kind="solid" icon="person" onClick={() => setIntro(true)}>
                Introduce me
              </Button>
              <Button icon="pen" onClick={() => shared.open("write:")}>
                Write as me
              </Button>
              {!draft && (
                <>
                  <Button ref={moreRef} icon="dots" aria-label="More" tip="More" data-tip-at="top" onClick={() => setMenu(true)} />
                  {menu && (
                    <Menu
                      anchor={moreRef}
                      align="end"
                      label="More"
                      onClose={() => setMenu(false)}
                      items={[{ label: "Edit the note", icon: <Icon name="pen" size={16} />, onSelect: openNote }]}
                    />
                  )}
                </>
              )}
            </>
          }
        />
        {p.unread.length > 0 && !draft && (
          <details className="me-unread">
            <summary>
              Orr couldn't read {p.unread.length} {p.unread.length === 1 ? "line" : "lines"} of your note.
            </summary>
            <ul>
              {p.unread.map((u, i) => (
                <li key={i}>
                  <b>{u.section}</b>: {u.reason}. <code>{u.text}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
        {tab === "story" ? (
          <StoryView />
        ) : tab === "work" ? (
          <WorkView />
        ) : tab === "skills" ? (
          <SkillsView />
        ) : tab === "voice" ? (
          <VoiceView onTry={(register) => shared.open(`write:register:${register}`)} />
        ) : (
          <Overview onTab={(t) => navigate(hrefOf(t))} />
        )}
        {!draft && data.note && (
          <footer className="me-foot">
            <p>
              Orr reads all of this from one note you can edit:{" "}
              <a
                href={routeHref({ kind: "notes", path: data.note.path.replace(/\.md$/, "") })}
                onClick={(e) => {
                  e.preventDefault();
                  openNote();
                }}
              >
                {data.note.title}
              </a>
              .{p.learnedFrom && <> Learned from {p.learnedFrom}.</>}
            </p>
            {data.others.length > 0 && (
              <p className="me-others">
                {data.others.length === 1 ? "Another note is" : `${data.others.length} other notes are`} tagged #persona too ({data.others.map((o) => o.title).join(", ")}); this page reads only the one above.
              </p>
            )}
          </footer>
        )}
        {trail.length > 0 && (
          <Side
            trail={trail}
            onBack={() => setTrail((t) => t.slice(0, -1))}
            onClose={() => setTrail([])}
            contacts={contacts}
            tree={tree}
            ai={data.ai.configured}
            onAnswered={() => {
              setTrail([]);
              void load();
            }}
            onAsk={(text) => {
              setTrail([]);
              onAsk(text);
            }}
          />
        )}
        {intro && <Introduce langs={pitchLanguages(p)} onClose={() => setIntro(false)} />}
      </div>
    </MeContext.Provider>
  );
}

function Header({ name, avatar, headline, facts, actions }: { name: string; avatar: string; headline?: string; facts: ReactNode; actions?: ReactNode }) {
  return (
    <header className="me-ph">
      <span className="me-photo">
        <Avatar name={avatar} size={64} />
      </span>
      <div className="me-ph-x">
        <h1>{name}</h1>
        {headline && <p className="me-headline">{headline}</p>}
        <div className="me-pm">{facts}</div>
      </div>
      {actions && <div className="me-acts">{actions}</div>}
    </header>
  );
}

