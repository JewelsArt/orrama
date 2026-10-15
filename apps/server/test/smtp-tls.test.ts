/**
 * Sending mail on port 587 (or anything but 465) must not log in without TLS.
 * A server — or a network in the middle — that does not offer STARTTLS used to
 * receive AUTH with the mailbox password in base64. This fake server offers
 * AUTH and no STARTTLS, and records what it is sent.
 */
import net from "node:net";
import { afterAll, describe, expect, it } from "vitest";

process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
const { sendMail } = await import("../src/mail.js");

const received: string[] = [];
const server = net.createServer((sock) => {
  sock.write("220 plain.example ESMTP\r\n");
  sock.on("data", (buf) => {
    for (const line of buf.toString().split("\r\n").filter(Boolean)) {
      received.push(line);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") sock.write("250-plain.example\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
      else if (cmd === "HELO") sock.write("250 plain.example\r\n");
      else if (cmd === "AUTH") sock.write("235 ok\r\n");
      else if (cmd === "QUIT") sock.end("221 bye\r\n");
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as net.AddressInfo).port;
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("SMTP without TLS", () => {
  it("refuses to send, and never sends the password", async () => {
    const creds = { email: "me@example.test", password: "hunter2-mail-password", imapHost: "127.0.0.1", imapPort: 993, smtpHost: "127.0.0.1", smtpPort: port };
    await expect(sendMail(creds, { to: "you@example.test", subject: "hi", body: "x" })).rejects.toThrow();
    const b64 = Buffer.from("hunter2-mail-password").toString("base64");
    const auth = received.filter((l) => /^AUTH/i.test(l) || l.includes(b64) || l.includes(Buffer.from("\0me@example.test\0hunter2-mail-password").toString("base64")));
    expect(auth).toEqual([]);
    expect(received.some((l) => /^EHLO/i.test(l))).toBe(true); // it did talk to the server
  });
});
