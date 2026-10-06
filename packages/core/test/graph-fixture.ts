/** A fictional vault: people, companies, projects, documents, conversations, and one of each trap. */
export const f = (path: string, content: string) => ({ path, content });
export const fm = (id: string, rest: string, body = "") => `---\nid: n-${id}\n${rest}\n---\n${body}`;

export const FILES = [
  f("Contacts/Companies/Acme.md", fm("acme", "tags: [company]\nlocation: Rotterdam", "# Acme")),
  f("Contacts/Companies/Globex.md", fm("globex", "tags: [company]\nlocation: Utrecht", "# Globex")),
  f("01-Me/Contacts/Ada Quill.md", fm("ada", 'tags: [contact]\nrole: CEO\ncompany: "[[Acme]]"', "# Ada")),
  f("01-Me/Contacts/Bo Marsh.md", fm("bo", "tags: [contact]\nrole: Advisor\ncompany: Globex", "# Bo")), // plain text, no link
  f("01-Me/Contacts/Cy Nord.md", fm("cy", "tags: [contact]\nrole: Mentor\ncompany: Initech Ltd", "# Cy")), // not a note
  f("01-Me/Contacts/Di Vale.md", fm("di", "tags: [contact]\nrole: Alumna", "# Di\nsupervises:: [[Rocket]]")),
  f("04-Projects/rocket.md", fm("rocket", "title: Rocket\ntags: [project/rocket, project, active]\nstatus: on-track\ndeadline: 2027-01-18", "# Rocket\n\n## People\n\n- [[Ada Quill]]\n- [[Globex]]\n- [[Ed Rook]]\n- [[Rocket Plan]]\n")),
  f("04-Projects/rocket/plan.md", fm("plan", "tags: [project/rocket]\ntitle: Rocket Plan\ndeadline: 2026-10-19", "# Plan")),
  f("04-Projects/rocket/ghost.md", fm("ghost", "title: Ghost\ntags: [project/vapour]", "# Ghost")),
  f("04-Projects/kite.md", fm("kite", "title: Kite\ntags: [project/kite, archived, active]", "# Kite")),
  f("04-Projects/sled.md", fm("sled", "title: Sled\ntags: [project/sled]\nstatus: sleeping", "# Sled")),
  f("04-Projects/bare.md", fm("bare", "title: Bare\ntags: [project/bare]", "# Bare")),
  f("Contacts/Companies/Initech.md", fm("initech", "title: Initech\ntags: [company]\ncompany: \"[[Acme]]\"", "# Initech")), // a company with a `company:` field: not works_at
  f("01-Me/Contacts/Ed Rook.md", fm("ed", 'tags: [contact]\ncompany: "[[Acme]]"', "# Ed\ncompany:: [[Acme]]")), // same fact twice
  f("04-Projects/lamp.md", fm("lamp", "title: Lamp\ntags: [project/lamp, active]\nstatus: archived", "# Lamp")), // field says archived, a tag says active
  f("04-Projects/orbit.md", fm("orbit", "title: Orbit\ntags: [project/orbit]\nstatus: planned", "# Orbit")),
  f("04-Projects/aaa-orbit.md", fm("orbit2", "title: Orbit copy\ntags: [project/orbit]\nstatus: planned", "# Orbit copy")), // sorts first, is not the conventional note
  f("04-Projects/orbit/notes.md", fm("onotes", "title: Orbit notes\ntags: [project/orbit]", "# Notes")),
  f("Claude Sessions/one.md", fm("c1", "type: claude-session\ndate: 2026-06-04\ndescription: Planned the rocket launch window\ntitle: Planning rocket\nproject: \"[[rocket]]\"", "# Planning\n\nabout:: [[Acme]]\n[[Kite]]")),
  f("Claude Sessions/two.md", fm("c2", "type: claude-session\ndate: 2026-09-01\ntitle: Chat", "# Chat")),
];
