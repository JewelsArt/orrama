/**
 * Contacts are notes, not rows: any readable note tagged #contact (by
 * convention living under Contacts/) with sector/role/company/... frontmatter,
 * plus the companies behind them (#company, Contacts/Companies/). The page is a
 * view over the vault — delete the DB and it rebuilds, share a contact with
 * #share/<team>, keep private ones in your personal folder.
 */
import type { FastifyInstance } from "fastify";
import { updateFrontmatter } from "@basalt/core";
import type { Db } from "../db.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** YAML list or comma-separated string → trimmed string list (front-matter is hand-written too). */
const strList = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v.map(str) : str(v).split(",");
  return raw.map((s) => s.trim()).filter(Boolean);
};

export async function contactRoutes(app: FastifyInstance, _db: Db, store: VaultStore) {
  app.get("/api/contacts", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    return store
      .readable(user)
      .filter((n) => n.tags.some((t) => t.tag === "contact"))
      .map((n) => ({
        id: n.id,
        name: n.title,
        path: n.path,
        sector: str(n.frontmatter["sector"]) || "Other",
        role: str(n.frontmatter["role"]),
        company: str(n.frontmatter["company"]),
        email: str(n.frontmatter["email"]),
        phone: str(n.frontmatter["phone"]),
        linkedin: str(n.frontmatter["linkedin"]),
        personal: n.folder.startsWith("Personal/"),
      }))
      .sort((a, b) => a.sector.localeCompare(b.sector) || a.name.localeCompare(b.name));
  });

  /**
   * Companies are notes tagged #company: the org behind the contacts. Same deal
   * as contacts — a note is the record, so meeting notes, [[links]] to the people
   * you know there and application tasks all live in the same file. `positions`
   * is the list of role types you actually saw open there.
   */
  app.get("/api/companies", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    return store
      .readable(user)
      .filter((n) => n.tags.some((t) => t.tag === "company"))
      .map((n) => ({
        id: n.id,
        name: n.title,
        path: n.path,
        description: str(n.frontmatter["description"]) || str(n.frontmatter["summary"]),
        sector: str(n.frontmatter["sector"]) || "Other",
        linkedin: str(n.frontmatter["linkedin"]),
        website: str(n.frontmatter["website"]),
        careers: str(n.frontmatter["careers"]),
        location: str(n.frontmatter["location"]),
        positions: strList(n.frontmatter["positions"] ?? n.frontmatter["roles"]),
        personal: n.folder.startsWith("Personal/"),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Edit the card fields in place. Front-matter only: the body is preserved
   *  byte-for-byte, and `store.write` still runs the normal edit ACL. */
  app.patch("/api/companies/:id", { preHandler: [app.authenticate] }, async (req) => {
    const user = store.aclUser(req.userId);
    const note = store.requireReadable(user, (req.params as { id: string }).id);
    if (!note.tags.some((t) => t.tag === "company")) throw new HttpError(400, "not a company note");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = ["description", "sector", "linkedin", "website", "careers", "location"] as const;
    const next = updateFrontmatter(note.content, (d) => {
      for (const k of fields) if (body[k] !== undefined) d[k] = str(body[k]);
      if (body["positions"] !== undefined) d["positions"] = strList(body["positions"]);
      return d;
    });
    store.write(user, note.path, next);
    return { ok: true };
  });
}
