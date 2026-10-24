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

/** GET /api/tasks: every task the caller can read, with its promoted object (Today's Due). */
export const tasksResponse = z.array(dashboardTaskSchema);

/** A step as its card shows it (GET /api/tasks/card, and the answer to every card change). */
export const taskCardResponse = o({
  task: taskLineSchema.extend({
    noteId: z.string(),
    notePath: z.string(),
    noteTitle: z.string(),
    /** The words as typed: the line without its box, block id, dates, priority and `#deadline`. */
    words: z.string(),
  }),
  canEdit: z.boolean(),
  /** The project the step's note belongs to, if any. */
  project: o({ slug: z.string(), name: z.string() }).nullable(),
  /** The `##` heading above the step in its note, if any. */
  section: nstr,
  /** Where it can be moved: every project whose note you can edit, with that note's sections. */
  places: z.array(o({ slug: z.string(), name: z.string(), sections: z.array(z.string()) })),
  /** Whether the step already sits in your inbox note. */
  inInbox: z.boolean(),
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

export const authStatusResponse = o({ needsSetup: z.boolean(), chooseNotes: z.boolean() });

/**
 * What every way in answers (sign-up, password, passcode, Touch ID, the switch from a stored
 * token): the account, nothing else. The session is the HttpOnly cookie set beside it, never in
 * the body, where any script on the page could read it (WEB-013).
 */
export const signInResponse = o({ user: meResponse });

export const sessionsResponse = z.array(
  o({ id: z.string(), label: z.string(), createdAt: z.number(), lastSeenAt: nnum, current: z.boolean() }),
);

export const passkeysResponse = z.array(o({ id: z.string(), label: z.string(), createdAt: z.number(), lastUsedAt: nnum }));

/** `source`: the repository this server's code comes from, linked from Settings (AGPL §13). */
export const healthResponse = o({ ok: z.boolean(), notes: z.number(), build: nstr, source: z.string() });

/** The accounts on this server (Settings → Access, shown only when there is more than one). */
export const membersResponse = z.array(o({ id: z.string(), username: z.string(), displayName: z.string(), isOwner: z.boolean(), avatar: z.string() }));

/** Settings → Notes: the folder the notes are read from (home as ~), how many, the version. Owners only. */
export const serverSettingsResponse = o({
  notesFolder: z.string(),
  notes: z.number(),
  version: z.string(),
  /** Set where Orrama starts (ORRAMA_VAULT_DIR): shown, not changed in the app. */
  fixed: z.boolean(),
  /** Orrama's own folder is the one being read. */
  own: z.boolean(),
  /** How many of the example's notes are here (Remove the example). */
  example: z.number(),
});

/** `POST /api/settings/notes-folder/look`: a folder, looked at before it is chosen. */
export const folderLookResponse = o({
  folder: z.string(),
  problem: nstr,
  notes: z.number(),
  more: z.boolean(),
  unstamped: z.number(),
  ontology: z.boolean(),
  current: z.boolean(),
});
export const startResponse = o({ ontology: z.enum(["written", "there"]), example: z.number() });

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

/** `/api/dashboard`: the same board with no team, every project the requester can see (the Projects board). */
export const dashboardResponse = teamDashboardResponse.extend({ team: z.null() });

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

/** GET /api/vault/folders: every folder the reader may see, empty ones too (1C). */
export const foldersResponse = z.array(z.string());

/** GET /api/vault/trash: what is in the trash that the reader could read where it came from (1C). */
export const trashResponse = z.array(
  o({
    /** Its path now, under `.trash/`: what restore takes. */
    path: z.string(),
    /** Where it came from, and goes back to. */
    from: z.string(),
    title: z.string(),
    kind: z.enum(["note", "file"]),
    /** When it went in. */
    at: z.number(),
    canRestore: z.boolean(),
  }),
);

/** GET /api/vault/note/:id/linkers?to=: the notes whose exact links follow a rename or move (1C). */
export const linkersResponse = o({
  notes: z.array(o({ id: z.string(), path: z.string(), title: z.string(), links: z.number(), canEdit: z.boolean() })),
  /** Links to the note that won't follow: Markdown links, or ones in notes the reader can't edit. */
  other: z.number(),
});

/** GET /api/vault/note/:id/history: the note's earlier versions, newest first. */
export const historyResponse = o({
  revisions: z.array(o({ seq: z.number(), at: z.number(), authorId: nstr, length: z.number(), content: z.string().optional() })),
  nextBefore: nnum,
  total: z.number(),
});

/** GET /api/vault/note/:id/history/:seq: one version's text. */
export const revisionResponse = o({ seq: z.number(), at: z.number(), authorId: nstr, content: z.string() });

/** GET /api/areas: the life areas in order, each with how many notes and projects it holds (routes/areas.ts, 1D). */
export const lifeAreasResponse = o({
  areas: z.array(
    o({
      /** The name's slug: what a tree note's `category` says. */
      id: z.string(),
      name: z.string(),
      /** "Also put notes here when their folder or tags contain…", as written. */
      words: z.array(z.string()),
      /** The area for everything no other area claims; exactly one. */
      catchAll: z.boolean(),
      notes: z.number(),
      projects: z.number(),
    }),
  ),
  /** The note that holds the list, or null while the vault has none (Settings makes it on the first change). */
  note: o({ id: z.string(), path: z.string(), hash: z.string() }).nullable(),
  /** Can this reader change the list? */
  canEdit: z.boolean(),
});

/** GET /api/notes/overview: Notes home's pins and counts (routes/notesHome.ts, R7). */
export const notesOverviewResponse = o({
  /** Ids of the readable notes whose front matter says `pinned: true`, by title. */
  pinned: z.array(z.string()),
  notes: z.number(),
  conversations: z.number(),
  openTasks: z.number(),
  doneTasks: z.number(),
});

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
      /** "conversation" for a saved chat (`type: claude-session`); the map hides those by default. */
      kind: z.enum(["note", "conversation"]),
      /** The note's description:/summary: front matter, else its first real sentence. */
      description: z.string(),
    }),
  ),
  edges: z.array(
    o({
      from: z.string(),
      to: z.string(),
      /** A typed relation (works_at, involves, part_of, about, supervises…), read from `from` to `to`; absent on a plain link. */
      relation: z.string().optional(),
      /** True when no link in the text says it: the relation comes from a tag, a field or a conversation's front matter. */
      implied: z.literal(true).optional(),
    }),
  ),
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
  /** The heuristic for now: the model is being asked about this task. */
  refining: z.boolean(),
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
  /** "ai" once the model has answered for every open task. */
  source: z.enum(["heuristic", "ai"]),
  /** Some estimates are the heuristic until the model answers: `GET /api/plan?refined=1` waits for them. */
  refining: z.boolean(),
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
  /** A subscribed occurrence's location, description (plain text) and links (http(s) only). */
  details: o({
    location: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    conference: z.string().optional(),
  }).optional(),
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
    /** `company:` as written (a link or a name). */
    company: z.string(),
    /** The company note it names, or null: a name with no note yet (who works where, 1F). */
    companyId: z.string().nullable(),
    email: z.string(),
    phone: z.string(),
    linkedin: z.string(),
    personal: z.boolean(),
  }),
);

