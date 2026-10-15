/**
 * account.ts - change the email, name or password of an existing account.
 *
 *   pnpm --dir apps/server account
 *
 * Exists because the seeded demo accounts (jules/erin/mara @orrama.dev, password
 * "orrama-demo") are credentials committed to the repo. Anyone who ran `seed` to
 * get started needs a way to turn one into a real account without hand-editing
 * SQLite, and a way back in after forgetting a password.
 *
 * The password is typed here, interactively, with echo off. It is never accepted
 * as a command-line argument: argv is visible to every process on the machine via
 * `ps`, and it lands in shell history.
 */
import { eq } from "drizzle-orm";
import readline from "node:readline";
import { hash as argonHash } from "@node-rs/argon2";
import { createDb, tables, type Db } from "./db.js";
import { isEntry } from "./entry.js";
import { revokeEverything } from "./sessions.js";
import { RETIRED_USERNAME, retireUsername, usernameRetired } from "./usernames.js";

const ETX = "\u0003";       // Ctrl-C
const BACKSPACE = "\u007f";

/**
 * Write the change. A new password is a clean break: it ends every session,
 * API token and Touch ID device, and clears the passcode and the calendar
 * feed link, in the same transaction (sessions.ts `revokeEverything`).
 * Whoever had the account under the old password keeps nothing — it used to
 * leave their session and their tokens working (audit SEC-007).
 */
export function applyAccountChange(
  db: Db,
  userId: string,
  change: { email: string; username: string; displayName: string; passwordHash: string | null },
) {
  const { passwordHash, ...profile } = change;
  return db.transaction((tx) => {
    // A rename retires the old name and may not take a retired one: both own
    // a Personal/<name>/ folder by path (usernames.ts, audit ACL-010).
    const before = tx.select().from(tables.users).where(eq(tables.users.id, userId)).get();
    if (before && before.username !== profile.username) {
      if (usernameRetired(tx, profile.username)) throw new Error(RETIRED_USERNAME);
      retireUsername(tx, before.username);
    }
    tx.update(tables.users)
      .set(passwordHash ? { ...profile, passwordHash } : profile)
      .where(eq(tables.users.id, userId))
      .run();
    return passwordHash ? revokeEverything(tx, userId) : null;
  });
}

/** Read a line without echoing it. Restores the terminal even on Ctrl-C. */
function askSecret(q: string): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stdout.write(q);
    const wasRaw = input.isRaw;
    if (input.isTTY) input.setRawMode(true);
    let value = "";
    const finish = (out: string) => {
      if (input.isTTY) input.setRawMode(Boolean(wasRaw));
      input.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(out);
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(value);
        if (ch === ETX) {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === BACKSPACE || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    input.on("data", onData);
  });
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));
  const db = createDb();
  const users = db.select().from(tables.users).all();
  if (users.length === 0) {
    console.log("No accounts yet. Open the app and create one - it will offer setup.");
    rl.close();
    return;
  }

  console.log("\nAccounts:\n");
  users.forEach((u, i) => {
    console.log(`  ${i + 1}. ${u.email}  (${u.displayName}${u.isOwner ? ", owner" : ""})`);
  });

  const pick = await ask(`\nWhich account to change? [1-${users.length}] `);
  const user = users[Number(pick) - 1];
  if (!user) {
    console.error("No such account.");
    rl.close();
    process.exitCode = 1;
    return;
  }

  console.log(`\nEditing ${user.email}. Press Enter to keep a value unchanged.\n`);
  const email = (await ask(`Email [${user.email}]: `)).trim().toLowerCase() || user.email;
  const username = (await ask(`Username [${user.username}]: `)).trim().toLowerCase() || user.username;
  const displayName = (await ask(`Display name [${user.displayName}]: `)).trim() || user.displayName;

  if (email !== user.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error(`\n"${email}" is not a valid email address.`);
    rl.close();
    process.exitCode = 1;
    return;
  }
  const clash = users.find((u) => u.id !== user.id && (u.email === email || u.username === username));
  if (clash) {
    console.error(`\nAnother account already uses that email or username (${clash.email}).`);
    rl.close();
    process.exitCode = 1;
    return;
  }

  if (username !== user.username && usernameRetired(db, username)) {
    console.error(`\n${RETIRED_USERNAME}`);
    rl.close();
    process.exitCode = 1;
    return;
  }
  if (username !== user.username) console.log(`The old username "${user.username}" will be retired: Personal/${user.username}/ stays on disk and no account can take that name again.`);

  const password = await askSecret("New password (Enter to keep the current one): ");
  let passwordHash: string | null = null;
  if (password.length > 0) {
    if (password.length < 8) {
      console.error("Password must be at least 8 characters. Nothing was changed.");
      rl.close();
      process.exitCode = 1;
      return;
    }
    const again = await askSecret("Confirm password: ");
    if (again !== password) {
      console.error("Passwords do not match. Nothing was changed.");
      rl.close();
      process.exitCode = 1;
      return;
    }
    passwordHash = await argonHash(password);
  }

  const revoked = applyAccountChange(db, user.id, { email, username, displayName, passwordHash });

  console.log(`\nUpdated. Sign in as ${email}.`);
  if (revoked) {
    console.log(
      `Signed out everywhere: ${revoked.sessions.length} session(s), ${revoked.tokens} API token(s) and ` +
        `${revoked.devices} Touch ID device(s) removed; the passcode and the calendar feed link were cleared. ` +
        "Set them up again in Settings. A live-sync connection already open ends when it reconnects or the server restarts.",
    );
  } else {
    console.log("Password unchanged: existing sessions and tokens stay valid.");
  }
  console.log("");
  rl.close();
}

if (isEntry(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
