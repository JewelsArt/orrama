/**
 * The Me page (ME, Nov 2026): the account's persona note, read and written.
 *
 *   GET  /api/persona                the note, read (core parsePersona), or null; and what an
 *                                    empty page needs: AI set up, what there is to read
 *   GET  /api/persona/text           the note's own sections as Markdown (get_persona)
 *   POST /api/persona/blank          "Start from a blank one": the headings, no AI
 *   POST /api/persona/answer         an open question answered, written on its line
 *   POST /api/persona/write          Introduce me / Write as me: a text from the persona alone
 *   POST /api/persona/generate       "Generate my persona": a job on the account's AI
 *   GET  /api/persona/generate       the job: its steps, then the draft
 *   POST /api/persona/generate/stop  Stop
 *   DELETE /api/persona/generate     Start again (the draft is thrown away)
 *   POST /api/persona/accept         the reviewed draft becomes the note
 *
 * Everything is the note: no second store. The draft lives in memory until it is accepted
 * (the page says "the draft stays on this device"); a restart drops it.
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  answerQuestion,
  blankPersona,
  isoLocal,
  parsePersona,
  PERSONA_SECTIONS,
  personaText,
  plain,
  unsourcedNumbers,
  type AclUser,
  type IndexedNote,
  type PersonaSection,
} from "@orrama/core";
import { tables, type Db } from "../db.js";
import { aiConfig, completeText } from "../aiProvider.js";
import { enoughToRead, personaCandidates, personaHome, personaNote, personaSources, type PersonaSources } from "../persona.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { tokenWriter } from "../agentWrites.js";

const answerSchema = z.object({ index: z.number().int().min(0), raw: z.string().min(1), answer: z.string().trim().min(1).max(2000) });
const writeSchema = z.object({
  kind: z.enum(["intro", "email"]),
  audience: z.enum(["recruiter", "lecturer", "client", "colleague", "other"]).default("other"),
  length: z.enum(["line", "s30", "min2"]).default("s30"),
  language: z.string().regex(/^[A-Za-z]{2}$/).default("EN"),
  purpose: z.string().max(500).optional(),
  /** What it is about: a project, place, skill or proof point of the page, by its name. */
  about: z.string().max(300).optional(),
});
const generateSchema = z.object({
  sources: z.object({ projects: z.boolean().default(true), notes: z.boolean().default(true), people: z.boolean().default(true), chats: z.boolean().default(false) }).default({ projects: true, notes: true, people: true, chats: false }),
});
const acceptSchema = z.object({ id: z.string().min(1) });

/** How long writing a draft may take: a whole persona is a long answer. */
const GENERATE_TIMEOUT_MS = 240_000;
/** What Orr is sent of the sources, at most. */
const BUDGET = { project: 2_500, note: 900, person: 300, chat: 600, total: 90_000 };

const AUDIENCE: Record<string, string> = {
  recruiter: "a recruiter",
  lecturer: "a lecturer",
  client: "a client",
  colleague: "a colleague",
  other: "someone they have not met",
};
const LENGTH: Record<string, string> = { line: "one sentence", s30: "about 30 seconds read aloud (60 to 90 words)", min2: "about 2 minutes read aloud (250 to 320 words)" };

/** The persona as Orr is given it to write: everything but the open questions, which are not facts yet. */
function personaForPrompt(content: string): string {
  return personaText(content, PERSONA_SECTIONS.filter((s) => s !== "questions"));
}

