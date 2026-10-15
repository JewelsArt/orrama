/** Planning test data: a step, a dated marker and an event, with sensible defaults. */
import type { CalEvent, DayMarker, PlanTask } from "@orrama/schema/responses";

export const task = (o: Partial<PlanTask> & { text: string }): PlanTask => ({
  noteId: "n-thesis",
  noteTitle: "Graduation thesis",
  line: 5,
  project: "Graduation thesis",
  assignee: null,
  forYou: true,
  due: null,
  priority: null,
  estimateHours: 2,
  expectedFinish: "2026-10-09",
  atRisk: false,
  blockId: null,
  plannedDate: null,
  objectId: null,
  blocks: [],
  scheduledHours: 0,
  remainingHours: 2,
  ...o,
});
export const marker = (o: Partial<DayMarker> & { id: string; date: string; title: string }): DayMarker => ({
  kind: "due",
  noteId: "n-thesis",
  line: 5,
  source: "Graduation thesis",
  amount: null,
  currency: null,
  overdue: false,
  priority: null,
  key: false,
  ...o,
});
export const event = (o: Partial<CalEvent> & { id: string; date: string; title: string }): CalEvent => ({
  ownerId: "u1",
  username: "jules",
  mine: true,
  startMin: 600,
  durationMin: 60,
  ...o,
});
