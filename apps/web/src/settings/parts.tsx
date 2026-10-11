/**
 * The pieces every Settings section is built from (structure.md §3): the eight sections and
 * their order, the mark that says where a setting lives, a section's header, a state line, and
 * the index "Find a setting" searches.
 */
import { type ReactNode } from "react";
import { Icon, type IconName } from "../ui/Icon.js";
import { HeadMark } from "../ui/orr/Orr.js";
import type { SettingsSection } from "../ui/router.js";

/** Where a setting lives (§3.2): the device you hold, your account, or the Mac that runs Orrama. */
export type Where = "device" | "account" | "server";

const WHERE: Record<Where, { label: string; icon: IconName; tip: string }> = {
  device: { label: "This device", icon: "phone", tip: "Kept on this browser, Mac app or phone only" },
  account: { label: "Your account", icon: "person", tip: "Follows you to every device you sign in on" },
  server: { label: "This server", icon: "device", tip: "Kept on the Mac that runs Orrama and holds your notes" },
};

export function WhereMark({ where }: { where: Where }) {
  const w = WHERE[where];
  return (
    <span className="set-where" title={w.tip}>
      <Icon name={w.icon} size={14} />
      {w.label}
    </span>
  );
}

export interface SectionMeta {
  id: SettingsSection;
  label: string;
  where: Where;
  /** The line under the section's title. */
  blurb: string;
}

/** The sections in order of use (§3.1); a rule in the list before This device. */
export const SECTIONS: SectionMeta[] = [
  { id: "you", label: "You", where: "account", blurb: "Your name and your Orr. They follow you to every device you sign in on." },
  {
    id: "appearance",
    label: "Appearance",
    where: "account",
    blurb: "How Orrama looks. Kept with your account, so every device shows the same app, unless one follows its own system.",
  },
  {
    id: "ai",
    label: "Orr & AI",
    where: "server",
    blurb: "The model Orr answers with, and how he should work for you. Your key never leaves this Mac: requests go straight from here to the provider.",
  },
  { id: "notes", label: "Notes", where: "server", blurb: "Where your notes live, and what Orr knows about them." },
  { id: "connections", label: "Connections", where: "account", blurb: "Calendars you follow, your mail, and your planning as a calendar others can add." },
  { id: "device", label: "This device", where: "device", blurb: "Quick ways back in on this device. Your password always works, and is the way in after a lockout." },
  { id: "sessions", label: "Signed in", where: "account", blurb: "Every device and browser signed in to your account. Signing one out ends it at once." },
  { id: "developer", label: "Developer", where: "server", blurb: "API tokens and webhooks for scripts, and the address Claude Code's MCP server talks to." },
  { id: "access", label: "Access", where: "server", blurb: "The accounts on this server and the teams that decide who reads what." },
];

/** The second group starts here (the rule in the list, the second box on the phone). */
export const SECOND_GROUP: SettingsSection = "device";

export function SectionIcon({ id, size = 19 }: { id: SettingsSection; size?: number }) {
  if (id === "ai") return <HeadMark size={size} />;
  const icon: Record<Exclude<SettingsSection, "ai">, IconName> = {
    you: "person",
    appearance: "palette",
    notes: "folder",
    connections: "plug",
    device: "device",
    sessions: "key",
    developer: "code",
    access: "people",
  };
  return <Icon name={icon[id]} size={size} />;
}

/** A section's header: title, where it lives, one line, and on the right what belongs there (Orr, your Orr). */
export function SectionHead({ meta, aside }: { meta: SectionMeta; aside?: ReactNode }) {
  return (
    <div className="set-head">
      <div>
        <h2>
          <span className="set-title">{meta.label}</span> <WhereMark where={meta.where} />
        </h2>
        <p>{meta.blurb}</p>
      </div>
      {aside && <div className="set-aside">{aside}</div>}
    </div>
  );
}

/** A connection's state: a dot (working, off, or in trouble), what it is, quiet details, an action at the end. */
export function StateLine({ tone, title, detail, action }: { tone: "ok" | "off" | "bad"; title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="set-state">
      <span className={`set-dot ${tone}`} aria-hidden="true" />
      <div>
        <b>{title}</b>
        {detail && <span> · {detail}</span>}
      </div>
      {action ?? <span />}
    </div>
  );
}

/** A heading inside a section ("Calendars", "API tokens"). */
export const SubHead = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="set-sub">
    <h3>{children}</h3>
    {aside}
  </div>
);

/**
 * What "Find a setting" searches: each setting by its name and the words someone might type
 * for it. ⌘K's Find can read the same list (R11).
 */
export const SETTINGS_INDEX: { label: string; section: SettingsSection; words: string }[] = [
  { label: "Name", section: "you", words: "display name profile" },
  { label: "Your Orr", section: "you", words: "avatar character picture" },
  { label: "Email and password", section: "you", words: "email password account login" },
  { label: "Theme", section: "appearance", words: "dark light night mode" },
  { label: "Match this device", section: "appearance", words: "system theme auto dark light" },
  { label: "Colour vision", section: "appearance", words: "colour color blind deuteranopia protanopia tritanopia palette profile" },
  { label: "Provider and model", section: "ai", words: "ai provider model chatgpt anthropic claude gemini google openai" },
  { label: "API key", section: "ai", words: "ai key secret" },
  { label: "How Orr should work for you", section: "ai", words: "instructions agent prompt tone" },
  { label: "Notes folder", section: "notes", words: "vault folder path files" },
  { label: "Life areas", section: "notes", words: "categories areas work personal school" },
  { label: "Ontology and Orr noticed", section: "notes", words: "graph types relations warnings health ontology" },
  { label: "Export", section: "notes", words: "export backup download" },
  { label: "Calendars", section: "connections", words: "calendar feed ics subscribe google apple" },
  { label: "Mail", section: "connections", words: "mail gmail email app password imap" },
  { label: "Publish my planning", section: "connections", words: "publish feed ics share calendar url" },
  { label: "Passcode", section: "device", words: "passcode pin unlock lock" },
  { label: "Touch ID", section: "device", words: "touch id passkey fingerprint unlock" },
  { label: "Signed-in devices", section: "sessions", words: "sessions devices browsers sign out logout everywhere" },
  { label: "API tokens", section: "developer", words: "token api bearer script shortcut" },
  { label: "Webhooks", section: "developer", words: "webhook hook post hmac" },
  { label: "MCP", section: "developer", words: "mcp claude code server address" },
];

export function findSettings(q: string, visible: Set<SettingsSection>) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_INDEX.filter((s) => visible.has(s.section)).filter((s) => {
    const hay = `${s.label} ${s.words} ${SECTIONS.find((x) => x.id === s.section)!.label}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** An error from the server said as a sentence, never an exception's text. */
export const said = (e: unknown, fallback: string) => {
  const m = e instanceof Error ? e.message : "";
  if (!m || /^(request failed|failed to fetch|\d{3}\b)/i.test(m)) return fallback;
  return m.charAt(0).toUpperCase() + m.slice(1);
};
