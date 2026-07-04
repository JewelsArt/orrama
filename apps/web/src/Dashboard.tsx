import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Me, type TreeNote } from "./api.js";
import { CATEGORIES, categoryColor, categoryOf } from "./categories.js";
import { onWs } from "./ws.js";

/**
 * The Dashboard — a personal "almanac" for the vault. Deliberately NOT the dark
 * command-center: warm paper, editorial serif numerals, one confident pine
 * accent. A calm morning read of where the work stands, computed from the vault.
 */

interface HomeData {
  user: { displayName: string; username: string };
  stats: { notes: number; openTasks: number; doneTasks: number; weekHours: number };
  trend: { day: string; count: number }[];
  agenda: { kind: "event" | "task"; title: string; startMin: number; durationMin: number; noteId: string | null }[];
  focus: {
    noteId: string;
    noteTitle: string;
    line: number;
    text: string;
    project: string | null;
    due: string | null;
    priority: number | null;
    assignee: string | null;
    overdue: boolean;
  }[];
}

const fmtMin = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mm === 0 ? `${h12}${ap}` : `${h12}:${String(mm).padStart(2, "0")}${ap}`;
};

export function Dashboard({ me, onOpenNote }: { me: Me; onOpenNote: (id: string) => void }) {
  const [home, setHome] = useState<HomeData | null>(null);
  const [tree, setTree] = useState<TreeNote[]>([]);

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
    return CATEGORIES.map((c) => ({ id: c.id, label: c.label, color: c.color, count: counts.get(c.id) ?? 0 })).filter(
      (c) => c.count > 0,
    );
  }, [tree]);

  const now = new Date();
  const dateLine = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = (home?.user.displayName ?? me.displayName).split(" ")[0];

  const colorForNote = (id: string) => {
    const n = tree.find((x) => x.id === id);
    return n ? categoryColor(categoryOf(n)) : "var(--dash-ink-3)";
  };

  return (
    <div className="home">
      <header className="dash-masthead">
        <div className="dash-mast-left">
          <span className="dash-kicker">The Vault Almanac</span>
          <h1 className="dash-title">
            {greeting}, {first}.
          </h1>
        </div>
        <div className="dash-mast-right">
          <span className="dash-date">{dateLine}</span>
          <span className="dash-edition">No. {home ? home.stats.notes : "—"}</span>
        </div>
      </header>
      <div className="dash-rule" />

      <div className="dash-grid">
        {/* hero */}
        <section className="dash-card dash-hero">
          <span className="dash-card-label">In the vault</span>
          <div className="dash-figure">{home?.stats.notes ?? "—"}</div>
          <span className="dash-figure-sub">notes, linked and growing</span>
          <div className="dash-hero-stats">
            <div>
              <span className="dash-stat-num">{home?.stats.openTasks ?? "—"}</span>
              <span className="dash-stat-lbl">open threads</span>
            </div>
            <div>
              <span className="dash-stat-num">{home?.stats.doneTasks ?? "—"}</span>
              <span className="dash-stat-lbl">put to rest</span>
            </div>
            <div>
              <span className="dash-stat-num">{home ? `${home.stats.weekHours}h` : "—"}</span>
              <span className="dash-stat-lbl">booked this week</span>
            </div>
          </div>
        </section>

        {/* activity chart */}
        <section className="dash-card dash-activity">
          <div className="dash-card-head">
            <span className="dash-card-label">Activity</span>
            <span className="dash-card-note">last fourteen days</span>
          </div>
          {home && <Sparkline data={home.trend} />}
        </section>

        {/* in focus */}
        <section className="dash-card dash-focus">
          <div className="dash-card-head">
            <span className="dash-card-label">In focus</span>
            <span className="dash-card-note">by priority &amp; due date</span>
          </div>
          <ol className="dash-focus-list">
            {home?.focus.map((f, i) => (
              <li key={`${f.noteId}:${f.line}`} className="dash-focus-item" onClick={() => onOpenNote(f.noteId)}>
                <span className="dash-focus-rank">{String(i + 1).padStart(2, "0")}</span>
                <span className="dash-focus-dot" style={{ background: colorForNote(f.noteId) }} />
                <span className="dash-focus-body">
                  <span className="dash-focus-text">{f.text}</span>
                  <span className="dash-focus-meta">
                    {f.noteTitle}
                    {f.project ? ` · ${f.project}` : ""}
                  </span>
                </span>
                {f.priority && <span className={`dash-prio p${f.priority}`}>P{f.priority}</span>}
                {f.due && <span className={`dash-due ${f.overdue ? "overdue" : ""}`}>{f.due.slice(5)}</span>}
              </li>
            ))}
            {home && home.focus.length === 0 && <li className="dash-empty">Nothing pressing. Rare and good.</li>}
          </ol>
        </section>

        {/* today agenda */}
        <section className="dash-card dash-agenda">
          <div className="dash-card-head">
            <span className="dash-card-label">Today</span>
            <span className="dash-card-note">{now.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
          </div>
          <ul className="dash-agenda-list">
            {home?.agenda.map((a, i) => (
              <li
                key={i}
                className={`dash-agenda-item ${a.kind}`}
                onClick={() => a.noteId && onOpenNote(a.noteId)}
                style={{ cursor: a.noteId ? "pointer" : "default" }}
              >
                <span className="dash-agenda-time">{fmtMin(a.startMin)}</span>
                <span className="dash-agenda-tick" />
                <span className="dash-agenda-body">
                  <span className="dash-agenda-title">{a.title}</span>
                  <span className="dash-agenda-kind">
                    {a.kind === "event" ? "meeting" : "focus block"} · {Math.round((a.durationMin / 60) * 10) / 10}h
                  </span>
                </span>
              </li>
            ))}
            {home && home.agenda.length === 0 && <li className="dash-empty">An open day. Fill it deliberately.</li>}
          </ul>
        </section>

        {/* loose threads checklist */}
        <section className="dash-card dash-threads">
          <div className="dash-card-head">
            <span className="dash-card-label">Loose threads</span>
            {home && (
              <span className="dash-card-note">
                {home.stats.doneTasks}/{home.stats.doneTasks + home.stats.openTasks} done
              </span>
            )}
          </div>
          <div className="dash-progress">
            <span
              className="dash-progress-fill"
              style={{
                width: home ? `${Math.round((home.stats.doneTasks / Math.max(home.stats.doneTasks + home.stats.openTasks, 1)) * 100)}%` : "0%",
              }}
            />
          </div>
          <ul className="dash-thread-list">
            {home?.focus.slice(0, 5).map((f) => (
              <li key={`${f.noteId}:${f.line}`} className="dash-thread">
                <button
                  className="dash-check"
                  aria-label={`Complete ${f.text}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void check(f.noteId, f.line);
                  }}
                />
                <span className="dash-thread-text" onClick={() => onOpenNote(f.noteId)}>
                  {f.text}
                </span>
                {f.due && <span className={`dash-due ${f.overdue ? "overdue" : ""}`}>{f.due.slice(5)}</span>}
              </li>
            ))}
            {home && home.focus.length === 0 && <li className="dash-empty">Inbox zero, thread zero.</li>}
          </ul>
        </section>

        {/* by category */}
        <section className="dash-card dash-cats">
          <div className="dash-card-head">
            <span className="dash-card-label">By category</span>
            <span className="dash-card-note">{tree.length} notes</span>
          </div>
          <div className="dash-cats-body">
            <Donut data={byCategory} total={tree.length} />
            <ul className="dash-cats-legend">
              {byCategory.map((c) => (
                <li key={c.id}>
                  <span className="dash-cat-dot" style={{ background: c.color }} />
                  <span className="dash-cat-label">{c.label}</span>
                  <span className="dash-cat-count">{Math.round((c.count / Math.max(tree.length, 1)) * 100)}%</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Editorial area sparkline — warm fill, ink stroke, marked peak. No chart lib. */
function Sparkline({ data }: { data: { day: string; count: number }[] }) {
  const w = 520;
  const h = 150;
  const pad = { t: 14, r: 8, b: 22, l: 8 };
  const max = Math.max(1, ...data.map((d) => d.count));
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const x = (i: number) => pad.l + (i / Math.max(data.length - 1, 1)) * iw;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.count).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;
  const peak = data.reduce((m, d, i) => (d.count > data[m]!.count ? i : m), 0);

  return (
    <svg className="dash-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Activity, last 14 days">
      <defs>
        <linearGradient id="dashFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--dash-accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--dash-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#dashFill)" />
      <path d={line} fill="none" stroke="var(--dash-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.count)} r={i === peak ? 4 : 0} fill="var(--dash-accent)" />
      ))}
      {data[peak]!.count > 0 && (
        <text x={x(peak)} y={y(data[peak]!.count) - 9} textAnchor="middle" className="dash-spark-peak">
          {data[peak]!.count}
        </text>
      )}
      {[0, Math.floor(data.length / 2), data.length - 1].map((i) => (
        <text key={i} x={x(i)} y={h - 6} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"} className="dash-spark-axis">
          {new Date(data[i]!.day).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
        </text>
      ))}
    </svg>
  );
}

/** Editorial donut with a centered figure. */
function Donut({ data, total }: { data: { id: string; color: string; count: number }[]; total: number }) {
  const r = 52;
  const stroke = 18;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const t = Math.max(total, 1);
  return (
    <svg className="dash-donut" viewBox="0 0 140 140" role="img" aria-label="Notes by category">
      <g transform="rotate(-90 70 70)">
        {data.map((d) => {
          const frac = d.count / t;
          const dash = frac * c;
          const seg = (
            <circle
              key={d.id}
              cx="70"
              cy="70"
              r={r}
              fill="none"
              stroke={d.color}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-offset}
            />
          );
          offset += dash;
          return seg;
        })}
      </g>
      <text x="70" y="66" textAnchor="middle" className="dash-donut-num">
        {total}
      </text>
      <text x="70" y="84" textAnchor="middle" className="dash-donut-lbl">
        notes
      </text>
    </svg>
  );
}
