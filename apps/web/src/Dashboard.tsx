import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Me, type TreeNote } from "./api.js";
import { CATEGORIES, categoryOf } from "./categories.js";
import { onWs } from "./ws.js";

const DASH_CARDS = ["hero", "activity", "focus", "schedule", "tasks", "analytics"];

/**
 * Draggable bento. Pick up a card and it gets physical inertia — tilts into the
 * direction of motion (proportional to pointer velocity), lifts + scales — while
 * the other cards slide out of the way (FLIP) and it settles into the new slot on
 * release. Order persists to localStorage. (designspells.com "cards have inertia")
 */
function useBentoReorder(ids: string[]) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("dh-order") || "null");
      if (Array.isArray(saved) && saved.length === ids.length && ids.every((i) => saved.includes(i))) return saved;
    } catch {
      /* ignore */
    }
    return ids;
  });
  useEffect(() => {
    localStorage.setItem("dh-order", JSON.stringify(order));
  }, [order]);

  const gridRef = useRef<HTMLDivElement>(null);
  const draggingId = useRef<string | null>(null);
  const rects = useRef<Map<string, DOMRect>>(new Map());
  const visualRectsRef = useRef<Map<string, DOMRect>>(new Map());

  // FLIP: after every reorder, slide the non-dragged cards from where they were.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    // 1. Immediately clear transforms to prepare for static layout measurement
    grid.querySelectorAll<HTMLElement>("[data-card]").forEach((el) => {
      if (el.dataset.card !== draggingId.current) {
        el.style.transition = "none";
        el.style.transform = "none";
      }
    });

    // 2. Measure static layout rects and apply FLIP
    grid.querySelectorAll<HTMLElement>("[data-card]").forEach((el) => {
      const id = el.dataset.card!;
      const target = el.getBoundingClientRect();
      
      // Use the visual rect recorded exactly before the DOM swap, or fallback to the previous static rect
      let visual = visualRectsRef.current.get(id);
      if (!visual) visual = rects.current.get(id);
      
      if (visual && id !== draggingId.current) {
        const dx = visual.left - target.left;
        const dy = visual.top - target.top;
        
        if (dx || dy) {
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          void el.offsetWidth; // force reflow
          requestAnimationFrame(() => {
            el.style.transition = "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)";
            el.style.transform = "";
          });
        }
      }
      // Store the STATIC target rect for collision detection
      rects.current.set(id, target);
    });
    visualRectsRef.current.clear();
  });

  const onDragStart = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, [role='button']")) return;
    const el = e.currentTarget;
    const id = el.dataset.card;
    if (!id) return;
    draggingId.current = id;

    const rect = el.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    const startX = e.clientX;
    const startY = e.clientY;
    let pointerX = e.clientX;
    let pointerY = e.clientY;
    let moved = false;
    let released = false;

    // spring state: the card trails the pointer with momentum (that's the inertia)
    let curX = 0;
    let curY = 0;
    let velX = 0;
    let velY = 0;
    let rot = 0;
    let rotVel = 0;
    let raf = 0;

    el.style.zIndex = "40";
    el.style.cursor = "grabbing";
    el.style.userSelect = "none";
    el.style.willChange = "transform";
    el.style.boxShadow = "0 34px 64px -22px rgba(20, 30, 60, 0.4)";
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* older browsers */
    }

    let cachedHomeLeft = rect.left;
    let cachedHomeTop = rect.top;
    let cachedOffsetLeft = el.offsetLeft;
    let cachedOffsetTop = el.offsetTop;

    const placeholder = document.createElement("div");
    placeholder.className = "dh-card-placeholder";
    placeholder.style.position = "absolute";
    placeholder.style.background = "rgba(0, 0, 0, 0.03)";
    placeholder.style.borderRadius = "var(--radius-lg)";
    placeholder.style.border = "1px solid rgba(0,0,0,0.05)";
    placeholder.style.pointerEvents = "none";
    placeholder.style.zIndex = "0";
    placeholder.style.width = el.offsetWidth + "px";
    placeholder.style.height = el.offsetHeight + "px";
    placeholder.style.left = "0px";
    placeholder.style.top = "0px";
    let phX = cachedOffsetLeft;
    let phY = cachedOffsetTop;
    placeholder.style.transform = `translate(${phX}px, ${phY}px)`;
    placeholder.style.transition = "transform 0.5s cubic-bezier(0.25, 1, 0.5, 1)";
    gridRef.current?.appendChild(placeholder);

    const getFastHome = () => {
      if (el.offsetLeft !== cachedOffsetLeft || el.offsetTop !== cachedOffsetTop) {
        const keep = el.style.transform;
        el.style.transform = "none";
        const r = el.getBoundingClientRect();
        el.style.transform = keep;
        cachedHomeLeft = r.left;
        cachedHomeTop = r.top;
        cachedOffsetLeft = el.offsetLeft;
        cachedOffsetTop = el.offsetTop;

        phX = cachedOffsetLeft;
        phY = cachedOffsetTop;
        placeholder.style.transform = `translate(${phX}px, ${phY}px)`;
      }
      return { left: cachedHomeLeft, top: cachedHomeTop };
    };

    const STIFF = 0.16; // spring toward target
    const DAMP = 0.77; // position: gentle overshoot (rotation below wobbles more)
    let lastStep = performance.now();
    let accumulatedTime = 0;
    const TIME_STEP = 16.666;
    let done = false;
    const cleanup = () => {
      el.style.transform = "";
      el.style.transition = "";
      el.style.boxShadow = "";
      el.style.cursor = "";
      el.style.userSelect = "";
      el.style.willChange = "";
      el.style.zIndex = "";
      placeholder.remove();
      draggingId.current = null;
      done = true;
    };

    let lastHome: { left: number; top: number } | null = null;

    // Physics integration using a fixed timestep to completely divorce 
    // the spring tension and wobble speed from the monitor refresh rate.
    const tick = () => {
      if (done) return;
      const now = performance.now();
      let dt = now - lastStep;
      if (dt > 64) dt = 64; // cap at 4 frames to avoid spiral of death on background tabs
      lastStep = now;
      accumulatedTime += dt;

      let tx = 0;
      let ty = 0;
      if (!released) {
        const home = getFastHome();
        if (lastHome) {
          curX -= home.left - lastHome.left;
          curY -= home.top - lastHome.top;
        }
        lastHome = home;
        tx = pointerX - grabX - home.left;
        ty = pointerY - grabY - home.top;
      }

      while (accumulatedTime >= TIME_STEP) {
        let currentVelX = 0;
        
        if (released) {
          // When released, physically spring the card back to its home slot
          velX = (velX + (tx - curX) * STIFF) * DAMP;
          velY = (velY + (ty - curY) * STIFF) * DAMP;
          curX += velX;
          curY += velY;
          currentVelX = velX;
        } else {
          // When held, stick tightly to the mouse cursor without positional wobbling
          currentVelX = tx - curX;
          curX = tx;
          curY = ty;
          velX = currentVelX; // keep velX updated for a seamless handoff on release
          velY = ty - curY;
        }

        // Tilt based on horizontal velocity (inertia effect)
        // We use an exponential lerp instead of a spring so it smoothly flows 
        // backwards without overshooting or wiggling.
        const rotTarget = released ? 0 : Math.max(-12, Math.min(12, currentVelX * 0.35));
        rot += (rotTarget - rot) * 0.15;
        
        accumulatedTime -= TIME_STEP;
      }
      const scale = released ? 1 + Math.min(0.035, (Math.abs(curX) + Math.abs(curY)) / 1200) : 1.035;
      el.style.transform = `translate(${curX.toFixed(2)}px, ${curY.toFixed(2)}px) rotate(${rot.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
      const settled = Math.abs(curX) < 0.3 && Math.abs(curY) < 0.3 && Math.abs(velX) < 0.12 && Math.abs(velY) < 0.12 && Math.abs(rot) < 0.12 && Math.abs(rotVel) < 0.12;
      if (released && settled) cleanup();
    };
    const loop = () => {
      if (done) return;
      tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    let lastOverId: string | undefined;

    const move = (ev: PointerEvent) => {
      pointerX = ev.clientX;
      pointerY = ev.clientY;
      if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) moved = true;
      tick(); // animate immediately on motion, independent of rAF throttling
      
      // Check which static grid slot is under the pointer. This avoids layout 
      // thrashing from elementFromPoint and ignores FLIP animations.
      let overId: string | undefined;
      for (const [cardId, r] of rects.current.entries()) {
        if (cardId === id) continue;
        if (pointerX >= r.left && pointerX <= r.right && pointerY >= r.top && pointerY <= r.bottom) {
          overId = cardId;
          break;
        }
      }

      if (overId !== lastOverId) {
        lastOverId = overId;
        if (overId && overId !== id) {
          const grid = gridRef.current;
          if (grid) {
            visualRectsRef.current.clear();
            grid.querySelectorAll<HTMLElement>("[data-card]").forEach(c => {
              visualRectsRef.current.set(c.dataset.card!, c.getBoundingClientRect());
            });
          }
          setOrder((o) => {
            const from = o.indexOf(id);
            const to = o.indexOf(overId);
            if (from < 0 || to < 0) return o;
            // check if we are already in this order to prevent useless updates
            if (from === to) return o;
            const next = [...o];
            next.splice(from, 1);
            next.splice(to, 0, id);
            return next;
          });
        }
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      released = true; // spring now carries it home with a wobble
      // safety net: if rAF is throttled (e.g. tab backgrounded), never leave it stuck
      window.setTimeout(() => {
        if (!done) cleanup();
      }, 1500);
      if (moved) {
        const swallow = (c: Event) => {
          c.stopPropagation();
          c.preventDefault();
        };
        el.addEventListener("click", swallow, { capture: true, once: true });
        window.setTimeout(() => el.removeEventListener("click", swallow, { capture: true } as EventListenerOptions), 0);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  return { order, gridRef, onDragStart };
}

/**
 * The Dashboard — a clean, light SaaS command surface (the light-mode showcase;
 * the rest of the app stays dark). Faithful to the HireFlow card layout, on
 * Basalt's own palette + Plus Jakarta Sans. Fully scoped under `.home`.
 */

interface AgendaItem {
  kind: "event" | "task";
  date: string;
  title: string;
  startMin: number;
  durationMin: number;
  noteId: string | null;
}
interface FocusItem {
  noteId: string;
  noteTitle: string;
  line: number;
  text: string;
  project: string | null;
  due: string | null;
  priority: number | null;
  assignee: string | null;
  overdue: boolean;
}
interface HomeData {
  user: { displayName: string; username: string };
  stats: { notes: number; openTasks: number; doneTasks: number; weekHours: number };
  trend: { day: string; count: number }[];
  agenda: AgendaItem[];
  focus: FocusItem[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmtTime = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${ap}`;
};
const BADGE = ["blue", "purple", "green", "orange", "pink"] as const;
/** Playful rotating card colours (Panze energy) — variety, not semantics.
 *  Teal-led, no violet/indigo. */
