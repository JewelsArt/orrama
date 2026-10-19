/**
 * Settings, rebuilt as a page (structure.md §3): eight sections, each at its own address
 * (`/settings/<section>`), each saying whether it lives on this device, your account or this
 * server. On the desktop the sections are listed on the left and one shows on the right; on the
 * phone `/settings` is the list (More → Settings) and each section is its own screen.
 *
 * The sections are in `settings/`: they keep everything the old one-long-form did (avatar,
 * name, theme, colour vision and the palette editor, the AI provider, model, key and
 * instructions, calendars, mail, the published planning link, passcode and Touch ID, sessions,
 * API tokens, webhooks, sign out), and everything that cannot be undone asks first (WEB-017).
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { AiConfig, Feed, MailAccount, Member, ServerSettings } from "@orrama/schema/responses";
import { api, type Me, type SessionInfo } from "./api.js";
import type { VisionProfile } from "./palette.js";
import { AccessSection } from "./settings/Access.js";
import { AiSection } from "./settings/Ai.js";
import { AppearanceSection, type ThemeChoice } from "./settings/Appearance.js";
import type { Look } from "./ui/theme.js";
import { ConnectionsSection } from "./settings/Connections.js";
import { DeveloperSection } from "./settings/Developer.js";
import { DeviceSection } from "./settings/Device.js";
import { NotesSection } from "./settings/NotesSettings.js";
import { findSettings, SECOND_GROUP, SectionIcon, SECTIONS } from "./settings/parts.js";
import { SignedInSection } from "./settings/SignedIn.js";
import { YouSection } from "./settings/You.js";
import { Button } from "./ui/controls.js";
import { SearchField } from "./ui/fields.js";
import { Icon } from "./ui/Icon.js";
import { Avatar, avatarName, AVATAR_NAMES } from "./ui/orr/Orr.js";
import { navigate, routeHref, type SettingsSection } from "./ui/router.js";
import { Skeleton } from "./ui/states.js";

export type { ThemeChoice };

const plain = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const open = (section: SettingsSection) => (e: MouseEvent) => {
  if (!plain(e)) return;
  e.preventDefault();
  navigate({ kind: "settings", section });
};

export interface SettingsProps {
  me: Me;
  /** The section in the address; none is the list on the phone and You on the desktop. */
  section?: SettingsSection;
  theme: ThemeChoice;
  /** What the page shows now (Match this device resolves to one of the two). */
  shown: "light" | "dark";
  onTheme: (t: ThemeChoice) => void;
  /** Paper or Clay (19 Oct 2026), per account. */
  look: Look;
  onLook: (look: Look) => void;
  vision: string;
  onVision: (v: string) => void;
  profiles: VisionProfile[];
  onProfiles: (p: VisionProfile[]) => void;
  onUpdate: (me: Me) => void;
  onSignOut: () => void;
}

export function Settings(props: SettingsProps) {
  const { me, section } = props;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [server, setServer] = useState<ServerSettings | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    api<Member[]>("GET", "/api/members")
      .then(setMembers)
      .catch(() => setMembers([]));
    if (me.isOwner)
      api<ServerSettings>("GET", "/api/settings/server")
        .then(setServer)
        .catch(() => setServer(null));
  }, [me.isOwner]);

  /** Orr & AI is the owner's; Access only exists with a second account (§3.1). */
  const visible = useMemo(
    () => SECTIONS.filter((s) => (s.id === "ai" ? me.isOwner : s.id === "access" ? (members?.length ?? 0) > 1 : true)),
    [me.isOwner, members],
  );
  const shown = section ?? "you";
  const known = visible.some((s) => s.id === shown);
  // An address for a section this server doesn't have (Access with one account) goes to You.
  useEffect(() => {
    if (section && !known && members !== null) navigate({ kind: "settings", section: "you" }, { replace: true });
  }, [section, known, members]);

  const results = findSettings(q, new Set(visible.map((s) => s.id)));
  const searchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && results[0]) {
      e.preventDefault();
      navigate({ kind: "settings", section: results[0].section });
      setQ("");
    }
  };

  return (
    <div className={section ? "set has-sec" : "set"}>
      <nav className="set-nav" aria-label="Settings">
        <h1>Settings</h1>
        <SearchField label="Find a setting" placeholder="Find a setting" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={searchKey} />
        {q.trim() ? (
          results.length > 0 ? (
            results.map((r) => (
              <a key={r.label} className="set-ni" href={routeHref({ kind: "settings", section: r.section })} onClick={(e) => (open(r.section)(e), setQ(""))}>
                <SectionIcon id={r.section} />
                <span>
                  {r.label}
                  <small>{SECTIONS.find((s) => s.id === r.section)!.label}</small>
                </span>
              </a>
            ))
          ) : (
            <p className="set-none">No setting called that.</p>
          )
        ) : (
          visible.map((s) => (
            <div key={s.id} style={{ display: "contents" }}>
              {s.id === SECOND_GROUP && <div className="set-sep" />}
              <a
                className={s.id === shown ? "set-ni on" : "set-ni"}
                href={routeHref({ kind: "settings", section: s.id })}
                aria-current={s.id === shown ? "page" : undefined}
                onClick={open(s.id)}
              >
                <SectionIcon id={s.id} />
                <span>{s.label}</span>
              </a>
            </div>
          ))
        )}
        <p className="set-foot">
          {server ? `Orrama ${server.version} · reading ${server.notes} notes in ${server.notesFolder}` : "Orrama"}
        </p>
      </nav>

      <div className="set-body">{known ? <Section {...props} id={shown} members={members ?? []} /> : <Skeleton rows={4} label="Loading Settings" />}</div>

      {!section && <PhoneList {...props} visible={visible.map((s) => s.id)} server={server} />}
    </div>
  );
}

