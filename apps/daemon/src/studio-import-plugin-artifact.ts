import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';

function refused(): never { throw new ArcaneError('STUDIO_IMPORT_PLUGIN', 'Rebuild the bundled Arcane plugin before preparing a Studio import.'); }
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function bytes(path: string, limit: number): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit)) refused();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true }), data = await handle.readFile();
    const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    for (const stat of [opened, after, named]) if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size ||
      stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs || stat.nlink !== 1n || stat.mode !== before.mode) refused();
    if (data.length !== Number(before.size)) refused();
    return data;
  } finally { await handle.close(); }
}

/** Read only the fixed bundled build, never the installed Studio plugin or credentials. */
export async function studioImportPluginArtifactHash(resourceRoot: string): Promise<string> {
  try {
    const root = resolve(resourceRoot);
    for (const directory of [root, join(root, 'plugin'), join(root, 'plugin', 'build')]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(directory), directory)) refused();
    }
    const manifest: unknown = JSON.parse((await bytes(join(root, 'plugin', 'build', 'manifest.json'), 64 * 1024)).toString('utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) refused();
    const m = manifest as Record<string, unknown>;
    if (m.schemaVersion !== 1 || m.protocolVersion !== 1 || m.preferredArtifact !== 'ArcaneLocalBridge.lua' ||
      !Array.isArray(m.artifacts) || m.artifacts.length > 8) refused();
    const artifacts = m.artifacts.filter(a => a && typeof a === 'object' && (a as Record<string, unknown>).name === 'ArcaneLocalBridge.lua');
    if (artifacts.length !== 1) refused();
    const artifact = artifacts[0] as Record<string, unknown>;
    if (artifact.format !== 'luau-source' || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes)) refused();
    const source = await bytes(join(root, 'plugin', 'build', 'ArcaneLocalBridge.lua'), 2 * 1024 * 1024);
    const hash = createHash('sha256').update(source).digest('hex');
    if (artifact.bytes !== source.length || artifact.sha256 !== hash || !source.includes('"scene.import_context"')) refused();
    return hash;
  } catch (error) {
    if (error instanceof ArcaneError) throw error;
    refused();
  }
}
