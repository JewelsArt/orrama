/**
 * Settings → Connections → Claude (2M): Connect to Claude lets the Claude app and Claude Code
 * work with your notes through Orrama's own MCP server, which the desktop app carries. Connect
 * makes a key good for Orrama's tools only, kept in Orrama's own folder (never in Claude's
 * settings or in the command below), adds Orrama to the Claude app's settings when the app is
 * on this computer, and shows the one command Claude Code needs. Disconnect asks first: the key
 * is revoked and Orrama leaves the Claude app's settings. The server does the work
 * (apps/server/src/claudeConnect.ts); a server that isn't the desktop app says so, and keeps the
 * way a script reaches it (an API token from Developer).
 */
import { useEffect, useState } from "react";
import type { ClaudeConnection } from "@orrama/schema/responses";
import { api } from "../api.js";
import type { ConfirmRequest } from "../Confirm.js";
import { Button } from "../ui/controls.js";
import { Input } from "../ui/fields.js";
import { toast } from "../ui/overlays.js";
import { Notice } from "../ui/states.js";
import { dateLabel } from "../ui/dates.js";
import { StateLine, SubHead, said } from "./parts.js";

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`);
  } catch {
    toast("Couldn't copy. Select it and copy it.");
  }
};

/** The Claude app's line, in words: the state, and what to do about it. */
function desktopLine(c: ClaudeConnection): { tone: "ok" | "off" | "bad"; detail: string } {
  switch (c.desktop) {
    case "added":
      return { tone: "ok", detail: "added. Quit and reopen Claude to see Orrama there." };
    case "missing":
      return { tone: "off", detail: "not added yet" };
    case "absent":
      return { tone: "off", detail: "not on this computer" };
    case "broken":
      return { tone: "bad", detail: c.desktopProblem ?? "Orrama couldn't read its settings." };
  }
}

export function ClaudePart({ ask }: { ask: (r: ConfirmRequest) => void }) {
  const [c, setC] = useState<ClaudeConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ClaudeConnection>("GET", "/api/claude")
      .then(setC)
      .catch(() => setC(null));
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      setC(await api<ClaudeConnection>("POST", "/api/claude/connect"));
    } catch (e) {
      setError(said(e, "Orrama couldn't connect to Claude."));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = () =>
    ask({
      title: "Disconnect Claude?",
      body: "Claude can't reach your notes any more: its key stops working and Orrama leaves the Claude app's settings. Claude Code keeps its line until you remove it there.",
      confirmLabel: "Disconnect Claude",
      danger: true,
      onConfirm: () =>
        void api<ClaudeConnection>("POST", "/api/claude/disconnect")
          .then(setC)
          .catch((e) => toast(said(e, "Claude couldn't be disconnected."))),
    });

  if (!c) return null;
  const used = c.connected?.lastUsedAt ? `used ${dateLabel(c.connected.lastUsedAt)}` : "not used yet";
  const desktop = desktopLine(c);
  const terminal = navigator.userAgent.includes("Windows") ? "a terminal" : "Terminal";

  return (
    <div>
      <SubHead>Claude</SubHead>
      {!c.available ? (
        <NotHere why={c.why} />
      ) : c.connected ? (
        <>
          <StateLine
            tone="ok"
            title="Connected"
            detail={`since ${dateLabel(c.connected.since)}, ${used}`}
            action={
              <Button size="sm" danger onClick={disconnect} aria-label="Disconnect Claude">
                Disconnect
              </Button>
            }
          />
          <div className="set-claude">
            <StateLine
              tone={desktop.tone}
              title="Claude app"
              detail={desktop.detail}
              action={
                c.desktop === "missing" ? (
                  <Button size="sm" disabled={busy} onClick={() => void connect()}>
                    Add
                  </Button>
                ) : undefined
              }
            />
          </div>
          {c.command && (
            <>
              <p className="set-help set-lead set-claude-code">Claude Code: run this once in {terminal}.</p>
              <div className="set-keyrow">
                <Input readOnly value={c.command} aria-label="The Claude Code command" onFocus={(e) => e.currentTarget.select()} />
                <Button onClick={() => void copy(c.command!, "The command")}>Copy</Button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <p className="set-help set-lead">
            Let Claude read your notes, steps, projects and calendar, change them when you ask, and write mail drafts that you send yourself.
          </p>
          <div className="set-actions">
            <Button kind="solid" disabled={busy} onClick={() => void connect()}>
              {busy ? "Connecting…" : "Connect to Claude"}
            </Button>
            <span className="set-help">
              {c.otherAccount ? "Another account on this computer is connected. Connecting moves Claude to yours." : "For the Claude app and Claude Code on this computer."}
            </span>
          </div>
        </>
      )}
      {error && <Notice title="Not connected" text={error} />}
    </div>
  );
}

/** A server that isn't the desktop app: why, and the way a script reaches it instead. */
function NotHere({ why }: { why: string | null }) {
  const [how, setHow] = useState(false);
  const origin = location.origin;
  return (
    <>
      <p className="set-help set-lead">
        {why}{" "}
        <button type="button" className="set-how" aria-expanded={how} onClick={() => setHow(!how)}>
          Another way?
        </button>
      </p>
      {how && (
        <p className="set-help">
          Make an API token in Developer, then register Orrama's MCP server from a copy of its source at user scope, so the token stays in{" "}
          <code>~/.claude.json</code> and out of your notes:{" "}
          <code>claude mcp add orrama --scope user --env ORRAMA_URL={origin} --env ORRAMA_TOKEN=bslt_… -- node …/apps/mcp/dist/index.js</code>
        </p>
      )}
    </>
  );
}
