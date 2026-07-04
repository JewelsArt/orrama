import type { TreeNote } from "./api.js";

/**
 * Semantic categories over the PARA vault, each with a colour. This one module
 * is the single source of truth for how the vault is grouped and coloured — the
 * map, the file list, and the category filter all read from here, so a note is
 * the same colour everywhere. First rule that matches wins (Personal is the
 * catch-all); edit the rules to re-shape the grouping and nothing else changes.
 */
export interface Category {
  id: string;
  label: string;
  color: string;
  re: RegExp;
}

export const CATEGORIES: Category[] = [
  { id: "school", label: "School", color: "#4a9eff", re: /universit|resit|\blaw\b|financial risk|financial account|transcomercial|school-resits|internship-defense|\bexam\b|the-professor|amsib|hva/ },
  { id: "work", label: "Work", color: "#e5383b", re: /scooperz|career|dashboard|portfolio|linkedin|paris-expansion|python-finance|proof-bank|05-content|the-scribe|the-finance|contact/ },
  { id: "knowledge", label: "Knowledge", color: "#2dd4bf", re: /03-knowledge|knowledge\//i },
  { id: "tools", label: "Claude & tools", color: "#a855f7", re: /07-claude|city map|characters|skills|obsidian-town|claude\.md|\/agents|claude sessions/ },
  { id: "personal", label: "Personal", color: "#f5a623", re: /.*/ },
];

const FALLBACK = "#8888aa";

export function categoryOf(note: Pick<TreeNote, "path" | "tags">): string {
  const hay = `${note.path} ${note.tags.join(" ")}`.toLowerCase();
  return CATEGORIES.find((c) => c.re.test(hay))!.id;
}

export function categoryColor(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.color ?? FALLBACK;
}

export function colorOf(note: Pick<TreeNote, "path" | "tags">): string {
  return categoryColor(categoryOf(note));
}
