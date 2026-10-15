/**
 * Sync engine (spec §10). Each note is a Y.Doc holding a Y.Text("content") of the
 * Markdown source; the file on disk is the render of the Y.Doc. No client
 * exchanges Y updates: the editor (NoteSync, client.ts) sends the full text with
 * the base it edited from (`baseContent` + `baseHash`); the server 3-way merges
 * it line by line against what the note holds now (`mergeText`, merge.ts) and
 * applies the result to the live doc as a minimal splice — one update log, one
 * history.
 */
import * as Y from "yjs";
import { canRead, type AclUser, type AclNote, type FolderGrant } from "@orrama/core";

const TEXT_KEY = "content";

export function createNoteDoc(content = ""): Y.Doc {
  const doc = new Y.Doc();
  if (content) doc.getText(TEXT_KEY).insert(0, content);
  return doc;
}

export function docContent(doc: Y.Doc): string {
  return doc.getText(TEXT_KEY).toString();
}

export function encodeStateB64(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

export function applyUpdateB64(doc: Y.Doc, updateB64: string): void {
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(updateB64, "base64")));
}

export function docFromUpdates(updatesB64: string[]): Y.Doc {
  const doc = new Y.Doc();
  for (const u of updatesB64) applyUpdateB64(doc, u);
  return doc;
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Minimal single-splice diff (common prefix/suffix). Good enough for editor saves.
 *
 * The bounds are whole code points, never the middle of a surrogate pair
 * (audit STO-001). Every emoji in U+1F400–U+1F7FF starts with \uD83D, so 🔴 →
 * 🟢 shares its first code unit: a prefix counted in code units stopped
 * between the halves, Yjs refused to split the pair and wrote U+FFFD for
 * both, and that text went to the vault.
 */
export function diffSplice(oldStr: string, newStr: string): { index: number; deleteCount: number; insert: string } | null {
  if (oldStr === newStr) return null;
  let start = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (start < minLen && oldStr[start] === newStr[start]) start++;
  // Stopped just after a shared high surrogate: its low half differs, so the
  // whole pair is part of the change.
  if (start > 0 && isHighSurrogate(oldStr.charCodeAt(start - 1))) start--;
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  // Same on the suffix side: a shared low surrogate goes with its high half.
  if (endOld < oldStr.length && isLowSurrogate(oldStr.charCodeAt(endOld))) {
    endOld++;
    endNew++;
  }
  return { index: start, deleteCount: endOld - start, insert: newStr.slice(start, endNew) };
}

/** A splice left the doc reading something other than the requested text. */
export class SpliceMismatchError extends Error {
  constructor() {
    super("the note's document does not match the text it was given");
    this.name = "SpliceMismatchError";
  }
}

/**
 * Set the doc's content to `newContent`, expressed as the smallest splice against
 * the doc's current text so concurrent remote edits outside the changed region
 * survive the merge. Returns the base64 update this transaction produced (null if no-op).
 */
export function updateDocContent(doc: Y.Doc, newContent: string, origin?: unknown): string | null {
  const text = doc.getText(TEXT_KEY);
  const diff = diffSplice(text.toString(), newContent);
  if (!diff) return null;
  let update: string | null = null;
  const listener = (u: Uint8Array) => {
    update = Buffer.from(u).toString("base64");
  };
  doc.on("update", listener);
  doc.transact(() => {
    if (diff.deleteCount > 0) text.delete(diff.index, diff.deleteCount);
    if (diff.insert) text.insert(diff.index, diff.insert);
  }, origin);
  doc.off("update", listener);
  // The backstop for any splice bug like STO-001: the doc must now read
  // exactly what was asked for. The caller holds a doc that disagrees with
  // the file and must drop it (vaultStore's `splice`); writing it would put
  // the damage on disk.
  if (text.toString() !== newContent) throw new SpliceMismatchError();
  return update;
}

export interface ManifestNote extends AclNote {
  id: string;
  path: string;
  contentHash: string;
}

export interface ManifestEntry {
  id: string;
  path: string;
  contentHash: string;
}

/**
 * Partial checkout manifest (spec §5.4/§10): contains ONLY files the user may read.
 * Unreadable notes never appear — this is server-side filtering before transport,
 * not client-side hiding.
 */
export function computeManifest(user: AclUser, notes: ManifestNote[], grants: FolderGrant[]): ManifestEntry[] {
  return notes
    .filter((n) => canRead(user, n, grants))
    .map(({ id, path, contentHash }) => ({ id, path, contentHash }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export { mergeText, lineHunks } from "./merge.js";
export { NoteSync, type NoteSyncHooks, type NoteSyncTransport, type SaveState, type SyncedNote } from "./client.js";
