import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isoLocal } from "@basalt/core/dates";
import { api, type Me, type TreeNote } from "./api.js";
import type { FinancePage } from "./App.js";
import { CATEGORIES, DOMAIN_COLOR, categoryOf, daysTo, isProjectActive, isSessionLog, relDay } from "./categories.js";
import { iconFor, paletteFor } from "./Finance.js";
import { onWs } from "./ws.js";

/** What each card is called, for the remove button's label and the picker. */
const CARD_META = {
  deadlines: { label: "Deadlines", hint: "Dated work, oldest first", c: "var(--v-pink)" },
  schedule: { label: "Next 7 days", hint: "Calendar, work and charges", c: "var(--v-lilac)" },
  projects: { label: "Projects", hint: "Active projects and progress", c: "var(--v-azure)" },
  spending: { label: "Last month", hint: "What it cost, and where it went", c: "var(--v-magenta)" },
  saving: { label: "Saving", hint: "What could be put aside", c: "var(--v-green)" },
  commitments: { label: "Money in and out", hint: "What is due, what is coming", c: "var(--v-cyan)" },
  focus: { label: "In Focus", hint: "Highest priority work", c: "var(--v-amber)" },
  hero: { label: "Vault Overview", hint: "Notes and task counts", c: "var(--v-cyan)" },
  category: { label: "By category", hint: "Shape of the vault", c: "var(--v-lilac)" },
} satisfies Record<string, { label: string; hint: string; c: string }>;
/** Lookup for ids that arrive as plain strings (the saved order, a data-card). */
const meta = (id: string) => CARD_META[id as keyof typeof CARD_META];

/* Default slot order, most actionable first. Adding or removing an id here
   invalidates any saved arrangement (useBentoReorder compares lengths), which
   is what we want: a layout saved before a card existed has no opinion on it. */