export function writeAsPrompt(name: string, content: string, body: z.infer<typeof writeSchema>): { system: string; prompt: string } {
  const lang = body.language.toUpperCase();
  const system = [
    `You write as ${name || "the user"}, in the first person, for them to send or say themselves.`,
    "Use ONLY the facts in the persona note below. Never add a fact, a name or a number that is not in it.",
    "Numbers: quote only numbers that appear in the note, above all in Proof points, exactly as written. If a number you would want is not there, leave it out; never estimate one.",
    "Follow the note's Voice and Rules for outside use to the letter. Never use anything the note marks as internal only.",
    lang === "FR" ? "Write in French." : lang === "EN" ? "Write in English." : `Write in the language with the code ${lang}.`,
    "Answer with the text only: no preamble, no notes, no quotation marks around it.",
  ].join("\n");
  const task =
    body.kind === "intro"
      ? `Write an introduction of me for ${AUDIENCE[body.audience]}, ${LENGTH[body.length]}.`
      : `Write an email from me to ${AUDIENCE[body.audience]}, with a greeting and a sign-off as my Voice says, the body ${LENGTH[body.length]}. Put the subject on the first line as "Subject: …", then a blank line, then the email.`;
  const prompt = [
    task,
    body.about ? `It is about: ${body.about}.` : "",
    body.purpose ? `Its purpose: ${body.purpose}.` : "",
    "",
    `<persona>\n${personaForPrompt(content)}\n</persona>`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
  return { system, prompt };
}

/* ---- generating a draft -------------------------------------------------------------------- */

interface Step {
  id: string;
  label: string;
  state: "waiting" | "running" | "done" | "skipped";
  ms: number | null;
}
interface Job {
  id: string;
  userId: string;
  state: "running" | "done" | "failed" | "stopped";
  steps: Step[];
  startedAt: number;
  draft: string | null;
  error: string | null;
  abort: AbortController;
}

const excerpt = (n: IndexedNote, max: number) => {
  const body = n.content.slice(n.content.indexOf("\n---", 3) > 0 && n.content.startsWith("---") ? n.content.indexOf("\n---", 3) + 4 : 0).trim();
  return body.length > max ? `${body.slice(0, max)}…` : body;
};

/** The sources as text, under one budget: projects first, then people, notes, chats. */
export function sourcesText(s: PersonaSources, on: z.infer<typeof generateSchema>["sources"]): string {
  const parts: string[] = [];
  let used = 0;
  const add = (kind: string, n: IndexedNote, max: number) => {
    const text = `<source kind="${kind}" note="${n.path.replace(/\.md$/, "")}" title="${n.title.replace(/"/g, "'")}">\n${excerpt(n, max)}\n</source>`;
    if (used + text.length > BUDGET.total) return;
    used += text.length;
    parts.push(text);
  };
  if (on.projects) s.projects.forEach((n) => add("project", n, BUDGET.project));
  if (on.people) s.people.forEach((n) => add("person", n, BUDGET.person));
  if (on.notes) s.notes.forEach((n) => add("note", n, BUDGET.note));
  if (on.chats) s.chats.forEach((n) => add("saved chat", n, BUDGET.chat));
  return parts.join("\n\n");
}

const GENERATE_SYSTEM = (name: string) =>
  [
    `You write a persona note about ${name || "the user"}: who they are, for introducing them and writing as them. Work and personal life, but never money, an address, health or family matters.`,
    "Use ONLY facts found in the sources you are given. Never invent a fact, a date, a name or a number. Where the sources disagree or are unclear, take the most likely reading and add a bullet to the last section asking the person.",
    "Answer with the note's Markdown only, in exactly this shape (keep every heading, even empty; keep the table headers exactly):",
    "",
    "## In short",
    "### One line",
    "- **EN:** …",
    "### 30 seconds",
    "**EN:** …",
    "### 2 minutes",
    "**EN:** …",
    "## Now",
    "| | |",
    "|---|---|",
    "| Role | … |   (also Study, Based in, Languages, Looking for when the sources say)",
    "## Experience",
    "| Period | Role | Organisation | What I did | Lane | Source |",
    "(Period like 'Sep 2025–Jan 2026' or 'Jul 2026–now'; Lane is Study, Work or Built; Source is the note it comes from as [[note path]])",
    "## Projects",
    "| Project | When | What it is | My part | Outcome | Skills | People | Part of | Outside use | Source |",
    "(Skills, People and Part of use the exact names from the Skills, People and Experience tables; ★ before the strongest projects)",
    "## Skills",
    "| Skill | Level | Proof |",
    "(Level out of 10 only when the sources give one, else empty; Proof names projects)",
    "## Proof points",
    "| Number | What | Source |",
    "(only numbers that appear in the sources, exactly as written)",
    "## People",
    "| Person | Role | How we work together |",
    "## Voice",
    "(bullets on how they write, from their own notes; empty if the sources don't show it)",
    "## Rules for outside use",
    "## Interests",
    "## Check with me",
    "(bullets: what you could not settle, one question each; options separated by **or**)",
  ].join("\n");

/** Takes out of a draft what has no source: a proof point whose number the sources don't hold becomes a question. */
export function checkDraft(draft: string, sources: string): string {
  const lines = draft.replace(/^```(?:markdown|md)?\n|```\s*$/g, "").split("\n");
  let section = "";
  const dropped: string[] = [];
  const kept = lines.filter((line) => {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) section = h[1]!.toLowerCase();
    if (section !== "proof points" || !line.trim().startsWith("|")) return true;
    const first = line.split("|")[1]?.trim() ?? "";
    if (!/\d/.test(first) || /^-+$/.test(first)) return true;
    if (unsourcedNumbers(first, sources).length === 0) return true;
    dropped.push(plain(first));
    return false;
  });
  let out = kept.join("\n").trim();
  if (dropped.length) {
    const q = `- Proof points: Orr couldn't find where ${dropped.join(", ")} ${dropped.length === 1 ? "comes" : "come"} from, so ${dropped.length === 1 ? "it was" : "they were"} left out. Add ${dropped.length === 1 ? "it" : "them"} back?`;
    out = /^##\s+check with/im.test(out) ? out.replace(/(^##\s+check with[^\n]*\n)/im, `$1\n${q}\n`) : `${out}\n\n## Check with me\n\n${q}`;
  }
  return out;
}

