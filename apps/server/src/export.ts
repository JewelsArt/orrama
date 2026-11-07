/**
 * export.ts — the command: everything Orrama holds that is not in the vault, in one folder.
 *
 *   pnpm --dir apps/server export [folder]
 *
 * What it writes, and why, is in exportData.ts; the app's Back up now (backup.ts) writes the
 * same with the notes, in one .zip.
 */
import { isEntry } from "./entry.js";
import { exportOrrama } from "./exportData.js";

export { EXPORT_FORMAT, exportOrrama, webhookHint, type ExportResult } from "./exportData.js";

if (isEntry(import.meta.url, process.argv[1])) {
  try {
    const { dir, counts } = await exportOrrama({ into: process.argv[2] });
    console.log(`Exported to ${dir}`);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(18)} ${v}`);
  } catch (err) {
    console.error(`export failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