/** GET /api/contacts/:id/projects: the projects a person supervises or is listed in (1F). */
export const contactProjectsResponse = z.array(
  o({
    /** The project note's id. */
    id: z.string(),
    title: z.string(),
    slug: z.string(),
    relation: z.enum(["supervises", "involved"]),
  }),
);
export type ContactProject = z.infer<typeof contactProjectsResponse>[number];

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

/** GET /api/people/context: each person's and company's graph relations and newest mention. */
const briefSchema = o({ id: z.string(), title: z.string(), type: z.string() });
export const peopleContextResponse = o({
  /** The vault has an ontology note; without one every relations list is empty. */
  typed: z.boolean(),
  entries: z.array(
    o({
      id: z.string(),
      relations: z.array(o({ relation: z.string(), to: z.array(briefSchema) })),
      /** The newest ordinary note linking here: its `date:` (YYYY-MM-DD) or when it was saved (ISO). */
      mention: o({ id: z.string(), title: z.string(), at: z.string() }).nullable(),
    }),
  ),
});

// ---------- projects ----------

export const projectsResponse = z.array(
  o({
    slug: z.string(),
    key: z.string(),
    name: z.string(),
    domain: domainSchema.nullable(),
    /** The project's life area id (`GET /api/areas`): its `area:`, its words, its old `domain:`, else the catch-all. */
    area: z.string(),
    noteId: nstr,
    total: z.number(),
    done: z.number(),
    status: nstr,
    start: nstr,
    deadline: nstr,
    /** Front matter `group:`, the project's group inside its area; null without one. */
    group: nstr,
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
  /** Also linked in the note outside `## People`: removing them leaves them listed. */
  inText: z.boolean(),
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
  /** The project's life area id, as `/api/projects` says it. */
  area: z.string(),
  status: z.string(),
  start: z.string(),
  deadline: z.string(),
  /** Front matter `group:`; "" without one. */
  group: z.string(),
  prompt: z.string(),
  /** Display items: markers and checkboxes stripped. Never written back. */
  goals: z.array(z.string()),
  /** The `## Goals` section as the note has it — what "Edit goals" opens on and saves (COR-005). */
  goalsSource: z.string(),
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

const noteBrief = o({ id: z.string(), title: z.string(), path: z.string() });
/** GET /api/projects/:slug/removal: what deleting the project does, for its Confirm (1E). */
export const projectRemovalResponse = o({
  note: noteBrief,
  /** Notes in the project's folder: they go to the trash with it. */
  inFolder: z.array(noteBrief),
  /** Its documents (the files in its folder that are not notes). */
  files: z.number(),
  /** Notes in the project that live elsewhere: they stay, and lose the project. */
  elsewhere: z.array(noteBrief),
  canDelete: z.boolean(),
});
/** GET /api/projects/:slug/notes/candidates: notes that could join the project, each with the project it is in now. */
export const projectCandidatesResponse = z.array(o({ id: z.string(), title: z.string(), path: z.string(), project: nstr }));
/** GET /api/admin/projects/hidden: the projects removed from the board (owners). */
export const hiddenProjectsResponse = z.array(o({ id: z.string(), slug: z.string(), name: z.string() }));

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
  orramaSuggested: z.literal(true).optional(),
});
export const boardResponse = o({
  nodes: z.array(boardNodeSchema),
  edges: z.array(boardEdgeSchema),
  canEdit: z.boolean(),
  /** documents.canvas did not parse: this is the default layout, and saving replaces it. */
  unreadable: z.literal(true).optional(),
});

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
  /** The date the note says, not rolled forward — what the calendars count from. */
  anchor: nstr,
  monthly: z.number(),
  /** Statement descriptors this line answers to (its Match column). */
  match: z.array(z.string()),
  category: z.string(),
  note: z.string(),
  /** 1-based line of the row in the note: which row of `table` this line is. */
  line: z.number(),
});
const totals = z.array(o({ currency: z.string(), monthly: z.number() }));

