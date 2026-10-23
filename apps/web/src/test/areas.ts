/** A `GET /api/areas` answer for the screens' tests: School, Work and Personal, Personal taking the rest. */
export const AREAS_REPLY = {
  areas: [
    { id: "school", name: "School", words: [], catchAll: false, notes: 0, projects: 0 },
    { id: "work", name: "Work", words: [], catchAll: false, notes: 0, projects: 0 },
    { id: "personal", name: "Personal", words: [], catchAll: true, notes: 0, projects: 0 },
  ],
  note: null,
  canEdit: true,
};
