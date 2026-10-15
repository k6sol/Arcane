import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { STUDIO_PLUGIN_SOURCES, STUDIO_PLUGIN_IDENTITY_SCHEME, STUDIO_PLUGIN_LIMITS } from '../../../packages/protocol/src/studio-plugin-artifact.js';

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

/** Verify the fixed bundled XML and return the loaded-source hierarchy identity.
 * Never inspect the installed Studio plugin or credentials. */
export async function studioImportPluginArtifactHash(resourceRoot: string): Promise<string> {
  try {
    const root = resolve(resourceRoot);
    for (const directory of [root, join(root, 'plugin'), join(root, 'plugin', 'build'), join(root, 'plugin', 'src')]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(directory), directory)) refused();
    }
    const manifest: unknown = JSON.parse((await bytes(join(root, 'plugin', 'build', 'manifest.json'), STUDIO_PLUGIN_LIMITS.manifestBytes)).toString('utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) refused();
    const m = manifest as Record<string, unknown>;
    if (m.schemaVersion !== 1 || m.protocolVersion !== 1 || m.preferredArtifact !== 'ArcaneLocalBridge.rbxmx' ||
      !Array.isArray(m.artifacts) || m.artifacts.length > 8) refused();
    const artifacts = m.artifacts.filter(a => a && typeof a === 'object' && (a as Record<string, unknown>).name === 'ArcaneLocalBridge.rbxmx');
    if (artifacts.length !== 1) refused();
    const artifact = artifacts[0] as Record<string, unknown>;
    if (artifact.format !== 'roblox-xml-v4' || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes)) refused();
    const source = await bytes(join(root, 'plugin', 'build', 'ArcaneLocalBridge.rbxmx'), STUDIO_PLUGIN_LIMITS.artifactBytes);
    const hash = createHash('sha256').update(source).digest('hex');
    if (artifact.bytes !== source.length || artifact.sha256 !== hash || !source.includes('"scene.import_context"')) refused();
    if (!Array.isArray(m.sources) || m.sources.length !== STUDIO_PLUGIN_SOURCES.length || !m.runtimeIdentity || typeof m.runtimeIdentity !== 'object') refused();
    const identity = m.runtimeIdentity as Record<string, unknown>;
    if (identity.scheme !== STUDIO_PLUGIN_IDENTITY_SCHEME || typeof identity.sha256 !== 'string') refused();
    const identities: string[] = [];
    for (const [index, [name, , filename]] of STUDIO_PLUGIN_SOURCES.entries()) {
      const descriptor = m.sources[index] as Record<string, unknown> | null;
      if (!descriptor || descriptor.path !== 'src/' + filename) refused();
      const original = await bytes(join(root, 'plugin', 'src', filename), 512 * 1024);
      let normalized = original.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      if (!normalized.endsWith('\n')) normalized += '\n';
      if (Buffer.byteLength(normalized) > STUDIO_PLUGIN_LIMITS.sourceBytes) refused();
      const sourceHash = createHash('sha256').update(normalized).digest('hex');
      if (descriptor.bytes !== Buffer.byteLength(normalized) || descriptor.sha256 !== sourceHash) refused();
      identities.push(name + '\0' + sourceHash);
    }
    const runtimeHash = createHash('sha256').update(STUDIO_PLUGIN_IDENTITY_SCHEME + '\n' + identities.join('\n') + '\n').digest('hex');
    if (identity.sha256 !== runtimeHash) refused();
    return runtimeHash;
  } catch (error) {
    if (error instanceof ArcaneError) throw error;
    refused();
  }
}
