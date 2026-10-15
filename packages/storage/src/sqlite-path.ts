import { toNamespacedPath } from 'node:path';

/** SQLite's Windows VFS needs the extended filename spelling for deep local
 * paths. Call only at the native database-open boundary, after the caller's
 * existing path checks. Keep canonical paths for identity, locks and sidecars;
 * this conversion supplies no filesystem authority or additional validation. */
export function sqliteTransportPath(filename: string): string {
  if (process.platform !== 'win32' || filename === '' || filename === ':memory:' ||
      filename.startsWith('\\\\?\\') || filename.startsWith('\\\\.\\')) return filename;
  return toNamespacedPath(filename);
}
