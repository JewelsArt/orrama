# Security

Orrama holds people's notes, mail and money, so a security hole matters. If you find one,
please tell us privately first, not in a public issue.

## How to report

Use GitHub's private reporting: the repository's **Security** tab → **Report a
vulnerability**. Only the maintainer sees it. Please include:

- what an attacker can do, and what they need first (an account, the same network, a
  shared folder, a file or mail they send you);
- the steps or a small script that shows it, and the version (at the foot of Settings, or the
  release you downloaded);
- whether it is already known somewhere else.

Orrama is made by one person. You'll get an answer within a week. Once a fix is released,
the report is published with the release notes, with your name if you want it.

## What is in scope

The desktop app for Mac and Windows, the server and web app in this repository, the
Docker image built from it, and the MCP server (`apps/mcp`). Only the newest release gets
fixes.

Out of scope: problems in a dependency that Orrama doesn't reach (report them upstream),
attacks that need full control of the computer Orrama runs on, and a server someone
exposes to the internet without the protections INSTALL.md describes.

## How Orrama protects you

The server listens on your own computer only and answers only to its own names; every
page and the database are behind your account; the assistant can draft mail but never send
it; secrets are kept in the system's credential store or a file only you can read. The
details, and the reasons for them, are in [CLAUDE.md](CLAUDE.md) ("Conventions & gotchas").
