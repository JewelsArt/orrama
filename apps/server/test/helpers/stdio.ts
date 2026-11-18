/**
 * An MCP client over stdio, the way Claude Desktop and Claude Code talk to a local server: the
 * command its settings name, JSON-RPC one message per line on stdin and stdout.
 */
import { spawn } from "node:child_process";

export function stdioClient(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "";
  let err = "";
  const waiting = new Map<number, (msg: { result?: any; error?: { message: string } }) => void>();
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    out += chunk;
    for (let nl = out.indexOf("\n"); nl >= 0; nl = out.indexOf("\n")) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number; result?: any; error?: { message: string } };
      if (typeof msg.id === "number") waiting.get(msg.id)?.(msg);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
  let next = 1;
  const request = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} in 20 s; stderr: ${err}`)), 20_000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  const initialize = async () => {
    const r = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "orrama-test", version: "0" } });
    notify("notifications/initialized");
    return r as { serverInfo: { name: string; version: string } };
  };
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const close = async () => {
    child.stdin.end();
    if ((await Promise.race([exited, new Promise((r) => setTimeout(() => r("running"), 5_000))])) === "running") child.kill("SIGKILL");
  };
  return { child, request, initialize, close, stderr: () => err };
}
