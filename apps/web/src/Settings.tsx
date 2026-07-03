import { useState } from "react";
import { api, type Me } from "./api.js";
import { CHARACTERS, CharacterAvatar } from "./avatars.js";
import { IconMoon, IconSignOut, IconSun, IconX } from "./icons.js";

export function Settings({
  me,
  theme,
  onTheme,
  onUpdate,
  onClose,
  onSignOut,
}: {
  me: Me;
  theme: string;
  onTheme: (t: string) => void;
  onUpdate: (me: Me) => void;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [name, setName] = useState(me.displayName);
  const [saving, setSaving] = useState(false);

  const patch = async (body: { avatar?: string; displayName?: string }) => {
    setSaving(true);
    try {
      onUpdate(await api<Me>("PATCH", "/api/me", body));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <span>Settings</span>
          <button className="ghost" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>

        <section>
          <h3>Character</h3>
          <div className="char-grid">
            {CHARACTERS.map((c) => (
              <button
                key={c.id}
                className={`char-pick ${me.avatar === c.id ? "active" : ""}`}
                title={c.name}
                disabled={saving}
                onClick={() => patch({ avatar: c.id })}
              >
                <CharacterAvatar id={c.id} size={40} />
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Profile</h3>
          <form
            className="settings-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name !== me.displayName) void patch({ displayName: name });
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
            <button className="primary" disabled={saving || name.trim() === me.displayName}>
              Save
            </button>
          </form>
          <p className="settings-meta">
            @{me.username} · {me.email}
            {me.teams.length > 0 && <> · {me.teams.map((t) => t.name).join(", ")}</>}
            {me.isOwner && <> · workspace owner</>}
          </p>
        </section>

        <section>
          <h3>Theme</h3>
          <div className="settings-row">
            <button className={`theme-pick ${theme === "command" ? "active" : ""}`} onClick={() => onTheme("command")}>
              <IconMoon /> Command Center
            </button>
            <button className={`theme-pick ${theme === "paper" ? "active" : ""}`} onClick={() => onTheme("paper")}>
              <IconSun /> Paper
            </button>
          </div>
        </section>

        <button className="settings-signout ghost" onClick={onSignOut}>
          <IconSignOut /> Sign out
        </button>
      </div>
    </div>
  );
}
