/**
 * Contacts are notes, not rows: any readable note tagged #contact (by
 * convention living under Contacts/) with sector/role/company/... frontmatter.
 * The page is a view over the vault — delete the DB and it rebuilds, share a
 * contact with #share/<team>, keep private ones in your personal folder.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import type { VaultStore } from "../vaultStore.js";

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

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
}