export const activitySchema = o({
  charges: z.number(),
  months: z.number(),
  first: nstr,
  last: nstr,
  total: z.number(),
  /** What the ledger line expects over the same run: amount × the charges its cadence expects. */
  expected: z.number(),
  seen: z.array(z.string()),
  /** The statement descriptors this line matched, biggest first. */
  merchants: z.array(z.string()),
});
/** A ledger row left out of every total because its amount or cadence could not be read. */
export const unreadableRowSchema = o({ service: z.string(), line: z.number(), field: z.enum(["amount", "cadence"]), text: z.string() });
export const ledgerSchema = o({
  totals,
  items: z.array(moneyItemSchema),
  count: z.number(),
  activity: z.record(activitySchema),
  unreadable: z.array(unreadableRowSchema),
});

export const payslipRowSchema = o({
  month: z.string(),
  gross: nnum,
  net: nnum,
  tax: nnum,
  hours: nnum,
  rate: nnum,
  file: z.string(),
  effectiveNet: nnum,
  /** 1-based line of the row in the note. */
  line: z.number(),
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
  /** weekly, biweekly, monthly…; null for a month spacing with no name (everyMonths says it). */
  cadence: nstr,
  everyMonths: z.number(),
  charges: z.number(),
  first: z.string(),
  last: z.string(),
  total: z.number(),
  active: z.boolean(),
});

const merchantTotal = o({ name: z.string(), total: z.number(), count: z.number() });

/**
 * A ledger's rows as written (core readLedgerTable): a row is changed by its index, its name and
 * the version it was read at, and every known column's cell is there as typed.
 */
export const ledgerRowSchema = o({ index: z.number(), line: z.number(), name: z.string(), cells: z.record(z.string()) });
const ledgerTable = o({ noteId: z.string(), version: z.string(), fields: z.array(z.string()), rows: z.array(ledgerRowSchema) }).nullable();

