/**
 * Optional two-way script sync between the paired Studio place and the open project folder (docs/script-sync.md).
 *
 * Off by default; switched on per project by the human in Settings (the switch lives in the daemon's state directory, never in
 * the project folder, so a cloned repository cannot turn it on). While on:
 *  - Export: Script, LocalScript and ModuleScript sources under the granted roots are mirrored into
 *    <project>/src/<Root>/<Path>.<server|client|module>.luau, with <project>/.arcane/sync.json mapping each file to its
 *    instance reference and the hash of the last source both sides agreed on.
 *  - Import: a changed file is applied with the ordinary script.update command and the exact current Studio source as its
 *    baseline. If Studio changed too, nothing is overwritten; the file is listed as a conflict for the person to resolve.
 *    New files create scripts with scene.create, which always creates them disabled. Nothing is ever enabled here.
 *  - Deletions on either side are never propagated; they are listed for a human decision.
 * Every Studio call goes through the same StudioStore admission (grants, write permission, capabilities) as any other
 * command. Files stay inside the project folder, links and junctions are refused, and sizes are bounded like script.update.
 */
import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicPreferenceReplace } from '../../../packages/core/src/selection.js';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import type { InstanceRef, Json, StudioCommand, StudioRoot, StudioSession } from '../../../packages/protocol/src/studio.js';
import { workflowProjectIdentity } from '../../../packages/storage/src/workflow-store.js';

export const SCRIPT_SYNC_LIMITS = Object.freeze({ sourceBytes: 100 * 1024, scripts: 500, nodes: 4000, depth: 32, files: 1000, totalBytes: 16 * 1024 * 1024, listed: 50, readConcurrency: 6 });
/** Granted roots that may hold scripts, in scan order (script-heavy services first, Workspace last). */
export const SCRIPT_SYNC_ROOTS: readonly StudioRoot[] = Object.freeze(['ServerScriptService', 'ReplicatedStorage', 'StarterPlayer', 'StarterGui', 'ServerStorage', 'Workspace'] as StudioRoot[]);
export const SCRIPT_SYNC_FOLDER = 'src';
export const SCRIPT_SYNC_INDEX = '.arcane/sync.json';
const REQUEST_PREFIX = 'scriptsync-';
const KIND: Record<string, 'server' | 'client' | 'module'> = { Script: 'server', LocalScript: 'client', ModuleScript: 'module' };
const CLASS: Record<string, string> = { server: 'Script', client: 'LocalScript', module: 'ModuleScript' };
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

export type ScriptSyncState = 'off' | 'waiting' | 'syncing' | 'ready' | 'error';
export interface ScriptSyncItem { file: string; reason: string }
export interface ScriptSyncDeletion { file: string; side: 'file' | 'studio' }
export interface ScriptSyncStatus {
  enabled: boolean; state: ScriptSyncState; message: string; folder: string; lastSyncAt: string | null; place: string | null; writable: boolean;
  counts: { tracked: number; exported: number; imported: number; created: number; conflicts: number; deletions: number; skipped: number };
  conflicts: ScriptSyncItem[]; deletions: ScriptSyncDeletion[]; skipped: ScriptSyncItem[];
}
/** The StudioStore surface this module uses; every command passes the store's normal admission. */
export interface ScriptSyncStudio {
  sessions(): (StudioSession & { live: boolean })[];
  enqueueVerified(input: unknown, verifier: null): Promise<StudioCommand>;
  command(id: string): StudioCommand;
  commands(sessionId?: string): StudioCommand[];
}
export interface ScriptSyncOptions {
  projectPath: string; stateDirectory: string; studio: ScriptSyncStudio;
  /** Test seams. */
  pollMs?: number; receiptMs?: number; debounceMs?: number; commandWaitMs?: number; commandTimeoutMs?: number; watchFiles?: boolean;
}
interface IndexEntry { ref: InstanceRef; hash: string }
interface SyncIndex { version: 1; placeId: number | null; universeId: number | null; files: Record<string, IndexEntry>; ignored: string[] }
interface StudioScript { ref: InstanceRef; source: string; hash: string }
interface StudioScan { scripts: Map<string, StudioScript>; present: Set<string>; containers: Map<string, InstanceRef | null>; complete: boolean; roots: Set<StudioRoot> }
interface FileEntry { text: string; hash: string }

export class ScriptSyncError extends ArcaneError {}
const fail = (code: string, message: string): never => { throw new ScriptSyncError(code, message); };
export const sourceHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const lower = (value: string) => value.toLowerCase();

