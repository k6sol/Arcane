import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { verifyWindowsBundle } from './package-windows.mjs';

const KIT = Object.freeze(['windows-install-cli.mjs', 'windows-installation.mjs', 'package-windows.mjs', 'create-local-release.mjs', 'managed-luau-compiler.mjs'].map(name => 'scripts/' + name));
const sha = value => createHash('sha256').update(value).digest('hex');
const within = (parent, path) => { const part = relative(parent, path); return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
const fail = code => { throw new Error('Setup payload ' + code + '.'); };
async function direct(path, kind) {
  const value = await fs.lstat(path, { bigint: true }), canonical = await fs.realpath(path);
  if (value.isSymbolicLink() || (process.platform === 'win32' ? canonical.toLowerCase() !== path.toLowerCase() : canonical !== path) ||
      (kind === 'directory' ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n)) fail('path');
  return value;
}
function absolute(value) { if (typeof value !== 'string' || !isAbsolute(value) || value !== resolve(value) || /[\x00-\x1f\x7f]/.test(value)) fail('path'); return value; }
function descriptor(value) {
  if (!value || typeof value.path !== 'string' || value.path.length > 1024 || !/^[A-Za-z0-9_@.+\-/]+$/.test(value.path) ||
      value.path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 512 * 1024 ** 2 || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('inventory');
  return value;
}
/** Streams a stored ZIP with data descriptors. No shell, whole-payload buffer,
 * installed Node prerequisite, mutable generated code or executable launch. */
export function createWindowsSetupPayload({ verifyBundle = verifyWindowsBundle } = {}) {
  if (typeof verifyBundle !== 'function') fail('verifier');
  return Object.freeze({ async build({ bundle, kitRoot, output }) {
    bundle = absolute(bundle); kitRoot = absolute(kitRoot); output = absolute(output);
    if (!output.endsWith('.zip') || within(bundle, output)) fail('output');
    const parent = dirname(output), parentStat = await direct(parent, 'directory');
    await direct(bundle, 'directory'); await direct(kitRoot, 'directory');
    const proof = await verifyBundle(bundle), manifestPath = join(bundle, 'windows-manifest.json'), manifestStat = await direct(manifestPath, 'file');
    if (manifestStat.size > 8n * 1024n ** 2n) fail('inventory');
    const manifestBytes = await fs.readFile(manifestPath), manifest = JSON.parse(manifestBytes);
    if (sha(manifestBytes) !== proof.manifestSha256 || !Array.isArray(manifest.files) || manifest.files.length !== proof.files ||
        manifest.files.length > 32768 || manifest.totalBytes !== proof.bytes || proof.bytes > 2 * 1024 ** 3) fail('inventory');
    const seen = new Set(), entries = [];
    for (const item of [...manifest.files, { path: 'windows-manifest.json', bytes: manifestBytes.length, sha256: proof.manifestSha256 }]) {
      descriptor(item); const name = 'bundle/' + item.path;
      if (name.length > 1024 || name.split('/').length > 32 || seen.has(name.toLowerCase())) fail('inventory'); seen.add(name.toLowerCase());
      entries.push({ ...item, name, source: join(bundle, ...item.path.split('/')) });
    }
    const node = entries.find(entry => entry.path === 'resources/node/node.exe'); if (!node) fail('node');
    const kitFiles = [];
    for (const path of KIT) {
      const source = join(kitRoot, ...path.split('/')), stat = await direct(source, 'file');
      if (stat.size > 1024n ** 2n || source === output) fail('kit');
      const bytes = await fs.readFile(source); if (!same(stat, await direct(source, 'file'))) fail('changed');
      const entry = { path: 'kit/' + path, bytes: bytes.length, sha256: sha(bytes) };
      kitFiles.push(entry); entries.push({ ...entry, name: entry.path, source });
    }
    const kitManifest = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-installer-kit',
      bundleManifestSha256: proof.manifestSha256, node: { path: 'bundle/' + node.path, bytes: node.bytes, sha256: node.sha256 }, files: kitFiles }) + '\n');
    entries.push({ name: 'kit-manifest.json', bytes: kitManifest.length, sha256: sha(kitManifest), data: kitManifest });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const archiveHash = createHash('sha256'), central = []; let offset = 0, totalBytes = 0;
    const handle = await fs.open(output, 'wx', 0o600);
    const write = async bytes => {
      if (offset + bytes.length >= 0xffffffff) fail('size');
      let written = 0; while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, null);
        if (!result.bytesWritten) fail('write'); written += result.bytesWritten;
      }
      archiveHash.update(bytes); offset += bytes.length;
    };
    try {
      for (const entry of entries) {
        const name = Buffer.from(entry.name), start = offset, header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0808, 6);
        header.writeUInt16LE(0x21, 12); header.writeUInt16LE(name.length, 26);
        await write(header); await write(name);
        let bytes = 0, crc = 0; const contentHash = createHash('sha256');
        const before = entry.source ? await direct(entry.source, 'file') : null;
        const chunks = entry.source ? createReadStream(entry.source) : [entry.data];
        for await (const chunk of chunks) {
          bytes += chunk.length; if (bytes > entry.bytes) fail('changed');
          crc = crc32(chunk, crc); contentHash.update(chunk); await write(chunk);
        }
        if (bytes !== entry.bytes || contentHash.digest('hex') !== entry.sha256 || before && !same(before, await direct(entry.source, 'file'))) fail('changed');
        totalBytes += bytes; if (totalBytes > 2 * 1024 ** 3 + 8 * 1024 ** 2) fail('size');
        const trailer = Buffer.alloc(16); trailer.writeUInt32LE(0x08074b50); trailer.writeUInt32LE(crc, 4); trailer.writeUInt32LE(bytes, 8); trailer.writeUInt32LE(bytes, 12); await write(trailer);
        const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
        record.writeUInt16LE(0x0808, 8); record.writeUInt16LE(0x21, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes, 20); record.writeUInt32LE(bytes, 24);
        record.writeUInt16LE(name.length, 28); record.writeUInt32LE(start, 42); central.push(record, name);
      }
      const centralStart = offset; for (const bytes of central) await write(bytes);
      const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(offset - centralStart, 12); end.writeUInt32LE(centralStart, 16); await write(end); await handle.sync();
      const after = await verifyBundle(bundle);
      if (after.manifestSha256 !== proof.manifestSha256 || after.files !== proof.files || after.bytes !== proof.bytes ||
          !same(manifestStat, await direct(manifestPath, 'file')) || (await direct(parent, 'directory')).ino !== parentStat.ino ||
          !same(await handle.stat({ bigint: true }), await direct(output, 'file'))) fail('changed');
      return Object.freeze({ output, payloadSha256: archiveHash.digest('hex'), bytes: offset, files: entries.length,
        uncompressedBytes: totalBytes, bundleManifestSha256: proof.manifestSha256, kitManifestSha256: sha(kitManifest),
        maximumRelativePathChars: Math.max(...entries.map(entry => entry.name.length)), kitFiles, node: { path: 'bundle/' + node.path, bytes: node.bytes, sha256: node.sha256 }, signed: false });
    } catch (error) {
      if (error instanceof Error) error.retainedPayload = output;
      throw error;
    } finally { await handle.close(); }
  } });
}

export const WINDOWS_SETUP_KIT_FILES = KIT;
