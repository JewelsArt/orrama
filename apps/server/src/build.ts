/**
 * What the desktop bundle knows about itself. `scripts/package-server.mjs` bundles the server
 * into one file and sets `__ORRAMA_BUNDLE__` (an esbuild `define`); under tsx (launchd, `dev`,
 * the tests) it is absent and the version comes from this package's own package.json. The
 * bundle has no package.json two folders up: reading one there gave Settings no version.
 */
import fs from "node:fs";

declare const __ORRAMA_BUNDLE__: { version: string } | undefined;

/** True inside the bundle (`resources/server/server.mjs`), false when run from the checkout. */
export const bundled = typeof __ORRAMA_BUNDLE__ !== "undefined";

const packageVersion = (): string => {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "";
  } catch {
    return "";
  }
};

/** The server's version (the thirteen places agree; release.test.ts). */
export const VERSION: string = typeof __ORRAMA_BUNDLE__ !== "undefined" ? __ORRAMA_BUNDLE__.version : packageVersion();
