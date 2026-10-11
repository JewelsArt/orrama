/**
 * The entity page's shared pieces (structure.md §2.5–2.6, §6 #27–28). The project page is
 * their richest user; R11 builds the person, company, conversation and document pages from
 * the same: `EntityHeader`, `StatusMenu`, `DatesButton`, `RelationRows` with `useRelations`
 * and `rolesOf`, and `OrrWarnings`. Styles: styles/entity.css. changes/R8.md says how.
 */
export { EntityHeader } from "./EntityHeader.js";
export { StatusMenu, statusLook } from "./StatusMenu.js";
export { DatesButton, rangeLabel, type DateSlot } from "./Dates.js";
export { useRelations, rolesOf, roleWord, RelationRows, OrrWarnings, type Related, type RelationItem, type RelationsState } from "./relations.js";
export { statusOf, shelfOf, statusProblems, STATUS_IDS, STATUS_WORD, type StatusId, type Shelf } from "./status.js";
export { parseDateInput } from "./dateInput.js";
