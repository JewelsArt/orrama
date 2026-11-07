/**
 * Where the database keeps values sealed with the secret key (secrets.ts): what a key rotation
 * re-encrypts (rotate-secret-key.ts) and what a restore on another computer can't open
 * (backup.ts). Its own module so the app's bundle can hold it: rotate-secret-key.ts is a
 * command that runs itself (package-server.mjs, OTHER_ENTRIES).
 */
/**
 * Every value encryptSecret() wrote. `where` narrows a key/value table to the
 * rows that hold one. The ChatGPT credentials (a long-lived refresh token)
 * were missing: a rotation left them undecryptable under the new key and
 * still readable under the old one — the one a rotation is meant to retire
 * (audit SEC-006). Anything new stored with encryptSecret() goes here too.
 */
export const COLUMNS: { table: string; id: string; column: string; where?: string }[] = [
  { table: "mail_accounts", id: "id", column: "password_encrypted" },
  { table: "workspace", id: "id", column: "ai_key_encrypted" },
  { table: "ics_feeds", id: "id", column: "url_encrypted" },
  { table: "meta", id: "key", column: "value", where: "key = 'chatgpt_credentials'" },
  // A row still in the clear (written before SEC-015, server not booted
  // since) is sealed under whatever key the next boot runs with.
  { table: "webhooks", id: "id", column: "secret", where: "substr(secret, 1, 6) <> 'whsec_'" },
];
