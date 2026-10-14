import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Windows TEMP may name an 8.3 alias. The non-native sync realpath preserves
// that spelling, so canonicalize before deriving scopes, identities or pins.
export function fixtureTempDirectory(): string {
  return realpathSync.native(tmpdir());
}

export function makeFixtureDirectory(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(fixtureTempDirectory(), prefix)));
}
