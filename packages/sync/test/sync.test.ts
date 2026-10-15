import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyUpdateB64,
  computeManifest,
  createNoteDoc,
  diffSplice,
  docContent,
  docFromUpdates,
  encodeStateB64,
  updateDocContent,
} from "../src/index.js";
import type { AclUser, FolderGrant } from "@orrama/core";

describe("note docs", () => {
  it("round-trips content through updates", () => {
    const doc = createNoteDoc("hello world");
    const clone = docFromUpdates([encodeStateB64(doc)]);
    expect(docContent(clone)).toBe("hello world");
  });

  it("expresses saves as minimal splices", () => {
    expect(diffSplice("abc def", "abc XY def")).toEqual({ index: 4, deleteCount: 0, insert: "XY " });
    expect(diffSplice("same", "same")).toBeNull();
  });

  it("merges concurrent edits to different regions (CRDT property, §13)", () => {
    const base = createNoteDoc("# Title\n\nline one\nline two\n");
    const a = docFromUpdates([encodeStateB64(base)]);
    const b = docFromUpdates([encodeStateB64(base)]);

    const ua = updateDocContent(a, "# Title\n\nline one EDITED BY A\nline two\n")!;
    const ub = updateDocContent(b, "# Title\n\nline one\nline two EDITED BY B\n")!;

    applyUpdateB64(a, ub);
    applyUpdateB64(b, ua);

    expect(docContent(a)).toBe(docContent(b)); // convergence
    expect(docContent(a)).toContain("EDITED BY A");
    expect(docContent(a)).toContain("EDITED BY B");
  });

  it("converges under arbitrary interleavings (mini property test)", () => {
    for (let seed = 0; seed < 20; seed++) {
      const rand = (() => {
        let s = seed + 1;
        return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      })();
      const base = createNoteDoc("abcdefghij".repeat(3));
      const docs = [0, 1, 2].map(() => docFromUpdates([encodeStateB64(base)]));
      const updates: string[] = [];
      for (const d of docs) {
        const t = d.getText("content");
        const pos = Math.floor(rand() * t.length);
        const u = updateDocContent(d, t.toString().slice(0, pos) + `[${pos}]` + t.toString().slice(pos));
        if (u) updates.push(u);
      }
      // deliver every update to every doc in a seed-shuffled order
      for (const d of docs) {
        const order = [...updates].sort(() => rand() - 0.5);
        for (const u of order) applyUpdateB64(d, u);
      }
      const [x, y, z] = docs.map(docContent);
      expect(y).toBe(x);
      expect(z).toBe(x);
    }
  });

  it("keeps history in the update log (restore = new edit, never destructive)", () => {
    const doc = createNoteDoc("v1");
    const log = [encodeStateB64(doc)];
    log.push(updateDocContent(doc, "v1 then v2")!);
    log.push(updateDocContent(doc, "v3 replaced everything")!);
    expect(docContent(docFromUpdates(log.slice(0, 2)))).toBe("v1 then v2");
    expect(docContent(docFromUpdates(log))).toBe("v3 replaced everything");
    expect(Y.encodeStateVector(doc)).toBeDefined();
  });
});

describe("partial checkout manifest (§5.4)", () => {
  const grants: FolderGrant[] = [{ team: "engineering", folder: "Engineering", role: "editor" }];
  const erin: AclUser = { id: "u1", username: "erin", teams: ["engineering"], isOwner: false };
  const notes = [
    { id: "a", path: "Engineering/A.md", contentHash: "h1", folder: "Engineering", onlyTeams: [], shareTeams: [] },
    { id: "b", path: "Marketing/B.md", contentHash: "h2", folder: "Marketing", onlyTeams: [], shareTeams: [] },
    { id: "c", path: "Marketing/C.md", contentHash: "h3", folder: "Marketing", onlyTeams: [], shareTeams: ["engineering"] },
    { id: "d", path: "Engineering/D.md", contentHash: "h4", folder: "Engineering", onlyTeams: ["marketing"], shareTeams: [] },
  ];

  it("contains only readable files — unreadable notes never reach the wire", () => {
    const manifest = computeManifest(erin, notes, grants);
    expect(manifest.map((m) => m.id)).toEqual(["a", "c"]);
    expect(JSON.stringify(manifest)).not.toContain("Engineering/D.md");
  });
});
