import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { IconMark } from "./icons.js";

export function Terminal({ me }: { me: any }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!containerRef.current) return;

    // Helper to get raw hex/rgb from CSS variables, since XTerm canvas renderer needs raw values
    const styles = getComputedStyle(document.documentElement);
    const getVar = (name: string, fallback: string) => {
      const val = styles.getPropertyValue(name).trim();
      return val || fallback;
    };

    // Grab actual theme colors to pass into xterm so it integrates flawlessly
    const term = new XTerm({
      fontFamily: getVar('--font-mono', 'JetBrains Mono') + ", monospace",
      fontSize: 13,
      cursorBlink: true,
      allowTransparency: true,
      theme: {
        background: "transparent",
        foreground: getVar('--text', '#ffffff'),
        cursor: getVar('--text', '#ffffff'),
        black: getVar('--text', '#ffffff'),
        red: getVar('--danger', '#ff0000'),
        green: getVar('--ok', '#00ff00'),
        yellow: getVar('--warn', '#ffff00'),
        blue: getVar('--accent', '#0000ff'),
        magenta: getVar('--logo', '#ff00ff'),
        cyan: getVar('--accent-dim', '#00ffff'),
        white: getVar('--bg', '#000000'),
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    const handleResize = () => {
      if (fitRef.current && termRef.current) {
        fitRef.current.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "resize",
            cols: termRef.current.cols,
            rows: termRef.current.rows,
          }));
        }
      }
    };
    window.addEventListener("resize", handleResize);

    const connect = () => {
      if (!termRef.current) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const token = localStorage.getItem("basalt-token") ?? "";
      const ws = new WebSocket(`${proto}://${location.host}/api/terminal?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      
      // xterm expects string or Uint8Array. Using string representation of utf8 text
      // since the server sends Buffer.
      ws.binaryType = "blob";

      ws.onopen = () => {
        term.writeln("\x1b[32mConnected to Claude Code terminal.\x1b[0m");
        handleResize();
      };

      ws.onmessage = async (e) => {
        if (e.data instanceof Blob) {
          const text = await e.data.text();
          termRef.current?.write(text);
        } else {
          termRef.current?.write(e.data);
        }
      };

      ws.onclose = () => {
        termRef.current?.writeln("\r\n\x1b[31mDisconnected. Reconnecting...\x1b[0m");
        reconnectTimer.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        // Handled by close
      };
    };

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    connect();

    return () => {
      window.removeEventListener("resize", handleResize);
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      term.dispose();
    };
  }, []);

  return (
    <div className="Terminal" style={{ height: "100%", padding: "16px", boxSizing: "border-box" }}>
      <div 
        style={{ 
          height: "100%", 
          borderRadius: "var(--radius-lg)", 
          padding: "16px 20px", 
          display: "flex", 
          flexDirection: "column",
          boxSizing: "border-box",
          background: "var(--glass)",
          backdropFilter: "blur(26px) saturate(150%)",
          WebkitBackdropFilter: "blur(26px) saturate(150%)",
          border: "1px solid var(--glass-brd)",
          boxShadow: "var(--card-shadow), inset 0 1px 0 var(--glass-hi)",
        }}
      >
        <div style={{ marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <IconMark size={16} />
          <strong style={{ fontFamily: "JetBrains Mono, monospace" }}>Claude Code (Vault Shell)</strong>
        </div>
        <div ref={containerRef} style={{ flex: 1, overflow: "hidden" }} />
      </div>
    </div>
  );
}
