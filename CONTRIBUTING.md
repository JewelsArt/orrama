# Contributing

Thank you for looking. Orrama is made by one person, so here is how to help without wasted
work on either side.

## Issues first

A bug, an idea or a question: open an issue. For a bug, say what you did, what you expected
and what happened, with your system and Orrama's version (at the foot of Settings). A
security hole goes to [SECURITY.md](SECURITY.md) instead, never into an issue.

Before you write code for anything bigger than a small fix, ask in an issue whether it fits.
Orrama leaves out a lot on purpose, and a pull request for something it won't carry is a
weekend lost.

## The contributor agreement

**A pull request can only be merged after you've signed the contributor agreement**, once,
before your first one. Ask for it in the issue or the pull request and it's sent to you.

Why: Orrama is under the AGPL, and stays so. The agreement lets the maintainer also offer
Orrama under another licence later (to a company that can't use the AGPL, say) without
asking every contributor again. You keep the copyright of what you wrote, and your
contribution stays available under the AGPL in Orrama.

## Writing a change

- Read [CLAUDE.md](CLAUDE.md) first: it is the codebase guide, with the rules each part
  keeps and why.
- [INSTALL.md](INSTALL.md) sets up a development copy. Work on a seeded vault
  (`pnpm --dir apps/server seed`, then `dev`), never on your real notes.
- Every behaviour you add or fix has a test that fails without your change.
  `pnpm typecheck`, `pnpm lint` and `pnpm test` pass before you open the pull request.
- Every permission rule goes through `packages/core`'s ACL; a new place that shows notes
  gets a test that it shows nobody a note they can't read.
- A new dependency must carry a licence the AGPL can carry (CLAUDE.md, "Licence"), and be
  at least a week old.
- Words on screen are plain English, short, and the design rules in CLAUDE.md hold.
- One change per pull request, in small commits that each pass on their own.
