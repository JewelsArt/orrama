import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CalEvent, DayMarker, Feed, PlanData, PlanTask, TreeNote } from "@basalt/schema/responses";
import { api, isAbort, latestOnly, type Me } from "./api.js";
import { CATEGORIES, categoryColor } from "./categories.js";
import { addDays, dayAt, isoDay, isoWeek, longMonth, longWeekday, monthAt, monthCells, monthKey, mondayOf, rangeLabel, weekAt } from "./calendarMath.js";
import { readKey, writeKey } from "./storage.js";
import { TaskCard } from "./TaskCard.js";
import { Button, Segmented, Tabs } from "./ui/controls.js";
import { dateLabel } from "./ui/dates.js";
import { isTyping } from "./ui/keys.js";
import { NameDialog } from "./ui/NameDialog.js";
import { anyLayerOpen, toast } from "./ui/overlays.js";
import { navigate, routeHref, type Route } from "./ui/router.js";
import { EmptyState, Notice, Skeleton } from "./ui/states.js";
import { onWs } from "./ws.js";
import { Hours, type DraggedStep } from "./planning/Hours.js";
import { ItemPopover, type Pop, type PopActions } from "./planning/ItemPopover.js";
import { Lanes } from "./planning/Lanes.js";
import { CALENDAR_LANE, DATED_LANE, buildItems, dueCounts, proposalWords, taskKey, toPlanCuts, weekDays, type Item, type Proposal, type ToPlanCut } from "./planning/model.js";
import { Month, PhoneMonth } from "./planning/Month.js";
import { PhoneWeek } from "./planning/PhoneWeek.js";
import { ToPlanPanel, ToPlanSheet } from "./planning/ToPlan.js";
import { HeadMark } from "./ui/orr/Orr.js";
import { planningRoute, type PlanningRoute } from "./planning/title.js";

/**
 * Planning (structure.md §2.2, Horizon's timetable): the week as lanes with an Hours switch,
 * the month, one day by the hour, and To plan, the steps with time still to book. Everything
 * the vault has dated is here in one vocabulary (planning/model.ts): booked time, events,
 * subscribed calendars, due days, key deadlines, money, and Orr's proposals, which are
 * written nowhere until you book them.
 *
 * Addresses: /planning/week/<a day in it or 2026-W41>, /planning/month/<yyyy-mm>,
 * /planning/day/<yyyy-mm-dd>; no date is this week, month or day. Lanes or Hours is
 * remembered on the device. ← and → step back and forward.
 */

type Scale = PlanningRoute["scale"];
type WeekView = "lanes" | "hours";

const VIEW_KEY = "basalt-plan-view";
const FULLDAY_KEY = "basalt-plan-fullday";