const CARD_COLORS = ["#12b3a6", "#ff6b9d", "#3b82f6", "#ffa53a", "#22c993"];

export function Dashboard({ me, onOpenNote }: { me: Me; onOpenNote: (id: string) => void }) {
  const [home, setHome] = useState<HomeData | null>(null);
  const [tree, setTree] = useState<TreeNote[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const { order, gridRef, onDragStart } = useBentoReorder(DASH_CARDS);
  const ord = (id: string) => ({ order: order.indexOf(id) });
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selDay, setSelDay] = useState(() => iso(new Date()));

  const load = useCallback(async () => {
    const [h, t] = await Promise.all([api<HomeData>("GET", "/api/home"), api<TreeNote[]>("GET", "/api/vault/tree")]);
    setHome(h);
    setTree(t);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 600);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [load]);

  const check = async (noteId: string, line: number) => {
    await api("POST", "/api/tasks/check", { noteId, line, checked: true });
    await load();
  };

  const byCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of tree) counts.set(categoryOf(n), (counts.get(categoryOf(n)) ?? 0) + 1);
    return CATEGORIES.map((c) => ({ id: c.id, label: c.label, color: c.color, count: counts.get(c.id) ?? 0 })).filter((c) => c.count > 0);
  }, [tree]);

  // Activity: this week vs last week from the 14-day trend.
  const weeks = useMemo(() => {
    const t = home?.trend ?? [];
    const last = t.slice(0, 7).map((d) => d.count);
    const now = t.slice(7, 14).map((d) => d.count);
    const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
    const delta = sum(last) === 0 ? (sum(now) > 0 ? 100 : 0) : Math.round(((sum(now) - sum(last)) / sum(last)) * 100);
    return { last, now, thisWeek: sum(now), delta };
  }, [home]);

  const now = new Date();
  const first = (home?.user.displayName ?? me.displayName).split(" ")[0];
  const agendaByDay = useMemo(() => {
    const m = new Map<string, AgendaItem[]>();
    for (const a of home?.agenda ?? []) {
      const list = m.get(a.date) ?? [];
      list.push(a);
      m.set(a.date, list);
    }
    return m;
  }, [home]);
  const dayAgenda = agendaByDay.get(selDay) ?? [];
  const donePct = home ? Math.round((home.stats.doneTasks / Math.max(home.stats.doneTasks + home.stats.openTasks, 1)) * 100) : 0;

  return (
    <div className="home">
      <header className="dh-top">
        <div>
          <h1 className="dh-h1">Dashboard</h1>
          <p className="dh-sub">Welcome back, {first}. Here's your vault at a glance.</p>
        </div>
        <div className="dh-top-meta">Updated {now.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
      </header>

      <div className="dh-grid" ref={gridRef} style={{ position: "relative" }}>
        {/* hero */}
        <section className="dh-card dh-hero" data-card="hero" style={ord("hero")} onPointerDown={onDragStart}>
          <div className="dh-hero-head">
            <div>
              <h2 className="dh-card-title">Vault Overview</h2>
              <p className="dh-card-sub">Your knowledge base, live.</p>
            </div>
            <span className="dh-chip blue">{ic.book}</span>
          </div>
          <div className="dh-big">{home?.stats.notes ?? "—"}</div>
          <div className="dh-big-row">
            <span className="dh-big-label">Total notes</span>
            {home && weeks.delta !== 0 && (
              <span className={`dh-delta ${weeks.delta >= 0 ? "up" : "down"}`}>
                {weeks.delta >= 0 ? "↑" : "↓"} {Math.abs(weeks.delta)}% this week
              </span>
            )}
          </div>
          <div className="dh-tiles">
            <div className="dh-tile">
              <span className="dh-chip indigo sm">{ic.tasks}</span>
              <div>
                <div className="dh-tile-num">{home?.stats.openTasks ?? "—"}</div>
                <div className="dh-tile-lbl">Open tasks</div>
              </div>
            </div>
            <div className="dh-tile">
              <span className="dh-chip green sm">{ic.check}</span>
              <div>
                <div className="dh-tile-num">{home?.stats.doneTasks ?? "—"}</div>
                <div className="dh-tile-lbl">Completed</div>
              </div>
            </div>
            <div className="dh-tile">
              <span className="dh-chip orange sm">{ic.clock}</span>
              <div>
                <div className="dh-tile-num">{home ? `${home.stats.weekHours}h` : "—"}</div>
                <div className="dh-tile-lbl">Booked</div>
              </div>
            </div>
          </div>
        </section>

        {/* activity chart */}
        <section className="dh-card dh-card-activity" data-card="activity" style={ord("activity")} onPointerDown={onDragStart}>
          <div className="dh-card-head">
            <div>
              <h2 className="dh-card-title">Activity</h2>
              <div className="dh-legend">
                <span className="dh-leg"><i className="dot accent" /> This week</span>
                <span className="dh-leg"><i className="dot muted" /> Last week</span>
              </div>
            </div>
            <span className="dh-pill-static">14 days</span>
          </div>
          {home && <LineChart last={weeks.last} now={weeks.now} />}
        </section>

        {/* in focus */}
        <section className="dh-card" data-card="focus" style={ord("focus")} onPointerDown={onDragStart}>
          <div className="dh-card-head">
            <h2 className="dh-card-title">In Focus</h2>
            <button className="dh-link" onClick={() => onOpenNote(home?.focus[0]?.noteId ?? "")}>View all</button>
          </div>
          <ul className="dh-fcards">
            {home?.focus.slice(0, 5).map((f, i) => (
              <li
                key={`${f.noteId}:${f.line}`}
                className="dh-fcard"
                style={{ ["--c" as string]: CARD_COLORS[i % CARD_COLORS.length] }}
                onClick={() => onOpenNote(f.noteId)}
              >
                <span className="dh-fcard-ic">{f.text[0]?.toUpperCase()}</span>
                <div className="dh-fcard-body">
                  <span className="dh-fcard-title">{f.text}</span>
                  <span className="dh-fcard-sub">{f.noteTitle}{f.project ? ` · ${f.project}` : ""}</span>
                </div>
                {(f.priority || f.due) && (
                  <span className="dh-fcard-badge">{f.due ? f.due.slice(5) : `P${f.priority}`}</span>
                )}
                <span className="dh-fcard-star">{ic.star}</span>
              </li>
            ))}
            {home && home.focus.length === 0 && <li className="dh-empty">Nothing pressing right now.</li>}
          </ul>
        </section>

        {/* schedule */}
        <section className="dh-card dh-card-schedule" data-card="schedule" style={ord("schedule")} onPointerDown={onDragStart}>
          <div className="dh-card-head">
            <h2 className="dh-card-title">Schedule</h2>
            <span className="dh-icon-btn">{ic.cal}</span>
          </div>
          <div className="dh-sched">
            <MiniCalendar month={calMonth} setMonth={setCalMonth} selDay={selDay} setSelDay={setSelDay} marks={agendaByDay} />
            <div className="dh-agenda">
              {dayAgenda.map((a, i) => (
                <div key={i} className="dh-agenda-row" onClick={() => a.noteId && onOpenNote(a.noteId)} style={{ cursor: a.noteId ? "pointer" : "default" }}>
                  <span className="dh-agenda-time">{fmtTime(a.startMin)}</span>
                  <div className={`dh-agenda-card ${a.kind}`}>
                    <span className="dh-agenda-title">{a.title}</span>
                    <span className="dh-agenda-kind">{a.kind === "event" ? "Meeting" : "Focus block"}</span>
                  </div>
                  <span className="dh-agenda-ic">{ic.video}</span>
                </div>
              ))}
              {dayAgenda.length === 0 && <div className="dh-agenda-empty">Nothing scheduled.</div>}
            </div>
          </div>
        </section>

        {/* today's tasks */}
        <section className="dh-card" data-card="tasks" style={ord("tasks")} onPointerDown={onDragStart}>
          <div className="dh-card-head">
            <h2 className="dh-card-title">Today's Tasks</h2>
          </div>
          <ul className="dh-tasks">
            {home?.focus.slice(0, 5).map((f, i) => (
              <li key={`${f.noteId}:${f.line}`} className="dh-task" style={{ ["--c" as string]: CARD_COLORS[i % CARD_COLORS.length] }}>
                <button className="dh-radio" aria-label={`Complete ${f.text}`} onClick={(e) => { e.stopPropagation(); void check(f.noteId, f.line); }} />
                <span className="dh-task-text" onClick={() => onOpenNote(f.noteId)}>{f.text}</span>
                {f.due && <span className={`dh-task-time ${f.overdue ? "over" : ""}`}>{f.due.slice(5)}</span>}
              </li>
            ))}
            {home && home.focus.length === 0 && <li className="dh-empty">All caught up.</li>}
          </ul>
          <div className="dh-task-foot">
            <div className="dh-prog">
              <div className="dh-prog-bar"><span style={{ width: `${donePct}%` }} /></div>
              <span className="dh-prog-lbl">{home?.stats.doneTasks ?? 0} of {(home?.stats.doneTasks ?? 0) + (home?.stats.openTasks ?? 0)} done · {donePct}%</span>
            </div>
          </div>
        </section>

        {/* analytics */}
        <section className="dh-card" data-card="analytics" style={ord("analytics")} onPointerDown={onDragStart}>
          <div className="dh-card-head">
            <h2 className="dh-card-title">Analytics</h2>
            <span className="dh-pill-static">This month</span>
          </div>
          <div className="dh-stats">
            <div className="dh-stat">
              <span className="dh-chip indigo sm">{ic.book}</span>
              <div className="dh-stat-num">{home?.stats.notes ?? "—"}</div>
              <div className="dh-stat-lbl">Notes</div>
            </div>
            <div className="dh-stat">
              <span className="dh-chip blue sm">{ic.link}</span>
              <div className="dh-stat-num">{home?.stats.openTasks ?? "—"}</div>
              <div className="dh-stat-lbl">Open</div>
            </div>
            <div className="dh-stat">
              <span className="dh-chip green sm">{ic.clock}</span>
              <div className="dh-stat-num">{home ? `${home.stats.weekHours}h` : "—"}</div>
              <div className="dh-stat-lbl">This week</div>
            </div>
          </div>
          <div className="dh-src">
            <span className="dh-src-title">Notes by category</span>
            <div className="dh-src-body">
              <Donut data={byCategory} total={tree.length} />
              <ul className="dh-src-legend">
                {byCategory.map((c) => (
                  <li key={c.id}>
                    <i className="dot" style={{ background: c.color }} />
                    <span>{c.label}</span>
                    <b>{Math.round((c.count / Math.max(tree.length, 1)) * 100)}%</b>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* add a component (placeholder — real components come later) */}
        <button className="dh-card dh-add" style={{ order: 99 }} onClick={() => setAddOpen(true)} aria-label="Add a component">
          <span className="dh-add-plus">{ic.plus}</span>
          <span className="dh-add-title">Add component</span>
          <span className="dh-add-sub">Build out your dashboard</span>
        </button>
      </div>

      {addOpen && (
        <div className="overlay" onClick={() => setAddOpen(false)}>
          <div className="dh-add-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add a component</h3>
            <p className="dh-add-modal-sub">Drop widgets onto your dashboard. More arrive soon — here's what's coming:</p>
            <div className="dh-add-grid">
              {[
                { c: "#3b82f6", label: "Recent notes" },
                { c: "#22c993", label: "Habit tracker" },
                { c: "#ffa53a", label: "Pinned tasks" },
                { c: "#ff6b9d", label: "Reading list" },
                { c: "#12b3a6", label: "Streak" },
                { c: "#7c3aed", label: "Quick note" },
              ].map((w) => (
                <div key={w.label} className="dh-add-opt" style={{ ["--c" as string]: w.c }}>
                  <span className="dh-add-opt-ic" />
                  <span>{w.label}</span>
                  <span className="dh-add-opt-soon">soon</span>
                </div>
              ))}
            </div>
            <div className="dh-add-modal-foot">
              <button className="dh-link" onClick={() => setAddOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LineChart({ last, now }: { last: number[]; now: number[] }) {
  const w = 520;
  const h = 300;
  const pad = { t: 20, r: 12, b: 30, l: 12 };
  const max = Math.max(1, ...last, ...now);
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const x = (i: number) => pad.l + (i / 6) * iw;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const smooth = (arr: number[]) => {
    if (arr.length === 0) return "";
    let d = `M ${x(0)},${y(arr[0]!)}`;
    for (let i = 1; i < arr.length; i++) {
      const xc = (x(i - 1) + x(i)) / 2;
      d += ` C ${xc},${y(arr[i - 1]!)} ${xc},${y(arr[i]!)} ${x(i)},${y(arr[i]!)}`;
    }
    return d;
  };
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  return (
    <svg className="dh-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Activity this week vs last">
      <defs>
        <linearGradient id="dhFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--d-accent)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--d-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <line key={g} x1={pad.l} x2={w - pad.r} y1={pad.t + ih * g} y2={pad.t + ih * g} className="dh-grid-line" />
      ))}
      <path d={`${smooth(now)} L ${x(6)},${pad.t + ih} L ${x(0)},${pad.t + ih} Z`} fill="url(#dhFill)" />
      <path d={smooth(last)} className="dh-line-last" />
      <path d={smooth(now)} className="dh-line-now" />
      {now.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r="3.5" className="dh-dot-now" />
      ))}
      {days.map((d, i) => (
        <text key={i} x={x(i)} y={h - 8} textAnchor="middle" className="dh-chart-axis">{d}</text>
      ))}
    </svg>
  );
}

function MiniCalendar({
  month,
  setMonth,
  selDay,
  setSelDay,
  marks,
}: {
  month: Date;
  setMonth: (d: Date) => void;
  selDay: string;
  setSelDay: (s: string) => void;
  marks: Map<string, unknown[]>;
}) {
  const y = month.getFullYear();
  const m = month.getMonth();
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon=0
  const days = new Date(y, m + 1, 0).getDate();
  const today = iso(new Date());
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return (
    <div className="dh-cal">
      <div className="dh-cal-head">
        <button className="dh-cal-nav" onClick={() => setMonth(new Date(y, m - 1, 1))} aria-label="Previous month">‹</button>
        <span>{month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</span>
        <button className="dh-cal-nav" onClick={() => setMonth(new Date(y, m + 1, 1))} aria-label="Next month">›</button>
      </div>
      <div className="dh-cal-dow">{["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="dh-cal-grid">
        {cells.map((d, i) => {
          if (d === null) return <span key={i} />;
          const key = iso(new Date(y, m, d));
          return (
            <button
              key={i}
              className={`dh-cal-day ${key === today ? "today" : ""} ${key === selDay ? "sel" : ""}`}
              onClick={() => setSelDay(key)}
            >
              {d}
              {marks.has(key) && <i className="dh-cal-mark" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Donut({ data, total }: { data: { id: string; color: string; count: number }[]; total: number }) {
  const r = 46;
  const stroke = 16;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const t = Math.max(total, 1);
  return (
    <svg className="dh-donut" viewBox="0 0 130 130" role="img" aria-label="Notes by category">
      <circle cx="65" cy="65" r={r} fill="none" stroke="var(--d-line)" strokeWidth={stroke} />
      <g transform="rotate(-90 65 65)">
        {data.map((d) => {
          const frac = d.count / t;
          const dash = frac * c;
          const seg = (
            <circle key={d.id} cx="65" cy="65" r={r} fill="none" stroke={d.color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${Math.max(dash - 2, 0)} ${c - Math.max(dash - 2, 0)}`} strokeDashoffset={-offset} />
          );
          offset += dash;
          return seg;
        })}
      </g>
      <text x="65" y="62" textAnchor="middle" className="dh-donut-num">{total}</text>
      <text x="65" y="79" textAnchor="middle" className="dh-donut-lbl">Notes</text>
    </svg>
  );
}

/* inline icons (stroke, currentColor) */
const ic = {
  book: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H13v10H4.5A1.5 1.5 0 0 0 3 13.5z" /><path d="M3 13.5A1.5 1.5 0 0 1 4.5 12H13v2H4.5A1.5 1.5 0 0 1 3 13.5z" /></svg>
  ),
  tasks: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4l1.5 1.5L6 3" /><path d="M8 4h6M8 8h6M8 12h6" /><path d="M2 8l1.5 1.5L6 7" /><path d="M2 12l1.5 1.5L6 11" /></svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 8.5l3 3 7-7" /></svg>
  ),
  clock: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></svg>
  ),
  link: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6.5 9.5l3-3" /><path d="M9 4.5l.8-.8a2.4 2.4 0 0 1 3.5 3.5l-1.6 1.6" /><path d="M7 11.5l-.8.8a2.4 2.4 0 0 1-3.5-3.5l1.6-1.6" /></svg>
  ),
  star: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 2l1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.3l4-.6z" /></svg>
  ),
  cal: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="3" width="11" height="10.5" rx="1.5" /><path d="M2.5 6h11M5.5 2v2M10.5 2v2" /></svg>
  ),
  video: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="4.5" width="8" height="7" rx="1.5" /><path d="M10 7l4-2v6l-4-2z" /></svg>
  ),
  plus: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
  ),
};