export const financeResponse = o({
  notes: o({ income: nstr, subscriptions: nstr, payslips: nstr, area: nstr }),
  income: ledgerSchema,
  subscriptions: ledgerSchema,
  payslips: z.array(payslipRowSchema),
  savings: savingsSchema,
  recurring: z.array(recurringSchema),
  summary: o({
    /** Income minus commitments, per currency — never summed across them. */
    net: totals,
    balance: nnum,
    balanceDate: nstr,
    runwayMonths: nnum,
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
          /** What `last` is compared against: the months around it, itself excluded. */
          lastTypical: z.number(),
          merchants: z.array(merchantTotal),
        }),
      ),
      /** Null under three complete months, where no honest figure exists. */
      typical: nnum,
      completeMonths: z.number(),
      lastComplete: nstr,
    }),
    txnCount: z.number(),
    skipped: z.number(),
    /** Statement files left out of every total, and why. */
    excluded: z.array(o({ name: z.string(), reason: z.string() })),
  }),
  files: z.array(fileEntry),
  /** Ledger tags carried by more than one note: the one used and the others. */
  ledgerConflicts: z.array(o({ tag: z.string(), using: z.string(), others: z.array(z.string()) })),
  /** Every ledger's rows as written, for the screens that change them; null where there is no note yet. */
  tables: o({
    subscriptions: ledgerTable,
    income: ledgerTable,
    payslips: ledgerTable,
    categories: ledgerTable,
    "own-accounts": ledgerTable,
  }),
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
  /** `average` is over the `activeMonths` complete months with spending. */
  stats: o({ total: z.number(), count: z.number(), activeMonths: z.number(), average: z.number(), high: z.number(), low: z.number() }),
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
  /** Where its rows are filed, and what keeps a screen from moving them (a commitment, an own account). */
  filing: o({ category: z.string(), commitment: nstr, own: nstr }),
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

// ---------- the knowledge graph (GET /api/graph/*) ----------
// What the MCP's vault_schema / find_entities / get_relations / find_path /
// list_summaries and the in-app agent hand a model. Compact on purpose: ids and
// titles, one line of summary, and provenance — never a note body.

const briefShape = { id: z.string(), title: z.string(), type: z.string() };
const noteRef = o({ id: z.string(), title: z.string() });
const graphVia = z.enum(["field", "inline", "section", "tag", "inverse", "derived"]);

export const graphSchemaResponse = o({
  notes: z.number(),
  types: z.array(o({ id: z.string(), count: z.number(), description: z.string() })),
  relations: z.array(
    o({ id: z.string(), domain: z.array(z.string()), range: z.array(z.string()), inverse: z.string().optional(), count: z.number(), description: z.string() }),
  ),
  derived: z.array(o({ id: z.string(), meaning: z.string(), count: z.number() })),
  statuses: z.array(o({ id: z.string(), count: z.number() })),
  mostConnected: z.array(o({ ...briefShape, connections: z.number() })),
  warnings: z.array(o({ code: z.string(), count: z.number() })),
});

export const graphEntitiesResponse = o({
  total: z.number(),
  entities: z.array(o({ ...briefShape, status: z.string().optional(), summary: z.string(), fields: z.record(z.string(), z.string()) })),
});

export const graphRelationsResponse = o({
  entity: o({ ...briefShape, status: z.string().optional(), summary: z.string(), fields: z.record(z.string(), z.string()) }),
  relations: z.array(
    o({
      relation: z.string(),
      to: z.array(
        o({
          ...briefShape,
          via: graphVia,
          where: z.string(),
          source: noteRef,
          text: z.literal(true).optional(),
          through: z.array(noteRef).optional(),
        }),
      ),
    }),
  ),
  warnings: z.array(z.string()),
});

const brief = o(briefShape);
export const graphPathResponse = o({
  found: z.boolean(),
  length: z.number().optional(),
  paths: z.array(z.array(o({ from: brief, relation: z.string(), to: brief, via: graphVia, where: z.string() }))),
});

export const graphSummariesResponse = o({
  total: z.number(),
  items: z.array(o({ id: z.string(), type: z.string().optional(), title: z.string(), date: z.string().optional(), status: z.string().optional(), about: noteRef.optional(), summary: z.string() })),
});