/** A single path segment that is a safe, portable file or folder name (Windows rules included). */
export function safeSegment(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 && !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name)
    && !/[. ]$/.test(name) && name !== '.' && name !== '..' && !RESERVED.test(name);
}
/** src/<Root>/<Path...>/<Name>.<server|client|module>.luau for a script reference, or null when it cannot be a file. */
export function scriptFilePath(root: StudioRoot, pathSegments: readonly string[], className: string): string | null {
  const kind = KIND[className];
  if (!kind || !SCRIPT_SYNC_ROOTS.includes(root) || pathSegments.length < 1 || pathSegments.length > SCRIPT_SYNC_LIMITS.depth || !pathSegments.every(safeSegment)) return null;
  return [SCRIPT_SYNC_FOLDER, root, ...pathSegments.slice(0, -1), pathSegments.at(-1) + '.' + kind + '.luau'].join('/');
}
/** Inverse of scriptFilePath; null for anything that is not a sync file. */
export function parseScriptFile(file: string): { root: StudioRoot; pathSegments: string[]; className: string } | null {
  const parts = file.split('/');
  if (parts.length < 3 || parts[0] !== SCRIPT_SYNC_FOLDER || !SCRIPT_SYNC_ROOTS.includes(parts[1] as StudioRoot)) return null;
  const match = /^(.+)\.(server|client|module)\.luau$/.exec(parts.at(-1)!);
  if (!match) return null;
  const pathSegments = [...parts.slice(2, -1), match[1]!];
  if (scriptFilePath(parts[1] as StudioRoot, pathSegments, CLASS[match[2]!]!) !== file) return null;
  return { root: parts[1] as StudioRoot, pathSegments, className: CLASS[match[2]!]! };
}
const containerKey = (root: string, segments: readonly string[]) => lower([root, ...segments].join('/'));

function validIndex(value: unknown): SyncIndex | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !(v.placeId === null || Number.isSafeInteger(v.placeId)) || !(v.universeId === null || Number.isSafeInteger(v.universeId))
    || !v.files || typeof v.files !== 'object' || Array.isArray(v.files) || !Array.isArray(v.ignored) || v.ignored.length > SCRIPT_SYNC_LIMITS.files) return null;
  const files: Record<string, IndexEntry> = {};
  const entries = Object.entries(v.files as Record<string, unknown>);
  if (entries.length > SCRIPT_SYNC_LIMITS.files) return null;
  for (const [file, raw] of entries) {
    const e = raw as { ref?: Record<string, unknown>; hash?: unknown } | null;
    const parsed = parseScriptFile(file), r = e?.ref;
    if (!parsed || !e || typeof e.hash !== 'string' || !/^[a-f0-9]{64}$/.test(e.hash) || !r || typeof r.instanceId !== 'string' || typeof r.sessionId !== 'string'
      || r.root !== parsed.root || r.className !== parsed.className || !Array.isArray(r.pathSegments) || r.pathSegments.some(s => typeof s !== 'string')) return null;
    files[file] = { hash: e.hash, ref: { instanceId: r.instanceId, sessionId: r.sessionId, root: parsed.root, pathSegments: [...r.pathSegments as string[]], className: parsed.className } };
  }
  if (v.ignored.some(file => typeof file !== 'string' || !parseScriptFile(file))) return null;
  return { version: 1, placeId: v.placeId as number | null, universeId: v.universeId as number | null, files, ignored: [...new Set(v.ignored as string[])] };
}

