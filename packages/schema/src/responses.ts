/**
 * What the server SENDS — one schema per GET endpoint the web app reads.
 *
 * The request schemas in api.ts guard what comes in; these describe what goes
 * out, so the web app's types and the server's answers come from one place.
 * apps/web imports the inferred types (type-only: no zod reaches the bundle);
 * apps/server/test/contract.test.ts calls every endpoint on a fixture-rich
 * server and parses each answer with these, so a field added, renamed or made
 * nullable on one side fails CI instead of drifting.
 *
 * Objects are strict: a field the server sends that is not written here fails
 * the contract too — the schema is the whole answer, not a subset of it.
 */
import { z } from "zod";
import { appearanceSchema, taskStatusSchema } from "./api.js";

/** A strict object: every field the server sends must be listed. */
const o = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const nstr = z.string().nullable();
const nnum = z.number().nullable();

// ---------- shared pieces ----------

export const domainSchema = z.enum(["personal", "professional", "academic"]);

/** A checkbox line as core parses it (ParsedTask). */
export const taskLineSchema = o({
  line: z.number(),
  checked: z.boolean(),
  /** Read off the checkbox: `[ ]` todo, `[/]` in progress, `[b]` blocked, `[x]` done. */
  status: z.enum(["todo", "in-progress", "blocked", "done"]),
  text: z.string(),
  raw: z.string(),
  assignee: z.string().optional(),
  start: z.string().optional(),
  due: z.string().optional(),
  priority: z.number().optional(),
  /** A `#deadline` task. */
  key: z.boolean().optional(),
  blockId: z.string().optional(),
  indent: z.number(),
});

