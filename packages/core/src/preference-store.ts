/**
 * Durable learned preferences: one JSON record per project (in the daemon's owned per-project state directory) plus one
 * global record shared by every project of this user (in the owned state root). Both use the selection-store pattern:
 * bounded regular-file reads, owner-only temporary file, fsync, atomic replace, one write at a time. An unreadable record is
 * never overwritten by learning; only an explicit "Forget all" replaces it. Nothing here touches the network.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicPreferenceReplace } from './selection.js';
import {
  editPreference, emptyPreferences, learn, learnedBias, mergeLayers, preferenceContext, readPreferenceState, removePreference, viewPreferences,
  type FeedbackSignal, type LearnResult, type LearnedBias, type Observation, type PreferenceState, type PreferenceView,
} from './preference-learning.js';

export const PREFERENCE_FILE = 'learned-preferences.v1.json';
const MAX_BYTES = 256 * 1024;
export type PreferenceLayer = 'project' | 'global';
interface Record_ { version: 1; enabled: boolean; preferences: PreferenceState }
export interface PreferenceSnapshot {
  enabled: boolean; project: PreferenceView[]; global: PreferenceView[]; context: string; warnings: string[];
}
export class PreferenceStoreError extends Error {
  constructor(readonly code: 'PREFERENCES_UNREADABLE' | 'PREFERENCES_INPUT' | 'PREFERENCES_WRITE', message: string) { super(message); this.name = 'PreferenceStoreError'; }
}

async function readRecord(directory: string): Promise<Record_ | 'missing' | 'unreadable'> {
  const file = join(directory, PREFERENCE_FILE);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.nlink > 1 || info.size > MAX_BYTES) return 'unreadable';
    const text = await readFile(file, 'utf8');
    const value = JSON.parse(text) as { version?: unknown; enabled?: unknown; preferences?: unknown };
    const preferences = readPreferenceState(value?.preferences);
    if (!value || value.version !== 1 || typeof value.enabled !== 'boolean' || !preferences) return 'unreadable';
    return { version: 1, enabled: value.enabled, preferences };
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'; }
}
async function writeRecord(directory: string, record: Record_): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, PREFERENCE_FILE), temporary = join(directory, 'learned-preferences-' + randomUUID() + '.tmp');
  const payload = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new PreferenceStoreError('PREFERENCES_WRITE', 'Learned preferences exceed their size bound.');
  let owns = false;
  try {
    const handle = await open(temporary, 'wx', 0o600); owns = true;
    try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
    await atomicPreferenceReplace(temporary, target);
    owns = false;
  } catch (error) {
    if (error instanceof PreferenceStoreError) throw error;
    throw new PreferenceStoreError('PREFERENCES_WRITE', 'Learned preferences could not be saved. The previous record was kept.');
  } finally { if (owns) await rm(temporary, { force: true }).catch(() => undefined); }
}

export interface PreferenceStoreOptions { projectDirectory: string; globalDirectory: string; now?: () => number }
export function createPreferenceStore(options: PreferenceStoreOptions) {
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => undefined); return next; };
  async function load(): Promise<{ project: Record_ | null; global: Record_ | null; warnings: string[] }> {
    const [project, global] = await Promise.all([readRecord(options.projectDirectory), readRecord(options.globalDirectory)]);
    const warnings: string[] = [];
    if (project === 'unreadable') warnings.push('This project\'s learned preferences are unreadable and were not changed. Forget all to start fresh.');
    if (global === 'unreadable') warnings.push('Your shared learned preferences are unreadable and were not changed. Forget all to start fresh.');
    const fresh = (): Record_ => ({ version: 1, enabled: true, preferences: emptyPreferences() });
    return { project: project === 'unreadable' ? null : project === 'missing' ? fresh() : project,
      global: global === 'unreadable' ? null : global === 'missing' ? fresh() : global, warnings };
  }
  const enabledOf = (global: Record_ | null) => global ? global.enabled : true;
  const merged = (project: Record_ | null, global: Record_ | null) => mergeLayers(project?.preferences ?? emptyPreferences(), global?.preferences ?? emptyPreferences());

  async function snapshot(): Promise<PreferenceSnapshot> {
    const { project, global, warnings } = await load(), at = now(), enabled = enabledOf(global);
    return { enabled, project: viewPreferences(project?.preferences ?? emptyPreferences(), at), global: viewPreferences(global?.preferences ?? emptyPreferences(), at),
      context: enabled ? preferenceContext(merged(project, global), at) : '', warnings };
  }
  /** The <= 600-character chat block ('' when learning is off or nothing is decided yet). Never throws. */
  async function context(): Promise<string> {
    try { const { project, global } = await load(); return enabledOf(global) ? preferenceContext(merged(project, global), now()) : ''; } catch { return ''; }
  }
  /** Compact defaults for the MCP tools ({} when learning is off). Never throws. */
  async function bias(): Promise<LearnedBias & { enabled: boolean }> {
    try {
      const { project, global } = await load(), enabled = enabledOf(global);
      return enabled ? { enabled, ...learnedBias(merged(project, global), now()) } : { enabled, prefer: {}, avoid: {}, boosts: {} };
    } catch { return { enabled: false, prefer: {}, avoid: {}, boosts: {} }; }
  }
  /** Learns one signal in the project layer (full weight) and the global layer (half weight). */
  function record(signal: FeedbackSignal, observations: readonly Observation[]): Promise<LearnResult & { enabled: boolean }> {
    return serial(async () => {
      const { project, global } = await load(), at = now();
      if (!enabledOf(global)) return { state: merged(project, global), changes: [], message: null, enabled: false };
      if (!project || !global) throw new PreferenceStoreError('PREFERENCES_UNREADABLE', 'Learned preferences are unreadable and were not changed. Forget all in Settings to start fresh.');
      const local = learn(project.preferences, signal, observations, at);
      const shared = learn(global.preferences, { ...signal, confidence: signal.confidence * 0.5 }, observations, at);
      if (local.state !== project.preferences) await writeRecord(options.projectDirectory, { ...project, preferences: local.state });
      if (shared.state !== global.preferences) await writeRecord(options.globalDirectory, { ...global, preferences: shared.state });
      // The note reflects what will be acted on next turn: the merged view.
      return { ...local, state: merged({ ...project, preferences: local.state }, { ...global, preferences: shared.state }), enabled: true };
    });
  }
  function edit(layer: PreferenceLayer, id: string, action: 'like' | 'dislike' | 'clear' | 'delete'): Promise<PreferenceSnapshot> {
    return serial(async () => {
      const directory = layer === 'project' ? options.projectDirectory : options.globalDirectory;
      const current = await readRecord(directory);
      if (current === 'unreadable') throw new PreferenceStoreError('PREFERENCES_UNREADABLE', 'Learned preferences are unreadable and were not changed. Forget all to start fresh.');
      const base: Record_ = current === 'missing' ? { version: 1, enabled: true, preferences: emptyPreferences() } : current;
      const preferences = action === 'delete' ? removePreference(base.preferences, id) : editPreference(base.preferences, id, action === 'clear' ? null : action, now());
      await writeRecord(directory, { ...base, preferences });
      return snapshot();
    });
  }
  /** "Forget all": empties both layers (also the explicit way out of an unreadable record). Keeps the on/off choice. */
  function forget(): Promise<PreferenceSnapshot> {
    return serial(async () => {
      const global = await readRecord(options.globalDirectory), enabled = typeof global === 'object' ? global.enabled : true;
      await writeRecord(options.projectDirectory, { version: 1, enabled: true, preferences: emptyPreferences() });
      await writeRecord(options.globalDirectory, { version: 1, enabled, preferences: emptyPreferences() });
      return snapshot();
    });
  }
  function setEnabled(enabled: boolean): Promise<PreferenceSnapshot> {
    return serial(async () => {
      const global = await readRecord(options.globalDirectory);
      if (global === 'unreadable') throw new PreferenceStoreError('PREFERENCES_UNREADABLE', 'Learned preferences are unreadable and were not changed. Forget all to start fresh.');
      await writeRecord(options.globalDirectory, { version: 1, enabled, preferences: global === 'missing' ? emptyPreferences() : global.preferences });
      return snapshot();
    });
  }
  return { snapshot, context, bias, record, edit, forget, setEnabled };
}
export type PreferenceStore = ReturnType<typeof createPreferenceStore>;