function Section({ id, members, ...p }: SettingsProps & { id: SettingsSection; members: Member[] }) {
  const meta = SECTIONS.find((s) => s.id === id)!;
  switch (id) {
    case "you":
      return <YouSection key={p.me.id} meta={meta} me={p.me} onUpdate={p.onUpdate} />;
    case "appearance":
      return (
        <AppearanceSection
          meta={meta}
          theme={p.theme}
          shown={p.shown}
          onTheme={p.onTheme}
          look={p.look}
          onLook={p.onLook}
          vision={p.vision}
          onVision={p.onVision}
          profiles={p.profiles}
          onProfiles={p.onProfiles}
        />
      );
    case "ai":
      return <AiSection meta={meta} />;
    case "notes":
      return <NotesSection meta={meta} owner={p.me.isOwner} />;
    case "connections":
      return <ConnectionsSection meta={meta} />;
    case "device":
      return <DeviceSection meta={meta} me={p.me} />;
    case "sessions":
      return <SignedInSection meta={meta} onSignOut={p.onSignOut} />;
    case "developer":
      return <DeveloperSection meta={meta} />;
    case "access":
      return <AccessSection meta={meta} members={members} />;
  }
}

/**
 * The phone's Settings (§1.6): your Orr on top, then the sections in two groups, each row
 * saying where it stands (the theme, the model, how many notes…), and Sign out at the foot.
 */
function PhoneList({ me, theme, look, onSignOut, visible, server }: SettingsProps & { visible: SettingsSection[]; server: ServerSettings | null }) {
  const [ai, setAi] = useState<AiConfig | null>(null);
  const [mail, setMail] = useState<MailAccount | null>(null);
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [passcode, setPasscode] = useState<boolean | null>(null);

  useEffect(() => {
    if (me.isOwner)
      api<AiConfig>("GET", "/api/admin/ai")
        .then(setAi)
        .catch(() => {});
    api<MailAccount>("GET", "/api/mail/account")
      .then(setMail)
      .catch(() => {});
    api<Feed[]>("GET", "/api/calendar/feeds")
      .then(setFeeds)
      .catch(() => {});
    api<SessionInfo[]>("GET", "/api/auth/sessions")
      .then(setSessions)
      .catch(() => {});
    api<{ passcode: boolean }>("POST", "/api/auth/unlock/options", { email: me.email })
      .then((r) => setPasscode(r.passcode))
      .catch(() => {});
  }, [me.isOwner, me.email]);

  const connections = [mail?.connected ? "Gmail" : null, feeds && feeds.length > 0 ? `${feeds.length} ${feeds.length === 1 ? "calendar" : "calendars"}` : null].filter(Boolean).join(", ");
  const summary: Partial<Record<SettingsSection, string>> = {
    appearance: `${look === "clay" ? "Clay" : "Paper"}, ${theme === "match" ? "Match this device" : theme === "dark" ? "Night" : "Day"}`,
    ai: ai ? (ai.configured ? (ai.model ?? "") : "Not set up") : "",
    notes: server ? `${server.notes} notes` : "",
    connections: mail && feeds ? connections || "None yet" : "",
    device: passcode === null ? "" : passcode ? "Passcode on" : "No passcode",
    sessions: sessions ? `${sessions.length} ${sessions.length === 1 ? "device" : "devices"}` : "",
  };
  const row = (id: Exclude<SettingsSection, "you">) => {
    const meta = SECTIONS.find((s) => s.id === id)!;
    return (
      <a key={id} className="set-prow" href={routeHref({ kind: "settings", section: id })} onClick={open(id)}>
        <SectionIcon id={id} size={20} />
        <b>{meta.label}</b>
        <small>{summary[id] ?? ""}</small>
        <Icon name="chev-r" size={14} />
      </a>
    );
  };
  const rest = visible.filter((id): id is Exclude<SettingsSection, "you"> => id !== "you");
  const cut = rest.findIndex((id) => id === SECOND_GROUP);
  const who = AVATAR_NAMES.find((a) => a.id === avatarName(me.avatar))!;

  return (
    <div className="set-list">
      <a className="set-pme" href={routeHref({ kind: "settings", section: "you" })} onClick={open("you")}>
        <Avatar name={me.avatar} size={56} />
        <span>
          <b>{me.displayName}</b>
          <small>{who.name} · Your account</small>
        </span>
        <Icon name="chev-r" size={14} />
      </a>
      <nav className="set-pgroup" aria-label="Settings">
        {rest.slice(0, cut).map(row)}
      </nav>
      <nav className="set-pgroup" aria-label="Settings on this device and server">
        {rest.slice(cut).map(row)}
      </nav>
      <Button className="set-psignout" danger onClick={onSignOut}>
        Sign out of this device
      </Button>
    </div>
  );
}