export function createScriptSync(options: ScriptSyncOptions) {
  const studio = options.studio;
  const pollMs = options.pollMs ?? 60_000, receiptMs = options.receiptMs ?? 2_000, debounceMs = options.debounceMs ?? 400;
  const commandWaitMs = options.commandWaitMs ?? 100, commandTimeoutMs = options.commandTimeoutMs ?? 190_000;
  const settingsFile = join(options.stateDirectory, 'script-sync.json');
  let enabled = false, closed = false, state: ScriptSyncState = 'off', message = 'Script sync is off.', lastSyncAt: string | null = null;
  let place: string | null = null, writable = false, settingsLoaded = false;
  const totals = { exported: 0, imported: 0, created: 0 };
  const conflicts = new Map<string, string>(), deletions = new Map<string, 'file' | 'studio'>(), skipped = new Map<string, string>();
  let tracked = 0, lastScan: StudioScan | null = null, lastScanSession = '';
  let watcher: FSWatcher | null = null, pollTimer: ReturnType<typeof setInterval> | null = null, receiptTimer: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null, receiptMark = '', receiptSeen = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => undefined); return next; };

  // ---- Project folder: canonical root, no links or junctions on any component we touch ----
  const projectRoot = (): string => {
    try { return workflowProjectIdentity(options.projectPath).projectPath; } catch { return fail('SYNC_PATH', 'The project folder is unavailable.'); }
  };
  async function realDirectory(path: string, create: boolean): Promise<boolean> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) { if (!create) return false; await mkdir(path); return realDirectory(path, false); }
    if (info.isSymbolicLink() || !info.isDirectory()) fail('SYNC_PATH', 'A folder used by script sync is a link, junction or file. Replace it with a plain folder.');
    return true;
  }
  /** Joins a sync-relative path under the project root, checking (and optionally creating) every parent folder. */
  async function placed(root: string, file: string, createParents: boolean): Promise<string | null> {
    const parts = file.split('/');
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      if (!await realDirectory(current, createParents)) return null;
    }
    return join(current, parts.at(-1)!);
  }
  async function readSyncFile(path: string, limit: number): Promise<string | null> {
    const info = await lstat(path).catch(() => null);
    if (!info) return null;
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) fail('SYNC_LINK', 'is a link or not a plain file');
    if (info.size > limit) fail('SYNC_SIZE', 'is larger than 100 KiB');
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(limit + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > limit) fail('SYNC_SIZE', 'is larger than 100 KiB');
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      if (text.includes('\u0000') || text.includes('�')) fail('SYNC_TEXT', 'is not UTF-8 text');
      return text;
    } finally { await handle.close(); }
  }
  async function writeSyncFile(root: string, file: string, text: string): Promise<void> {
    if (Buffer.byteLength(text, 'utf8') > SCRIPT_SYNC_LIMITS.sourceBytes) fail('SYNC_SIZE', 'Source is larger than 100 KiB.');
    const target = (await placed(root, file, true))!;
    const existing = await lstat(target).catch(() => null);
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1)) fail('SYNC_LINK', file + ' is a link or not a plain file; it was not changed.');
    const temporary = target + '.' + randomUUID().slice(0, 8) + '.arcane-tmp';
    try { await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 }); await atomicPreferenceReplace(temporary, target); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  }
  /** Files are compared as LF text without a byte-order mark, so editors and git line-ending settings do not cause churn. */
  const normal = (text: string) => text.replace(/^﻿/, '').replace(/\r\n/g, '\n');

  async function readIndex(root: string): Promise<SyncIndex> {
    const path = await placed(root, SCRIPT_SYNC_INDEX, false);
    const empty: SyncIndex = { version: 1, placeId: null, universeId: null, files: {}, ignored: [] };
    if (!path) return empty;
    let text: string | null;
    try { text = await readSyncFile(path, 4 * 1024 * 1024); } catch { return fail('SYNC_INDEX', '.arcane/sync.json is not a plain file. Remove it to start a fresh sync.'); }
    if (text === null) return empty;
    let value: unknown = null; try { value = JSON.parse(text); } catch { /* Refused below. */ }
    return validIndex(value) ?? fail('SYNC_INDEX', '.arcane/sync.json is unreadable. Fix it, or delete it to start a fresh sync.');
  }
  async function saveIndex(root: string, index: SyncIndex): Promise<void> {
    tracked = Object.keys(index.files).length;
    const text = JSON.stringify({ version: 1, placeId: index.placeId, universeId: index.universeId, ignored: [...index.ignored].sort(),
      files: Object.fromEntries(Object.entries(index.files).sort(([a], [b]) => a < b ? -1 : 1)) }, null, 2) + '\n';
    const target = (await placed(root, SCRIPT_SYNC_INDEX, true))!;
    const existing = await lstat(target).catch(() => null);
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1)) fail('SYNC_INDEX', '.arcane/sync.json is a link or not a plain file.');
    const temporary = target + '.' + randomUUID().slice(0, 8) + '.arcane-tmp';
    try { await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 }); await atomicPreferenceReplace(temporary, target); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  }

  // ---- Studio: the live paired session and bounded commands through the ordinary queue ----
  function liveSession(): StudioSession | null {
    return studio.sessions().find(s => s.live && !s.revokedAt) ?? null;
  }
  /** Writes need a writable pairing, the methods in this plugin, and Studio in Edit mode. */
  function writeBlock(session: StudioSession, method: 'script.update' | 'scene.create'): string | null {
    if (!session.allowWrites) return 'This Studio connection is read-only, so file changes are not applied.';
    if (!session.capabilities.includes(method)) return 'The connected Studio plugin cannot apply this change. Update the plugin.';
    if (session.proof?.mode !== 'Edit') return 'Studio is not in Edit mode; file changes wait until the playtest stops.';
    return null;
  }
  async function call(session: StudioSession, method: string, args: Record<string, Json>): Promise<Record<string, unknown>> {
    const queued = await studio.enqueueVerified({ sessionId: session.id, requestId: REQUEST_PREFIX + randomUUID(), method, args }, null);
    const deadline = Date.now() + commandTimeoutMs;
    for (;;) {
      if (closed) fail('SYNC_STOPPED', 'Script sync stopped.');
      const current = studio.command(queued.id);
      if (current.state === 'succeeded') {
        const result = current.result;
        return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
      }
      if (current.state !== 'queued' && current.state !== 'dispatched') fail(/conflict/i.test(current.error ?? '') ? 'SYNC_CONFLICT' : 'SYNC_COMMAND', (current.error ?? 'Studio did not complete the command.').slice(0, 300));
      if (Date.now() > deadline) fail('SYNC_TIMEOUT', 'Studio did not answer in time.');
      await new Promise(resolve => setTimeout(resolve, commandWaitMs));
    }
  }
  const asRef = (value: unknown): InstanceRef | null => {
    const r = value as InstanceRef | null;
    return r && typeof r === 'object' && typeof r.instanceId === 'string' && typeof r.sessionId === 'string' && typeof r.root === 'string'
      && Array.isArray(r.pathSegments) && r.pathSegments.every(s => typeof s === 'string') && typeof r.className === 'string' ? r : null;
  };
  async function readSource(session: StudioSession, ref: InstanceRef): Promise<string> {
    const result = await call(session, 'script.read', { ref: ref as unknown as Json });
    if (typeof result.source !== 'string') fail('SYNC_COMMAND', 'Studio returned no script source.');
    return result.source as string;
  }

  async function scanStudio(session: StudioSession): Promise<StudioScan> {
    const scan: StudioScan = { scripts: new Map(), present: new Set(), containers: new Map(), complete: true, roots: new Set() };
    const found = new Map<string, InstanceRef>(), clashes = new Set<string>();
    let nodes = 0;
    for (const root of SCRIPT_SYNC_ROOTS.filter(r => session.allowedRoots.includes(r))) {
      scan.roots.add(root);
      const pending: { ref: InstanceRef | null; depth: number }[] = [{ ref: null, depth: 0 }];
      while (pending.length) {
        const next = pending.shift()!;
        const result = await call(session, 'scene.children', { root, ...(next.ref ? { ref: next.ref as unknown as Json } : {}), limit: 200 });
        if (!next.ref) { const parent = asRef(result.parentRef); if (parent) scan.containers.set(containerKey(root, []), parent); }
        if (result.truncated === true) { scan.complete = false; skipped.set(next.ref ? [root, ...next.ref.pathSegments].join('/') : root, 'has more than 200 children; only the first 200 are synced'); }
        for (const item of Array.isArray(result.items) ? result.items as { ref?: unknown; childCount?: unknown }[] : []) {
          const ref = asRef(item.ref); if (!ref || ref.root !== root) continue;
          if (++nodes > SCRIPT_SYNC_LIMITS.nodes) { scan.complete = false; skipped.set(root, 'more than ' + SCRIPT_SYNC_LIMITS.nodes + ' instances were found; the rest are not synced'); pending.length = 0; break; }
          const key = containerKey(root, ref.pathSegments);
          scan.containers.set(key, scan.containers.has(key) ? null : ref);
          if (KIND[ref.className]) {
            const file = scriptFilePath(root, ref.pathSegments, ref.className);
            if (!file) { skipped.set([root, ...ref.pathSegments].join('/'), 'its name cannot be used as a file name'); scan.complete = false; }
            else if ([...found.keys()].some(other => lower(other) === lower(file))) clashes.add(lower(file));
            else found.set(file, ref);
          }
          if (Number(item.childCount) > 0 && next.depth + 1 < SCRIPT_SYNC_LIMITS.depth) pending.push({ ref, depth: next.depth + 1 });
        }
      }
    }
    for (const [file] of found) if (clashes.has(lower(file))) { found.delete(file); skipped.set(file, 'two scripts share this path; rename one in Studio'); scan.present.add(file); }
    let total = 0;
    const work = [...found];
    if (work.length > SCRIPT_SYNC_LIMITS.scripts) { scan.complete = false; for (const [file] of work.slice(SCRIPT_SYNC_LIMITS.scripts)) { skipped.set(file, 'more than ' + SCRIPT_SYNC_LIMITS.scripts + ' scripts; not synced'); scan.present.add(file); } work.length = SCRIPT_SYNC_LIMITS.scripts; }
    const reader = async () => {
      for (let item = work.shift(); item; item = work.shift()) {
        const [file, ref] = item; scan.present.add(file);
        const source = await readSource(session, ref);
        const bytes = Buffer.byteLength(source, 'utf8');
        if (bytes > SCRIPT_SYNC_LIMITS.sourceBytes) { skipped.set(file, 'is larger than 100 KiB in Studio'); continue; }
        if ((total += bytes) > SCRIPT_SYNC_LIMITS.totalBytes) { skipped.set(file, 'the 16 MiB sync budget is used up'); scan.complete = false; continue; }
        scan.scripts.set(file, { ref, source, hash: sourceHash(source) });
      }
    };
    await Promise.all(Array.from({ length: SCRIPT_SYNC_LIMITS.readConcurrency }, reader));
    lastScan = scan; lastScanSession = session.id;
    return scan;
  }

  async function scanFiles(root: string, roots: Set<StudioRoot>): Promise<Map<string, FileEntry>> {
    const files = new Map<string, FileEntry>();
    if (!await realDirectory(join(root, SCRIPT_SYNC_FOLDER), false)) return files;
    let seen = 0;
    const walk = async (relative: string, depth: number): Promise<void> => {
      const absolute = join(root, ...relative.split('/'));
      for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const file = relative + '/' + entry.name;
        if (entry.isSymbolicLink()) { skipped.set(file, 'is a link or junction; links are never followed'); continue; }
        if (entry.isDirectory()) { if (depth < SCRIPT_SYNC_LIMITS.depth) await walk(file, depth + 1); continue; }
        if (!entry.isFile() || !/\.(?:server|client|module)\.luau$/.test(entry.name)) continue;
        if (++seen > SCRIPT_SYNC_LIMITS.files) { skipped.set(SCRIPT_SYNC_FOLDER, 'has more than ' + SCRIPT_SYNC_LIMITS.files + ' script files; the rest are not synced'); return; }
        if (!parseScriptFile(file)) { skipped.set(file, 'its name cannot be mapped to a Studio script'); continue; }
        try {
          const text = await readSyncFile(join(absolute, entry.name), SCRIPT_SYNC_LIMITS.sourceBytes);
          if (text !== null) { const value = normal(text); files.set(file, { text: value, hash: sourceHash(value) }); }
        } catch (error) { skipped.set(file, error instanceof ScriptSyncError ? error.message : 'could not be read'); }
      }
    };
    for (const name of SCRIPT_SYNC_ROOTS) {
      if (!roots.has(name)) continue;
      const relative = SCRIPT_SYNC_FOLDER + '/' + name;
      if (await realDirectory(join(root, SCRIPT_SYNC_FOLDER, name), false)) await walk(relative, 1);
    }
    return files;
  }

  // ---- One full reconciliation: Studio scan + folder scan, decided per file against the agreed hash ----
  async function apply(session: StudioSession, index: SyncIndex, file: string, ref: InstanceRef, studioSource: string, text: string): Promise<void> {
    const block = writeBlock(session, 'script.update');
    if (block) { skipped.set(file, block); return; }
    try {
      await call(session, 'script.update', { ref: ref as unknown as Json, expectedSource: studioSource, source: text });
      index.files[file] = { ref, hash: sourceHash(text) }; totals.imported++; conflicts.delete(file);
    } catch (error) {
      if (error instanceof ScriptSyncError && error.code === 'SYNC_CONFLICT') conflicts.set(file, 'Studio changed while the file was being applied.');
      else skipped.set(file, error instanceof Error ? error.message : 'Studio did not accept the change.');
    }
  }
  /** Writes one Studio source to its file; a refused path is reported for that file only. */
  async function exportFile(root: string, index: SyncIndex, file: string, script: StudioScript): Promise<void> {
    try { await writeSyncFile(root, file, script.source); index.files[file] = { ref: script.ref, hash: script.hash }; totals.exported++; }
    catch (error) { if (!(error instanceof ScriptSyncError)) throw error; skipped.set(file, error.message); }
  }
  async function create(session: StudioSession, scan: StudioScan, index: SyncIndex, file: string, text: string): Promise<void> {
    const target = parseScriptFile(file)!;
    const block = writeBlock(session, 'scene.create') ?? writeBlock(session, 'script.update');
    if (block) { skipped.set(file, 'new file waits: ' + block); return; }
    const parent = scan.containers.get(containerKey(target.root, target.pathSegments.slice(0, -1)));
    if (!parent) { skipped.set(file, 'new file waits: create its parent folder in Studio first (or rename duplicates)'); return; }
    const created = await call(session, 'scene.create', { parent: parent as unknown as Json, className: target.className, name: target.pathSegments.at(-1)! });
    const ref = asRef(created.ref);
    if (!ref) { skipped.set(file, 'Studio did not return the new script.'); return; }
    totals.created++;
    const baseline = await readSource(session, ref);
    index.files[file] = { ref, hash: sourceHash(baseline) };
    if (baseline !== text) await apply(session, index, file, ref, baseline, text);
  }

  async function fullPass(): Promise<void> {
    if (!enabled || closed) return;
    const session = liveSession();
    if (!session) { state = 'waiting'; message = 'Connect Studio to sync scripts.'; place = null; return; }
    state = 'syncing'; message = 'Syncing scripts…'; place = session.name; writable = !writeBlock(session, 'script.update');
    const root = projectRoot();
    const index = await readIndex(root);
    if (index.placeId !== null && (index.placeId !== session.placeId || index.universeId !== session.universeId))
      fail('SYNC_PLACE', 'This project folder is synced with a different Studio place. Open that place, or delete .arcane/sync.json to sync this one.');
    index.placeId = session.placeId; index.universeId = session.universeId;
    skipped.clear(); deletions.clear();
    const scan = await scanStudio(session);
    const files = await scanFiles(root, scan.roots);
    const ignored = new Set(index.ignored);
    const names = new Set([...scan.scripts.keys(), ...files.keys(), ...Object.keys(index.files)]);
    const seenConflicts = new Set<string>();
    for (const file of [...names].sort()) {
      if (ignored.has(file)) continue;
      const parsed = parseScriptFile(file)!;
      if (!scan.roots.has(parsed.root)) continue; // Never sync outside the granted roots.
      const known = index.files[file], s = scan.scripts.get(file), f = files.get(file);
      if (s && f) {
        if (s.hash === f.hash) { index.files[file] = { ref: s.ref, hash: s.hash }; continue; }
        const studioMoved = !known || s.hash !== known.hash, fileMoved = !known || f.hash !== known.hash;
        if (studioMoved && !fileMoved) await exportFile(root, index, file, s);
        else if (!studioMoved && fileMoved) await apply(session, index, file, s.ref, s.source, f.text);
        else { seenConflicts.add(file); if (!conflicts.has(file)) conflicts.set(file, known ? 'Changed in Studio and in the file since the last sync.' : 'Studio and the file differ and were never synced.'); if (known) index.files[file] = { ...known, ref: s.ref }; }
      } else if (s) {
        if (skipped.has(file)) continue; // On disk but unreadable within bounds; already reported.
        if (known) deletions.set(file, 'file');
        else await exportFile(root, index, file, s);
      } else if (f) {
        if (scan.present.has(file)) continue; // Present in Studio but not readable within bounds; reported as skipped.
        if (known) { if (scan.complete) deletions.set(file, 'studio'); }
        else if (scan.complete) await create(session, scan, index, file, f.text);
        else skipped.set(file, 'new file waits: the Studio scan was incomplete');
      } else if (known && scan.complete) delete index.files[file];
    }
    for (const file of [...conflicts.keys()]) if (!seenConflicts.has(file)) conflicts.delete(file);
    await saveIndex(root, index);
    arm(root);
    lastSyncAt = new Date().toISOString(); state = 'ready';
    message = conflicts.size ? 'Synced. Some files need your decision.' : scan.complete ? 'Scripts are in sync.' : 'Synced what fits; some scripts are skipped.';
  }

  /** After a folder change: compare files with the agreed hashes only, reading Studio just for the files that changed. */
  async function filePass(): Promise<void> {
    if (!enabled || closed) return;
    const session = liveSession();
    if (!session) { state = 'waiting'; message = 'Connect Studio to sync scripts.'; return; }
    if (!lastScan || lastScanSession !== session.id) return fullPass();
    const root = projectRoot(), index = await readIndex(root);
    if (index.placeId !== session.placeId || index.universeId !== session.universeId) return fullPass();
    state = 'syncing';
    const files = await scanFiles(root, lastScan.roots), ignored = new Set(index.ignored);
    let rescan = false;
    for (const [file, f] of files) {
      if (ignored.has(file) || conflicts.has(file)) continue;
      const known = index.files[file];
      if (!known) { if (!lastScan.present.has(file)) rescan = true; continue; }
      if (known.hash === f.hash) continue;
      if (known.ref.sessionId !== session.id) { rescan = true; continue; }
      let current: string;
      try { current = await readSource(session, known.ref); } catch { rescan = true; continue; }
      const studioHash = sourceHash(current);
      if (studioHash === f.hash) index.files[file] = { ...known, hash: f.hash };
      else if (studioHash === known.hash) await apply(session, index, file, known.ref, current, f.text);
      else conflicts.set(file, 'Changed in Studio and in the file since the last sync.');
    }
    for (const [file, side] of [...deletions]) if (side === 'file' && files.has(file)) deletions.delete(file);
    for (const file of Object.keys(index.files)) if (!files.has(file) && !ignored.has(file) && !skipped.has(file) && lastScan.roots.has(parseScriptFile(file)!.root)) deletions.set(file, 'file');
    await saveIndex(root, index);
    if (rescan) return fullPass();
    lastSyncAt = new Date().toISOString(); state = 'ready';
    message = conflicts.size ? 'Synced. Some files need your decision.' : 'Scripts are in sync.';
  }

  /** Arcane's own script.update receipts (chat, tools) update the matching file right away; new scripts trigger a scan. */
  async function receiptPass(): Promise<void> {
    if (!enabled || closed) return;
    const session = liveSession(); if (!session) return;
    const fresh = studio.commands(session.id).filter(c => c.state === 'succeeded' && !c.requestId.startsWith(REQUEST_PREFIX)
      && (c.method === 'script.update' || c.method === 'scene.create') && c.finishedAt !== null && !receiptSeen.has(c.id));
    if (!receiptMark) { receiptMark = new Date().toISOString(); for (const c of fresh) receiptSeen.add(c.id); return; }
    const relevant = fresh.filter(c => c.finishedAt! >= receiptMark);
    for (const c of fresh) receiptSeen.add(c.id);
    if (receiptSeen.size > 2000) receiptSeen = new Set([...receiptSeen].slice(-500));
    if (!relevant.length) return;
    let rescan = false;
    const root = projectRoot(), index = await readIndex(root);
    if (index.placeId !== session.placeId) return fullPass();
    for (const c of relevant) {
      const mutation = (c.result as { mutation?: { ref?: unknown; after?: { source?: unknown } } } | null)?.mutation;
      const ref = asRef(mutation?.ref);
      if (c.method === 'scene.create') { if (ref && KIND[ref.className]) rescan = true; continue; }
      if (!ref || typeof mutation?.after?.source !== 'string') continue;
      const file = scriptFilePath(ref.root, ref.pathSegments, ref.className);
      const known = file ? index.files[file] : undefined;
      if (!file || !known || known.ref.instanceId !== ref.instanceId) { rescan = true; continue; }
      const source = mutation.after.source, hash = sourceHash(source);
      if (hash === known.hash) continue;
      let current: FileEntry | null = null;
      try { const path = await placed(root, file, false); const text = path ? await readSyncFile(path, SCRIPT_SYNC_LIMITS.sourceBytes) : null; current = text === null ? null : { text: normal(text), hash: sourceHash(normal(text)) }; }
      catch { skipped.set(file, 'could not be read'); continue; }
      if (!current) { deletions.set(file, 'file'); continue; }
      if (current.hash === hash) index.files[file] = { ...known, hash };
      else if (current.hash === known.hash) {
        if (Buffer.byteLength(source, 'utf8') > SCRIPT_SYNC_LIMITS.sourceBytes) { skipped.set(file, 'is larger than 100 KiB in Studio'); continue; }
        await writeSyncFile(root, file, source); index.files[file] = { ...known, hash }; totals.exported++;
      } else conflicts.set(file, 'Changed in Studio and in the file since the last sync.');
    }
    await saveIndex(root, index);
    if (rescan) return fullPass();
    lastSyncAt = new Date().toISOString();
  }

  const guarded = (work: () => Promise<void>) => serial(async () => {
    try { await work(); }
    catch (error) {
      if (closed) return;
      state = 'error';
      message = error instanceof ArcaneError ? error.message : 'Script sync stopped on an unexpected error. Your files and Studio were not changed further.';
    }
  });
  function arm(root: string): void {
    if (watcher || !enabled || closed || options.watchFiles === false) return;
    try {
      watcher = watch(join(root, SCRIPT_SYNC_FOLDER), { recursive: true }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { debounce = null; void guarded(filePass); }, debounceMs); debounce.unref?.();
      });
      watcher.on('error', () => { watcher?.close(); watcher = null; });
    } catch { watcher = null; /* The periodic poll still covers folder changes. */ }
  }
  function start(): void {
    if (closed) return;
    pollTimer ??= setInterval(() => void guarded(fullPass), pollMs); pollTimer.unref?.();
    receiptTimer ??= setInterval(() => void guarded(receiptPass), receiptMs); receiptTimer.unref?.();
  }
  function halt(): void {
    if (pollTimer) clearInterval(pollTimer); if (receiptTimer) clearInterval(receiptTimer); if (debounce) clearTimeout(debounce);
    pollTimer = receiptTimer = debounce = null; watcher?.close(); watcher = null; receiptMark = ''; receiptSeen = new Set();
  }

  async function loadSettings(): Promise<void> {
    if (settingsLoaded) return; settingsLoaded = true;
    try {
      const value = JSON.parse(await readFile(settingsFile, 'utf8')) as { version?: unknown; enabled?: unknown };
      if (value.version === 1 && value.enabled === true) { enabled = true; state = 'waiting'; message = 'Starting script sync…'; start(); void guarded(fullPass); }
    } catch { /* Missing or unreadable: off, the default. */ }
  }
  async function saveSettings(): Promise<void> {
    await mkdir(options.stateDirectory, { recursive: true });
    const temporary = settingsFile + '.' + randomUUID().slice(0, 8) + '.tmp';
    await writeFile(temporary, JSON.stringify({ version: 1, enabled }) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await atomicPreferenceReplace(temporary, settingsFile);
  }

  function status(): ScriptSyncStatus {
    const list = <T>(items: T[]) => items.slice(0, SCRIPT_SYNC_LIMITS.listed);
    return { enabled, state: enabled ? state : 'off', message: enabled ? message : 'Script sync is off.', folder: SCRIPT_SYNC_FOLDER, lastSyncAt, place, writable,
      counts: { tracked, ...totals, conflicts: conflicts.size, deletions: deletions.size, skipped: skipped.size },
      conflicts: list([...conflicts].map(([file, reason]) => ({ file, reason }))),
      deletions: list([...deletions].map(([file, side]) => ({ file, side }))),
      skipped: list([...skipped].map(([file, reason]) => ({ file, reason }))) };
  }
  /** Current Studio source and reference for one tracked or scanned file. */
  async function studioSide(session: StudioSession, index: SyncIndex, file: string): Promise<{ ref: InstanceRef; source: string }> {
    const ref = (lastScanSession === session.id ? lastScan?.scripts.get(file)?.ref : undefined) ?? (index.files[file]?.ref.sessionId === session.id ? index.files[file]!.ref : undefined);
    if (!ref) return fail('SYNC_STALE', 'Studio has no current copy of this script. Sync again first.');
    return { ref, source: await readSource(session, ref) };
  }
  const requireFile = (file: unknown): string => typeof file === 'string' && file.length <= 1024 && parseScriptFile(file) ? file : fail('SYNC_INPUT', 'Choose one listed script file.');
  const requireSession = (): StudioSession => {
    const session = liveSession();
    return session ?? fail('SYNC_OFFLINE', 'Connect Studio first.');
  };

  return {
    async status(): Promise<ScriptSyncStatus> { await loadSettings(); return status(); },
    async setEnabled(value: boolean): Promise<ScriptSyncStatus> {
      await loadSettings();
      if (value === enabled) return status();
      enabled = value; await saveSettings();
      if (enabled) { state = 'waiting'; message = 'Starting script sync…'; start(); void guarded(fullPass); }
      else { halt(); conflicts.clear(); deletions.clear(); skipped.clear(); state = 'off'; message = 'Script sync is off.'; }
      return status();
    },
    /** "Sync now": one full pass, awaited. */
    async syncNow(): Promise<ScriptSyncStatus> {
      await loadSettings();
      if (!enabled) fail('SYNC_OFF', 'Turn on script sync first.');
      await guarded(fullPass); return status();
    },
    /** Conflict resolution chosen by the person: keep the Studio source (write the file) or keep the file (apply it to Studio). */
    async resolve(fileInput: unknown, keep: unknown): Promise<ScriptSyncStatus> {
      await loadSettings();
      const file = requireFile(fileInput);
      if (keep !== 'studio' && keep !== 'file') fail('SYNC_INPUT', 'Choose Keep Studio or Keep file.');
      if (!enabled) fail('SYNC_OFF', 'Turn on script sync first.');
      if (!conflicts.has(file)) fail('SYNC_STALE', 'This conflict is no longer open.');
      await serial(async () => {
        const session = requireSession(), root = projectRoot(), index = await readIndex(root);
        const side = await studioSide(session, index, file);
        if (keep === 'studio') {
          await writeSyncFile(root, file, side.source); index.files[file] = { ref: side.ref, hash: sourceHash(side.source) }; totals.exported++; conflicts.delete(file);
        } else {
          const path = await placed(root, file, false), text = path ? await readSyncFile(path, SCRIPT_SYNC_LIMITS.sourceBytes) : null;
          if (text === null) fail('SYNC_STALE', 'The file no longer exists.');
          const block = writeBlock(session, 'script.update'); if (block) fail('SYNC_READ_ONLY', block);
          await call(session, 'script.update', { ref: side.ref as unknown as Json, expectedSource: side.source, source: normal(text!) });
          index.files[file] = { ref: side.ref, hash: sourceHash(normal(text!)) }; totals.imported++; conflicts.delete(file);
        }
        await saveIndex(root, index);
      });
      return status();
    },
    /** Deletions are never propagated. A missing file can be restored or ignored; a script removed in Studio can have its
     * file deleted or be recreated (disabled) from the file. */
    async deletion(fileInput: unknown, action: unknown): Promise<ScriptSyncStatus> {
      await loadSettings();
      const file = requireFile(fileInput), side = deletions.get(file);
      if (!enabled) fail('SYNC_OFF', 'Turn on script sync first.');
      if (!side) fail('SYNC_STALE', 'This deletion is no longer listed.');
      const allowed = side === 'file' ? ['restore', 'ignore'] : ['delete-file', 'recreate'];
      if (typeof action !== 'string' || !allowed.includes(action)) fail('SYNC_INPUT', 'Choose one of the listed actions.');
      await serial(async () => {
        const root = projectRoot(), index = await readIndex(root);
        if (action === 'restore') {
          const session = requireSession(), current = await studioSide(session, index, file);
          await writeSyncFile(root, file, current.source); index.files[file] = { ref: current.ref, hash: sourceHash(current.source) }; totals.exported++;
        } else if (action === 'ignore') { delete index.files[file]; index.ignored = [...new Set([...index.ignored, file])]; }
        else if (action === 'delete-file') {
          const path = await placed(root, file, false), info = path ? await lstat(path).catch(() => null) : null;
          if (info && (info.isSymbolicLink() || !info.isFile())) fail('SYNC_LINK', 'The file is a link or not a plain file; it was not deleted.');
          if (path && info) await rm(path);
          delete index.files[file];
        } else delete index.files[file];
        deletions.delete(file);
        await saveIndex(root, index);
      });
      if (action === 'recreate') await guarded(fullPass);
      return status();
    },
    close(): void { closed = true; halt(); },
  };
}
export type ScriptSync = ReturnType<typeof createScriptSync>;
