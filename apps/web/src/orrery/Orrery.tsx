/**
 * The Orrery (structure.md §2.16): how everything you keep relates, with Orr in the middle, as a
 * live web you can take hold of. Rail key 4; on the phone, under More.
 *
 *   /orrery                     the whole vault (Kind)
 *   /orrery?area=work           zoomed to a life area
 *   /orrery?area=work&topic=…   zoomed to a topic
 *   /orrery?center=<slug>       Steps, with that thing in the middle
 *
 * The address is the level you are at, so Back, a link and a reload all land where you were;
 * the canvas (engine.ts) asks for a level and the address answers. What is selected, where you
 * dragged things and the camera are not remembered: it always opens tidy (decided 9 October).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { Button } from "../ui/controls.js";
import { Icon } from "../ui/Icon.js";
import { isTyping } from "../ui/keys.js";
import { HeadMark } from "../ui/orr/Orr.js";
import { anyLayerOpen } from "../ui/overlays.js";
import { canGoBack, navigate, routeHref, type Route } from "../ui/router.js";
import { readKey, writeKey } from "../storage.js";
import { onWs } from "../ws.js";
import { loadOrrery } from "./data.js";
import { fmt, OrreryEngine, type Box, type Intent, type Snapshot } from "./engine.js";
import { Glyph } from "./Glyph.js";
import { KIND_NAME, relationGroups, type Model, type ONode } from "./model.js";

export type OrreryRoute = Extract<Route, { kind: "orrery" }>;

const REST_KEY = "orrama-orrery-rest";
/** Relations each group shows in the panel before "+ N more" (which opens Steps). */
const PER_GROUP = 6;
/** A load slower than this shows "Reading your notes", and the files arrive with a count. */
const SLOW_MS = 250;

type Data = { phase: "loading" } | { phase: "error" } | { phase: "ready"; model: Model; sig: string; slow: boolean };

/** The vault, read once and again whenever a note changes (live sync), debounced. */
function useOrreryData(): [Data, () => void] {
  const [data, setData] = useState<Data>({ phase: "loading" });
  const ctl = useRef<AbortController | null>(null);
  const load = useCallback((quiet: boolean) => {
    ctl.current?.abort();
    const c = (ctl.current = new AbortController());
    const t0 = performance.now();
    if (!quiet) setData({ phase: "loading" });
    loadOrrery(c.signal).then(
      ({ model, sig }) => {
        if (c.signal.aborted) return;
        setData((d) => (d.phase === "ready" && d.sig === sig ? d : { phase: "ready", model, sig, slow: !quiet && performance.now() - t0 > SLOW_MS }));
      },
      () => {
        if (!c.signal.aborted && !quiet) setData({ phase: "error" });
      },
    );
  }, []);
  useEffect(() => {
    load(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => load(true), 800);
    });
    return () => {
      off();
      clearTimeout(timer);
      ctl.current?.abort();
    };
  }, [load]);
  return [data, useCallback(() => load(false), [load])];
}

/** The node an address names: a project by its board slug first, then any file by its file name. */
function nodeBySlug(m: Model, slug: string): number {
  const p = m.nodes.find((d) => d.t === 0 && d.slug === slug);
  return (p ?? m.nodes.find((d) => d.slug === slug))?.i ?? -1;
}
function topicBySlug(m: Model, slug: string, area: number): number {
  const all = m.topics.filter((t) => t.slug === slug);
  return (all.find((t) => t.area === area) ?? all[0])?.id ?? -1;
}

/** Where a file opens: a project on its own page, anything else as a note. */
export function openRoute(d: ONode): Route {
  return d.project ? { kind: "project", slug: d.project.slug } : { kind: "notes", path: d.path.replace(/\.md$/i, "") };
}