const DASH_CARDS = ["deadlines", "schedule", "projects", "spending", "saving", "commitments", "focus", "hero", "category"];

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
  // The effect itself still runs after every render — that pass also clears stale
  // transforms and refreshes the drag hit-test rects, so restricting it to
  // `[order]` leaves cards stranded mid-animation. Only the *animation* is gated,
  // on the order having actually changed: an unrelated re-render (the theme
  // toggle, a data refresh) shifts card metrics by a pixel or two, which this
  // used to read as a reorder and answer with a 0.6s transform on all six
  // backdrop-filter cards. Mid-theme-transition that both cost frames and got
  // baked into the view-transition snapshot, so the dashboard appeared displaced
  // for the length of the reveal.
  const prevOrder = useRef(order);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const reordered = prevOrder.current !== order;
    prevOrder.current = order;

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
      
      if (visual && id !== draggingId.current && reordered) {
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

  /**
   * Bound to the grip at the top of a card, never to the card itself. When the
   * whole surface was the drag target, every pointerdown inside it opened a
   * drag: a click on a project row was swallowed before it could navigate, and
   * the only reason links worked at all was an exclusion list of tag names that
   * a plain <li> row was never on. A dedicated handle means one place starts a
   * drag and everything else is just content.
   */
  const onDragStart = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget.closest<HTMLElement>("[data-card]");
    const id = el?.dataset.card;
    if (!el || !id) return;
    e.preventDefault(); // the grip is a <button>; don't let it take focus/click
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

interface SubscriptionItem {
  service: string;
  amount: number;
  currency: string;
  cadence: string;
  next: string | null;
  monthly: number;
  note: string;
}
interface AgendaItem {
  kind: "event" | "task" | "due" | "charge";
  date: string;
  title: string;
  startMin: number | null;
  durationMin: number | null;
  noteId: string | null;
  line: number | null;
  /** Feed label for a calendar event, project for a due task. */
  source: string | null;
  amount: number | null;
  currency: string | null;
  /** A `#deadline` task. */
  key: boolean;
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
interface DeadlineItem {
  noteId: string;
  noteTitle: string;
  line: number;
  text: string;
  project: string | null;
  due: string;
  priority: number | null;
  /** A `#deadline` task; the server sorts upcoming ones to the top. */
  key: boolean;
  overdue: boolean;
  days: number;
}
export interface ProjectRow {
  slug: string;
  key: string;
  name: string;
  domain: string | null;
  noteId: string | null;
  total: number;
  done: number;
  status: string | null;
  start: string | null;
  deadline: string | null;
  nextDue: string | null;
  overdue: number;
}
interface HomeData {
  user: { displayName: string; username: string };
  stats: { notes: number; sessions: number; openTasks: number; doneTasks: number; overdueTasks: number; weekHours: number };
  deadlines: DeadlineItem[];
  agenda: AgendaItem[];
  focus: FocusItem[];
  finance: {
    out: Ledger;
    in: Ledger;
    net: { currency: string; monthly: number }[];
  };
  /** What the statement says the month is doing. Null with no statement filed. */
  spending: {
    month: string;
    total: number;
    typical: number;
    categories: { category: string; total: number; typical: number; colour: string | null }[];
    running: { month: string; total: number; dayOf: number; daysIn: number } | null;
    savings: {
      target: number;
      surplus: number;
      trimmable: number;
      observed: number | null;
      targetRate: number | null;
      top: { category: string; save: number; colour: string | null }[];
    };
    basedOn: number;
  } | null;
}
interface Ledger {
  noteId: string | null;
  totals: { currency: string; monthly: number }[];
  items: SubscriptionItem[];
  count: number;
}

/** The wall-calendar date, from @basalt/core — the one local-date module.
 *  This was `toISOString().slice(0, 10)`, which pre-filled the date picker
 *  with yesterday for the first hour or two of every day (audit). */
const iso = isoLocal;
const fmtTime = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${ap}`;
};
/** "Today" / "Tomorrow" / "Fri 5 Sep" — the week list is read by day, not date. */
const dayLabel = (date: string): string => {
  const d = daysTo(date);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
};

/** Rows the "Next 7 days" card shows before "N more this week". */
const WEEK_ROWS = 8;
/**
 * The first `limit` rows of the week, soonest first, keeping each day's own
 * order; a day cut part-way shows the rows that fit. `hidden` is what is left.
 */
function capDays<T>(days: { date: string; rows: T[] }[], limit: number) {
  const out: { date: string; rows: T[] }[] = [];
  let left = limit;
  let hidden = 0;
  for (const d of days) {
    const take = Math.max(0, Math.min(d.rows.length, left));
    if (take > 0) out.push({ date: d.date, rows: d.rows.slice(0, take) });
    hidden += d.rows.length - take;
    left -= take;
  }
  return { days: out, hidden };
}

/**
 * Money always carries the currency's own decimals — €10.00, never €10. The
 * table is hand-written, so "10" and "19.99" sit side by side in it; trimming
 * the zeros would print them as different kinds of number and lose the decimal
 * alignment that makes a column of amounts scannable.
 */
const money = (amount: number, currency: string | null): string =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency || "EUR",
    // A charge shows as "−€13.99" rather than a bare minus that reads as a typo.
    signDisplay: amount < 0 ? "always" : "auto",
  }).format(amount);

/** Ledger total as one string; several currencies collapse to a count so the
 *  bar never claims a single figure it cannot honestly produce. */
const ledgerLabel = (l: { totals: { currency: string; monthly: number }[] }): string =>
  l.totals.length === 0 ? "—" : l.totals.length === 1 ? `${money(l.totals[0]!.monthly, l.totals[0]!.currency)}` : `${l.totals.length} currencies`;

/** Both bars scale against the larger side, so the shorter one reads as a ratio. */
const barPct = (fin: { in: { totals: { monthly: number }[] }; out: { totals: { monthly: number }[] } }, side: "in" | "out"): number => {
  const sum = (t: { monthly: number }[]) => t.reduce((a, b) => a + Math.abs(b.monthly), 0);
  const hi = Math.max(sum(fin.in.totals), sum(fin.out.totals));
  return hi === 0 ? 0 : Math.round((sum(fin[side].totals) / hi) * 100);
};

const BADGE = ["blue", "purple", "green", "orange", "pink"] as const;
/** Playful rotating card colours (Panze energy) — variety, not semantics.
 *  Teal-led, no violet/indigo. */
/** "Aug 26" — a month, said the way the Finance tab says it. */
const shortMonth = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });

/** No colour assigned — the neutral fill the contact avatars already use. */
const NO_DOMAIN = "var(--cat-b)";

export function Dashboard({
  me,
  onOpenNote,
  onOpenProject,
  onOpenOverview,
  onOpenPlanning,
  onOpenCategory,
  onOpenFinance,
  onOpenSettings,
}: {
  me: Me;
  onOpenNote: (id: string) => void;
  onOpenProject: (slug: string) => void;
  onOpenOverview: () => void;
  onOpenPlanning: () => void;
  onOpenCategory: (id: string) => void;
  /** Anywhere in the Finance area: a page, a month, a category. */
  onOpenFinance: (to?: { page?: FinancePage; month?: string; category?: string }) => void;
  onOpenSettings: () => void;
}) {
  const [home, setHome] = useState<HomeData | null>(null);
  const [tree, setTree] = useState<TreeNote[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  /** Which ledger the add-row form is open for, or null when it is closed. */
  const [adding, setAdding] = useState<"income" | "subscriptions" | null>(null);
  /**
   * Cards taken off the dashboard. Kept apart from the saved ORDER, which always
   * lists every card: a hidden card keeps its slot, so putting it back drops it
   * where it was rather than at the end. (It also keeps useBentoReorder's
   * length check meaningful — that is how it detects a stale saved layout.)
   */
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("dh-hidden") || "[]");
      return new Set(Array.isArray(saved) ? saved.filter((id: string) => id in CARD_META) : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    localStorage.setItem("dh-hidden", JSON.stringify([...hidden]));
  }, [hidden]);
  const shown = (id: string) => !hidden.has(id);
  const removeCard = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const id = e.currentTarget.closest<HTMLElement>("[data-card]")?.dataset.card;
    if (id) setHidden((h) => new Set(h).add(id));
  }, []);
  const restoreCard = useCallback((id: string) => {
    setHidden((h) => {
      const next = new Set(h);
      next.delete(id);
      return next;
    });
  }, []);

  const { order, gridRef, onDragStart } = useBentoReorder(DASH_CARDS);
  const ord = (id: string) => ({ order: order.indexOf(id) });

  const load = useCallback(async () => {
    const [h, t, p] = await Promise.all([
      api<HomeData>("GET", "/api/home"),
      api<TreeNote[]>("GET", "/api/vault/tree"),
      api<ProjectRow[]>("GET", "/api/projects"),
    ]);
    setHome(h);
    setTree(t);
    setProjects(p);
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

  // The donut is a shape-of-the-vault reading, so it runs on the curated notes:
  // 550 of the 613 files are Claude session transcripts, and left in they drown
  // every real slice (they alone made the chart read "Claude & tools 76%").
  const curated = useMemo(() => tree.filter((n) => !isSessionLog(n)), [tree]);
  const byCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of curated) counts.set(categoryOf(n), (counts.get(categoryOf(n)) ?? 0) + 1);
    return CATEGORIES.map((c) => ({ id: c.id, label: c.label, color: c.color, count: counts.get(c.id) ?? 0 })).filter((c) => c.count > 0);
  }, [curated]);

  // Tasks carry their project's *name*; the board addresses projects by slug.
  // This is the bridge that lets a deadline row's project chip open the
  // workspace instead of being decoration.
  const slugByProject = useMemo(() => new Map(projects.map((p) => [p.name, p.slug])), [projects]);
  /* A focus row wears its project's life-area colour — the same rule the
     Projects card, the Overview board and the project workspace already follow,
     so a project is one colour wherever it appears. It used to cycle five hues
     by list position, which was a rainbow that meant nothing and borrowed the
     category palette the donut beside it uses to mean something. */
  const domainByProject = useMemo(() => new Map(projects.map((p) => [p.name, p.domain])), [projects]);
  const focusColor = useCallback(
    (project: string | null) => (project ? DOMAIN_COLOR[domainByProject.get(project) ?? ""] : undefined) ?? NO_DOMAIN,
    [domainByProject],
  );
  // "Active" has to mean it: a finished or parked project is not work in flight,
  // and counting it made the card's own subtitle wrong.
  const activeProjects = useMemo(() => projects.filter(isProjectActive), [projects]);
  const restingCount = projects.length - activeProjects.length;
  const openProjectNamed = useCallback(
    (name: string | null) => {
      const slug = name ? slugByProject.get(name) : undefined;
      if (slug) onOpenProject(slug);
    },
    [slugByProject, onOpenProject],
  );

  const fin = home?.finance;
  const spend = home?.spending ?? null;
  /** The rules note's colour when it has one, else the Finance fallback — so a
   *  category is the same colour here as on the page this card opens. */
  const catColour = useCallback((colour: string | null, name: string) => paletteFor([{ category: name, colour }])(name), []);
  const now = new Date();
  const first = (home?.user.displayName ?? me.displayName).split(" ")[0];
  /** The next seven days, but only the ones that hold something — seven rows of
   *  "nothing" is a worse answer than a short list. */
  const days = useMemo(() => {
    const m = new Map<string, AgendaItem[]>();
    for (const a of home?.agenda ?? []) {
      const list = m.get(a.date) ?? [];
      list.push(a);
      m.set(a.date, list);
    }
    return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([date, rows]) => ({ date, rows }));
  }, [home]);
  /** The week card shows WEEK_ROWS rows, soonest first, until asked for the
   *  rest — a thesis with twenty dated questions otherwise turns the card into
   *  the longest thing on the page. Not persisted: it opens short every time. */
  const [weekAll, setWeekAll] = useState(false);
  const week = useMemo(() => capDays(days, weekAll ? Infinity : WEEK_ROWS), [days, weekAll]);

  return (
    <div className="home">
      <header className="dh-top">
        <div>
          <h1 className="dh-h1">Dashboard</h1>
          <p className="dh-sub">Welcome back, {first}. Here's your vault at a glance.</p>
        </div>
        <div className="dh-top-right">
          <span className="dh-top-meta">Updated {now.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
          <button
            className={`dh-edit ${editing ? "on" : ""}`}
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      </header>

      <div className={`dh-grid ${editing ? "is-editing" : ""}`} ref={gridRef} style={{ position: "relative" }}>
        {/* hero */}
        {shown("hero") && (
        <section className="dh-card dh-hero" data-card="hero" style={ord("hero")}>
          <CardTools onDragStart={onDragStart} editing={editing} onRemove={removeCard} label={CARD_META.hero.label} />
          <div className="dh-hero-head">
            <div>
              <h2 className="dh-card-title">Vault Overview</h2>
              <p className="dh-card-sub">Your knowledge base, live.</p>
            </div>
            <span className="dh-chip blue">{ic.book}</span>
          </div>
          <div className="dh-big">{home?.stats.notes ?? "—"}</div>
          <div className="dh-big-row">
            <span className="dh-big-label">Notes written</span>
          </div>
          {!!home?.stats.sessions && (
            <div className="dh-big-note">plus {home.stats.sessions} Claude session logs</div>
          )}
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
        )}

        {/* in focus */}
        {shown("focus") && (
        <section className="dh-card" data-card="focus" style={ord("focus")}>
          <CardTools onDragStart={onDragStart} editing={editing} onRemove={removeCard} label={CARD_META.focus.label} />
          <div className="dh-card-head">
            <div>
              <h2 className="dh-card-title">In Focus</h2>
              <p className="dh-card-sub">Highest priority, dated or not.</p>
            </div>
            <button className="dh-link" onClick={onOpenOverview}>View all</button>
          </div>
          <ul className="dh-fcards">
            {home?.focus.slice(0, 5).map((f) => (
              <li
                key={`${f.noteId}:${f.line}`}
                className="dh-fcard"
                style={{ ["--c" as string]: focusColor(f.project) }}
                onClick={() => onOpenNote(f.noteId)}
              >
                <span className="dh-fcard-ic">{f.text[0]?.toUpperCase()}</span>
                <div className="dh-fcard-body">
                  <span className="dh-fcard-title">{f.text}</span>
                  {/* Both halves are real elements so each can truncate on its
                      own. As a bare text node plus a button they could not: the
                      button began partway along the line and ran past the card. */}
                  <span className="dh-fcard-sub">
                    <span className="dh-fcard-note">{f.noteTitle}</span>
                    {f.project && (
                      <>
                        <span aria-hidden>·</span>
                        <button
                          className="dh-task-proj"
                          onClick={(e) => { e.stopPropagation(); openProjectNamed(f.project); }}
                        >
                          {f.project}
                        </button>
                      </>
                    )}
                  </span>
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
        )}

        {/* next 7 days — calendar, work and money, merged */}
        {shown("schedule") && (
        <section className="dh-card dh-card-week" data-card="schedule" style={ord("schedule")}>
          <CardTools onDragStart={onDragStart} editing={editing} onRemove={removeCard} label={CARD_META.schedule.label} />
          <div className="dh-card-head">
            <div>
              <h2 className="dh-card-title">Next 7 days</h2>
              <p className="dh-card-sub">Calendar, work and charges.</p>
            </div>
            <button className="dh-link" onClick={onOpenPlanning}>Planning</button>
          </div>
          {days.length > 0 ? (
            <>
            <ul className="dh-week">
              {week.days.map((d) => (
                <li key={d.date} className="dh-day">
                  <span className="dh-day-label">{dayLabel(d.date)}</span>
                  <ul className="dh-day-rows">
                    {d.rows.map((a, i) => (
                      <li
                        key={i}
                        className={`dh-ag ${a.kind} ${a.key ? "key" : ""}`}
                        onClick={() => (a.noteId ? onOpenNote(a.noteId) : undefined)}
                        style={{ cursor: a.noteId ? "pointer" : "default" }}
                      >
                        <span className="dh-ag-time">{a.startMin !== null ? fmtTime(a.startMin) : "all day"}</span>
                        <span className="dh-ag-title">{a.title}</span>
                        {a.amount !== null ? (
                          <span className="dh-ag-amt">{money(a.amount, a.currency)}</span>
                        ) : (
                          a.source && <span className="dh-ag-tag">{a.source}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {(week.hidden > 0 || weekAll) && (
              <div className="dh-task-foot">
                <button className="dh-link" onClick={() => setWeekAll((v) => !v)} aria-expanded={weekAll}>
                  {weekAll ? "Show less" : `${week.hidden} more this week →`}
                </button>
              </div>
            )}
            </>
          ) : (
            <div className="dh-empty-block">
              <p>Nothing in the next seven days.</p>
              {/* The usual reason this card is empty is that no calendar is
                  subscribed — say so, rather than leaving a blank week. */}
              <button className="dh-link" onClick={onOpenSettings}>Connect a calendar →</button>
            </div>
          )}
        </section>
        )}

        {/* ---- Finance, in three cards -------------------------------------
             One card could not carry this any more. Spending, saving and the
             two ledgers are different questions asked at different moments, and
             every figure below is a door into the Finance area rather than a
             number to look at. */}
        {shown("spending") && (
        <section className="dh-card" data-card="spending" style={ord("spending")}>
          <CardTools onDragStart={onDragStart} editing={editing} onRemove={removeCard} label={CARD_META.spending.label} />
          <div className="dh-card-head">
            <div>
              <h2 className="dh-card-title">{spend ? shortMonth(spend.month) : "Last month"}</h2>
              <p className="dh-card-sub">What it cost, and where it went.</p>
            </div>
            <button className="dh-link" onClick={() => onOpenFinance({ page: "spending" })}>All spending</button>
          </div>
          {spend ? (
            <>
              <button className="dh-spend" onClick={() => onOpenFinance({ month: spend.month })}>
                <span className="dh-net">
                  <span className="dh-net-num">{money(spend.total, "EUR")}</span>
                  <span className="dh-net-lbl">
                    {spend.total > spend.typical ? "above" : "below"} a typical {money(spend.typical, "EUR")}
                  </span>
                </span>
                <span className="dh-pace">
                  <i className="track">
                    <i className="fill" style={{ width: `${Math.min((spend.total / Math.max(spend.typical, 1)) * 100, 100)}%` }} />
                    <i className="typical" />
                  </i>
                </span>
              </button>
              <ul className="dh-cats">
                {spend.categories.map((c) => (
                  <li key={c.category}>
                    <button
                      className="dh-cat"
                      style={{ ["--c" as string]: catColour(c.colour, c.category) }}
                      onClick={() => onOpenFinance({ month: spend.month, category: c.category })}
                    >
                      <i className="tile">{iconFor(c.category)}</i>
                      <span className="nm">{c.category}</span>
                      <span className="bar">
                        <i style={{ width: `${(c.total / Math.max(spend.categories[0]?.total ?? 1, 1)) * 100}%` }} />
                      </span>
                      <b>{money(c.total, "EUR")}</b>
                    </button>
                  </li>
                ))}
              </ul>
              {spend.running && (
                <button className="dh-running" onClick={() => onOpenFinance({ month: spend.running!.month })}>
                  {shortMonth(spend.running.month)} so far: <b>{money(spend.running.total, "EUR")}</b>
                  <em>day {spend.running.dayOf} of {spend.running.daysIn}</em>
                </button>
              )}
            </>
          ) : (
            <div className="dh-empty-block">
              <p>No statement filed yet.</p>
              <p className="dh-empty-hint">Upload a bank export on the Finance page and this fills in.</p>
            </div>
          )}
        </section>
        )}

        {shown("saving") && (
        <section className="dh-card" data-card="saving" style={ord("saving")}>
          <CardTools onDragStart={onDragStart} editing={editing} onRemove={removeCard} label={CARD_META.saving.label} />
          <div className="dh-card-head">
            <div>
              <h2 className="dh-card-title">Saving</h2>
              <p className="dh-card-sub">On your own numbers.</p>
            </div>
            <button className="dh-link" onClick={() => onOpenFinance({ page: "savings" })}>The working</button>
          </div>
          {spend && spend.savings.target > 0 ? (
            <>
              <button className="dh-spend" onClick={() => onOpenFinance({ page: "savings" })}>
                <span className="dh-net">
                  <span className="dh-net-num up">{money(spend.savings.target, "EUR")}</span>
                  <span className="dh-net-lbl">
                    a month is realistic
                    {spend.savings.targetRate !== null && ` · ${spend.savings.targetRate}% of what comes in`}
                  </span>
                </span>
                <span className="dh-save-bar">
                  <i className="surplus" style={{ width: `${(Math.max(0, spend.savings.surplus) / spend.savings.target) * 100}%` }} />
                  <i className="trim" style={{ width: `${(spend.savings.trimmable / spend.savings.target) * 100}%` }} />
                </span>
                <span className="dh-spend-foot">
                  <span><b>{money(Math.max(0, spend.savings.surplus), "EUR")}</b> already left over</span>
                  <span className="save"><b>{money(spend.savings.trimmable, "EUR")}</b> trimmable</span>
                </span>
              </button>
              <ul className="dh-cats">
                {spend.savings.top.map((h) => (
                  <li key={h.category}>
                    <button
                      className="dh-cat"
                      style={{ ["--c" as string]: catColour(h.colour, h.category) }}
                      onClick={() => onOpenFinance({ category: h.category })}
                    >
                      <i className="tile">{iconFor(h.category)}</i>
                      <span className="nm">{h.category}</span>
                      <span className="bar">
                        <i style={{ width: `${(h.save / Math.max(spend.savings.top[0]?.save ?? 1, 1)) * 100}%` }} />
                      </span>
                      <b>{money(h.save, "EUR")}</b>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="dh-empty-block">
              <p>Not enough history yet.</p>
              <p className="dh-empty-hint">Three complete months of statement are needed before a typical month means anything.</p>
            </div>
          )}
        </section>
        )}

        {shown("commitments") && (
        <section className="dh-card" data-card="commitments" style={ord("commitments")}>
          <CardTools onDragStart={onDragStart} editing={editing} onRemove={removeCard} label={CARD_META.commitments.label} />
          <div className="dh-card-head">
            <div>
              <h2 className="dh-card-title">Money in and out</h2>
              <p className="dh-card-sub">Monthly, recurring.</p>
            </div>
            <div className="dh-head-tools">
              <button className="dh-link" onClick={() => setAdding("income")}>+ Income</button>
              <button className="dh-link" onClick={() => setAdding("subscriptions")}>+ Sub</button>
            </div>
          </div>

          {fin && (fin.in.count > 0 || fin.out.count > 0) ? (
            <>
              <div className="dh-flow">
                <button className="dh-flow-row" onClick={() => onOpenFinance({ page: "income" })}>
                  <span className="dh-flow-lbl">In</span>
                  <span className="dh-flow-bar"><i className="in" style={{ width: `${barPct(fin, "in")}%` }} /></span>
                  <span className="dh-flow-amt">{ledgerLabel(fin.in)}</span>
                </button>
                <button className="dh-flow-row" onClick={() => onOpenFinance({ page: "subscriptions" })}>
                  <span className="dh-flow-lbl">Out</span>
                  <span className="dh-flow-bar"><i className="out" style={{ width: `${barPct(fin, "out")}%` }} /></span>
                  <span className="dh-flow-amt">{ledgerLabel(fin.out)}</span>
                </button>
              </div>
              <ul className="dh-subs">
                {fin.out.items.slice(0, 5).map((sub) => {
                  const d = sub.next ? daysTo(sub.next) : null;
                  return (
                    <li key={sub.service} className="dh-sub" onClick={() => onOpenFinance({ page: "subscriptions" })}>
                      <span className="dh-sub-name">{sub.service}</span>
                      <span className="dh-sub-when">{d !== null ? relDay(d) : sub.cadence}</span>
                      <span className="dh-sub-amt">{money(sub.amount, sub.currency)}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <div className="dh-empty-block">
              <p>Nothing tracked yet.</p>
              <p className="dh-empty-hint">Add what comes in and what goes out — the net, and the week ahead, follow from it.</p>
            </div>
          )}
        </section>
        )}

        {shown("deadlines") && (
        <section className="dh-card dh-card-deadlines" data-card="deadlines" style={ord("deadlines")}>
          <CardTools onDragStart={onDragStart} editing={editing} onRemove={removeCard} label={CARD_META.deadlines.label} />
          <div className="dh-card-head">
            <div>
              <h2 className="dh-card-title">Deadlines</h2>
              <p className="dh-card-sub">Dated work, oldest first.</p>
            </div>
            {!!home?.stats.overdueTasks && <span className="dh-pill-alert">{home.stats.overdueTasks} overdue</span>}
          </div>
          <ul className="dh-tasks">
            {home?.deadlines.slice(0, 6).map((d) => (
              <li key={`${d.noteId}:${d.line}`} className={`dh-task ${d.key ? "key" : ""}`}>
                <button className="dh-radio" aria-label={`Complete ${d.text}`} onClick={(e) => { e.stopPropagation(); void check(d.noteId, d.line); }} />
                <div className="dh-task-body">
                  <span className="dh-task-text" onClick={() => onOpenNote(d.noteId)}>{d.text}</span>
                  <span className="dh-task-meta">
                    {d.project && slugByProject.has(d.project) ? (
                      <button className="dh-task-proj" onClick={() => openProjectNamed(d.project)}>{d.project}</button>
                    ) : (
                      <button className="dh-task-proj plain" onClick={() => onOpenNote(d.noteId)}>{d.project ?? d.noteTitle}</button>
                    )}
                  </span>
                </div>
                <span className={`dh-task-time ${d.overdue ? "over" : ""}`}>{relDay(d.days)}</span>
              </li>
            ))}
            {home && home.deadlines.length === 0 && <li className="dh-empty">Nothing dated. Add a due: to a task.</li>}
          </ul>
          {home && home.deadlines.length > 6 && (
            <div className="dh-task-foot">
              <button className="dh-link" onClick={onOpenOverview}>{home.deadlines.length - 6} more dated →</button>
            </div>
          )}
        </section>
        )}

        {/* projects */}
        {shown("projects") && (
        <section className="dh-card" data-card="projects" style={ord("projects")}>
          <CardTools onDragStart={onDragStart} editing={editing} onRemove={removeCard} label={CARD_META.projects.label} />
          <div className="dh-card-head">
            <div>
              <h2 className="dh-card-title">Projects</h2>
              <p className="dh-card-sub">{activeProjects.length} active.</p>
            </div>
            <button className="dh-link" onClick={onOpenOverview}>Board</button>
          </div>
          <ul className="dh-projs">
            {activeProjects.slice(0, 6).map((p) => {
              // A project-level `deadline:` is the stronger promise when it is
              // there; otherwise the soonest due date among its own open tasks
              // stands in, which is the only date most projects actually have.
              const when = p.deadline ?? p.nextDue;
              const days = when ? daysTo(when) : null;
              const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
              const color = DOMAIN_COLOR[p.domain ?? ""] ?? "var(--accent)";
              return (
                <li key={p.slug} className="dh-proj" style={{ ["--c" as string]: color }} onClick={() => onOpenProject(p.slug)}>
                  <div className="dh-proj-body">
                    <span className="dh-proj-name">{p.name}</span>
                    <span className="dh-proj-sub">
                      {p.total > 0 ? `${p.done}/${p.total} steps` : "no steps yet"}
                      {p.overdue > 0 && <b className="dh-proj-late"> · {p.overdue} late</b>}
                    </span>
                    <span className="dh-proj-bar"><i style={{ width: `${pct}%` }} /></span>
                  </div>
                  <span className={`dh-proj-when ${days !== null && days < 0 ? "over" : ""}`}>{days !== null ? relDay(days) : "—"}</span>
                </li>
              );
            })}
            {activeProjects.length === 0 && <li className="dh-empty">Nothing active. Everything is done or parked.</li>}
          </ul>
          {(activeProjects.length > 6 || restingCount > 0) && (
            <div className="dh-task-foot">
              <button className="dh-link" onClick={onOpenOverview}>
                {[activeProjects.length > 6 ? `${activeProjects.length - 6} more active` : "", restingCount > 0 ? `${restingCount} done or parked` : ""].filter(Boolean).join(" · ")} →
              </button>
            </div>
          )}
        </section>
        )}

        {/* by category — the vault's shape, and the way into it */}
        {shown("category") && (
        <section className="dh-card" data-card="category" style={ord("category")}>
          <CardTools onDragStart={onDragStart} editing={editing} onRemove={removeCard} label={CARD_META.category.label} />
          <div className="dh-card-head">
            <div>
              <h2 className="dh-card-title">By category</h2>
              <p className="dh-card-sub">{curated.length} notes written.</p>
            </div>
          </div>
          <div className="dh-src-body">
            <Donut data={byCategory} total={curated.length} />
            <ul className="dh-src-legend">
              {byCategory.map((c) => (
                <li key={c.id}>
                  {/* Opens Architecture already filtered to this slice — the
                      category chips there read from the same categories.ts. */}
                  <button className="dh-cat" onClick={() => onOpenCategory(c.id)}>
                    <i className="dot" style={{ background: c.color }} />
                    <span>{c.label}</span>
                    <b>{Math.round((c.count / Math.max(curated.length, 1)) * 100)}%</b>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
        )}

        {/* add a component (placeholder — real components come later) */}
        <button className="dh-card dh-add" style={{ order: 99 }} onClick={() => setAddOpen(true)} aria-label="Add a component">
          <span className="dh-add-plus">{ic.plus}</span>
          <span className="dh-add-title">Add component</span>
          <span className="dh-add-sub">Build out your dashboard</span>
        </button>
      </div>

      {adding && (
        <AddMoneyRow
          kind={adding}
          noteMissing={!(adding === "income" ? fin?.in.noteId : fin?.out.noteId)}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void load();
          }}
        />
      )}

      {addOpen && (
        <div className="overlay" onClick={() => setAddOpen(false)}>
          <div className="dh-add-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add a component</h3>
            <p className="dh-add-modal-sub">
              {hidden.size > 0
                ? "Cards you have taken off. Each one goes back to the slot it came from."
                : "Every card is already on your dashboard. Remove one with Edit and it will wait here."}
            </p>
            {hidden.size > 0 && (
              <div className="dh-add-grid">
                {/* Ordered by the saved layout, not by when they were removed, so
                    the picker reads in the same order as the dashboard. */}
                {order
                  .filter((id) => hidden.has(id))
                  .map((id) => (
                    <button
                      key={id}
                      className="dh-add-opt"
                      style={{ ["--c" as string]: meta(id).c }}
                      onClick={() => {
                        restoreCard(id);
                        setAddOpen(false);
                      }}
                    >
                      <span className="dh-add-opt-ic" />
                      <span className="dh-add-opt-body">
                        <b>{meta(id).label}</b>
                        <em>{meta(id).hint}</em>
                      </span>
                    </button>
                  ))}
              </div>
            )}
            <div className="dh-add-modal-foot">
              <button className="dh-link" onClick={() => setAddOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;

/**
 * Add one row to a money ledger.
 *
 * It posts to the server rather than editing Markdown in the browser: the note
 * is a shared file that Obsidian may have changed since this tab loaded it, so
 * the append has to happen against whatever is on disk at that moment. The
 * server re-reads, appends and writes through the store — the same path every
 * other mutation takes, ACL and note id included.
 */
function AddMoneyRow({
  kind,
  noteMissing,
  onClose,
  onSaved,
}: {
  kind: "income" | "subscriptions";
  noteMissing: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isIncome = kind === "income";
  const [service, setService] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<(typeof CADENCES)[number]>("monthly");
  const [next, setNext] = useState(iso(new Date()));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const canSave = service.trim().length > 0 && amount.trim().length > 0 && !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await api("POST", `/api/finance/${kind}`, { service, amount, cadence, next, note });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dh-add-modal dh-form"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          // Enter saves from any field except the note, where it is just a key.
          if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName !== "TEXTAREA") void save();
        }}
      >
        <h3>{isIncome ? "Add income" : "Add subscription"}</h3>
        <p className="dh-add-modal-sub">
          Goes straight into the table in your {isIncome ? "income" : "subscriptions"} note — editable in Obsidian afterwards.
        </p>
        {noteMissing ? (
          <p className="dh-form-error">
            No note is tagged <code>#{kind}</code> yet. Create one with a table of {isIncome ? "Source" : "Service"}, Amount, Every and Next columns.
          </p>
        ) : (
          <>
            <label className="dh-field">
              <span>{isIncome ? "Source" : "Name"}</span>
              <input ref={first} value={service} onChange={(e) => setService(e.target.value)} placeholder={isIncome ? "Scooperz" : "Spotify"} maxLength={80} />
            </label>
            <div className="dh-field-row">
              <label className="dh-field">
                <span>Amount</span>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.99" inputMode="decimal" maxLength={24} />
              </label>
              <label className="dh-field">
                <span>Recurrence</span>
                <select value={cadence} onChange={(e) => setCadence(e.target.value as (typeof CADENCES)[number])}>
                  {CADENCES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="dh-field">
                <span>{isIncome ? "Next payment" : "Next charge"}</span>
                <input type="date" value={next} onChange={(e) => setNext(e.target.value)} />
              </label>
            </div>
            <label className="dh-field">
              <span>Note</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" maxLength={140} />
            </label>
            {/* The amount is free text so "€10.99", "10,99" and "30 USD" all work
                — the parser reads all three, and a number input would reject them. */}
            <p className="dh-form-hint">Currency optional — a bare number is euros.</p>
            {error && <p className="dh-form-error">{error}</p>}
          </>
        )}
        <div className="dh-add-modal-foot">
          <button className="dh-link" onClick={onClose}>Cancel</button>
          {!noteMissing && (
            <button className="dh-btn-solid" onClick={() => void save()} disabled={!canSave}>
              {saving ? "Saving…" : "Add"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A card's own chrome: the grip that starts a drag — the only thing on a card
 * that does — and, in edit mode, the cross that takes the card off the
 * dashboard. Both find their card with `closest("[data-card]")` rather than
 * being told which one they belong to, so adding a card needs no wiring.
 */
function CardTools({
  onDragStart,
  editing,
  onRemove,
  label,
}: {
  onDragStart: (e: React.PointerEvent<HTMLElement>) => void;
  editing: boolean;
  onRemove: (e: React.MouseEvent<HTMLElement>) => void;
  label: string;
}) {
  return (
    <>
      <button className="dh-grip" onPointerDown={onDragStart} aria-label="Drag to reorder this card" title="Drag to reorder">
        <svg width="16" height="10" viewBox="0 0 16 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
          <path d="M3 2h10M3 5h10M3 8h10" />
        </svg>
      </button>
      {editing && (
        <button className="dh-remove" onClick={onRemove} aria-label={`Remove the ${label} card`} title={`Remove ${label}`}>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      )}
    </>
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
