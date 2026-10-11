/**
 * Personal dashboard aggregates — one call that powers the Dashboard tab. Every
 * number is a view over the requester's readable vault (ACL-filtered like all
 * else): counts, a 14-day activity sparkline from note mtimes, this week's
 * booked hours, today's agenda (own events + task blocks), and the tasks most
 * worth doing next. Category colouring stays client-side (categories.ts).
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  completeMonths,
  recentMonths,
  monthlyByCategory,
  monthlyTotals,
  parseCategoryRules,
  parseSubscriptions,
  typicalMonth,
  isoLocal,
  parsePayslipTable,
} from "@basalt/core";
import { ownerOf } from "../calendarNotes.js";
import { tables, type Db } from "../db.js";
import type { VaultStore } from "../vaultStore.js";
import { buildRules, financeNote, ledgerNote, netTotals, planSavings, statementsFor, typicalAround } from "./finance.js";
import { icsEventsFor } from "./ics.js";

/** The wall-calendar date, in the timezone the server is standing in. */
const iso = isoLocal;

/**
 * Claude Code drops a transcript per session into `Claude Sessions/` — 550 of
 * the vault's 613 files. They are ordinary notes (indexed, searchable,
 * linkable) and stay that way everywhere else; they are just not *knowledge
 * base*. Counting them made "Total notes" a measure of how much Claude has run
 * rather than how much Jules has written, and it swamped every derived figure:
 * the category donut read 76% "Claude & tools", and one bulk re-index of the
 * folder was the whole 14-day activity trend. So the dashboard counts the
 * curated vault and reports the transcripts as their own number.
 *
 * Tasks are deliberately NOT filtered — no transcript contains a checkbox, so
 * open/done counts were already clean, and a `- [ ]` that ever does appear in
 * one is a real task Jules wrote mid-session.
 *
 * Mirrored client-side by `isSessionLog` in apps/web/src/categories.ts, which
 * shapes the donut off the note tree. Change one, change the other.
 */
const SESSION_DIR = "Claude Sessions/";
const isSessionLog = (notePath: string) => notePath.startsWith(SESSION_DIR);