export function Orrery({ route, onAsk }: { route: OrreryRoute; onAsk: () => void }) {
  const [data, reload] = useOrreryData();
  const model = data.phase === "ready" ? data.model : null;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<OrreryEngine | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [laidOut, setLaidOut] = useState<Model | null>(null);
  const [rest, setRest] = useState(() => readKey(REST_KEY) === "1");

  // the address of each level, and the level it was entered from (so Back steps out one level)
  const enteredFrom = useRef(new Map<string, string>());
  const here = () => location.pathname + location.search;
  const goIn = useCallback((to: OrreryRoute) => {
    const href = routeHref(to);
    enteredFrom.current.set(href, here());
    navigate(to);
  }, []);
  const goOut = useCallback((to: OrreryRoute) => {
    const href = routeHref(to);
    if (enteredFrom.current.get(here()) === href && canGoBack()) history.back();
    else navigate(to, { replace: true });
  }, []);
  const routeRef = useRef(route);
  routeRef.current = route;
  const modelRef = useRef(model);
  modelRef.current = model;

  const onIntent = useCallback(
    (it: Intent) => {
      const m = engineRef.current?.model;
      if (!m) return;
      const r = routeRef.current;
      if (it.kind === "steps") goIn({ kind: "orrery", center: m.nodes[it.i]!.slug });
      else if (it.kind === "area") goIn({ kind: "orrery", area: m.areas[it.area]!.id });
      else if (it.kind === "topic") {
        const t = m.topics[it.topic]!;
        goIn({ kind: "orrery", area: m.areas[t.area]!.id, topic: t.slug });
      } else if (it.kind === "home") goOut({ kind: "orrery" });
      else goOut(r.topic && r.area ? { kind: "orrery", area: r.area } : { kind: "orrery" });
    },
    [goIn, goOut],
  );

  // the engine lives as long as the page
  useEffect(() => {
    const canvas = canvasRef.current!;
    const engine = new OrreryEngine(canvas, { onChange: setSnap, onIntent: (i) => onIntentRef.current(i) });
    engine.setRest(readKey(REST_KEY) === "1");
    engineRef.current = engine;
    setSnap(engine.snapshot());
    const stage = stageRef.current!;
    const size = () => {
      const r = stage.getBoundingClientRect();
      engine.resize(Math.round(r.width), Math.round(r.height));
    };
    size();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(size) : null;
    ro?.observe(stage);
    if (document.fonts?.ready) void document.fonts.ready.then(() => engine.readColors());
    return () => {
      ro?.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, []);
  const onIntentRef = useRef(onIntent);
  onIntentRef.current = onIntent;

  // data in: blank while reading, an error, empty, or the vault
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (data.phase === "loading") engine.setBlank("reading");
    else if (data.phase === "error") engine.setBlank("error");
    else if (data.model.nodes.length === 0) engine.setBlank("empty");
    else void engine.setModel(data.model, data.sig, { reveal: data.slow }).then(() => setLaidOut(engine.model));
  }, [data]);

  // the address's level, once the vault is laid out
  useEffect(() => {
    const engine = engineRef.current;
    const m = laidOut;
    if (!engine || !m || engine.model !== m) return;
    const area = route.area ? m.areas.findIndex((a) => a.id === route.area) : -1;
    if (route.center) {
      const c = nodeBySlug(m, route.center);
      if (c >= 0) return engine.show({ center: c });
    }
    const topic = route.topic ? topicBySlug(m, route.topic, area) : -1;
    engine.show({ area, topic });
  }, [route, laidOut]);

  // the controls on the stage, which names keep clear of
  const legendRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const whereRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const engine = engineRef.current;
    const stage = stageRef.current;
    if (!engine || !stage) return;
    const s = stage.getBoundingClientRect();
    const boxes: Box[] = [];
    for (const el of [legendRef.current, zoomRef.current, whereRef.current]) {
      if (!el || !el.offsetWidth) continue;
      const r = el.getBoundingClientRect();
      boxes.push({ left: r.left - s.left, top: r.top - s.top, right: r.right - s.left, bottom: r.bottom - s.top });
    }
    engine.setObstacles(boxes);
  });

  const toggleRest = (on: boolean) => {
    setRest(on);
    writeKey(REST_KEY, on ? "1" : "0");
    engineRef.current?.setRest(on);
  };

  // keys: Esc steps out, + − 0 zoom, Enter puts the selection in the middle, arrows move
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || anyLayerOpen()) return;
      const s = engine.snapshot();
      const t = e.target as HTMLElement | null;
      const onMap = !t || t === document.body || t === canvasRef.current;
      const arrows: Record<string, { x: number; y: number }> = { ArrowRight: { x: 1, y: 0 }, ArrowLeft: { x: -1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
      if (e.key === "Escape") engine.escape();
      else if (e.key === "+" || e.key === "=") engine.zoomBy(1.4);
      else if (e.key === "-" || e.key === "_") engine.zoomBy(1 / 1.4);
      else if (e.key === "0") engine.fit();
      else if (e.key === "Enter" && onMap && s.sel >= 0 && !(s.view === "steps" && s.center === s.sel)) onIntentRef.current({ kind: "steps", i: s.sel });
      else if (arrows[e.key] && onMap) engine.step(arrows[e.key]!);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const engine = engineRef.current;
  const meta =
    data.phase === "loading"
      ? "Reading your notes…"
      : data.phase === "error"
        ? "Can't read your notes"
        : !model || model.nodes.length === 0
          ? "No files yet"
          : `${fmt(model.nodes.length)} files · ${fmt(model.ea.length)} links · ${fmt(model.topics.filter((t) => t.n > 0).length)} topics`;
  const ready = !!snap && !snap.blank && !!model && laidOut === model;
  const sel = ready && snap.sel >= 0 ? model.nodes[snap.sel] : undefined;
  const steps = ready && snap.view === "steps";

  return (
    <div className="orrery">
      <header className="o-top">
        <h1>Orrery</h1>
        <span className="o-meta">{meta}</span>
        <span className="o-sp" />
        <div className="tabs bare o-arr" role="radiogroup" aria-label="Arrange">
          <button type="button" role="radio" aria-checked={!steps} onClick={() => steps && onIntent({ kind: "home" })}>
            Kind
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={steps}
            disabled={!steps && !sel}
            title={!steps && !sel ? "Select something to put it in the middle" : undefined}
            onClick={() => !steps && sel && onIntent({ kind: "steps", i: sel.i })}
          >
            Steps
          </button>
        </div>
        <FindInOrrery model={ready ? model : null} rest={rest} onPick={(i) => engine?.flyTo(i)} />
      </header>
      <div className="o-body">
        <div className="o-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            tabIndex={0}
            role="application"
            aria-roledescription="orrery"
            aria-label="The Orrery. Arrow keys move between files, Enter puts one in the middle, plus and minus zoom, 0 shows the whole circle, Escape steps back."
          />
          {ready && <Where ref={whereRef} snap={snap} model={model} onOut={() => onIntent({ kind: "out" })} onHome={() => onIntent({ kind: "home" })} onArea={(a) => goOut({ kind: "orrery", area: model?.areas[a]?.id })} />}
          {data.phase === "loading" && (
            <div className="o-load" role="status">
              <span>Reading your notes</span>
              <i className="busy">
                <b />
              </i>
            </div>
          )}
          {snap?.reveal && (
            <div className="o-load" role="status">
              <span>
                Reading your notes · {fmt(snap.reveal.got)} of {fmt(snap.reveal.of)}
              </span>
              <i>
                <b style={{ width: `${Math.round((100 * snap.reveal.got) / Math.max(1, snap.reveal.of))}%` }} />
              </i>
            </div>
          )}
          {data.phase === "error" && (
            <div className="o-msg" role="alert">
              <b>Can't read your notes folder</b>
              <p>It didn't answer. It may have moved, or the drive isn't connected. Your files are safe where they are.</p>
              <div className="o-acts">
                <Button kind="solid" onClick={reload}>
                  Try again
                </Button>
                <Button onClick={() => navigate({ kind: "settings", section: "notes" })}>Choose another folder</Button>
              </div>
            </div>
          )}
          {data.phase === "ready" && data.model.nodes.length === 0 && (
            <div className="o-msg">
              <b>Your files will gather around me</b>
              <p>Show me where your notes are, and every file finds its place here.</p>
              <div className="o-acts">
                <Button kind="solid" onClick={() => navigate({ kind: "settings", section: "notes" })}>
                  Point me at your notes folder
                </Button>
              </div>
            </div>
          )}
          {ready && <Legend ref={legendRef} rest={rest} />}
          <div className="o-zoom" ref={zoomRef} hidden={!ready}>
            <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => engine?.zoomBy(1.5)}>
              <Icon name="plus" size={18} />
            </button>
            <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => engine?.zoomBy(1 / 1.5)}>
              <svg className="i" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4.5 10h11" />
              </svg>
            </button>
            <button type="button" aria-label="Back to Orr" title="Back to Orr" onClick={() => engine?.home()}>
              <HeadMark size={16} />
            </button>
          </div>
        </div>
        <aside className="o-panel" aria-label={sel ? sel.name : "The whole vault"}>
          <Panel
            data={data}
            ready={ready}
            snap={snap}
            model={model}
            rest={rest}
            onRest={toggleRest}
            onFly={(i) => engine?.flyTo(i)}
            onMiddle={(i) => onIntent({ kind: "steps", i })}
            onBack={() => onIntent({ kind: "home" })}
            onArea={(a) => (snap?.area === a ? goOut({ kind: "orrery" }) : goIn({ kind: "orrery", area: model?.areas[a]?.id }))}
            onTopic={(t) => onIntent({ kind: "topic", topic: t })}
            onAsk={onAsk}
          />
        </aside>
      </div>
    </div>
  );
}