/** The phone (the shell's own breakpoint). */
function useNarrow(): boolean {
  const q = "(max-width: 760px)";
  const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

export function Planning({
  me,
  route = { kind: "planning", scale: "week" },
  onOpenNote,
  onOpenProject,
}: {
  me: Me;
  route?: PlanningRoute;
  onOpenNote: (id: string) => void;
  onOpenProject?: (slug: string) => void;
}) {
  void me;
  const narrow = useNarrow();
  const [nowTick, setNowTick] = useState(Date.now());
  const now = useMemo(() => new Date(nowTick), [nowTick]);
  const today = isoDay(now);
  // The phone has no Lanes/Hours switch: its week stands up, and Day is its hour window.
  const scale = route.scale;
  const [view, setViewState] = useState<WeekView>(() => (readKey(VIEW_KEY) === "hours" ? "hours" : "lanes"));
  const setView = (v: WeekView) => {
    setViewState(v);
    writeKey(VIEW_KEY, v);
  };
  const [fullDay, setFullDayState] = useState(() => readKey(FULLDAY_KEY) === "1");
  const setFullDay = (v: boolean) => {
    setFullDayState(v);
    writeKey(FULLDAY_KEY, v ? "1" : "0");
  };

  /* ---------- where we are ---------- */

  const weekStart = useMemo(() => (scale === "day" ? mondayOf(dayAt(route.at, now)) : weekAt(route.at, now)), [scale, route.at, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = useMemo(() => monthAt(route.at, now), [route.at, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const theDay = useMemo(() => dayAt(route.at, now), [route.at, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const cells = useMemo(() => monthCells(first).map(isoDay), [first]);
  const range = useMemo(
    () => (scale === "month" ? { from: cells[0]!, to: cells[41]! } : { from: days[0]!, to: isoDay(addDays(weekStart, 27)) }),
    [scale, cells, days, weekStart],
  );

  /* ---------- data ---------- */

  const [plan, setPlan] = useState<PlanData | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [markers, setMarkers] = useState<DayMarker[]>([]);
  const [areas, setAreas] = useState<Map<string, string>>(new Map());
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [failed, setFailed] = useState(false);
  const [nextLoad] = useState(latestOnly);

  const load = useCallback(async () => {
    const signal = nextLoad();
    try {
      const [p, e, m, tree, f] = await Promise.all([
        api<PlanData>("GET", "/api/plan", undefined, { signal }),
        api<CalEvent[]>("GET", `/api/events?from=${range.from}&to=${range.to}`, undefined, { signal }),
        api<DayMarker[]>("GET", `/api/calendar/markers?from=${range.from}&to=${range.to}`, undefined, { signal }),
        api<TreeNote[]>("GET", "/api/vault/tree", undefined, { signal }),
        api<Feed[]>("GET", "/api/calendar/feeds", undefined, { signal }),
      ]);
      setPlan(p);
      setEvents(e);
      setMarkers(m);
      setAreas(new Map(tree.map((n) => [n.id, n.category])));
      setFeeds(f);
      setFailed(false);
    } catch (err) {
      if (isAbort(err)) return;
      setFailed(true);
    }
  }, [range, nextLoad]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 500);
    });
    const tick = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => {
      off();
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [load]);

  // The server decides whose a task is (forYou): assigned to you, or to nobody in a note you
  // can edit. Filtering on the @name here hid every task without one.
  const tasks = useMemo(() => (plan?.assignees ?? []).flatMap((a) => a.tasks).filter((t) => t.forYou), [plan]);
  const backlog = useMemo(() => tasks.filter((t) => t.remainingHours > 0), [tasks]);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const areaOf = useCallback((noteId: string) => areas.get(noteId) ?? "personal", [areas]);
  const colorOf = useCallback((lane: string) => (lane === DATED_LANE || lane === CALENDAR_LANE ? null : CATEGORIES.some((c) => c.id === lane) ? categoryColor(lane) : "var(--c-other)"), []);
  const items = useMemo(
    () => buildItems({ tasks, events, markers, proposals: proposals ?? [], areaOf, from: range.from, to: range.to }),
    [tasks, events, markers, proposals, areaOf, range],
  );
  const inSpan = (from: string, to: string) => items.filter((i) => i.date >= from && i.date <= to);

  /* ---------- To plan, the card, the popover ---------- */

  const [cut, setCut] = useState<ToPlanCut>("week");
  const [sheet, setSheet] = useState(false);
  const cuts = useMemo(() => toPlanCuts(backlog, today, days[0]!, days[6]!), [backlog, today, days]);
  const [card, setCard] = useState<{ task: PlanTask; anchor: HTMLElement | null } | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const withPanel = !narrow && (scale === "day" || (scale === "week" && view === "hours"));
  const openToPlan = (c: ToPlanCut) => {
    setCut(c);
    if (!withPanel) setSheet(true);
  };

  const findTask = (i: Item): PlanTask | undefined => i.task ?? (i.marker?.noteId ? tasks.find((t) => t.noteId === i.marker!.noteId && t.line === i.marker!.line) : undefined);

  const openItem = (i: Item, el: HTMLElement) => {
    if (i.kind === "pp" && i.proposal) {
      setProposals((cur) => (cur ? cur.filter((p) => p !== i.proposal) : cur));
      return;
    }
    if (i.kind === "du" || i.kind === "key") {
      const t = findTask(i);
      if (t) setCard({ task: t, anchor: el });
      else if (i.marker?.noteId) onOpenNote(i.marker.noteId);
      return;
    }
    if (i.kind === "ms" || i.kind === "mn") {
      if (i.marker?.noteId) onOpenNote(i.marker.noteId);
      return;
    }
    setPop({ kind: "item", item: i, anchor: el });
  };

  const after = async (work: Promise<unknown>, said?: string) => {
    try {
      await work;
      if (said) toast(said);
    } catch {
      toast("That didn't save. Try again.");
    }
    await load();
  };

  const moveItem = (i: Item, date: string) => {
    if (i.kind === "bk" && i.block) return void after(api("PATCH", `/api/blocks/${i.block.id}`, { date }), `Moved to ${dateLabel(date)}`);
    if (i.kind === "ev" && i.event) return void after(api("PATCH", `/api/events/${i.event.id}`, { date }), `Moved to ${dateLabel(date)}`);
    if ((i.kind === "du" || i.kind === "key") && i.marker?.noteId) {
      const t = findTask(i);
      return void after(
        api("POST", "/api/tasks/dates", { noteId: i.marker.noteId, line: i.marker.line ?? undefined, blockId: t?.blockId ?? undefined, text: t?.text ?? i.title, due: date }),
        `Due ${dateLabel(date)}`,
      );
    }
  };

  const popActions: PopActions = {
    patch: async (i, change) => {
      const url = i.kind === "bk" ? `/api/blocks/${i.block!.id}` : `/api/events/${i.event!.id}`;
      await after(api("PATCH", url, change));
    },
    remove: async (i) => {
      const url = i.kind === "bk" ? `/api/blocks/${i.block!.id}` : `/api/events/${i.event!.id}`;
      await after(api("DELETE", url));
    },
    create: async (date, startMin, durationMin, title) => {
      await after(api("POST", "/api/events", { title, date, startMin, durationMin }));
    },
    openStep: (i, anchor) => {
      setPop(null);
      if (i.task) setCard({ task: i.task, anchor });
    },
    openNote: (id) => {
      setPop(null);
      onOpenNote(id);
    },
  };

  const bookStep = (s: DraggedStep, date: string, startMin: number) =>
    void after(
      api("POST", "/api/tasks/blocks", { noteId: s.noteId, line: s.line, blockId: s.blockId ?? undefined, text: s.text, date, startMin, estimateHours: s.estimateHours }),
      `Booked ${dateLabel(date)}`,
    );

  /* ---------- Plan my week ---------- */

  const [planning, setPlanning] = useState(false);
  const [booking, setBooking] = useState(false);
  const autoPlan = async () => {
    setPlanning(true);
    try {
      const res = await api<{ proposals: Proposal[]; unplaced: number }>("POST", "/api/plan/auto", { from: days[0], to: days[6] });
      setProposals(res.proposals);
    } catch {
      toast("Orr couldn't plan the week just now. Try again.");
    } finally {
      setPlanning(false);
    }
  };
  /** Booking goes through the ordinary block endpoint: one path promotes the checkbox and
   *  writes the block, whoever asked for it. */
  const book = async (list: Proposal[]) => {
    setBooking(true);
    try {
      for (const p of list) {
        await api("POST", "/api/tasks/blocks", { noteId: p.noteId, line: p.line, blockId: p.blockId ?? undefined, text: p.text, date: p.date, startMin: p.startMin, durationMin: p.durationMin, estimateHours: p.estimateHours });
        setProposals((cur) => (cur ? cur.filter((x) => x !== p) : cur));
      }
      setProposals((cur) => (cur && cur.length === 0 ? null : cur));
    } catch {
      toast("A block didn't book. The rest are still proposed.");
    } finally {
      setBooking(false);
      await load();
    }
  };

  /* ---------- going places ---------- */

  const goto = (s: Scale, at: Date) => navigate(planningRoute(s, at, now));
  const step = (dir: -1 | 1) => {
    if (scale === "month") goto("month", new Date(first.getFullYear(), first.getMonth() + dir, 1, 12));
    else if (scale === "day") goto("day", addDays(theDay, dir));
    else goto("week", addDays(weekStart, 7 * dir));
  };
  const openDay = (date: string) => navigate(planningRoute("day", dayAt(date, now), now));
  /** Switching scale keeps the date you were looking at, or today when it's in view. */
  const scaleAt = (s: Scale): Date => {
    const span = scale === "month" ? { from: isoDay(first), to: isoDay(new Date(first.getFullYear(), first.getMonth() + 1, 0, 12)) } : scale === "day" ? { from: isoDay(theDay), to: isoDay(theDay) } : { from: days[0]!, to: days[6]! };
    if (today >= span.from && today <= span.to) return now;
    if (s === "day" && scale === "week") return weekStart;
    return scale === "month" ? first : scale === "day" ? theDay : weekStart;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || anyLayerOpen()) return;
      // Arrows inside a group of tabs move between the tabs.
      if ((e.target as HTMLElement | null)?.closest?.('[role="tablist"], [role="radiogroup"]')) return;
      e.preventDefault();
      step(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ---------- the header ---------- */

  const span =
    scale === "month"
      ? { from: isoDay(first), to: isoDay(new Date(first.getFullYear(), first.getMonth() + 1, 0, 12)) }
      : scale === "day"
        ? { from: isoDay(theDay), to: isoDay(theDay) }
        : { from: days[0]!, to: days[6]! };
  const counts = dueCounts(inSpan(span.from, span.to), backlog, today);
  const dated = inSpan(span.from, span.to).filter((i) => i.kind === "du" || i.kind === "key" || i.kind === "ms" || i.kind === "mn").length;
  const title = scale === "month" ? `${longMonth(first)} ${first.getFullYear()}` : scale === "day" ? `${longWeekday(theDay)} ${theDay.getDate()} ${longMonth(theDay)}` : `Week ${isoWeek(weekStart).week}`;
  const meta =
    scale === "month"
      ? `weeks ${isoWeek(first).week}–${isoWeek(new Date(first.getFullYear(), first.getMonth() + 1, 0, 12)).week}`
      : scale === "day"
        ? `Week ${isoWeek(theDay).week}`
        : rangeLabel(weekStart, addDays(weekStart, 6));
  const thisOne = scale === "month" ? "This month" : scale === "day" ? "Today" : "This week";
  const atThisOne = scale === "month" ? monthKey(first) === monthKey(now) : scale === "day" ? isoDay(theDay) === today : days.includes(today);
  const broken = feeds.filter((f) => f.lastError);
  const scaleTabs = (
    <Tabs<Scale>
      label="Scale"
      value={scale}
      onChange={(s) => goto(s, scaleAt(s))}
      items={(["day", "week", "month"] as Scale[]).map((s) => ({ id: s, label: s === "day" ? "Day" : s === "week" ? "Week" : "Month", href: routeHref(planningRoute(s, scaleAt(s), now)) }))}
    />
  );
  const countLinks = (
    <span className="hl">
      <button type="button" onClick={() => openToPlan("week")}>
        {scale === "month" ? `${dated} dated` : `${counts.due} due`}
      </button>
      {counts.late > 0 && (
        <>
          ·
          <button type="button" className="late" onClick={() => openToPlan("late")}>
            {counts.late} late
          </button>
        </>
      )}
    </span>
  );

  const proposalBox = proposals && (
    <div className="oprop boxed plan-prop" role="status">
      <HeadMark size={18} />
      <p>{proposalWords(proposals, today).text}</p>
      <div className="acts">
        {proposals.length > 0 && (
          <Button size="sm" disabled={booking} onClick={() => void book(proposals)}>
            {booking ? "Booking…" : proposalWords(proposals, today).book}
          </Button>
        )}
        <Button size="sm" kind="quiet" onClick={() => setProposals(null)}>
          Not now
        </Button>
      </div>
    </div>
  );

  const feedNotice = broken.length > 0 && (
    <Notice
      title={broken.length === 1 ? `The calendar “${broken[0]!.label}” didn't update.` : `${broken.length} calendars didn't update.`}
      text="What it had before is still shown. The rest of the week is up to date."
      actions={
        <Button
          size="sm"
          onClick={() =>
            void after(
              Promise.all(broken.map((f) => api("POST", `/api/calendar/feeds/${f.id}/refresh`))),
            )
          }
        >
          Retry
        </Button>
      }
    />
  );

  /* ---------- the body ---------- */

  const loading = !plan && !failed;
  const toPlanProps = { cuts, cut, onCut: setCut, today, onOpen: (t: PlanTask, el: HTMLElement) => setCard({ task: t, anchor: el }), colorOf: (noteId: string) => colorOf(areaOf(noteId)) };
  const hoursFor = (list: string[]) => (
    <Hours
      days={list}
      items={inSpan(list[0]!, list[list.length - 1]!)}
      today={today}
      now={now}
      fullDay={fullDay}
      onFullDay={setFullDay}
      onOpen={openItem}
      onNewEvent={(date, startMin, anchor) => setPop({ kind: "new-event", date, startMin, anchor })}
      onBook={bookStep}
      onPatch={(i, to) => void after(api("PATCH", i.kind === "bk" ? `/api/blocks/${i.block!.id}` : `/api/events/${i.event!.id}`, to))}
      onOpenDay={list.length > 1 ? openDay : undefined}
      colorOf={colorOf}
      pending={pop?.kind === "new-event" ? { date: pop.date, startMin: pop.startMin } : null}
    />
  );
  const estimateNote = plan && (
    <p className="hint plan-est">
      Estimates are {plan.source === "ai" ? "refined by AI" : "heuristic"}; a day holds {plan.hoursPerDay}h of focused work.
    </p>
  );
  const monthEmpty = scale === "month" && plan && inSpan(isoDay(first), isoDay(new Date(first.getFullYear(), first.getMonth() + 1, 0, 12))).length === 0;

  let body: ReactNode;
  if (failed) {
    body = <Notice title="Planning didn't load." text="The server didn't answer. Your notes are untouched." actions={<Button size="sm" onClick={() => void load()}>Retry</Button>} />;
  } else if (loading) {
    body = (
      <div className="plan-loading" aria-busy="true">
        <Skeleton rows={5} label="Loading the week" />
      </div>
    );
  } else if (narrow) {
    body =
      scale === "month" ? (
        <PhoneMonth first={first} cells={cells} items={items} today={today} now={now} onOpen={openItem} onMove={moveItem} onAdd={setAdding} onOpenDay={openDay} colorOf={colorOf} />
      ) : scale === "day" ? (
        hoursFor([isoDay(theDay)])
      ) : (
        <PhoneWeek days={days} items={items} today={today} now={now} onOpen={openItem} onBook={(p) => void book([p])} colorOf={colorOf} />
      );
  } else if (scale === "month") {
    body = (
      <>
        {monthEmpty && <EmptyState pose="telescope" title={`Nothing dated in ${longMonth(first)}.`} text="Due days, key deadlines, money and events land here as your notes give them dates." />}
        <Month first={first} cells={cells} items={items} today={today} onOpen={openItem} onMove={moveItem} onAdd={setAdding} onOpenDay={openDay} colorOf={colorOf} />
        <Foot hint="A day's number opens that day. “+N more” opens it too." />
      </>
    );
  } else if (withPanel) {
    body = (
      <div className="plan-body">
        <div className="plan-side">
          <ToPlanPanel {...toPlanProps} />
          {estimateNote}
        </div>
        {hoursFor(scale === "day" ? [isoDay(theDay)] : days)}
      </div>
    );
  } else {
    body = (
      <>
        <Lanes
          weekStart={weekStart}
          days={days}
          items={items}
          today={today}
          now={now}
          unplanned={backlog.length}
          onOpen={openItem}
          onMove={moveItem}
          onAdd={setAdding}
          onOpenDay={openDay}
          onOpenMonth={() => goto("month", addDays(weekStart, 7))}
          onPickSome={() => openToPlan("all")}
          colorOf={colorOf}
        />
        <Foot hint="Click a lane to see it alone. Drag anything to another day; its note changes with it." />
      </>
    );
  }

  return (
    <div className={`ui plan ${narrow ? "phone" : ""}`}>
      {narrow ? (
        <>
          <div className="ptabs2">{scaleTabs}</div>
          <div className="pmeta">
            {scale === "month" ? `${longMonth(first)} ${first.getFullYear()}` : scale === "day" ? dateLabel(isoDay(theDay)) : rangeLabel(weekStart, addDays(weekStart, 6))}
            {countLinks}
            <span className="sp" />
            <Button size="sm" kind="quiet" icon="chev-l" aria-label="Back" onClick={() => step(-1)} />
            <Button size="sm" kind="quiet" icon="chev-r" aria-label="Forward" onClick={() => step(1)} />
          </div>
          {feedNotice}
          {proposalBox}
        </>
      ) : (
        <>
          <header className="phead bar2">
            <h1>{title}</h1>
            <span className="meta">{meta}</span>
            {countLinks}
            {scaleTabs}
            {scale === "week" && (
              <>
                <span className="sep" />
                <Segmented<WeekView>
                  label="Show the week as"
                  value={view}
                  onChange={setView}
                  items={[
                    { id: "lanes", label: "Lanes" },
                    { id: "hours", label: "Hours" },
                  ]}
                />
              </>
            )}
            <div className="sp" />
            <div className="nav">
              {!atThisOne && (
                <Button size="sm" kind="quiet" onClick={() => goto(scale, now)}>
                  {thisOne}
                </Button>
              )}
              <Button size="sm" icon="chev-l" aria-label={`Previous ${scale}`} tip={`Previous ${scale}  ←`} onClick={() => step(-1)} />
              <Button size="sm" icon="chev-r" aria-label={`Next ${scale}`} tip={`Next ${scale}  →`} onClick={() => step(1)} />
            </div>
            {!withPanel && (
              <Button size="sm" icon="list" onClick={() => openToPlan(cut)}>
                To plan <span className="q3">{backlog.length}</span>
              </Button>
            )}
            {scale !== "month" && (
              <Button size="sm" orr disabled={planning || backlog.length === 0} onClick={() => void autoPlan()}>
                {planning ? "Working…" : "Plan my week"}
              </Button>
            )}
          </header>
          {feedNotice}
          {proposalBox}
        </>
      )}

      {body}

      {sheet && (
        <ToPlanSheet {...toPlanProps} onClose={() => setSheet(false)} />
      )}
      {pop && <ItemPopover key={pop.kind === "item" ? pop.item.id : `${pop.date}:${pop.startMin}`} pop={pop} onClose={() => setPop(null)} actions={popActions} />}
      {card && (
        <TaskCard
          key={taskKey(card.task)}
          // The step as the last load has it: what booking it just changed shows at once.
          task={tasks.find((t) => taskKey(t) === taskKey(card.task)) ?? card.task}
          anchor={card.anchor}
          onClose={() => setCard(null)}
          onOpenNote={(id) => {
            setCard(null);
            onOpenNote(id);
          }}
          onOpenProject={onOpenProject}
          onScheduled={load}
        />
      )}
      {adding && (
        <NameDialog
          title={`A step due ${dateLabel(adding)}`}
          label="What's the step?"
          help="It goes into your inbox note, due that day."
          confirm="Add it"
          onClose={() => setAdding(null)}
          onSubmit={async (name) => {
            await api("POST", "/api/capture", { text: `- [ ] ${name} due:${adding}` });
            await load();
          }}
        />
      )}
    </div>
  );
}

/** The legend (one vocabulary on every time view) and the view's hint. */
function Foot({ hint }: { hint: string }) {
  return (
    <div className="plan-foot">
      <div className="lgd">
        <span>
          <i className="lg bk" />
          booked time
        </span>
        <span>
          <i className="lg ev" />
          event
        </span>
        <span>
          <i className="lg fd" />
          subscribed calendar
        </span>
        <span>
          <i className="lg du" />
          due
        </span>
        <span>
          <i className="lg key" />
          key deadline
        </span>
        <span>
          <i className="lg pp" />
          proposed by Orr
        </span>
      </div>
      <span className="hint">{hint}</span>
    </div>
  );
}