export async function homeRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  app.get("/api/home", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const grants = store.grants();
    const projects = store.projects();
    const notes = store.readable(user);
    const curated = notes.filter((n) => !isSessionLog(n.path));
    const tasks = store.index.tasks(user, grants, projects);

    const open = tasks.filter((t) => !t.checked);
    const done = tasks.filter((t) => t.checked);

    const today = new Date();
    today.setHours(12, 0, 0, 0);

    // My task blocks between two dates: the rows of MY calendar notes, on
    // tasks I can still read. A block is a row of its booker's calendar note
    // (calendarNotes.ts) — that is the only place one comes from, so whose it
    // is is the note's `calendar:`, not the task's @assignee. Selecting by
    // `assigneeId = me` dropped every block on a task without an @mention (the
    // Dashboard said 0 h booked for a full week) and counted someone else's
    // block on a task that mentions me (audit COR-003).
    const readableIds = new Set(notes.map((n) => n.id));
    const myCalNotes = store.index.all().filter((n) => ownerOf(n) === user.username).map((n) => n.id);
    const myBlocks = (from: string, to: string) => {
      if (myCalNotes.length === 0) return [];
      const rows = db
        .select({ block: tables.taskBlocks, obj: tables.taskObjects })
        .from(tables.taskBlocks)
        .innerJoin(tables.taskObjects, eq(tables.taskBlocks.taskObjectId, tables.taskObjects.id))
        .where(and(inArray(tables.taskBlocks.calNoteId, myCalNotes), gte(tables.taskBlocks.date, from), lte(tables.taskBlocks.date, to)))
        .all();
      return rows.filter((r) => readableIds.has(r.obj.noteId));
    };

    // This week's booked hours (my task blocks Mon–Sun).
    const monday = new Date(today);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const sunday = new Date(monday.getTime() + 6 * 86_400_000);
    const weekBlocks = myBlocks(iso(monday), iso(sunday)).map((r) => r.block);
    const weekHours = Math.round((weekBlocks.reduce((s, b) => s + b.durationMin, 0) / 60) * 10) / 10;

    // The Finance area: two ledgers, each a note carrying a Markdown table, found
    // by tag so they can live anywhere. Same parser both ways — income names the
    // first column "Source" instead of "Service", which is the only difference.
    const subsNote = financeNote(store, user, "subscriptions");
    const incomeNote = financeNote(store, user, "income");
    const subsNoteId = subsNote?.id ?? null;
    const subscriptions = subsNote ? parseSubscriptions(subsNote.content, iso(today)) : [];
    const income = incomeNote ? parseSubscriptions(incomeNote.content, iso(today)) : [];

    // Agenda for the next 7 days. Everything dated that is coming up, from all
    // four places it can live — which is the point of the card, and why it used
    // to be permanently empty: it read the `events` table alone and so was blind
    // to subscribed calendars, to the tasks Jules actually dates, and to money.
    const todayKey = iso(today);
    const weekEndKey = iso(new Date(today.getTime() + 6 * 86_400_000));
    const rangeBlocks = myBlocks(todayKey, weekEndKey);
    const rangeEvents = db
      .select()
      .from(tables.events)
      .where(and(eq(tables.events.ownerId, user.id), gte(tables.events.date, todayKey), lte(tables.events.date, weekEndKey)))
      .all();
    // Subscribed calendars (Google et al) are expanded per request from the
    // stored ICS, exactly as routes/calendar.ts does for Planning — there is no
    // Google API here, just the secret .ics URL the user pasted into Settings.
    const icsItems = await icsEventsFor(db, user.id, user.username, todayKey, weekEndKey).catch(() => []);

    type AgendaRow = {
      kind: "event" | "task" | "due" | "charge" | "income";
      date: string;
      title: string;
      /** Minutes past midnight; null for all-day rows, which sort before timed ones. */
      startMin: number | null;
      durationMin: number | null;
      noteId: string | null;
      line: number | null;
      source: string | null;
      amount: number | null;
      currency: string | null;
      /** A `#deadline` task: drawn on its own and first in its day. */
      key: boolean;
    };
    const row = (r: Partial<AgendaRow> & Pick<AgendaRow, "kind" | "date" | "title">): AgendaRow => ({
      startMin: null, durationMin: null, noteId: null, line: null, source: null, amount: null, currency: null, key: false, ...r,
    });

    const agenda: AgendaRow[] = [
      ...rangeEvents.map((e) => row({ kind: "event", date: e.date, title: e.title, startMin: e.startMin, durationMin: e.durationMin })),
      ...icsItems.map((e) => row({ kind: "event", date: e.date, title: e.title, startMin: e.allDay ? null : e.startMin, durationMin: e.durationMin, source: e.feedLabel ?? "calendar" })),
      ...rangeBlocks.map(({ block: b, obj }) => {
        const note = store.index.get(obj.noteId);
        const line = note?.tasks.find((t) => t.blockId === obj.blockId);
        return row({ kind: "task", date: b.date, title: line?.text ?? note?.title ?? "Task", startMin: b.startMin, durationMin: b.durationMin, noteId: note?.id ?? null, line: line?.line ?? null });
      }),
      // Tasks due inside the window. The Deadlines card is sorted oldest-first
      // and so opens on what is already late; this is the other question — what
      // lands this week — and today they do not overlap at all.
      ...open
        .filter((t) => t.due && t.due >= todayKey && t.due <= weekEndKey)
        .map((t) => row({ kind: "due", date: t.due!, title: t.text, noteId: t.noteId, line: t.line, source: t.project, key: !!t.key })),
      ...subscriptions
        .filter((sub) => sub.next && sub.next >= todayKey && sub.next <= weekEndKey)
        .map((sub) => row({ kind: "charge", date: sub.next!, title: sub.service, noteId: subsNoteId, amount: -sub.amount, currency: sub.currency })),
      ...income
        .filter((inc) => inc.next && inc.next >= todayKey && inc.next <= weekEndKey)
        .map((inc) => row({ kind: "income", date: inc.next!, title: inc.service, noteId: incomeNote?.id ?? null, amount: inc.amount, currency: inc.currency })),
    ].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        Number(b.key) - Number(a.key) ||
        (a.startMin ?? -1) - (b.startMin ?? -1) ||
        a.title.localeCompare(b.title),
    );

    // Deadlines: every open task that carries a date, oldest first, so the card
    // opens on what is actually late rather than on what was typed last. 44 of
    // the 97 open tasks are dated and 20 of those are past — a number that had
    // no home on the dashboard before. Undated work is not missing, it is what
    // the priority-ordered `focus` list below is for.
    const todayStr = iso(today);
    const DAY = 86_400_000;
    // Key deadlines still ahead go first: the card shows six rows, and on a
    // vault with forty late tasks an upcoming #deadline would never reach them.
    const upcomingKey = (t: (typeof open)[number]) => !!t.key && t.due! >= todayStr;
    const deadlines = open
      .filter((t) => t.due)
      .sort(
        (a, b) =>
          Number(upcomingKey(b)) - Number(upcomingKey(a)) ||
          a.due!.localeCompare(b.due!) ||
          a.noteTitle.localeCompare(b.noteTitle),
      )
      .slice(0, 24)
      .map((t) => ({
        noteId: t.noteId,
        noteTitle: t.noteTitle,
        line: t.line,
        text: t.text,
        project: t.project,
        due: t.due!,
        priority: t.priority ?? null,
        key: !!t.key,
        overdue: t.due! < todayStr,
        // Signed whole days from today; negative is late. Both dates are parsed
        // as UTC midnight so DST never turns a 7-day gap into 6.96.
        days: Math.round((Date.parse(`${t.due!}T00:00:00Z`) - Date.parse(`${todayStr}T00:00:00Z`)) / DAY),
      }));

    // Focus: the open tasks most worth doing next.
    const focus = [...open]
      .sort(
        (a, b) =>
          (a.priority ?? 4) - (b.priority ?? 4) ||
          (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
          a.noteTitle.localeCompare(b.noteTitle),
      )
      .slice(0, 6)
      .map((t) => ({
        noteId: t.noteId,
        noteTitle: t.noteTitle,
        line: t.line,
        text: t.text,
        project: t.project,
        due: t.due ?? null,
        priority: t.priority ?? null,
        assignee: t.assignee ?? null,
        overdue: !!t.due && t.due < todayStr,
      }));

    return {
      user: { displayName: db.select().from(tables.users).where(eq(tables.users.id, user.id)).get()?.displayName ?? user.username, username: user.username },
      stats: {
        notes: curated.length,
        sessions: notes.length - curated.length,
        openTasks: open.length,
        doneTasks: done.length,
        overdueTasks: open.filter((t) => t.due && t.due < todayStr).length,
        weekHours,
      },
      deadlines,
      agenda,
      focus,
      /**
       * What the month is actually doing, not just what the ledgers plan for.
       *
       * The card used to show income minus commitments and call it "left per
       * month", which is a number about intentions: it knows nothing about the
       * €1,000 of groceries, transport and everything else that leaves by card.
       * This is the same pipeline the Finance tab runs, compacted to the four
       * figures a dashboard has room for.
       */
      /**
       * What the month actually cost, and what could be put aside.
       *
       * Anchored on the LAST COMPLETE month, not the one in progress. On the
       * 3rd of September the current month is three days of data, and a
       * dashboard leading with €187 against a typical €1,809 is a fact about
       * the calendar rather than about spending. The month in progress is still
       * reported, underneath, where it cannot be mistaken for the headline.
       */
      spending: await (async () => {
        const { txns, complete, currency } = await statementsFor(store, user);
        if (txns.length === 0) return null;
        const rulesNote = ledgerNote(store, user, "spending-categories");
        const rules = buildRules(rulesNote ? parseCategoryRules(rulesNote.content) : [], subscriptions, txns);
        const catMonths = monthlyByCategory(txns, rules);
        const last = txns[txns.length - 1]!.date;
        const allComplete = completeMonths(catMonths, complete);
        const finished = recentMonths(allComplete); // the same window as the Finance tab
        // One typicalMonth(), shared with the Finance tab (audit). It answers
        // null under three complete months, which is the same threshold the
        // card's own empty state already tells the user about — so the card is
        // withheld rather than leading with "below a typical €0".
        if (typicalMonth(finished) === null) return null;

        const slipNote = ledgerNote(store, user, "payslips");
        // The Finance tab's own planSavings, so the two screens cannot quote
        // different targets from one set of numbers.
        const savings = planSavings(txns, finished, {
          payslipNet: (slipNote ? parsePayslipTable(slipNote.content) : [])
            .map((r) => r.net)
            .filter((n): n is number => n !== null),
          ledger: monthlyTotals(income),
          currency,
        });

        const month = finished[finished.length - 1]!;
        // The card leads with a month and opens that month's page, so it
        // compares the way the page does: against the months around it,
        // itself excluded (typicalAround).
        const running = catMonths.find((m) => m.month === last.slice(0, 7));
        const [y, mo, d] = last.split("-").map(Number) as [number, number, number];
        const colourOf = (name: string) => rules.find((r) => r.category === name)?.colour ?? null;

        return {
          /** The last COMPLETE month — the one the card leads with. */
          month: month.month,
          total: month.total,
          typical: typicalAround(allComplete, month.month, null),
          /** Its biggest categories, each a door to that month filtered. */
          categories: Object.entries(month.byCategory)
            .map(([category, total]) => ({
              category,
              total: Math.round(total * 100) / 100,
              typical: typicalAround(allComplete, month.month, category),
              colour: colourOf(category),
            }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 5),
          /** The month still running, reported but never as the headline. */
          running:
            running && running.month !== month.month
              ? { month: running.month, total: running.total, dayOf: d, daysIn: new Date(Date.UTC(y, mo, 0)).getUTCDate() }
              : null,
          savings: {
            target: savings.target,
            surplus: savings.surplus,
            trimmable: savings.trimmable,
            observed: savings.observed,
            targetRate: savings.targetRate,
            top: savings.headroom.slice(0, 3).map((h) => ({ category: h.category, save: h.save, colour: colourOf(h.category) })),
          },
          basedOn: finished.length,
        };
      })(),
      finance: {
        out: {
          noteId: subsNoteId,
          totals: monthlyTotals(subscriptions),
          items: [...subscriptions].sort((a, b) => (a.next ?? "9999").localeCompare(b.next ?? "9999")).slice(0, 8),
          count: subscriptions.length,
        },
        in: {
          noteId: incomeNote?.id ?? null,
          totals: monthlyTotals(income),
          items: [...income].sort((a, b) => (a.next ?? "9999").localeCompare(b.next ?? "9999")).slice(0, 8),
          count: income.length,
        },
        /** In minus out, per currency. Only currencies that appear on both sides
         *  can net honestly; one that appears on a single side is passed through
         *  as-is rather than being converted at a rate we do not have. */
        net: netTotals(income, subscriptions),
      },
    };
  });
}