/** The path at the map's top left: where you are, and the way back out. */
const Where = ({ ref, snap, model, onOut, onHome, onArea }: { ref: Ref<HTMLDivElement>; snap: Snapshot; model: Model; onOut: () => void; onHome: () => void; onArea: (a: number) => void }) => {
  if (snap.view === "steps" && snap.center >= 0)
    return (
      <div className="o-where" ref={ref}>
        <button type="button" className="o-orr" onClick={onHome}>
          <HeadMark size={16} />
          You
        </button>
        <Icon name="chev-r" size={14} />
        <b>{model.nodes[snap.center]!.name}</b>
        <span className="o-q">in the middle</span>
      </div>
    );
  if (snap.area < 0) return null;
  const back = snap.backSel >= 0 ? model.nodes[snap.backSel]?.name : undefined;
  return (
    <div className="o-where" ref={ref}>
      <button type="button" className="o-orr" onClick={onOut} title="Back to where you were">
        <Icon name="back" size={14} />
        Back
      </button>
      <button type="button" className="o-crumb" onClick={onHome}>
        <HeadMark size={16} />
        You
      </button>
      <Icon name="chev-r" size={14} />
      {snap.topic >= 0 ? (
        <>
          <button type="button" className="o-crumb" onClick={() => onArea(snap.area)}>
            {model.areas[snap.area]!.name}
          </button>
          <Icon name="chev-r" size={14} />
          <b>{model.topics[snap.topic]!.name}</b>
        </>
      ) : (
        <b>{model.areas[snap.area]!.name}</b>
      )}
      {back && <span className="o-q">Back returns to {back}</span>}
    </div>
  );
};

