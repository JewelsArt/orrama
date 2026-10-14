/** Close a database `createDb` opened: Windows cannot delete an open one (EBUSY, audit OPS-003). */
export function closeDb(db: unknown): void {
  (db as { $client: { close(): void } }).$client.close();
}