/** A promoted task's database row. */
export const taskObjectSchema = o({
  id: z.string(),
  noteId: z.string(),
  blockId: z.string(),
  status: taskStatusSchema,
  assigneeId: nstr,
  due: nstr,
  plannedDate: nstr,
  description: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** A task line with the note it sits in. */
export const dashboardTaskSchema = taskLineSchema.extend({
  noteId: z.string(),
  notePath: z.string(),
  noteTitle: z.string(),
  project: nstr,
  object: taskObjectSchema.nullable(),
});

const teamBase = { id: z.string(), slug: z.string(), name: z.string(), color: z.string(), icon: z.string() };
export const teamSchema = o(teamBase);

const fileEntry = o({ name: z.string(), size: z.number(), mtimeMs: z.number(), ext: z.string() });

// ---------- account ----------

export const meResponse = o({
  id: z.string(),
  email: z.string(),
  username: z.string(),
  displayName: z.string(),
  isOwner: z.boolean(),
  avatar: z.string(),
  appearance: appearanceSchema.nullable(),
  teams: z.array(teamSchema),
});

export const authStatusResponse = o({ needsSetup: z.boolean() });

export const sessionsResponse = z.array(
  o({ id: z.string(), label: z.string(), createdAt: z.number(), lastSeenAt: nnum, current: z.boolean() }),
);

export const passkeysResponse = z.array(o({ id: z.string(), label: z.string(), createdAt: z.number(), lastUsedAt: nnum }));

export const healthResponse = o({ ok: z.boolean(), notes: z.number(), build: nstr });

export const aiConfigResponse = o({
  provider: nstr,
  model: nstr,
  configured: z.boolean(),
  instructions: z.string(),
  baseUrl: z.string(),
  chatgpt: o({ connected: z.boolean(), email: nstr, manageUsage: z.string() }),
});

export const aiStatusResponse = o({ configured: z.boolean(), provider: nstr, model: nstr });

/** ChatGPT plan models — only answers once a ChatGPT account is connected. */
export const chatgptModelsResponse = z.array(o({ slug: z.string(), name: z.string() }));

export const teamsResponse = z.array(o({ ...teamBase, total: z.number(), done: z.number() }));

export const teamDashboardResponse = o({
  team: teamSchema,
  projects: z.array(
    o({
      project: z.string(),
      projectId: nstr,
      slug: nstr,
      /** Front-matter lifecycle: "", planning, on-track, at-risk, blocked, sleeping, cancelled, done. */
      status: z.string(),
      total: z.number(),
      done: z.number(),
      assignees: z.array(z.string()),
      lastActivityMs: z.number().optional(),
      domain: domainSchema.nullable(),
      tasks: z.array(dashboardTaskSchema),
    }),
  ),
  members: z.array(
    o({
      id: z.string(),
      username: z.string(),
      displayName: z.string(),
      avatar: z.string(),
      openTasks: z.number(),
      inProgress: z.array(o({ text: z.string(), noteId: z.string(), project: nstr })),
      assigned: z.array(o({ text: z.string(), noteId: z.string(), due: z.string().optional(), priority: z.number().optional() })),
      lastEdit: o({ id: z.string(), title: z.string(), at: z.number() }).nullable(),
    }),
  ),
  orphaned: z.array(o({ id: z.string(), noteId: z.string(), blockId: z.string(), updatedAt: z.number() })),
});

// ---------- vault ----------

export const treeResponse = z.array(
  o({
    id: z.string(),
    path: z.string(),
    folder: z.string(),
    title: z.string(),
    hash: z.string(),
    mtimeMs: z.number(),
    tags: z.array(z.string()),
    openTasks: z.number(),
    /** Life-area, from the vault's #vault-categories rules. */
    category: z.string(),
  }),
);

export const graphResponse = o({
  nodes: z.array(
    o({
      id: z.string(),
      title: z.string(),
      folder: z.string(),
      sector: nstr,
      tags: z.array(z.string()),
      links: z.number(),
      tasks: z.number(),
      /** The note's description:/summary: front matter, else its first real sentence. */
      description: z.string(),
    }),
  ),
  edges: z.array(o({ from: z.string(), to: z.string() })),
});

export const noteResponse = o({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  content: z.string(),
  hash: z.string(),
  tags: z.array(o({ tag: z.string(), line: z.number() })),
  tasks: z.array(taskLineSchema),
  links: z.array(
    o({
      target: z.string(),
      heading: z.string().optional(),
      alias: z.string().optional(),
      raw: z.string(),
      line: z.number(),
      targetId: nstr,
      locked: z.boolean(),
    }),
  ),
  backlinks: z.array(o({ fromId: z.string(), fromTitle: z.string(), fromPath: z.string(), line: z.number(), context: z.string() })),
  canEdit: z.boolean(),
});

export const relatedResponse = z.array(o({ id: z.string(), title: z.string(), path: z.string(), score: z.number() }));

export const searchResponse = z.array(o({ id: z.string(), path: z.string(), title: z.string() }));

// ---------- planning and calendar ----------

export const timeBlockSchema = o({ id: z.string(), date: z.string(), startMin: z.number(), durationMin: z.number() });

export const planTaskSchema = o({
  noteId: z.string(),
  noteTitle: z.string(),
  line: z.number(),
  text: z.string(),
  project: nstr,
  assignee: nstr,
  /** Assigned to you, or to nobody in a note you can edit. */
  forYou: z.boolean(),
  due: nstr,
  priority: nnum,
  estimateHours: z.number(),
  expectedFinish: z.string(),
  atRisk: z.boolean(),
  blockId: nstr,
  plannedDate: nstr,
  objectId: nstr,
  blocks: z.array(timeBlockSchema),
  scheduledHours: z.number(),
  remainingHours: z.number(),
});

export const planResponse = o({
  team: o({ slug: z.string(), name: z.string(), color: z.string() }).nullable(),
  source: z.enum(["heuristic", "ai"]),
  hoursPerDay: z.number(),
  generatedAt: z.number(),
  assignees: z.array(o({ assignee: z.string(), totalHours: z.number(), tasks: z.array(planTaskSchema) })),
  atRisk: z.number(),
  totalHours: z.number(),
});

export const calEventSchema = o({
  id: z.string(),
  ownerId: z.string(),
  username: z.string(),
  mine: z.boolean(),
  title: z.string(),
  date: z.string(),
  startMin: z.number(),
  durationMin: z.number(),
  /** Set on occurrences from a subscribed ICS feed: render-only. */
  source: z.literal("ics").optional(),
  readonly: z.boolean().optional(),
  feedLabel: z.string().optional(),
  allDay: z.boolean().optional(),
});
export const eventsResponse = z.array(calEventSchema);

export const markersResponse = z.array(
  o({
    id: z.string(),
    kind: z.enum(["due", "milestone", "charge", "income"]),
    date: z.string(),
    title: z.string(),
    noteId: nstr,
    line: nnum,
    source: nstr,
    amount: nnum,
    currency: nstr,
    overdue: z.boolean(),
    priority: nnum,
    /** A `#deadline` task: a solid red chip, first in its day. */
    key: z.boolean(),
  }),
);

export const feedsResponse = z.array(
  o({ id: z.string(), label: z.string(), host: nstr, createdAt: z.number(), lastSyncedAt: nnum, lastError: nstr }),
);

export const icsTokenResponse = o({ token: nstr });

// ---------- people ----------

export const contactsResponse = z.array(
  o({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    sector: z.string(),
    role: z.string(),
    company: z.string(),
    email: z.string(),
    phone: z.string(),
    linkedin: z.string(),
    personal: z.boolean(),
  }),
);

export const companiesResponse = z.array(
  o({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    description: z.string(),
    sector: z.string(),
    linkedin: z.string(),
    website: z.string(),
    careers: z.string(),
    location: z.string(),
    /** Role types seen open there. */
    positions: z.array(z.string()),
    personal: z.boolean(),
  }),
);

// ---------- projects ----------

export const projectsResponse = z.array(
  o({
    slug: z.string(),
    key: z.string(),
    name: z.string(),
    domain: domainSchema.nullable(),
    noteId: nstr,
    total: z.number(),
    done: z.number(),
    status: nstr,
    start: nstr,
    deadline: nstr,
    nextDue: nstr,
    overdue: z.number(),
  }),
);

export const projectPersonSchema = o({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["contact", "company"]),
  role: z.string(),
  company: z.string(),
  linkedin: z.string(),
  path: z.string(),
});

export const projectNoteSchema = o({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  mtimeMs: z.number(),
  tasks: z.number(),
  done: z.number(),
});

/** A project step: a task with the `##` section of the project note it sits under. */
export const projectTaskSchema = dashboardTaskSchema.extend({ section: z.string() });

export const projectWorkspaceResponse = o({
  slug: z.string(),
  key: z.string(),
  name: z.string(),
  noteId: z.string(),
  path: z.string(),
  domain: domainSchema.nullable(),
  status: z.string(),
  start: z.string(),
  deadline: z.string(),
  prompt: z.string(),
  goals: z.array(z.string()),
  decisions: z.array(z.string()),
  inbox: z.array(z.string()),
  people: z.array(projectPersonSchema),
  notes: z.array(projectNoteSchema),
  files: z.array(fileEntry),
  content: z.string(),
  canEdit: z.boolean(),
  total: z.number(),
  done: z.number(),
  tasks: z.array(projectTaskSchema),
});

const boardBox = { id: z.string(), x: z.number(), y: z.number(), width: z.number(), height: z.number() };
export const boardNodeSchema = z.discriminatedUnion("type", [
  o({ ...boardBox, type: z.literal("file"), file: z.string() }),
  o({ ...boardBox, type: z.literal("group"), label: z.string(), color: z.string().optional() }),
]);
export const boardEdgeSchema = o({
  id: z.string(),
  fromNode: z.string(),
  toNode: z.string(),
  label: z.string().optional(),
  /** Proposed by Claude, drawn dashed until accepted. */
  basaltSuggested: z.literal(true).optional(),
});
export const boardResponse = o({ nodes: z.array(boardNodeSchema), edges: z.array(boardEdgeSchema), canEdit: z.boolean() });

// ---------- the document reader ----------

export const docHtmlResponse = o({ html: z.string(), messages: z.number() });

export const sheetSchema = o({ name: z.string(), rows: z.array(z.array(z.string())), truncated: z.boolean(), totalRows: z.number() });
export const sheetResponse = o({ sheets: z.array(sheetSchema), sheetCount: z.number() });

export const slideBlockSchema = z.discriminatedUnion("kind", [
  o({ kind: z.literal("p"), text: z.string(), level: z.number() }),
  o({ kind: z.literal("table"), rows: z.array(z.array(z.string())) }),
]);
export const deckResponse = o({
  slides: z.array(
    o({
      n: z.number(),
      title: z.string(),
      hidden: z.boolean(),
      blocks: z.array(slideBlockSchema),
      images: z.array(o({ ref: z.string(), alt: z.string() })),
      notes: z.string(),
    }),
  ),
  slideCount: z.number(),
  truncated: z.boolean(),
  /** data: URLs by key; a logo on every slide is sent once. */
  media: z.record(z.string()),
  omittedImages: z.number(),
});

// ---------- finance ----------

export const moneyItemSchema = o({
  service: z.string(),
  amount: z.number(),
  currency: z.string(),
  cadence: z.string(),
  next: nstr,
  monthly: z.number(),
  /** Statement descriptors this line answers to (its Match column). */
  match: z.array(z.string()),
  category: z.string(),
  note: z.string(),
});
const totals = z.array(o({ currency: z.string(), monthly: z.number() }));

export const activitySchema = o({
  charges: z.number(),
  months: z.number(),
  first: nstr,
  last: nstr,
  total: z.number(),
  seen: z.array(z.string()),
  /** The statement descriptors this line matched, biggest first. */
  merchants: z.array(z.string()),
});
export const ledgerSchema = o({ totals, items: z.array(moneyItemSchema), count: z.number(), activity: z.record(activitySchema) });

export const payslipRowSchema = o({
  month: z.string(),
  gross: nnum,
  net: nnum,
  tax: nnum,
  hours: nnum,
  rate: nnum,
  file: z.string(),
  effectiveNet: nnum,
});

export const savingsSchema = o({
  incomeMonthly: z.number(),
  incomeSource: z.enum(["balance", "payslips", "ledger", "none"]),
  spendMonthly: z.number(),
  /** Everything that left the account, transfers included. */
  outflowMonthly: z.number(),
  surplus: z.number(),
  committedMonthly: z.number(),
  discretionaryMonthly: z.number(),
  trimmable: z.number(),
  /** The two real months the headroom is measured between. */
  typicalMonth: nstr,
  goodMonth: nstr,
  target: z.number(),
  targetRate: nnum,
  observed: nnum,
  headroom: z.array(o({ category: z.string(), typical: z.number(), good: z.number(), save: z.number() })),
  emergencyFund: z.number(),
  monthsToFund: nnum,
  basedOn: z.number(),
});

export const recurringSchema = o({
  merchant: z.string(),
  amount: z.number(),
  months: z.array(z.string()),
  everyMonths: z.number(),
  first: z.string(),
  last: z.string(),
  total: z.number(),
  active: z.boolean(),
});

const merchantTotal = o({ name: z.string(), total: z.number(), count: z.number() });

export const financeResponse = o({
  notes: o({ income: nstr, subscriptions: nstr, payslips: nstr, area: nstr }),
  income: ledgerSchema,
  subscriptions: ledgerSchema,
  payslips: z.array(payslipRowSchema),
  savings: savingsSchema,
  recurring: z.array(recurringSchema),
  summary: o({
    inPerMonth: z.number(),
    outPerMonth: z.number(),
    net: z.number(),
    balance: nnum,
    balanceDate: nstr,
    runwayMonths: nnum,
    avgSpend: z.number(),
    burn: nnum,
    /** Monthly change in balance; positive means the account is growing. */
    drift: nnum,
    spanMonths: z.number(),
  }),
  spending: o({
    months: z.array(o({ month: z.string(), spend: z.number(), fees: z.number(), refunds: z.number(), movedIn: z.number(), movedOut: z.number() })),
    dataThrough: nstr,
    categories: o({
      noteId: nstr,
      rules: z.array(o({ category: z.string(), colour: nstr })),
      months: z.array(o({ month: z.string(), byCategory: z.record(z.number()), committed: z.record(z.number()), total: z.number() })),
      forecast: z.array(
        o({
          category: z.string(),
          typical: z.number(),
          low: z.number(),
          high: z.number(),
          months: z.number(),
          last: nnum,
          merchants: z.array(merchantTotal),
        }),
      ),
      /** Null under three complete months, where no honest figure exists. */
      typical: nnum,
      completeMonths: z.number(),
      lastComplete: nstr,
    }),
    fixed: z.number(),
    variable: z.number(),
    matched: z.array(z.string()),
    txnCount: z.number(),
    skipped: z.number(),
  }),
  files: z.array(fileEntry),
});

export const financeCategoryResponse = o({
  category: z.string(),
  colour: nstr,
  years: z.array(z.string()),
  year: nstr,
  series: z.array(o({ month: z.string(), total: z.number(), count: z.number(), hasData: z.boolean(), future: z.boolean(), partial: z.boolean() })),
  /** Every year the statements reach, for the "Year" view. */
  yearly: z.array(o({ year: z.string(), total: z.number(), count: z.number(), partial: z.boolean() })),
  merchants: z.array(merchantTotal),
  stats: o({ total: z.number(), count: z.number(), activeMonths: z.number(), high: z.number(), low: z.number() }),
});

export const financeMonthResponse = o({
  month: z.string(),
  category: nstr,
  complete: z.boolean(),
  total: z.number(),
  movedOut: z.number(),
  movedIn: z.number(),
  refunded: z.number(),
  count: z.number(),
  transferCount: z.number(),
  typical: z.number(),
  categories: z.array(o({ category: z.string(), total: z.number(), count: z.number(), colour: nstr, typical: z.number() })),
  prev: nstr,
  next: nstr,
  transactions: z.array(
    o({
      date: z.string(),
      description: z.string(),
      amount: z.number(),
      refund: z.boolean(),
      moved: z.boolean(),
      type: z.string(),
      balance: nnum,
      category: z.string(),
    }),
  ),
});

export const financeMerchantResponse = o({
  merchant: z.string(),
  years: z.array(z.string()),
  year: nstr,
  /** Which way the money mostly goes here — a merchant is not always somewhere you spend. */
  direction: z.enum(["in", "out"]),
  transactions: z.array(o({ date: z.string(), amount: z.number(), refund: z.boolean(), type: z.string(), balance: nnum })),
  months: z.array(o({ month: z.string(), total: z.number() })),
  stats: o({
    total: z.number(),
    count: z.number(),
    average: z.number(),
    biggest: z.number(),
    first: nstr,
    last: nstr,
    allTime: z.number(),
  }),
});

// ---------- the dashboard ----------

const homeLedger = o({ noteId: nstr, totals, items: z.array(moneyItemSchema), count: z.number() });

export const homeResponse = o({
  user: o({ displayName: z.string(), username: z.string() }),
  stats: o({
    notes: z.number(),
    sessions: z.number(),
    openTasks: z.number(),
    doneTasks: z.number(),
    overdueTasks: z.number(),
    weekHours: z.number(),
  }),
  deadlines: z.array(
    o({
      noteId: z.string(),
      noteTitle: z.string(),
      line: z.number(),
      text: z.string(),
      project: nstr,
      due: z.string(),
      priority: nnum,
      /** A `#deadline` task; upcoming ones sort to the top. */
      key: z.boolean(),
      overdue: z.boolean(),
      days: z.number(),
    }),
  ),
  agenda: z.array(
    o({
      kind: z.enum(["event", "task", "due", "charge", "income"]),
      date: z.string(),
      title: z.string(),
      startMin: nnum,
      durationMin: nnum,
      noteId: nstr,
      line: nnum,
      /** Feed label for a calendar event, project for a due task. */
      source: nstr,
      amount: nnum,
      currency: nstr,
      key: z.boolean(),
    }),
  ),
  focus: z.array(
    o({
      noteId: z.string(),
      noteTitle: z.string(),
      line: z.number(),
      text: z.string(),
      project: nstr,
      due: nstr,
      priority: nnum,
      assignee: nstr,
      overdue: z.boolean(),
    }),
  ),
  finance: o({ out: homeLedger, in: homeLedger, net: totals }),
  /** What the statement says the month is doing. Null with no statement filed. */
  spending: o({
    month: z.string(),
    total: z.number(),
    typical: z.number(),
    categories: z.array(o({ category: z.string(), total: z.number(), typical: z.number(), colour: nstr })),
    running: o({ month: z.string(), total: z.number(), dayOf: z.number(), daysIn: z.number() }).nullable(),
    savings: o({
      target: z.number(),
      surplus: z.number(),
      trimmable: z.number(),
      observed: nnum,
      targetRate: nnum,
      top: z.array(o({ category: z.string(), save: z.number(), colour: nstr })),
    }),
    basedOn: z.number(),
  }).nullable(),
});

// ---------- mail ----------

export const mailAccountResponse = o({
  connected: z.boolean(),
  email: nstr,
  imapHost: nstr,
  lastCheckedAt: nnum,
  lastError: nstr,
});

export const mailDraftsResponse = z.array(
  o({
    id: z.string(),
    to: z.string(),
    subject: z.string(),
    body: z.string(),
    inReplyTo: nstr,
    references: nstr,
    createdBy: z.enum(["agent", "token"]),
    createdAt: z.number(),
  }),
);

export const mailCategorySchema = z.enum(["primary", "social", "promotions", "updates", "forums"]);

/** Live IMAP — not exercised by the contract test (no mail server there). */
export const mailInboxResponse = o({
  email: z.string(),
  messages: z.array(
    o({
      uid: z.number(),
      from: z.string(),
      fromName: z.string(),
      subject: z.string(),
      date: nstr,
      seen: z.boolean(),
      messageId: nstr,
      category: mailCategorySchema,
    }),
  ),
});

/** Live IMAP — not exercised by the contract test. */
export const mailMessageResponse = o({
  uid: z.number(),
  from: z.string(),
  fromName: z.string(),
  to: z.string(),
  subject: z.string(),
  date: nstr,
  text: z.string(),
  html: nstr,
  messageId: nstr,
  references: nstr,
});

// ---------- integrations ----------

export const tokensResponse = z.array(o({ id: z.string(), label: z.string(), prefix: z.string(), createdAt: z.number(), lastUsedAt: nnum }));

export const webhooksResponse = z.array(
  o({
    id: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    active: z.boolean(),
    createdAt: z.number(),
    lastStatus: nnum,
    lastFiredAt: nnum,
  }),
);

// ---------- inferred types for the web app ----------

export type TaskLine = z.infer<typeof taskLineSchema>;
export type TaskObject = z.infer<typeof taskObjectSchema>;
export type DashboardTask = z.infer<typeof dashboardTaskSchema>;
export type Team = z.infer<typeof teamSchema>;
export type Me = z.infer<typeof meResponse>;
export type SessionInfo = z.infer<typeof sessionsResponse>[number];
export type AiConfig = z.infer<typeof aiConfigResponse>;
export type DashboardData = z.infer<typeof teamDashboardResponse>;
export type TreeNote = z.infer<typeof treeResponse>[number];
export type GraphData = z.infer<typeof graphResponse>;
export type NoteDetail = z.infer<typeof noteResponse>;
export type NoteLink = NoteDetail["links"][number];
export type SearchHit = z.infer<typeof searchResponse>[number];
export type TimeBlock = z.infer<typeof timeBlockSchema>;
export type PlanTask = z.infer<typeof planTaskSchema>;
export type PlanData = z.infer<typeof planResponse>;
export type CalEvent = z.infer<typeof calEventSchema>;
export type DayMarker = z.infer<typeof markersResponse>[number];
export type Feed = z.infer<typeof feedsResponse>[number];
export type Contact = z.infer<typeof contactsResponse>[number];
export type Company = z.infer<typeof companiesResponse>[number];
export type ProjectRow = z.infer<typeof projectsResponse>[number];
export type ProjectPerson = z.infer<typeof projectPersonSchema>;
export type ProjectNote = z.infer<typeof projectNoteSchema>;
export type ProjectFile = z.infer<typeof fileEntry>;
export type ProjectTask = z.infer<typeof projectTaskSchema>;
export type ProjectWorkspace = z.infer<typeof projectWorkspaceResponse>;
export type BoardNode = z.infer<typeof boardNodeSchema>;
export type BoardEdge = z.infer<typeof boardEdgeSchema>;
export type Board = z.infer<typeof boardResponse>;
export type Sheet = z.infer<typeof sheetSchema>;
export type SlideBlock = z.infer<typeof slideBlockSchema>;
export type Deck = z.infer<typeof deckResponse>;
export type MoneyItem = z.infer<typeof moneyItemSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type Ledger = z.infer<typeof ledgerSchema>;
export type PayslipRow = z.infer<typeof payslipRowSchema>;
export type Savings = z.infer<typeof savingsSchema>;
export type Recurring = z.infer<typeof recurringSchema>;
export type FinanceData = z.infer<typeof financeResponse>;
export type CategoryDetail = z.infer<typeof financeCategoryResponse>;
export type MonthDetail = z.infer<typeof financeMonthResponse>;
export type MerchantDetail = z.infer<typeof financeMerchantResponse>;
export type HomeData = z.infer<typeof homeResponse>;
export type MailAccount = z.infer<typeof mailAccountResponse>;
export type PendingDraft = z.infer<typeof mailDraftsResponse>[number];
export type MailCategory = z.infer<typeof mailCategorySchema>;
export type InboxItem = z.infer<typeof mailInboxResponse>["messages"][number];
export type MailMessage = z.infer<typeof mailMessageResponse>;
export type ApiToken = z.infer<typeof tokensResponse>[number];
export type Webhook = z.infer<typeof webhooksResponse>[number];