const Legend = ({ ref, rest }: { ref: Ref<HTMLDivElement>; rest: boolean }) => (
  <div className="o-legend" ref={ref} aria-hidden="true">
    {(
      [
        [0, "project"],
        [1, "person"],
        [2, "company"],
        [3, "note"],
        [4, "conversation"],
        ...(rest ? [[5, "review or template"] as const] : []),
      ] as const
    ).map(([t, label]) => (
      <span key={t}>
        <Glyph t={t} />
        {label}
      </span>
    ))}
    <span>
      <svg width="22" height="8" aria-hidden="true">
        <path d="M1 4H21" stroke="var(--ink)" strokeWidth="1.8" />
      </svg>
      relation
    </span>
    <span>size: how connected</span>
  </div>
);

/** Find within the Orrery: names that match, best-linked first; picking one flies to it. */
function FindInOrrery({ model, rest, onPick }: { model: Model | null; rest: boolean; onPick: (i: number) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const found = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!model || s.length < 2) return [];
    const out: ONode[] = [];
    for (const d of model.nodes) if ((d.t !== 5 || rest) && d.name.toLowerCase().includes(s)) out.push(d);
    const starts = (d: ONode) => (d.name.toLowerCase().startsWith(s) ? 1 : 0);
    return out.sort((a, b) => starts(b) - starts(a) || b.deg - a.deg || a.i - b.i).slice(0, 8);
  }, [model, q, rest]);
  const pick = (d: ONode) => {
    setOpen(false);
    setQ("");
    onPick(d.i);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") (setAt((k) => Math.min(found.length - 1, k + 1)), e.preventDefault());
    else if (e.key === "ArrowUp") (setAt((k) => Math.max(0, k - 1)), e.preventDefault());
    else if (e.key === "Enter" && found[at]) (pick(found[at]!), e.preventDefault());
    else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      (e.target as HTMLInputElement).blur();
    }
  };
  const showList = open && q.trim().length >= 2;
  return (
    <div className="o-find">
      <div className="inp search">
        <Icon name="search" size={18} />
        <input
          type="search"
          placeholder="Find in the orrery"
          aria-label="Find in the orrery"
          role="combobox"
          aria-expanded={showList}
          aria-controls="o-results"
          value={q}
          disabled={!model}
          onChange={(e) => (setQ(e.target.value), setOpen(true), setAt(0))}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
        />
      </div>
      {showList && (
        <ul className="o-results" id="o-results" role="listbox">
          {found.length ? (
            found.map((d, k) => (
              <li key={d.id} role="option" aria-selected={k === at} className={k === at ? "on" : undefined} onMouseDown={(e) => (e.preventDefault(), pick(d))} onMouseEnter={() => setAt(k)}>
                <Glyph t={d.t} />
                <b>{d.name}</b>
                <span>
                  {KIND_NAME[d.t]} · {model?.areas[d.area]?.name}
                </span>
              </li>
            ))
          ) : (
            <li className="o-nores">Nothing by that name.</li>
          )}
        </ul>
      )}
    </div>
  );
}