const withFrontmatter = (name: string, day: string, body: string) =>
  [
    "---",
    `title: ${JSON.stringify(`Persona — ${name || "me"}`)}`,
    "tags:",
    "  - persona",
    `updated: ${day}`,
    "sources: written by Orr from your notes",
    "---",
    "",
    `# Persona — ${name || "me"}`,
    "",
    body.replace(/^#\s[^\n]*\n+/, "").trim(),
    "",
  ].join("\n");

export async function personaRoutes(app: FastifyInstance, db: Db, store: VaultStore) {
  const auth = { preHandler: [app.authenticate] };
  const jobs = new Map<string, Job>();

  const nameOf = (userId: string) => db.select().from(tables.users).where(eq(tables.users.id, userId)).get()?.displayName ?? "";
  const counts = (user: AclUser) => {
    const s = personaSources(store, user);
    return { sources: s, counts: { projects: s.projects.length, notes: s.notes.length, people: s.people.length, chats: s.chats.length } };
  };
  const mailConnected = (userId: string) => !!db.select().from(tables.mailAccounts).where(eq(tables.mailAccounts.userId, userId)).get();
  const today = () => isoLocal(new Date());

  app.get("/api/persona", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const [note, ...others] = personaCandidates(db, store, user);
    const c = aiConfig(db);
    const ai = { configured: !!c, provider: c?.provider ?? null };
    if (note) {
      return {
        note: { id: note.id, path: note.path, title: note.title, mtimeMs: note.mtimeMs ?? null, hash: store.noteHash(note) },
        persona: parsePersona(note.content, nameOf(req.userId)),
        others: others.map((n) => n.path),
        ai,
        sources: null,
      };
    }
    const { counts: n } = counts(user);
    return { note: null, persona: null, others: [], ai, sources: { ...n, mail: mailConnected(req.userId), enough: enoughToRead(n), home: personaHome(db, store, user) } };
  });

  app.get<{ Querystring: { section?: string } }>("/api/persona/text", auth, async (req) => {
    const user = store.aclUser(req.userId);
    const note = personaNote(db, store, user);
    if (!note) return { exists: false, name: nameOf(req.userId), path: null, text: "" };
    const want = (req.query.section ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const bad = want.filter((s) => !(PERSONA_SECTIONS as readonly string[]).includes(s));
    if (bad.length) throw new HttpError(400, `unknown section ${bad.join(", ")}: one of ${PERSONA_SECTIONS.join(", ")}`);
    return { exists: true, name: parsePersona(note.content, nameOf(req.userId)).name, path: note.path, text: personaText(note.content, want as PersonaSection[]) };
  });

  app.post("/api/persona/blank", auth, async (req) => {
    const user = store.aclUser(req.userId);
    if (personaNote(db, store, user)) throw new HttpError(409, "You already have a persona note.");
    const path = personaHome(db, store, user);
    const note = store.write(user, path, blankPersona(nameOf(req.userId), today()), undefined, undefined, { create: true, guard: req.viaToken ? tokenWriter : undefined });
    return { id: note.id, path: note.path };
  });

  app.post("/api/persona/answer", auth, async (req) => {
    const body = answerSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    const note = personaNote(db, store, user);
    if (!note) throw new HttpError(404, "You have no persona note.");
    const next = answerQuestion(note.content, body.index, body.raw, body.answer, today());
    if (next === null) throw new HttpError(409, "The note changed since the page read it. Reload to see the question as it is now.");
    const saved = store.write(user, note.path, next, store.noteHash(note), undefined, { guard: req.viaToken ? tokenWriter : undefined });
    return { id: saved.id, path: saved.path };
  });

  app.post("/api/persona/write", auth, async (req, reply) => {
    const body = writeSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    const note = personaNote(db, store, user);
    if (!note) throw new HttpError(404, "You have no persona note.");
    const c = aiConfig(db);
    if (!c) throw new HttpError(400, "AI is not set up. Connect it in Settings → Orr & AI.");
    const name = parsePersona(note.content, nameOf(req.userId)).name;
    const { system, prompt } = writeAsPrompt(name, note.content, body);
    const run = new AbortController();
    const deadline = setTimeout(() => run.abort(new Error("timed out")), 120_000);
    deadline.unref();
    // The page closing the request (Stop, closing the panel) ends the model call too.
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) run.abort(new Error("the client closed the request"));
    });
    let text: string;
    try {
      text = (await completeText(c, { system, prompt, abortSignal: run.signal, maxOutputTokens: 1200 })).trim();
    } catch (err) {
      req.log.error({ err: err instanceof Error ? err.message : String(err) }, "persona/write");
      throw new HttpError(502, "Orr couldn't write it: the AI didn't answer.");
    } finally {
      clearTimeout(deadline);
    }
    let subject = "";
    if (body.kind === "email") {
      const m = /^subject:\s*(.+)\n+/i.exec(text);
      if (m) {
        subject = m[1]!.trim();
        text = text.slice(m[0].length).trim();
      }
    }
    // Never a number the note doesn't hold: said, so the person checks it before it goes anywhere.
    return { text, subject, unsourced: unsourcedNumbers(`${subject}\n${text}`, note.content) };
  });

  /* ---- Generate my persona ------------------------------------------------------------------ */

  const jobView = (j: Job | undefined) => {
    if (!j) return null;
    const persona = j.draft ? parsePersona(j.draft, nameOf(j.userId)) : null;
    return {
      id: j.id,
      state: j.state,
      steps: j.steps.map(({ id, label, state, ms }) => ({ id, label, state, ms })),
      error: j.error,
      persona,
      found: persona
        ? { places: persona.experience.length, projects: persona.projects.length, skills: persona.skills.length, proof: persona.proof.length, people: persona.people.length, questions: persona.questions.filter((q) => !q.answer).length }
        : null,
    };
  };

  app.get("/api/persona/generate", auth, async (req) => jobView(jobs.get(req.userId)));

  app.post("/api/persona/generate", auth, async (req) => {
    const body = generateSchema.parse(req.body ?? {});
    const user = store.aclUser(req.userId);
    if (jobs.get(req.userId)?.state === "running") throw new HttpError(409, "Orr is already writing your page.");
    if (personaNote(db, store, user)) throw new HttpError(409, "You already have a persona note.");
    const c = aiConfig(db);
    if (!c) throw new HttpError(400, "AI is not set up. Connect it in Settings → Orr & AI.");
    const { sources, counts: n } = counts(user);
    const on = body.sources;
    if (!enoughToRead({ projects: on.projects ? n.projects : 0, notes: on.notes ? n.notes : 0 })) throw new HttpError(400, "There isn't enough to read yet.");
    const name = nameOf(req.userId);
    const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    const steps: Step[] = [
      { id: "projects", label: `Reading ${plural(n.projects, "project", "projects")}`, state: on.projects ? "waiting" : "skipped", ms: null },
      { id: "people", label: `Reading ${plural(n.people, "person", "people")}`, state: on.people ? "waiting" : "skipped", ms: null },
      { id: "notes", label: `Reading ${plural(n.notes, "note", "notes")}`, state: on.notes ? "waiting" : "skipped", ms: null },
      { id: "chats", label: `Reading ${plural(n.chats, "saved chat", "saved chats")}`, state: on.chats ? "waiting" : "skipped", ms: null },
      { id: "write", label: "Writing the draft", state: "waiting", ms: null },
      { id: "check", label: "Checking every number has a source", state: "waiting", ms: null },
    ];
    const job: Job = { id: crypto.randomUUID(), userId: req.userId, state: "running", steps, startedAt: Date.now(), draft: null, error: null, abort: new AbortController() };
    jobs.set(req.userId, job);
    const step = async <T>(id: string, run: () => Promise<T> | T): Promise<T> => {
      const s = job.steps.find((x) => x.id === id)!;
      s.state = "running";
      const t0 = Date.now();
      const out = await run();
      s.state = "done";
      s.ms = Date.now() - t0;
      return out;
    };
    const deadline = setTimeout(() => job.abort.abort(new Error("timed out")), GENERATE_TIMEOUT_MS);
    deadline.unref();
    void (async () => {
      try {
        let text = "";
        for (const id of ["projects", "people", "notes", "chats"] as const) {
          if (!on[id]) continue;
          await step(id, () => undefined);
        }
        text = sourcesText(sources, on);
        const draft = await step("write", () =>
          completeText(c, { system: GENERATE_SYSTEM(name), prompt: `The sources:\n\n${text}`, abortSignal: job.abort.signal, maxOutputTokens: 8000 }),
        );
        if (job.state !== "running") return;
        job.draft = await step("check", () => withFrontmatter(name, today(), checkDraft(draft, text)));
        job.state = "done";
      } catch (err) {
        if (job.state !== "running") return;
        req.log.error({ err: err instanceof Error ? err.message : String(err) }, "persona/generate");
        job.state = "failed";
        job.error = job.abort.signal.aborted ? "It took too long, so Orr stopped." : "The AI didn't answer.";
        for (const s of job.steps) if (s.state === "running") s.state = "waiting";
      } finally {
        clearTimeout(deadline);
      }
    })();
    return jobView(job);
  });

  app.post("/api/persona/generate/stop", auth, async (req) => {
    const job = jobs.get(req.userId);
    if (job?.state === "running") {
      job.state = "stopped";
      job.abort.abort(new Error("stopped"));
      for (const s of job.steps) if (s.state === "running") s.state = "waiting";
    }
    return jobView(job);
  });

  app.delete("/api/persona/generate", auth, async (req) => {
    const job = jobs.get(req.userId);
    job?.abort.abort(new Error("thrown away"));
    jobs.delete(req.userId);
    return { ok: true };
  });

  app.post("/api/persona/accept", auth, async (req) => {
    const body = acceptSchema.parse(req.body);
    const user = store.aclUser(req.userId);
    const job = jobs.get(req.userId);
    if (!job || job.id !== body.id || job.state !== "done" || !job.draft) throw new HttpError(404, "That draft is gone. Generate it again.");
    if (personaNote(db, store, user)) throw new HttpError(409, "You already have a persona note.");
    // The draft's Voice and Rules become how agents write as the user: a token may not put them there.
    const note = store.write(user, personaHome(db, store, user), job.draft, undefined, undefined, { create: true, guard: req.viaToken ? tokenWriter : undefined });
    jobs.delete(req.userId);
    return { id: note.id, path: note.path };
  });

  app.addHook("onClose", async () => {
    for (const j of jobs.values()) j.abort.abort(new Error("the server is stopping"));
  });
}
