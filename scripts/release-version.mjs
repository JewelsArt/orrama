#!/usr/bin/env node
// What release.yml builds and where it puts it, as GitHub Actions outputs (version=, tag=, title=).
//
// The version is the app's (apps/desktop/src-tauri/tauri.conf.json; test/release.test.ts keeps the
// other twelve places in step). A tag push must be v<that version>, and its draft release is that
// tag. A run by hand must name that version (so nobody builds 0.1.0 thinking it is 0.2.0), and its
// draft is a test build, v<version>-test.<run number>, never published.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The release for one run, or why there is none. */
export function releaseOf({ version, refType, refName, input, runNumber }) {
  if (refType === "tag") {
    if (refName !== `v${version}`) return { problem: `the tag ${refName} is not v${version}, the app's version` };
    return { version, tag: refName, title: `Orrama ${version}` };
  }
  if (input !== version) return { problem: `asked for ${input || "no version"}, but the app here is ${version}` };
  return { version, tag: `v${version}-test.${runNumber}`, title: `Orrama ${version}, test build ${runNumber}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"));
  const r = releaseOf({
    version,
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    input: process.env.INPUT_VERSION,
    runNumber: process.env.RUN_NUMBER,
  });
  if (r.problem) {
    console.error(`release-version: ${r.problem}`);
    process.exit(1);
  }
  console.log(`version=${r.version}\ntag=${r.tag}\ntitle=${r.title}`);
}