interface PanelProps {
  data: Data;
  ready: boolean;
  snap: Snapshot | null;
  model: Model | null;
  rest: boolean;
  onRest: (on: boolean) => void;
  onFly: (i: number) => void;
  onMiddle: (i: number) => void;
  onBack: () => void;
  onArea: (a: number) => void;
  onTopic: (t: number) => void;
  onAsk: () => void;
}

/** The panel: the whole vault, an area, or one thing and its relations in words. */
function Panel(p: PanelProps) {
  const { data, ready, snap, model } = p;
  if (data.phase === "error")
    return (
      <div className="o-pt">
        <span className="o-type">The whole vault</span>
        <h2>Can't read your notes</h2>
        <p>The notes folder didn't answer, so there's nothing to draw. Try again, or choose the folder again in Settings.</p>
        <div className="o-acts">
          <Button size="sm" onClick={() => navigate({ kind: "settings", section: "notes" })}>
            Open Settings
          </Button>
        </div>
      </div>
    );
  if (data.phase === "ready" && data.model.nodes.length === 0)
    return (
      <div className="o-pt">
        <span className="o-type">
          <HeadMark size={16} />
          You · the whole vault
        </span>
        <h2>No files yet</h2>
        <p>Once Orrama knows where your notes are, every file gathers here around Orr: projects nearest, then people and companies, then notes and conversations.</p>
      </div>
    );
  if (!ready || !snap || !model || snap.reveal)
    return (
      <>
        <div className="o-pt">
          <span className="o-type">
            <HeadMark size={16} />
            You · the whole vault
          </span>
          <h2>Reading your notes</h2>
          <p>Files appear as they're read, projects first, then people, then notes. You can look around while the rest arrive.</p>
        </div>
        <p className="o-hint">The Orrery fills in by itself; nothing to do.</p>
      </>
    );
  if (snap.sel >= 0) return <ThingPanel {...p} snap={snap} model={model} i={snap.sel} />;
  if (snap.area >= 0) return <AreaPanel {...p} snap={snap} model={model} />;
  const total = model.nodes.length;
  return (
    <>
      <div className="o-pt">
        <span className="o-type">
          <HeadMark size={16} />
          You · the whole vault
        </span>
        <h2>{fmt(total)} files</h2>
        <p>Every file around Orr: projects nearest, then people and companies, then notes and conversations. Each life area is a slice of the circle, coloured on the rim. Lines are the strongest links; click a file to see all of its own.</p>
      </div>
      <section>
        <h3>Life areas</h3>
        {model.areas.map((a, ai) =>
          model.areaCount[ai] ? (
            <button key={a.id} type="button" className="o-area" onClick={() => p.onArea(ai)}>
              <i style={{ background: `var(${a.v})` }} />
              <b>{a.name}</b>
              <span>{fmt(model.areaCount[ai]!)}</span>
              <u style={{ width: `${Math.round((100 * model.areaCount[ai]!) / total)}%`, background: `var(${a.v})` }} />
            </button>
          ) : null,
        )}
      </section>
      <section>
        <h3>What's in it</h3>
        <div className="o-counts">
          {(
            [
              ["Projects", 0],
              ["People", 1],
              ["Companies", 2],
              ["Notes", 3],
              ["Conversations", 4],
              ["Reviews and templates", 5],
            ] as const
          ).map(([label, t]) => (
            <span key={t} style={{ display: "contents" }}>
              <span>
                <Glyph t={t} />
                {label}
              </span>
              <b>{fmt(model.counts[t]!)}</b>
            </span>
          ))}
        </div>
        <label className="o-switch">
          <span>Show reviews and templates</span>
          <button type="button" role="switch" aria-checked={p.rest} className="ui-sw" onClick={() => p.onRest(!p.rest)} />
        </label>
      </section>
      <p className="o-hint">
        Files pull on what they link to and push the rest away, each inside its life area. Drag a file: its neighbourhood rearranges around it, and it stays there until you leave the Orrery. Scroll or pinch to zoom, drag the background to move. Click anything to see how it relates; double-click to put it in the middle.
      </p>
    </>
  );
}

