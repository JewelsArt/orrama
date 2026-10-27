/**
 * The update feed (2E): `scripts/release-feed.mjs` writes `latest.json`, what every installed
 * Orrama reads to learn of a new version (apps/desktop/src-tauri/src/updater.rs). One version per
 * feed, a signature for every platform, https downloads that name the version, and the version's
 * changelog entry as the notes the dialog shows.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type Feed = { version: string; notes: string; pub_date: string; platforms: Record<string, { signature: string; url: string }> };
type Added = { feed?: Feed; problem?: string };
const root = path.resolve(import.meta.dirname, "../../..");
const feedModule = (await import(pathToFileURL(path.join(root, "scripts/release-feed.mjs")).href)) as {
  PLATFORMS: string[];
  addToFeed(feed: Feed | null, e: { version: string; platform: string; signature: string; url: string; notes?: string; now?: Date }): Added;
  checkFeed(feed: Feed | null, version: string, platforms?: string[]): string[];
  notesFromChangelog(changelog: string, version: string): string;
};
const { PLATFORMS, addToFeed, checkFeed, notesFromChangelog } = feedModule;

const base = "https://github.com/JewelsArt/orrama/releases/download/v0.2.0";
const mac = { version: "0.2.0", platform: "darwin-aarch64", signature: "c2ln\n", url: `${base}/Orrama_0.2.0_aarch64.app.tar.gz`, now: new Date("2026-11-02T10:00:00.123Z") };
const win = { version: "0.2.0", platform: "windows-x86_64", signature: "c2lnMg==", url: `${base}/Orrama_0.2.0_x64-setup.exe` };

describe("the update feed", () => {
  it("is made by the first platform and completed by the second", () => {
    expect(PLATFORMS).toEqual(["darwin-aarch64", "windows-x86_64"]);
    const first = addToFeed(null, { ...win, notes: "### Fixed\n- Notes keep their title" });
    expect(first.problem).toBeUndefined();
    const both = addToFeed(first.feed!, mac).feed!;
    expect(both).toEqual({
      version: "0.2.0",
      notes: "### Fixed\n- Notes keep their title",
      pub_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      platforms: {
        "windows-x86_64": { signature: "c2lnMg==", url: win.url },
        "darwin-aarch64": { signature: "c2ln", url: mac.url },
      },
    });
    expect(checkFeed(both, "0.2.0")).toEqual([]);
  });

  it("is checked before the release is published", () => {
    const winOnly = addToFeed(null, win).feed!;
    expect(checkFeed(winOnly, "0.2.0")).toEqual(["darwin-aarch64 is missing"]);
    expect(checkFeed(winOnly, "0.2.0", ["windows-x86_64"])).toEqual([]);
    expect(checkFeed(winOnly, "0.2.1")[0]).toMatch(/for 0\.2\.0, not 0\.2\.1/);
    expect(checkFeed(null, "0.2.0")).toEqual(["there is no feed"]);
    const stale = { ...winOnly, version: "0.2.1" };
    expect(checkFeed(stale, "0.2.1", ["windows-x86_64"])).toEqual([`windows-x86_64's download (${win.url}) does not name 0.2.1`]);
  });

  it("never mixes versions, takes no test build, and needs a signature and an https download", () => {
    const feed = addToFeed(null, win).feed!;
    expect(addToFeed(feed, { ...mac, version: "0.2.1" }).problem).toMatch(/the feed is for 0\.2\.0, not 0\.2\.1/);
    expect(addToFeed(null, { ...mac, version: "0.2.0-test.7" }).problem).toMatch(/not X\.Y\.Z/);
    expect(addToFeed(null, { ...mac, platform: "linux-x86_64" }).problem).toMatch(/not one of/);
    expect(addToFeed(null, { ...mac, signature: " \n" }).problem).toMatch(/no signature.*TAURI_SIGNING_PRIVATE_KEY/);
    expect(addToFeed(null, { ...mac, url: "http://example.com/Orrama_0.2.0.tar.gz" }).problem).toMatch(/https/);
    expect(addToFeed(null, { ...mac, url: "http://127.0.0.1:4879/Orrama_0.2.0_aarch64.app.tar.gz" }).problem).toBeUndefined();
  });

  it("takes its notes from the version's changelog entry", () => {
    const log = "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] — 2026-11-02\n\n### Fixed\n- One\n\n## [0.1.0] — 2026-10-01\n\n- Old\n";
    expect(notesFromChangelog(log, "0.2.0")).toBe("### Fixed\n- One");
    expect(notesFromChangelog(log, "0.1.0")).toBe("- Old");
    expect(notesFromChangelog(log, "0.3.0")).toBe("");
  });
});