/** GET /api/graph/warnings: every warning, one row per note, with what its fix needs (Orr noticed, R11). */
export const graphWarningsResponse = o({
  /** The vault has an ontology note the caller can read. */
  typed: z.boolean(),
  ontology: o({ id: z.string(), title: z.string(), path: z.string() }).nullable(),
  warnings: z.array(
    o({
      code: z.string(),
      message: z.string(),
      note: o({ ...briefShape, path: z.string() }),
      relation: z.string().optional(),
      target: z.string().optional(),
      object: brief.optional(),
      found: z.string().optional(),
      tag: z.string().optional(),
      field: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
  ),
});

export type GraphSchema = z.infer<typeof graphSchemaResponse>;
export type GraphWarnings = z.infer<typeof graphWarningsResponse>;
export type GraphEntities = z.infer<typeof graphEntitiesResponse>;
export type GraphRelations = z.infer<typeof graphRelationsResponse>;
export type GraphPath = z.infer<typeof graphPathResponse>;
export type GraphSummaries = z.infer<typeof graphSummariesResponse>;

export type Appearance = z.infer<typeof appearanceSchema>;
export type TaskLine = z.infer<typeof taskLineSchema>;
export type TaskObject = z.infer<typeof taskObjectSchema>;
export type TaskCardData = z.infer<typeof taskCardResponse>;
export type DashboardTask = z.infer<typeof dashboardTaskSchema>;
export type Team = z.infer<typeof teamSchema>;
export type Me = z.infer<typeof meResponse>;
export type SignedIn = z.infer<typeof signInResponse>;
export type SessionInfo = z.infer<typeof sessionsResponse>[number];
export type AiConfig = z.infer<typeof aiConfigResponse>;
export type Member = z.infer<typeof membersResponse>[number];
export type ServerSettings = z.infer<typeof serverSettingsResponse>;
export type FolderLook = z.infer<typeof folderLookResponse>;
export type Health = z.infer<typeof healthResponse>;
export type DashboardData = z.infer<typeof dashboardResponse>;
export type TreeNote = z.infer<typeof treeResponse>[number];
export type TrashItem = z.infer<typeof trashResponse>[number];
export type Linkers = z.infer<typeof linkersResponse>;
export type NoteHistory = z.infer<typeof historyResponse>;
export type Revision = z.infer<typeof revisionResponse>;
export type NotesOverview = z.infer<typeof notesOverviewResponse>;
export type LifeAreas = z.infer<typeof lifeAreasResponse>;
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
export type PeopleContext = z.infer<typeof peopleContextResponse>;
export type ProjectRow = z.infer<typeof projectsResponse>[number];
export type ProjectPerson = z.infer<typeof projectPersonSchema>;
export type ProjectNote = z.infer<typeof projectNoteSchema>;
export type ProjectFile = z.infer<typeof fileEntry>;
export type ProjectTask = z.infer<typeof projectTaskSchema>;
export type ProjectWorkspace = z.infer<typeof projectWorkspaceResponse>;
export type ProjectRemoval = z.infer<typeof projectRemovalResponse>;
export type ProjectCandidate = z.infer<typeof projectCandidatesResponse>[number];
export type HiddenProject = z.infer<typeof hiddenProjectsResponse>[number];
export type BoardNode = z.infer<typeof boardNodeSchema>;
export type FileNode = Extract<BoardNode, { type: "file" }>;
export type GroupNode = Extract<BoardNode, { type: "group" }>;
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
export type LedgerRowData = z.infer<typeof ledgerRowSchema>;
export type LedgerTableData = NonNullable<FinanceData["tables"]["subscriptions"]>;
export type HomeData = z.infer<typeof homeResponse>;
export type AgendaItem = HomeData["agenda"][number];
export type FocusItem = HomeData["focus"][number];
export type DeadlineItem = HomeData["deadlines"][number];
export type HomeLedger = HomeData["finance"]["out"];
export type MailAccount = z.infer<typeof mailAccountResponse>;
export type PendingDraft = z.infer<typeof mailDraftsResponse>[number];
export type MailCategory = z.infer<typeof mailCategorySchema>;
export type InboxItem = z.infer<typeof mailInboxResponse>["messages"][number];
export type MailMessage = z.infer<typeof mailMessageResponse>;
export type ApiToken = z.infer<typeof tokensResponse>[number];
export type Webhook = z.infer<typeof webhooksResponse>[number];