function AreaPanel({ snap, model, onTopic, onFly, onArea, onAsk }: PanelProps & { snap: Snapshot; model: Model }) {
  const ai = snap.area;
  const a = model.areas[ai]!;
  const topics = model.areaTopics[ai]!.map((t) => model.topics[t]!).filter((t) => t.n > 0).sort((x, y) => y.n - x.n || x.id - y.id);
  const inA = model.nodes.filter((d) => d.area === ai);
  const cnt = [0, 0, 0, 0, 0, 0];
  for (const d of inA) cnt[d.t]!++;
  const max = Math.max(1, topics[0]?.n ?? 1);
  const projects = inA.filter((d) => d.t === 0).sort((x, y) => y.deg - x.deg || x.i - y.i);
  return (
    <>
      <div className="o-pt">
        <span className="o-type">
          <i className="o-dot" style={{ background: `var(${a.v})` }} />
          Life area
        </span>
        <h2>{a.name}</h2>
        <p>
          {fmt(inA.length)} files in {topics.length} topics: {fmt(cnt[0]!)} projects, {fmt(cnt[1]! + cnt[2]!)} people and companies, {fmt(cnt[3]! + cnt[4]!)} notes and conversations.
        </p>
      </div>
      <div className="o-acts">
        <Button size="sm" onClick={() => onArea(ai)}>
          <HeadMark size={14} />
          Back to the whole vault
        </Button>
        <Button size="sm" kind="quiet" orr onClick={onAsk}>
          Ask Orr about {a.name}
        </Button>
      </div>
      <section>
        <h3>
          Topics <span>{topics.length}</span>
        </h3>
        {topics.slice(0, 10).map((t) => (
          <button key={t.id} type="button" className={snap.topic === t.id ? "o-area on" : "o-area"} onClick={() => onTopic(t.id)}>
            <i style={{ background: `var(${a.v})` }} />
            <b>{t.name}</b>
            <span>{fmt(t.n)}</span>
            <u style={{ width: `${Math.max(2, Math.round((t.n / max) * 100))}%`, background: `var(${a.v})` }} />
          </button>
        ))}
        {topics.length > 10 && <p className="o-none">+ {topics.length - 10} smaller topics, named as you zoom in.</p>}
      </section>
      {projects.length > 0 && (
        <section>
          <h3>
            Projects <span>{projects.length}</span>
          </h3>
          <div className="o-list">
            {projects.slice(0, 5).map((d) => (
              <button key={d.id} type="button" onClick={() => onFly(d.i)}>
                <Glyph t={0} />
                <b>{d.name}</b>
                {d.project?.status && <span className={`status ${d.project.status.replace(" ", "-")}`}>{d.project.status}</span>}
              </button>
            ))}
          </div>
        </section>
      )}
      <p className="o-hint">Click a topic to fly to it. Click Orr or press Esc for the whole vault.</p>
    </>
  );
}

