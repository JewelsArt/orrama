/**
 * Opening a message parses whatever its sender wrote, on the event loop.
 * mailparser runs nodemailer's address parser over From/To/Cc/Reply-To, and
 * before nodemailer 10.0.6 its free-text fallback was quadratic: a 62 KB From
 * held the whole server for 3.5 s each time the message was opened, in Mail
 * or through the agent's read_email (audit OPS-002).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readMessage } from "../src/mail.js";

const source = (headers: string) => Buffer.from(`${headers}\r\nSubject: hi\r\nMessage-ID: <m1@example.org>\r\n\r\nbody\r\n`);

describe("readMessage on a hostile message", () => {
  // The first parse also loads and compiles mailparser: not what is measured.
  beforeAll(async () => {
    await readMessage(1, source("From: x@example.org\r\nTo: j@example.org"));
  });

  for (const header of ["From", "To", "Cc", "Reply-To"]) {
    it(`a 64 KB ${header} of "a." parses in well under a second`, async () => {
      const other = header === "To" ? "From: x@example.org" : "To: j@example.org";
      const t = performance.now();
      const m = await readMessage(1, source(`${header}: ${"a.".repeat(32_000)}\r\n${other}`));
      const ms = performance.now() - t;
      expect(m.subject).toBe("hi");
      // ~3,500 ms before; ~20 ms now. 500 leaves room for a loaded machine
      // running every suite at once (200 failed there) and still catches it.
      expect(ms).toBeLessThan(500);
    });
  }

  it("still reads an ordinary message the way the Mail view shows it", async () => {
    const m = await readMessage(
      7,
      source("From: Ada <ada@example.org>\r\nTo: Jules <j@example.org>, b@example.org\r\nReferences: <a@x> <b@x>\r\nDate: Tue, 06 Oct 2026 09:00:00 +0000"),
      { from: [{ name: "Ada", address: "ada@example.org" }] },
    );
    expect(m).toMatchObject({
      uid: 7,
      from: "ada@example.org",
      fromName: "Ada",
      to: '"Jules" <j@example.org>, b@example.org',
      subject: "hi",
      date: "2026-10-06T09:00:00.000Z",
      messageId: "<m1@example.org>",
      references: "<a@x> <b@x>",
    });
    expect(m.text.trim()).toBe("body");
  });
});