function describe(m: Model, d: ONode): string {
  if (d.description) return d.description;
  const topic = m.topics[d.cl]?.name ?? m.areas[d.area]!.name;
  if (d.t === 0) return `${topic} · ${d.project?.total ? `${d.project.done} of ${d.project.total} steps done` : "no steps yet"} · ${d.deg} relations`;
  if (d.t === 4) return "A saved conversation, filed with what it is about.";
  if (d.t === 5) return `A review or template, in ${m.areas[d.area]!.name}.`;
  return `In ${topic} · ${d.days === 0 ? "edited today" : d.days === 1 ? "edited yesterday" : `edited ${d.days} days ago`}.`;
}

function ThingPanel({ snap, model, i, rest, onFly, onMiddle, onBack, onAsk }: PanelProps & { snap: Snapshot; model: Model; i: number }) {
  const d = model.nodes[i]!;
  const groups = relationGroups(model, i, (j) => model.nodes[j]!.t !== 5 || rest);
  const total = groups.reduce((s, g) => s + g.items.length, 0);
  const center = snap.view === "steps" && snap.center === i;
  const hidden = rest ? 0 : model.adj[i]!.length - total;
  const st = d.project?.status;
  return (
    <>
      <div className="o-pt">
        <span className="o-type">
          <Glyph t={d.t} />
          {KIND_NAME[d.t]} · <i className="o-dot" style={{ background: `var(${model.areas[d.area]!.v})` }} />
          {model.areas[d.area]!.name}
          {st && (
            <>
              {" · "}
              <span className={`status ${st.replace(" ", "-")}`}>{st}</span>
            </>
          )}
        </span>
        <h2>{d.name}</h2>
        <p>{describe(model, d)}</p>
      </div>
      <div className="o-acts">
        <Button size="sm" kind="solid" onClick={() => navigate(openRoute(d))}>
          Open
        </Button>
        {center ? (
          <Button size="sm" onClick={onBack}>
            <HeadMark size={14} />
            Back to Orr
          </Button>
        ) : (
          <Button size="sm" onClick={() => onMiddle(i)}>
            Put in the middle
          </Button>
        )}
        <Button size="sm" kind="quiet" orr onClick={onAsk}>
          Ask Orr
        </Button>
      </div>
      <section>
        <h3>
          Relations <span>{fmt(total)}</span>
        </h3>
        {groups.map((g) => (
          <div key={g.name} className="o-rel">
            <span className="k">{g.name}</span>
            <span className="v">
              {g.items.slice(0, PER_GROUP).map((o) => (
                <a
                  key={o}
                  href={routeHref(openRoute(model.nodes[o]!))}
                  onClick={(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
                    e.preventDefault();
                    onFly(o);
                  }}
                >
                  {model.nodes[o]!.name}
                </a>
              ))}
              {g.items.length > PER_GROUP && (
                <a
                  href={routeHref({ kind: "orrery", center: d.slug })}
                  className="o-more"
                  onClick={(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
                    e.preventDefault();
                    onMiddle(i);
                  }}
                >
                  + {fmt(g.items.length - PER_GROUP)} more
                </a>
              )}
            </span>
          </div>
        ))}
        {!groups.length && <p className="o-none">Nothing links here yet.</p>}
      </section>
      <p className="o-hint">
        {center
          ? `${fmt(groups.reduce((s, g) => s + g.items.length, 0))} things one step away${hidden ? ` (and ${hidden === 1 ? "1 review or template" : `${fmt(hidden)} reviews or templates`}, switched off)` : ""}. Click anything to see how it relates; double-click to put it in the middle.`
          : "Lines show its relations; everything else steps back. Double-click to put it in the middle."}
      </p>
    </>
  );
}
