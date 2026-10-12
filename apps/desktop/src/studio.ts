import type { startWorkflowPanel, WorkflowPanelOptions } from './workflow-panel.js';
import { CodexHistoryPanel } from './codex-history.js';
import { LearningPanel } from './learning-panel.js';
/// <reference lib="dom" />
import { CodexChat, CodexChatApi } from './codex-chat.js';
import { startWorkspaceShell } from './workspace-shell.js';
import { ArtifactDownloads } from './asset-downloads.js';
import type { NativeStudioMetadata, NativeStudioInventoryItem } from '../../../packages/studio-adapter/src/session.js';
import type { NativeStudioReadMethod } from '../../../packages/studio-adapter/src/policy.js';
import type { AssetInput, AssetProbe, AssetManifest } from '../../../packages/asset-pipeline/src/types.js';
import type { AssetJobRecord } from '../../daemon/src/asset-service.js';
import type { WorkRun, WorkTask } from '../../../packages/storage/src/work-store.js';
import type { InstanceRef, Json, MutationReceipt, StudioCommand, StudioMethod, StudioRoot, StudioSession } from '../../../packages/protocol/src/studio.js';

// Runtime dependencies are deliberately browser-only; the shared protocol import
// is erased by TypeScript. Keep these literals checked against its types.
export const STUDIO_ROOTS = ['Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPlayer', 'Lighting'] as const satisfies readonly StudioRoot[];
export const BUILDER_METHODS = ['scene.children', 'scene.search', 'scene.inspect', 'selection.read', 'script.read', 'scene.create', 'scene.update', 'script.update'] as const satisfies readonly StudioMethod[];
const CREATE_CLASSES = ['Folder', 'Model', 'Part', 'Script', 'LocalScript', 'ModuleScript'];
const WRITABLE_PROPERTIES = ['Name', 'Size', 'Position', 'Color', 'Anchored', 'CanCollide', 'Transparency', 'Material'];
const MATERIALS = ['Plastic', 'SmoothPlastic', 'Metal', 'Wood', 'WoodPlanks', 'Concrete', 'Brick', 'Glass', 'Neon', 'Slate', 'Sand', 'Fabric'];
const TOKEN_KEY = 'arcane-lab-session';
const utf8 = (value: string) => new TextEncoder().encode(value).length;
const json = (value: unknown) => JSON.stringify(value, null, 2);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isMutation = (method: StudioMethod) => ['scene.create', 'scene.update', 'script.update', 'scene.restore'].includes(method);
export const inProgress = (command: StudioCommand) => command.state === 'queued' || command.state === 'dispatched' || command.state === 'needs_reconciliation';

export function readReference(value: unknown, session: StudioSession): InstanceRef {
  if (!record(value) || typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 256 || value.instanceId.includes('\0') || value.sessionId !== session.id || !session.allowedRoots.includes(value.root as StudioRoot) || typeof value.className !== 'string' || !value.className || !Array.isArray(value.pathSegments) || value.pathSegments.length > 64 || value.pathSegments.some(p => typeof p !== 'string' || p.length > 256)) {
    throw new Error('The returned reference is not valid for this exact session and its root grants.');
  }
  return { instanceId: value.instanceId, sessionId: session.id, root: value.root as StudioRoot, pathSegments: value.pathSegments as string[], className: value.className };
}
const sameRef = (a: InstanceRef, b: InstanceRef) => a.instanceId === b.instanceId && a.sessionId === b.sessionId && a.root === b.root;
export interface Baseline { ref: InstanceRef; commandId: string; properties?: Record<string, Json>; source?: string }
export interface BuilderInput {
  root: string; limit: number; query: string; ref: InstanceRef | null; browseParent: boolean;
  className: string; name: string; properties: Record<string, Json>; source: string; baseline: Baseline | null;
}

function validateProperties(properties: Record<string, Json>): void {
  for (const [key, value] of Object.entries(properties)) {
    if (!WRITABLE_PROPERTIES.includes(key)) throw new Error('Unsupported writable property: ' + key);
    if (key === 'Name' && (typeof value !== 'string' || !value.trim() || value.length > 100 || value.includes('\0'))) throw new Error('Name must be nonempty and at most 100 characters.');
    if (['Anchored', 'CanCollide'].includes(key) && typeof value !== 'boolean') throw new Error(key + ' must be a boolean.');
    if (key === 'Transparency' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('Transparency must be between 0 and 1.');
    if (key === 'Material' && (typeof value !== 'string' || !MATERIALS.includes(value))) throw new Error('Choose a supported material.');
    if (['Size', 'Position', 'Color'].includes(key)) {
      const tag = key === 'Color' ? 'Color3' : 'Vector3';
      if (!record(value) || value.type !== tag || !Array.isArray(value.value) || value.value.length !== 3 || value.value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error(key + ' needs three finite channels.');
      if (value.value.some(v => Math.abs(v as number) > 100000)) throw new Error(key + ' channels must be bounded to ±100000.');
      if (key === 'Size' && value.value.some(v => (v as number) < 0.05 || (v as number) > 2048)) throw new Error('Size channels must be between 0.05 and 2048 studs.');
      if (key === 'Color' && value.value.some(v => (v as number) < 0 || (v as number) > 1)) throw new Error('Color channels must be between 0 and 1.');
    }
  }
}

export function prepareCommand(session: StudioSession | undefined, method: string, input: BuilderInput): { method: StudioMethod; args: Record<string, Json> } {
  if (!session) throw new Error('Choose an exact paired Studio session.');
  if (session.revokedAt) throw new Error('This session is revoked. Reconnect using an active Arcane API key and choose the new session.');
  if (!(BUILDER_METHODS as readonly string[]).includes(method)) throw new Error('Unsupported builder operation. Restore must use a recorded receipt.');
  const operation = method as StudioMethod;
  if (!session.capabilities.includes(operation)) throw new Error('This exact plugin session does not report support for ' + operation + '.');
  if (isMutation(operation) && !session.allowWrites) throw new Error('This session is read-only. Pair with explicit write grants to edit.');
  const needRef = (): InstanceRef => {
    if (!input.ref) throw new Error('Choose an opaque reference returned in a receipt.');
    return readReference(input.ref, session);
  };
  const refJson = () => needRef() as unknown as Json;
  let args: Record<string, Json>;
  switch (operation) {
    case 'scene.children': case 'scene.search': {
      if (!session.allowedRoots.includes(input.root as StudioRoot)) throw new Error('Choose one of this session’s granted service roots.');
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) throw new Error('Result limit must be an integer from 1 to 200.');
      args = { root: input.root, limit: input.limit };
      if (operation === 'scene.search') {
        if (!input.query.trim() || input.query.length > 100 || input.query.includes('\0')) throw new Error('Enter a nonempty search query of at most 100 characters.');
        args.query = input.query.trim();
      } else if (input.browseParent) {
        const ref = needRef();
        if (ref.root !== input.root) throw new Error('The parent reference and chosen service root must match.');
        args.ref = ref as unknown as Json;
      }
      break;
    }
    case 'selection.read': args = {}; break;
    case 'scene.inspect': case 'script.read': args = { ref: refJson() }; break;
    case 'scene.create': {
      if (!CREATE_CLASSES.includes(input.className)) throw new Error('Choose a supported creation class.');
      if (!input.name.trim() || input.name.length > 100 || input.name.includes('\0')) throw new Error('Choose an instance name of at most 100 characters.');
      validateProperties(input.properties);
      if (input.className !== 'Part' && Object.keys(input.properties).length) throw new Error('Additional creation properties are offered only for Part.');
      if ('Name' in input.properties) throw new Error('Use the instance name field for creation.');
      args = { parent: refJson(), className: input.className, name: input.name.trim(), properties: input.properties }; break;
    }
    case 'scene.update': {
      const ref = needRef();
      if (!input.baseline || !sameRef(input.baseline.ref, ref) || !input.baseline.properties) throw new Error('Inspect this exact instance and use its receipt as the property baseline.');
      if (!Object.keys(input.properties).length) throw new Error('Choose at least one property to change.');
      validateProperties(input.properties);
      if ('Name' in input.properties && (STUDIO_ROOTS as readonly string[]).includes(ref.className)) throw new Error('Service roots cannot be renamed.');
      const expected: Record<string, Json> = {};
      for (const key of Object.keys(input.properties)) {
        if (!Object.hasOwn(input.baseline.properties, key)) throw new Error('The inspect baseline does not contain ' + key + '. Read it again.');
        expected[key] = input.baseline.properties[key]!;
      }
      args = { ref: ref as unknown as Json, expected, properties: input.properties }; break;
    }
    case 'script.update': {
      const ref = needRef();
      if (!['Script', 'LocalScript', 'ModuleScript'].includes(ref.className)) throw new Error('Choose a script reference.');
      if (!input.baseline || !sameRef(input.baseline.ref, ref) || input.baseline.source === undefined) throw new Error('Read this exact script’s editor source and use its receipt as the baseline.');
      if (utf8(input.source) > 100 * 1024 || utf8(input.baseline.source) > 100 * 1024) throw new Error('Each source text must be at most 100 KiB in UTF-8.');
      if (input.source.includes('\0') || input.baseline.source.includes('\0')) throw new Error('Source text cannot contain NUL bytes.');
      args = { ref: ref as unknown as Json, expectedSource: input.baseline.source, source: input.source }; break;
    }
    default: throw new Error('Use the receipt restore flow.');
  }
  if (utf8(JSON.stringify(args)) > 256 * 1024) throw new Error('Command arguments exceed 256 KiB.');
  return { method: operation, args };
}

export function mutationReceipt(command: StudioCommand): MutationReceipt | null {
  if (command.state !== 'succeeded' || !record(command.result) || !record(command.result.mutation)) return null;
  const m = command.result.mutation;
  if (!['scene.create', 'scene.update', 'script.update'].includes(String(m.kind)) || m.kind !== command.method || !record(m.ref) || m.ref.sessionId !== command.sessionId || !record(m.after) || (m.before !== null && !record(m.before))) return null;
  return m as unknown as MutationReceipt;
}
export function prepareRestore(command: StudioCommand, session: StudioSession | undefined, requestId: string): { commandId: string; requestId: string } {
  if (!session || session.id !== command.sessionId || session.clientSessionId !== command.clientSessionId) throw new Error('Restore requires the exact original paired session.');
  if (session.revokedAt || !session.allowWrites) throw new Error('The original session needs active write permission.');
  if (!session.capabilities.includes('scene.restore')) throw new Error('The exact plugin session does not report restore support.');
  if (!mutationReceipt(command)) throw new Error('Only a succeeded mutation with a recorded receipt can be restored.');
  return { commandId: command.id, requestId };
}

export function baselineFromReceipt(command: StudioCommand, session: StudioSession): Baseline {
  if (command.state !== 'succeeded' || command.sessionId !== session.id || command.clientSessionId !== session.clientSessionId || !record(command.result)) throw new Error('Use a succeeded read receipt from this exact paired session.');
  const ref = readReference(command.result.ref, session), requested = readReference(command.args.ref, session);
  if (!sameRef(ref, requested) || ref.className !== requested.className) throw new Error('The read receipt does not match the requested reference.');
  if (command.method === 'scene.inspect' && record(command.result.properties)) return { ref, commandId: command.id, properties: command.result.properties as Record<string, Json> };
  if (command.method === 'script.read' && typeof command.result.source === 'string') return { ref, commandId: command.id, source: command.result.source };
  throw new Error('This receipt does not contain an inspect or editor source baseline.');
}

export interface WorkTaskInput { key: string; title: string; instructions: string; acceptance: string; scope: string[]; dependencies: string[] }
export interface WorkRunInput { title: string; objective: string; tasks: WorkTaskInput[] }
function workText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(label + ' must be nonempty and at most ' + max + ' characters.');
  return value.trim();
}
export function prepareWorkRun(value: unknown): WorkRunInput {
  if (!record(value) || !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 64) throw new Error('A run needs 1–64 explicit tasks.');
  const tasks = value.tasks.map((value): WorkTaskInput => {
    if (!record(value)) throw new Error('Each task needs explicit instructions, acceptance, scopes and dependencies.');
    const key = workText(value.key, 'Task key', 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('Task keys use letters, numbers, underscores and hyphens.');
    if (!Array.isArray(value.scope) || !value.scope.length || value.scope.length > 20 || !Array.isArray(value.dependencies) || value.dependencies.length > 64) throw new Error('Each task needs 1–20 scopes and an explicit dependency list.');
    const scope = value.scope.map(p => {
      const path = workText(p, 'Relative scope', 300).replaceAll('\\', '/');
      if (path.split('/').some(s => !s || s === '.' || s === '..' || /[<>:"|?*\x00-\x1f]/.test(s) || ['.git', '.codex', '.agents', '.aws', 'node_modules', '.env'].includes(s.toLowerCase()) || s.toLowerCase().startsWith('.env.'))) throw new Error('Scopes must be safe relative project paths.');
      return path;
    });
    return { key, title: workText(value.title, 'Task title', 200), instructions: workText(value.instructions, 'Task instructions', 16000), acceptance: workText(value.acceptance, 'Acceptance criteria', 4000), scope: [...new Set(scope)], dependencies: value.dependencies.map(d => workText(d, 'Dependency key', 64)) };
  });
  const keys = new Map(tasks.map(t => [t.key, t]));
  if (keys.size !== tasks.length) throw new Error('Task keys must be unique.');
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error('Task dependencies must not contain a cycle.');
    if (visited.has(key)) return;
    const task = keys.get(key); if (!task) throw new Error('Dependency key is missing: ' + key);
    visiting.add(key); task.dependencies.forEach(visit); visiting.delete(key); visited.add(key);
  };
  tasks.forEach(t => visit(t.key));
  const input = { title: workText(value.title, 'Run title', 200), objective: workText(value.objective, 'Objective', 8000), tasks };
  if (utf8(JSON.stringify(input)) > 600 * 1024) throw new Error('Run payload exceeds the daemon’s 600 KiB limit.');
  return input;
}
export function prepareWorkReview(task: WorkTask | undefined, approved: boolean, note: string): { taskId: string; approved: boolean; note: string } {
  if (!task || task.state !== 'needs_review') throw new Error('Only a submitted task awaiting human review can be reviewed.');
  if (approved && !task.evidence.length) throw new Error('Approval requires submitted evidence.');
  return { taskId: task.id, approved, note: workText(note, 'Review decision note', 4000) };
}

export function prepareAssetInput(value: unknown): AssetInput {
  if (!record(value) || Object.keys(value).some(k => !['template', 'name', 'seed', 'sizeMeters', 'color', 'triangleBudget', 'renderResolution', 'renderSamples'].includes(k))) throw new Error('Asset requests use only fixed template parameters.');
  if (value.template !== 'hero-prop' && value.template !== 'environment-kit') throw new Error('Choose hero-prop or environment-kit.');
  if (typeof value.name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value.name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:-|$)/i.test(value.name)) throw new Error('Asset name must be a safe lowercase slug, at most 48 characters.');
  const input: AssetInput = { template: value.template, name: value.name };
  for (const [key, low, high] of [['seed', 0, 2147483647], ['triangleBudget', 100, 50000], ['renderResolution', 128, 1024], ['renderSamples', 4, 64]] as const) {
    const number = value[key]; if (number === undefined) continue;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < low || number > high) throw new Error(key + ' must be an integer from ' + low + ' to ' + high + '.');
    input[key] = number;
  }
  for (const [key, low, high] of [['sizeMeters', 0.1, 20], ['color', 0, 1]] as const) {
    const vector = value[key]; if (vector === undefined) continue;
    if (!Array.isArray(vector) || vector.length !== 3 || vector.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < low || n > high)) throw new Error(key + ' requires three channels from ' + low + ' to ' + high + '.');
    input[key] = vector as [number, number, number];
  }
  return input;
}

export interface StudioKeyRecord { keyId: string; allowedRoots: StudioRoot[]; allowWrites: boolean; issuedAt: string; revokedAt: string | null; lastUsedAt: string | null }
export interface IssuedStudioKey extends Omit<StudioKeyRecord, 'revokedAt' | 'lastUsedAt'> { apiKey: string }
export function prepareStudioKeyGrant(roots: unknown, writes: unknown): { allowedRoots: StudioRoot[]; allowWrites: boolean } {
  if (!Array.isArray(roots) || !roots.length || roots.length > STUDIO_ROOTS.length || roots.some(root => !(STUDIO_ROOTS as readonly unknown[]).includes(root)) || new Set(roots).size !== roots.length || typeof writes !== 'boolean') throw new Error('Choose explicit service roots and a read-only or write grant.');
  return { allowedRoots: [...roots] as StudioRoot[], allowWrites: writes };
}
export function readStudioKeyRecords(value: unknown): StudioKeyRecord[] {
  if (!Array.isArray(value)) throw new Error('The key endpoint returned invalid metadata.');
  return value.map(entry => {
    if (!record(entry) || Object.keys(entry).some(key => !['keyId', 'allowedRoots', 'allowWrites', 'issuedAt', 'revokedAt', 'lastUsedAt'].includes(key)) || typeof entry.keyId !== 'string' || !entry.keyId.trim() || entry.keyId.length > 200 || entry.keyId.includes('\0')) throw new Error('Key history must contain metadata only; no raw API keys.');
    const grant = prepareStudioKeyGrant(entry.allowedRoots, entry.allowWrites);
    const timestamp = (value: unknown, nullable: boolean): string | null => {
      if (nullable && value === null) return null;
      if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error('Key metadata contains an invalid timestamp.');
      return value;
    };
    return { keyId: entry.keyId, ...grant, issuedAt: timestamp(entry.issuedAt, false)!, revokedAt: timestamp(entry.revokedAt, true), lastUsedAt: timestamp(entry.lastUsedAt, true) };
  });
}
export function readIssuedStudioKey(value: unknown, origin: string, grant: { allowedRoots: StudioRoot[]; allowWrites: boolean }): IssuedStudioKey {
  if (!record(value) || typeof value.apiKey !== 'string') throw new Error('The key issuance response did not contain a one-time API key.');
  const match = /^arcane_local_v1_([1-9][0-9]{0,4})_([a-f0-9]{64})$/.exec(value.apiKey), local = new URL(origin);
  if (!match || match[0] !== value.apiKey || Number(match[1]) > 65535 || local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.port !== match[1]) throw new Error('The issued API key does not match this exact local daemon port and format.');
  const [metadata] = readStudioKeyRecords([{ keyId: value.keyId, allowedRoots: value.allowedRoots, allowWrites: value.allowWrites, issuedAt: value.issuedAt, revokedAt: null, lastUsedAt: null }]);
  if (!metadata || metadata.allowWrites !== grant.allowWrites || json([...metadata.allowedRoots].sort()) !== json([...grant.allowedRoots].sort())) throw new Error('Issued key grants do not match the human-selected service access.');
  return { keyId: metadata.keyId, allowedRoots: metadata.allowedRoots, allowWrites: metadata.allowWrites, issuedAt: metadata.issuedAt, apiKey: value.apiKey };
}

export const NATIVE_READ_METHODS = ['get_studio_state', 'search_game_tree', 'inspect_instance', 'script_read', 'script_search', 'script_grep', 'get_console_output'] as const satisfies readonly NativeStudioReadMethod[];
export const NATIVE_HTTP_RESULT_BYTES = 512 * 1024;
export const NATIVE_DISPLAY_BYTES = 64 * 1024;
export interface NativeObservation { native: { kind: 'built-in-studio-mcp'; readOnly: true; available: true; requiresExplicitRead: true; provenance: NativeStudioMetadata['provenance']; metadata: NativeStudioMetadata }; studios?: NativeStudioInventoryItem[]; method?: NativeStudioReadMethod; studio_id?: string; result?: unknown }
export interface NativeReadInput { path: string; datamodel: string; query: string; instanceType: string; limit: number; depth: number; startLine: number; endLine: number }
export interface NativeReadRequest { method: NativeStudioReadMethod; args: Record<string, Json> & { studio_id: string } }
export function sanitizeNativeText(value: string, secrets: readonly string[] = [], maximum = NATIVE_DISPLAY_BYTES): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]');
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\barcane_local_v1_[0-9]+_[a-f0-9]{64}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(["'](?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)["']\s*:\s*["'])[^"'\r\n]*(["'])/gi, '$1[REDACTED]$2')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= maximum ? text : new TextDecoder().decode(bytes.slice(0, maximum), { stream: true }) + '\n[Display truncated to ' + maximum + ' UTF-8 bytes; request a smaller range.]';
}
export function readNativeObservation(value: unknown, inventory = false): NativeObservation {
  if (!record(value) || !record(value.native) || value.native.kind !== 'built-in-studio-mcp' || value.native.readOnly !== true || value.native.available !== true || value.native.requiresExplicitRead !== true || !record(value.native.metadata)) throw new Error('Native response did not identify a bounded read-only observation.');
  const metadata = value.native.metadata;
  if (metadata.connected !== false) throw new Error('Native response did not report a closed per-request connection.');
  if (!record(metadata.provenance) || !['live', 'fixture'].includes(String(metadata.provenance.kind)) || metadata.evidenceKind !== metadata.provenance.kind || !record(value.native.provenance) || value.native.provenance.kind !== metadata.evidenceKind || typeof metadata.observedAt !== 'string' || !Number.isFinite(Date.parse(metadata.observedAt)) || !Array.isArray(metadata.tools) || metadata.tools.length > 128 || !record(metadata.limits) || typeof metadata.requestsUsed !== 'number' || !Number.isSafeInteger(metadata.requestsUsed) || metadata.requestsUsed < 0) throw new Error('Native capability or connection metadata is invalid.');
  for (const [key, maximum] of [['timeoutMs', 15000], ['maxRequests', 256], ['resultBytes', NATIVE_HTTP_RESULT_BYTES]] as const) { const number = metadata.limits[key]; if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error('Native connection limits are invalid.'); }
  if (metadata.requestsUsed > (metadata.limits.maxRequests as number) || (metadata.limits.maxRequests as number) < 3 || metadata.sdkVersion !== '1.32.1' || metadata.transport !== (metadata.evidenceKind === 'fixture' ? 'in-memory-fixture' : 'stdio') || json(value.native.provenance) !== json(metadata.provenance) || (metadata.evidenceKind === 'fixture' && (typeof metadata.provenance.label !== 'string' || !metadata.provenance.label.trim()))) throw new Error('Native response provenance or request budget is inconsistent.');
  const toolIds = new Set<string>();
  for (const tool of metadata.tools) {
    if (!record(tool) || typeof tool.name !== 'string' || !/^[a-z0-9_]{1,100}$/.test(tool.name) || toolIds.has(tool.name) || typeof tool.allowed !== 'boolean' || !(tool.blockedReason === null || typeof tool.blockedReason === 'string') || !record(tool.inputSchema)) throw new Error('Native observed tool inventory is invalid.');
    toolIds.add(tool.name);
  }
  if (inventory) {
    if (!Array.isArray(value.studios) || value.studios.length > 64) throw new Error('Native Studio choices are invalid or exceed 64 entries.');
    const ids = new Set<string>();
    for (const studio of value.studios) {
      if (!record(studio) || typeof studio.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(studio.id) || ids.has(studio.id) || typeof studio.name !== 'string' || studio.name.length > 512) throw new Error('Native inventory has invalid or duplicate exact Studio IDs.');
      ids.add(studio.id);
    }
  }
  return value as unknown as NativeObservation;
}
export function readNativeReceipt(value: unknown, request: NativeReadRequest, toolError = false): NativeObservation {
  const observation = readNativeObservation(value);
  if (observation.studio_id !== request.args.studio_id || observation.method !== request.method) throw new Error('Native response did not match the exact requested Studio ID and method.');
  if (!record(observation.result) || (observation.result.isError !== undefined && typeof observation.result.isError !== 'boolean') || (observation.result.isError === true) !== toolError) throw new Error('Native read receipt has an inconsistent tool-error state.');
  return observation;
}
export function nativeMethodAvailable(observation: NativeObservation, method: string): boolean {
  const tool = observation.native.metadata.tools.find(tool => tool.name === method);
  return (NATIVE_READ_METHODS as readonly string[]).includes(method) && tool?.allowed === true && tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
}
export function prepareNativeRead(observation: NativeObservation | null, studioId: string, method: string, input: NativeReadInput): NativeReadRequest {
  if (!observation || !observation.studios) throw new Error('Observe native capabilities and Studio choices first.');
  if (!studioId || !observation.studios.some(studio => studio.id === studioId)) throw new Error('Choose an exact studio_id from the observed native inventory.');
  if (!nativeMethodAvailable(observation, method)) throw new Error('This read is unavailable or blocked by the observed native tool policy. Selection is not exposed by this adapter.');
  const text = (value: string, label: string, maximum: number) => { if (!value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(label + ' must be nonempty, bounded and free of control characters.'); return value.trim(); };
  const integer = (value: number, label: string, maximum: number) => { if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(label + ' must be an integer from 1 to ' + maximum + '.'); return value; };
  const args: NativeReadRequest['args'] = { studio_id: studioId };
  switch (method) {
    case 'get_studio_state': case 'get_console_output': break;
    case 'inspect_instance': args.path = text(input.path, 'Instance path', 1024); break;
    case 'search_game_tree':
      if (!['Edit', 'Client', 'Server'].includes(input.datamodel)) throw new Error('Choose an explicit Edit, Client or Server datamodel.');
      args.datamodel_type = input.datamodel; args.head_limit = integer(input.limit, 'Result limit', 200); args.max_depth = integer(input.depth, 'Tree depth', 10);
      if (input.path.trim()) args.path = text(input.path, 'Tree path', 1024);
      if (input.query.trim()) args.keywords = text(input.query, 'Name keywords', 256);
      if (input.instanceType.trim()) args.instance_type = text(input.instanceType, 'Instance class', 100);
      break;
    case 'script_read':
      args.target_file = text(input.path, 'Script path', 1024); args.should_read_entire_file = false;
      args.start_line_one_indexed = integer(input.startLine, 'Start line', 1_000_000); args.end_line_one_indexed_inclusive = integer(input.endLine, 'End line', 1_000_000);
      if (input.endLine < input.startLine || input.endLine - input.startLine >= 500) throw new Error('Choose an ordered inclusive range of at most 500 source lines.');
      break;
    case 'script_search': args.keywords = text(input.query, 'Script keywords', 256); break;
    case 'script_grep': args.query = text(input.query, 'Script content query', 256); break;
    default: throw new Error('Only native read operations are offered.');
  }
  const request = { method: method as NativeStudioReadMethod, args };
  if (utf8(JSON.stringify(request)) > 32 * 1024) throw new Error('Native request exceeds the HTTP 32 KiB bound.');
  return request;
}
export function nativeResultText(result: unknown, secrets: readonly string[] = []): string {
  if (!record(result) || !Array.isArray(result.content) || result.content.some(item => !record(item) || item.type !== 'text' || typeof item.text !== 'string')) throw new Error('Native result must contain text read output only.');
  const text = result.content.map(item => (item as { text: string }).text).join('\n\n');
  return sanitizeNativeText(text + (result.structuredContent === undefined ? '' : '\n\nStructured output:\n' + json(result.structuredContent)), secrets);
}
async function boundedNativeJson(response: Response): Promise<unknown> {
  const chunks: Uint8Array[] = []; let length = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new StudioRequestError('Native response has no readable JSON body.', 'unavailable');
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > NATIVE_HTTP_RESULT_BYTES) { await reader.cancel(); throw new StudioRequestError('Native response exceeded 512 KiB.', 'unavailable'); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; } catch { throw new StudioRequestError('Native endpoint returned unreadable UTF-8 JSON.', 'unavailable'); }
}

export class StudioRequestError extends Error {
  constructor(message: string, readonly outcome: 'rejected' | 'unknown' | 'unavailable', readonly details?: { code: string; status: number; payload: unknown }) { super(message); }
}
export class StudioApi {
  constructor(private readonly token: string, private readonly transport: typeof fetch = fetch, private readonly deadline = 12000) {}
  async request<T>(path: string, input?: unknown, format: 'json' | 'preview' = 'json', deadline = this.deadline): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new StudioRequestError('Open /studio with the launcher’s local control token. This tab has no valid token.', 'rejected');
    const nativeRoute = /^\/v1\/native\/(?:capabilities|read)$/.test(path);
    if (!(nativeRoute || /^\/v1\/(?:studio\/(?:sessions|keys(?:\/revoke)?|pairing|revoke|restore|commands(?:\/[a-zA-Z0-9_%.-]+)?)|product\/(?:state|mcp-token)|work\/(?:runs|ready|create|review)|assets\/(?:jobs|probe|start|cancel|manifest|preview))(?:\?[^#]*)?$/.test(path)) || new URL(path, 'http://127.0.0.1').pathname !== path.split('?')[0]) throw new StudioRequestError('Unsupported local control route.', 'rejected');
    const post = input !== undefined, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline);
    try {
      const transport = this.transport;
      const response = await transport(path, { method: post ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + this.token, ...(post ? { 'Content-Type': 'application/json' } : {}) }, ...(post ? { body: JSON.stringify(input) } : {}), signal: controller.signal, cache: 'no-store', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (format === 'preview' && response.ok) {
        if (response.headers.get('Content-Type')?.split(';')[0] !== 'image/png') throw new StudioRequestError('Preview response is not a PNG.', 'unavailable');
        const blob = await response.blob();
        if (!blob.size || blob.size > 8 * 1024 * 1024) throw new StudioRequestError('Preview exceeds the 8 MiB limit or is empty.', 'unavailable');
        return blob as T;
      }
      let data: unknown;
      try { data = nativeRoute ? await boundedNativeJson(response) : await response.json(); } catch (error) { if (nativeRoute && error instanceof StudioRequestError) throw error; throw new StudioRequestError('The daemon returned an unreadable response (HTTP ' + response.status + ').', post && response.status < 400 || response.status >= 500 && post ? 'unknown' : 'unavailable'); }
      if (!response.ok) {
        const detail = record(data) && typeof data.message === 'string' ? data.message : 'Local request failed.';
        const code = record(data) && typeof data.error === 'string' ? data.error + ': ' : '';
        throw new StudioRequestError(code + detail + ' (HTTP ' + response.status + ')', post ? response.status >= 500 ? 'unknown' : 'rejected' : 'unavailable', { code: record(data) && typeof data.error === 'string' ? data.error : '', status: response.status, payload: data });
      }
      return data as T;
    } catch (error) {
      if (error instanceof StudioRequestError) throw error;
      throw new StudioRequestError(controller.signal.aborted ? 'The local request timed out.' : error instanceof Error ? error.message : 'The local request could not be completed.', post ? 'unknown' : 'unavailable');
    } finally { clearTimeout(timer); }
  }
  nativeCapabilities() { return this.request<NativeObservation>('/v1/native/capabilities', undefined, 'json', 45000); }
  nativeRead(input: NativeReadRequest) { return this.request<NativeObservation>('/v1/native/read', input, 'json', 45000); }
  keys() { return this.request<{ keys: StudioKeyRecord[] }>('/v1/studio/keys'); }
  issueKey(input: { allowedRoots: StudioRoot[]; allowWrites: boolean }) { return this.request<IssuedStudioKey>('/v1/studio/keys', input); }
  revokeKey(keyId: string) { return this.request<{ revoked: true }>('/v1/studio/keys/revoke', { keyId }); }
  agentToken() { return this.request<{ token: string; scopes: unknown; canReview: false; expires: string }>('/v1/product/mcp-token', {}); }
  assetJobs() { return this.request<{ jobs: AssetJobRecord[] }>('/v1/assets/jobs'); }
  assetProbe() { return this.request<{ probe: AssetProbe }>('/v1/assets/probe', {}, 'json', 60000); }
  assetStart(input: AssetInput) { return this.request<{ job: AssetJobRecord }>('/v1/assets/start', input); }
  assetCancel(jobId: string) { return this.request<{ job: AssetJobRecord }>('/v1/assets/cancel', { jobId }); }
  assetManifest(jobId: string) { return this.request<{ manifest: AssetManifest }>('/v1/assets/manifest?jobId=' + encodeURIComponent(jobId)); }
  assetPreview(jobId: string, path: string) {
    if (!['preview-hero.png', 'preview-side.png'].includes(path)) throw new StudioRequestError('Choose a fixed manifest preview.', 'rejected');
    return this.request<Blob>('/v1/assets/preview?jobId=' + encodeURIComponent(jobId) + '&path=' + encodeURIComponent(path), undefined, 'preview');
  }
  runs() { return this.request<{ runs: WorkRun[] }>('/v1/work/runs'); }
  ready() { return this.request<{ tasks: WorkTask[] }>('/v1/work/ready'); }
  createRun(input: WorkRunInput) { return this.request<{ run: WorkRun }>('/v1/work/create', input); }
  reviewTask(input: { taskId: string; approved: boolean; note: string }) { return this.request<{ task: WorkTask }>('/v1/work/review', input); }
  sessions() { return this.request<{ sessions: StudioSession[] }>('/v1/studio/sessions'); }
  product() { return this.request<ProductState>('/v1/product/state'); }
  commands(sessionId: string) { return this.request<{ commands: StudioCommand[] }>('/v1/studio/commands?sessionId=' + encodeURIComponent(sessionId)); }
  command(id: string) { return this.request<{ command: StudioCommand }>('/v1/studio/commands/' + encodeURIComponent(id)); }
}

export function takeControlToken(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>, storage: Pick<Storage, 'getItem' | 'setItem'>): string {
  const fragment = location.hash.slice(1);
  let token = /^[a-f0-9]{64}$/.test(fragment) ? fragment : '';
  try {
    if (token) storage.setItem(TOKEN_KEY, token);
    else if (!fragment) token = storage.getItem(TOKEN_KEY) ?? '';
  } catch { /* Original launcher links still work in storage-disabled tabs. */ }
  history.replaceState(null, '', location.pathname + location.search);
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

interface ProductState { projectPath: string; protocolVersion: 1; studioSessions: unknown; commandCounts: unknown; features: unknown; buildTasks: unknown }
interface PendingRequest { path: '/v1/studio/commands' | '/v1/studio/restore'; body: Record<string, unknown>; sessionId: string; requestId: string }
interface PropertyControl { checked: HTMLInputElement; inputs: (HTMLInputElement | HTMLSelectElement)[] }
const HELP: Record<string, string> = {
  'scene.children': 'Browse a granted service root, or enable browsing inside a returned instance. Paths are display-only.',
  'scene.search': 'Search names inside one granted root. The plugin bounds traversal and may truncate results.',
  'scene.inspect': 'Read allowlisted properties from the exact selected instance. Use the receipt to capture an edit baseline.',
  'selection.read': 'Read the current Studio selection within granted roots. No instance reference is required.',
  'script.read': 'Read current editor text through ScriptEditorService, including unsaved edits.',
  'scene.create': 'Create one supported instance inside the exact selected parent. Studio must be in edit mode.',
  'scene.update': 'Change checked properties only. The plugin compares every expected baseline value before writing.',
  'script.update': 'Replace editor source only if it still matches the exact captured baseline. Conflicts are refused.'
};
const STATE_EXPLANATIONS: Record<StudioCommand['state'], string> = {
  queued: 'Accepted by the daemon; waiting for the exact paired plugin. This is not evidence of Studio execution.',
  dispatched: 'Delivered to the paired plugin; awaiting its receipt. The outcome is not yet known.',
  succeeded: 'The daemon recorded a succeeded plugin receipt. Inspect the returned result below.',
  failed: 'The daemon recorded a failed command. Inspect the error and any recovery details; partial changes may need reconciliation.',
  cancelled: 'The command was cancelled. Inspect its record for the reason.',
  needs_reconciliation: 'Execution may have happened without a confirmed receipt. Further work is blocked; inspect Studio and repair or reconnect a new session explicitly.'
};
const stateTone = (state: StudioCommand['state']) => state === 'succeeded' ? 'good' : ['failed', 'cancelled'].includes(state) ? 'error' : 'warning';

export class StudioWorkbench {
  private canonicalProjectPath = '';
  historyProjectPath(): string { return this.canonicalProjectPath; }
  private readonly projectListeners = new Set<() => void>();
  subscribeProjectChange(listener: () => void): () => void {
    this.projectListeners.add(listener);
    return () => { this.projectListeners.delete(listener); };
  }
  private observeProjectPath(value: unknown): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value) || value === this.canonicalProjectPath) return;
    this.canonicalProjectPath = value;
    for (const listener of this.projectListeners) listener();
  }
  private nativeObservation: NativeObservation | null = null;
  private nativeInventoryReady = false;
  private nativeObserverBusy = false;
  private nativeStudioId = '';
  private nativeViewEpoch = 0;
  private nativeRequestEpoch = 0;
  private nativeToken = '';
  private nativeSecretEpoch = 0;
  private nativeBusy = false;
  private assetJobs: AssetJobRecord[] = [];
  private assetJobId = '';
  private assetAvailable = false;
  private assetBusy = false;
  private assetProbed = false;
  private assetUnknown = '';
  private assetReadAfterUnknown = false;
  private assetPreviewEpoch = 0;
  private workRuns: WorkRun[] = [];
  private readyIds = new Set<string>();
  private workTaskId = '';
  private workAvailable = false;
  private workBusy = false;
  private workUnknown = '';
  private workReadAfterUnknown = false;
  private stopped = false;
  private sessions: StudioSession[] = [];
  private commands: StudioCommand[] = [];
  private sessionId = '';
  private commandId = '';
  private ref: InstanceRef | null = null;
  private propertyBaseline: Baseline | null = null;
  private sourceBaseline: Baseline | null = null;
  private propertyControls = new Map<string, PropertyControl>();
  private pending: PendingRequest | null = null;
  private busy = false;
  private refreshing = false;
  private online = false;
  private historyReady = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshFailures = 0;
  private studioKeys: StudioKeyRecord[] = [];
  private issuedKey: IssuedStudioKey | null = null;
  private keyRevealed = false;
  private keyAvailable = false;
  private keyBusy = false;
  private keyUnknown = '';
  private keyReadAfterUnknown = false;
  private keySecretEpoch = 0;
  private confirmation: (() => Promise<void>) | null = null;
  private readonly assetDownloads: ArtifactDownloads;
  constructor(private readonly doc: Document, private readonly api: StudioApi, private readonly origin: string, private readonly token: string) { this.assetDownloads = new ArtifactDownloads(doc, token); }
  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.doc.getElementById(id);
    if (!element) throw new Error('Missing Studio UI element: ' + id);
    return element as T;
  }
  private make<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, className?: string): HTMLElementTagNameMap[K] {
    const item = this.doc.createElement(tag);
    if (content !== undefined) item.textContent = content;
    if (className) item.className = className;
    return item;
  }
  private text(id: string, value: string) { this.el(id).textContent = value; }
  private value(id: string) { return this.el<HTMLInputElement>(id).value; }
  private checked(id: string) { return this.el<HTMLInputElement>(id).checked; }
  private badge(id: string, label: string, tone = 'neutral') { const item = this.el(id); item.textContent = label; item.className = 'status-text ' + tone; }
  private notice(message: string, tone = '') { this.text('notice', message); this.el('notice').className = 'notice ' + tone; }
  private error(error: unknown) { this.notice(error instanceof Error ? error.message : String(error), 'error'); }
  private active() { return this.sessions.find(s => s.id === this.sessionId); }
  private chosenCommand() { return this.commands.find(c => c.id === this.commandId); }
  private option(select: HTMLSelectElement, value: string, label: string) { const o = this.make('option', label); o.value = value; select.append(o); }
  private identity(id: string, entries: [string, string][]) { const list = this.el(id); list.replaceChildren(); for (const [key, value] of entries) list.append(this.make('dt', key), this.make('dd', value)); }
  private on(id: string, event: string, action: (event: Event) => void) { this.el(id).addEventListener(event, action); }

  async start(): Promise<void> {
    this.el<HTMLAnchorElement>('providers-link').href = this.token ? '/#' + this.token : '/';
    this.text('native-setup', "$env:ARCANE_DAEMON_URL = '" + this.origin + "'\n$env:ARCANE_LOCAL_TOKEN = '<SCOPED_AGENT_TOKEN>'\nnpm run launch:native");
    this.on('go-work', 'click', () => { this.clearStudioKey(); this.el('work-heading').scrollIntoView({ block: 'start' }); this.el('work-heading').focus(); });
    this.on('go-assets', 'click', () => { this.clearStudioKey(); this.el('asset-heading').scrollIntoView({ block: 'start' }); this.el('asset-heading').focus(); });
    this.on('go-codex', 'click', () => { this.clearStudioKey(); this.el<HTMLDetailsElement>('codex-panel').open = true; this.el('codex-heading').scrollIntoView({ block: 'start' }); this.el('codex-heading').focus(); });
    this.on('go-native', 'click', () => { this.clearStudioKey(); this.el('diagnostics-heading').scrollIntoView({ block: 'start' }); this.el('diagnostics-heading').focus(); });
    this.on('diagnostics-probe', 'click', () => { void this.observeNative(); });
    this.on('diagnostics-studio', 'change', () => this.selectNativeStudio());
    this.on('diagnostics-method', 'change', () => this.renderNativeForm());
    this.on('diagnostics-form', 'input', () => this.renderNativeControls());
    this.on('diagnostics-form', 'submit', event => { event.preventDefault(); void this.readNative(); });
    this.renderNativeForm();
    this.on('native-get-token', 'click', () => { void this.getNativeToken(); });
    this.on('native-copy-token', 'click', () => { if (this.nativeToken) void this.copy(this.nativeToken); });
    for (const root of STUDIO_ROOTS) {
      const label = this.make('label'), input = this.make('input'); input.type = 'checkbox'; input.value = root; input.name = 'key-root'; input.checked = root === 'Workspace'; label.append(input, this.make('span', root)); this.el('key-roots').append(label);
    }
    this.on('asset-form', 'submit', event => { event.preventDefault(); void this.startAsset(); });
    this.on('asset-form', 'input', () => this.renderAssetControls());
    this.on('asset-template', 'change', () => { this.el<HTMLInputElement>('asset-size').value = this.value('asset-template') === 'hero-prop' ? '1, 0.65, 0.7' : '3, 3, 2.8'; this.renderAssetControls(); });
    this.on('asset-probe', 'click', () => { void this.probeAsset(); });
    this.on('asset-job-picker', 'change', () => { this.assetJobId = this.value('asset-job-picker'); this.clearAssetPreview(); this.renderAssetJob(); this.renderAssetControls(); });
    this.on('asset-cancel', 'click', () => { void this.cancelAsset(); });
    this.on('asset-load-manifest', 'click', () => { void this.loadAssetManifest(); });
    this.on('asset-refresh', 'click', () => { void this.refresh(); });
    this.on('asset-acknowledge', 'click', () => { if (!this.assetAvailable || !this.assetReadAfterUnknown || this.assetBusy) return; this.assetUnknown = ''; this.assetReadAfterUnknown = false; this.renderAssetControls(); });
    this.renderAssetControls();
    this.on('work-create-form', 'submit', event => { event.preventDefault(); void this.createWork(); });
    this.on('work-add-task', 'click', () => this.addWorkTask());
    this.on('work-create-form', 'input', () => this.renderWorkControls());
    this.on('work-run-picker', 'change', () => this.renderWorkBoard());
    this.on('work-filter', 'change', () => this.renderWorkBoard());
    this.on('work-review-note', 'input', () => this.renderWorkControls());
    this.on('work-approve', 'click', () => this.reviewWork(true));
    this.on('work-changes', 'click', () => this.reviewWork(false));
    this.on('work-refresh', 'click', () => { void this.refresh(); });
    this.on('work-acknowledge', 'click', () => {
      if (!this.workReadAfterUnknown || !this.workAvailable || this.workBusy) return;
      this.workUnknown = ''; this.workReadAfterUnknown = false; this.renderWorkControls();
      this.text('work-notice', 'Recorded runs checked. Any subsequent create or review is a new human decision.');
    });
    this.addWorkTask();
    this.on('refresh', 'click', () => { void this.refresh(); });
    this.on('session-picker', 'change', () => this.selectSession(this.value('session-picker')));
    this.on('key-form', 'submit', event => { event.preventDefault(); void this.issueStudioKey(); });
    this.on('key-form', 'change', () => this.renderKeyControls());
    this.on('key-reveal', 'click', () => { if (!this.issuedKey) return; this.keyRevealed = !this.keyRevealed; this.renderIssuedKey(); });
    this.on('key-copy', 'click', () => { if (this.issuedKey) void this.copy(this.issuedKey.apiKey); });
    this.on('key-dismiss', 'click', () => this.clearStudioKey());
    this.on('key-refresh', 'click', () => { void this.refresh(); });
    this.on('key-acknowledge', 'click', () => { if (!this.keyAvailable || !this.keyReadAfterUnknown || this.keyBusy) return; this.keyUnknown = ''; this.keyReadAfterUnknown = false; this.renderKeyControls(); });
    this.doc.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('a[href]')) this.clearStudioKey(); });
    this.renderKeyControls();
    this.on('revoke', 'click', () => this.reviewRevoke());
    this.on('command-form', 'submit', event => { event.preventDefault(); void this.send(); });
    this.on('method', 'change', () => this.renderForm(true));
    this.on('create-class', 'change', () => this.renderForm(true));
    this.on('command-form', 'input', () => this.renderControls());
    this.on('command-form', 'change', () => this.renderControls());
    this.on('clear-ref', 'click', () => this.setRef(null));
    this.on('copy-ref', 'click', () => { if (this.ref) void this.copy(json(this.ref)); });
    this.on('inspect-target', 'click', () => { void this.send('scene.inspect'); });
    this.on('read-source', 'click', () => { void this.send('script.read'); });
    this.on('history-filter', 'change', () => this.renderHistory());
    this.on('use-baseline', 'click', () => this.useBaseline());
    this.on('restore', 'click', () => this.reviewRestore());
    this.on('recover-request', 'click', () => { void this.recover(); });
    this.on('retry-request', 'click', () => { if (this.pending) void this.submit(this.pending); });
    this.on('confirm-check', 'change', () => { this.el<HTMLButtonElement>('confirm-action').disabled = !this.checked('confirm-check'); });
    this.on('confirm-cancel', 'click', () => this.el<HTMLDialogElement>('confirm-dialog').close());
    this.on('confirm-dialog', 'close', () => { this.confirmation = null; });
    this.on('confirm-action', 'click', () => { const action = this.confirmation; if (!action || !this.checked('confirm-check')) return; this.el<HTMLDialogElement>('confirm-dialog').close(); void action(); });
    this.renderForm(true);
    if (!this.token) { this.notice('Open the /studio session link printed by the local launcher. This tab has no valid control token.', 'error'); this.badge('connection-status', 'Control token required', 'error'); this.renderControls(); return; }
    await this.refresh();
    this.schedule();
  }
  resume() { this.stopped = false; this.renderNativeControls(); void this.refresh().finally(() => this.schedule()); }
  dismissConnectionSecrets(): void {
    this.clearStudioKey(); this.nativeSecretEpoch++; this.nativeToken = '';
    this.text('native-token', ''); this.text('native-scopes', '');
    this.el('native-token-result').hidden = true;
    this.el<HTMLButtonElement>('native-copy-token').disabled = true;
  }
  stop() {
    this.nativeViewEpoch++; this.nativeRequestEpoch++; this.nativeObserverBusy = false;
    this.nativeInventoryReady = false; this.nativeObservation = null; this.nativeStudioId = '';
    const picker = this.el<HTMLSelectElement>('diagnostics-studio'); picker.replaceChildren(); this.option(picker, '', 'Observe Studio choices first');
    this.el('diagnostics-tools').replaceChildren(); this.clearNativeReceipt('Native view cleared after page exit. Observe capabilities again.');
    this.text('diagnostics-request-status', 'Previous request discarded after page exit'); this.text('diagnostics-connection', 'No current request receipt');
    this.dismissConnectionSecrets(); this.assetDownloads.clear(); this.assetPreviewEpoch++; this.stopped = true;
    if (this.timer) clearTimeout(this.timer); this.renderNativeControls();
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => { if (!this.doc.hidden && this.checked('auto-refresh')) void this.refresh().finally(() => this.schedule()); else this.schedule(); }, Math.min(30000, 3000 * 2 ** Math.min(this.refreshFailures, 3)));
  }
  async refresh(): Promise<void> {
    if (this.refreshing || !this.token) return;
    this.refreshing = true; this.el<HTMLButtonElement>('refresh').disabled = true;
    const capturedSession = this.sessionId;
    const workRead = Promise.allSettled([this.refreshWork(), this.refreshAssets(), this.refreshStudioKeys()]);
    const reads = await Promise.allSettled([this.api.sessions(), this.api.product(), ...(capturedSession ? [this.api.commands(capturedSession)] : [])]);
    try {
      // Project/chat metadata does not depend on Studio availability.
      const product = reads[1]!;
      if (product.status === 'fulfilled') this.renderProduct(product.value as ProductState);
      else { this.text('product-evidence', 'Product state unavailable: ' + String(product.reason)); this.text('project-path', 'Product state unavailable'); this.text('command-counts', 'Unknown'); this.text('build-tasks', 'Build board unavailable: ' + String(product.reason)); }
      const sessionRead = reads[0]!;
      if (sessionRead.status === 'rejected') throw sessionRead.reason;
      const sessionData = sessionRead.value as { sessions: StudioSession[] };
      if (!Array.isArray(sessionData.sessions)) throw new Error('The session endpoint returned an invalid payload.');
      this.sessions = sessionData.sessions;
      this.online = true;
      this.renderSessions();
      if (capturedSession && capturedSession === this.sessionId) {
        const commandRead = reads[2]!;
        if (commandRead.status === 'rejected') throw commandRead.reason;
        const data = commandRead.value as { commands: StudioCommand[] };
        if (!Array.isArray(data.commands) || data.commands.some(c => c.sessionId !== capturedSession)) throw new Error('The history endpoint returned records for a different session.');
        this.commands = data.commands;
        this.historyReady = true;
        // The selected receipt may have aged beyond the bounded history window.
        if (this.commandId && !this.commands.some(c => c.id === this.commandId)) {
          const receipt = await this.api.command(this.commandId);
          if (this.sessionId === capturedSession && receipt.command.sessionId === capturedSession) this.commands.push(receipt.command);
        }
        this.resolvePending();
        this.renderHistory(); this.renderReceipt();
      }
      this.refreshFailures = 0;
      this.badge('connection-status', product.status === 'rejected' ? 'Product status unavailable' : 'Daemon responding', product.status === 'rejected' ? 'warning' : 'good');
      this.text('last-refresh', new Date().toLocaleTimeString());
      if (this.el('notice').textContent?.startsWith('Checking') || this.el('notice').textContent?.startsWith('Refresh unavailable')) this.notice('Local daemon responding. Choose an exact session to work in Studio.');
    } catch (error) {
      this.online = false; this.historyReady = false; this.refreshFailures++;
      this.badge('connection-status', 'Refresh unavailable', 'error');
      this.notice('Refresh unavailable: ' + (error instanceof Error ? error.message : String(error)) + ' Cached records may be stale. Command outcomes have not been inferred.', 'error');
    } finally {
      await workRead;
      this.refreshing = false; this.el<HTMLButtonElement>('refresh').disabled = false; this.renderControls(); this.renderKeyControls();
    }
  }

  private renderProduct(state: ProductState) {
    if (state.protocolVersion === 1) this.observeProjectPath(state.projectPath);
    this.text('project-path', typeof state.projectPath === 'string' ? state.projectPath : 'Project path unavailable');
    const counts = record(state.commandCounts) ? Object.entries(state.commandCounts).map(([key, value]) => key + ': ' + String(value)).join(' · ') : json(state.commandCounts) ?? 'Unavailable';
    this.text('command-counts', counts || 'No commands recorded');
    const evidence = this.el('product-evidence'); evidence.replaceChildren();
    for (const [title, data] of [['Features', state.features], ['Build tasks', state.buildTasks], ['Reported Studio sessions', state.studioSessions]] as const) {
      const details = this.make('details'), pre = this.make('pre', json(data) ?? 'Not reported'); details.append(this.make('summary', title), pre); evidence.append(details);
    }
    const board = this.el('build-tasks'); board.replaceChildren();
    if (!Array.isArray(state.buildTasks) || !state.buildTasks.length) board.append(this.make('p', 'No authored build tasks reported by the daemon.', 'empty'));
    if (Array.isArray(state.buildTasks)) for (const task of state.buildTasks) {
      if (!record(task)) continue;
      const card = this.make('article', undefined, 'build-task'), top = this.make('div', undefined, 'task-top');
      const stateLabel = typeof task.state === 'string' ? task.state : 'Unknown';
      top.append(this.make('span', typeof task.id === 'string' ? task.id : 'Task', 'task-id'), this.make('span', stateLabel.replaceAll('_', ' '), 'badge neutral'));
      card.append(top, this.make('h3', typeof task.title === 'string' ? task.title : 'Untitled task'), this.make('p', 'Owner: ' + (typeof task.owner === 'string' ? task.owner : 'Not reported')), this.make('p', typeof task.acceptance === 'string' ? task.acceptance : 'Acceptance criteria not reported.'));
      if (Array.isArray(task.dependsOn) && task.dependsOn.length) card.append(this.make('p', 'Depends on: ' + task.dependsOn.map(String).join(', ')));
      const details = this.make('details'); details.append(this.make('summary', 'Recorded evidence'), this.make('pre', Array.isArray(task.evidence) && task.evidence.length ? json(task.evidence) : 'No evidence recorded on this board.')); card.append(details); board.append(card);
    }
  }
  private renderSessions() {
    const picker = this.el<HTMLSelectElement>('session-picker'); picker.replaceChildren(); this.option(picker, '', 'Choose a session explicitly');
    for (const session of this.sessions) this.option(picker, session.id, session.name + ' · place ' + session.placeId + ' · ' + session.id + (session.revokedAt ? ' · REVOKED' : session.allowWrites ? ' · writes' : ' · read-only'));
    this.text('session-count', String(this.sessions.filter(s => !s.revokedAt).length) + ' active / ' + this.sessions.length + ' recorded');
    if (this.sessionId && !this.active()) { this.sessionId = ''; this.clearTarget(); this.notice('The selected session is no longer reported. Choose a session explicitly; no window was substituted.', 'warning'); }
    picker.value = this.sessionId;
    const session = this.active();
    if (!session) { this.badge('session-mode', 'No target'); this.text('session-summary', 'Connect the Arcane plugin with an API key, then choose its exact session.'); this.el('session-details').replaceChildren(); return; }
    this.badge('session-mode', session.revokedAt ? 'Revoked' : session.allowWrites ? 'Writes granted' : 'Read-only', session.revokedAt ? 'error' : session.allowWrites ? 'warning' : 'good');
    const age = Date.now() - Date.parse(session.lastSeenAt), heartbeat = Number.isFinite(age) ? Math.max(0, Math.floor(age / 1000)) + 's ago' : 'Unknown';
    this.text('session-summary', session.name + ' · heartbeat ' + heartbeat + (age > 20000 ? ' · plugin may be disconnected' : '') + (session.revokedAt ? ' · revoked' : ''));
    this.identity('session-details', [['Session', session.id], ['Client session', session.clientSessionId], ['Place / universe', session.placeId + ' / ' + session.universeId], ['Plugin', session.pluginVersion + ' · protocol ' + session.protocolVersion], ['Granted roots', session.allowedRoots.join(', ')], ['Last seen', session.lastSeenAt], ['Capabilities', session.capabilities.join(', ') || 'None reported']]);
    const root = this.el<HTMLSelectElement>('command-root'), previous = root.value; root.replaceChildren();
    for (const allowed of session.allowedRoots) this.option(root, allowed, allowed);
    if (session.allowedRoots.includes(previous as StudioRoot)) root.value = previous;
  }
  private clearTarget() {
    this.commands = []; this.commandId = ''; this.historyReady = false; this.setRef(null); this.renderHistory(); this.renderReceipt();
  }
  private selectSession(id: string) {
    if (this.busy || this.pending) { this.el<HTMLSelectElement>('session-picker').value = this.sessionId; return; }
    this.clearStudioKey(); this.sessionId = id; this.clearTarget(); this.renderSessions(); this.renderForm(true);
    this.notice(id ? 'Exact session selected: ' + id + '. Loading its command history…' : 'No Studio session selected.');
    // If a previous refresh is finishing, the next scheduled refresh loads history.
    void this.refresh();
  }
  private setRef(ref: InstanceRef | null) {
    this.ref = ref; this.propertyBaseline = null; this.sourceBaseline = null;
    this.el<HTMLTextAreaElement>('source').value = '';
    this.el<HTMLInputElement>('browse-parent').checked = false;
    this.text('ref-label', ref ? ref.root + ' / ' + ref.pathSegments.join(' / ') + ' · ' + ref.className : 'No instance selected');
    this.text('selected-ref', ref ? json(ref) : 'Choose a returned node in a receipt below.');
    this.renderForm(true);
  }

  private renderForm(rebuildProperties = false) {
    const method = this.value('method'), browse = method === 'scene.children', search = method === 'scene.search';
    for (const [id, visible] of [['root-field', browse || search], ['limit-field', browse || search], ['query-field', search], ['browse-parent-field', browse], ['ref-field', !search && method !== 'selection.read'], ['create-fields', method === 'scene.create'], ['properties-field', method === 'scene.create' && this.value('create-class') === 'Part' || method === 'scene.update'], ['source-fields', method === 'script.update']] as [string, boolean][]) this.el(id).hidden = !visible;
    this.el<HTMLInputElement>('query').required = search;
    this.el<HTMLInputElement>('limit').required = browse || search;
    this.el<HTMLInputElement>('create-name').required = method === 'scene.create';
    this.text('method-help', HELP[method] ?? 'Choose a supported operation.');
    this.text('properties-legend', method === 'scene.create' ? 'Optional Part properties' : 'Checked properties will be changed');
    this.text('property-baseline', this.propertyBaseline ? 'Baseline from inspect receipt ' + this.propertyBaseline.commandId + '. Current values must still match.' : method === 'scene.update' ? 'Inspect the target and use its receipt as a baseline before editing.' : 'Unchecked fields are omitted. The plugin validates all properties before creation.');
    this.text('source-baseline', this.sourceBaseline ? 'Editor baseline: receipt ' + this.sourceBaseline.commandId + ' · ' + utf8(this.sourceBaseline.source ?? '') + ' UTF-8 bytes.' : 'Read the editor source, then use its receipt as a baseline.');
    this.text('expected-source', this.sourceBaseline?.source ?? 'No baseline captured.');
    if (rebuildProperties) this.renderProperties();
    this.renderControls();
  }
  private renderProperties() {
    this.propertyControls.clear(); const editor = this.el('property-editor'); editor.replaceChildren();
    const create = this.value('method') === 'scene.create';
    const keys = create ? ['Size', 'Position', 'Color', 'Anchored', 'CanCollide', 'Transparency', 'Material'] : WRITABLE_PROPERTIES.filter(key => this.propertyBaseline?.properties && Object.hasOwn(this.propertyBaseline.properties, key));
    for (const key of keys) {
      const baseline = create ? undefined : this.propertyBaseline?.properties?.[key];
      const row = this.make('div', undefined, 'property-row'), label = this.make('label'), checkbox = this.make('input');
      checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', 'Change ' + key); label.append(checkbox, this.make('span', key)); row.append(label);
      const inputs: (HTMLInputElement | HTMLSelectElement)[] = [];
      if (['Size', 'Position', 'Color'].includes(key)) {
        const vector = this.make('div', undefined, 'vector');
        for (let i = 0; i < 3; i++) {
          const input = this.make('input'); input.type = 'number'; input.step = 'any'; input.setAttribute('aria-label', key + ' ' + ['X / R', 'Y / G', 'Z / B'][i]);
          input.value = String(record(baseline) && Array.isArray(baseline.value) ? baseline.value[i] : key === 'Size' ? [4, 1, 2][i] : key === 'Color' ? 1 : 0);
          if (key === 'Color') { input.min = '0'; input.max = '1'; }
      if (key === 'Size') { input.min = '0.05'; input.max = '2048'; } inputs.push(input); vector.append(input);
        } row.append(vector);
      } else if (['Anchored', 'CanCollide', 'Material'].includes(key)) {
        const select = this.make('select'); select.setAttribute('aria-label', key + ' value');
        for (const value of key === 'Material' ? MATERIALS : ['true', 'false']) this.option(select, value, value);
        select.value = baseline !== undefined ? String(baseline) : key === 'Material' ? 'Plastic' : 'true'; inputs.push(select); row.append(select);
      } else {
        const input = this.make('input'); input.type = key === 'Transparency' ? 'number' : 'text'; input.setAttribute('aria-label', key + ' value'); input.value = baseline !== undefined ? String(baseline) : '0';
        if (key === 'Transparency') { input.min = '0'; input.max = '1'; input.step = 'any'; } inputs.push(input); row.append(input);
      }
      if (baseline !== undefined) row.append(this.make('span', 'Expected: ' + JSON.stringify(baseline), 'baseline'));
      const sync = () => { for (const input of inputs) input.disabled = !checkbox.checked || this.busy || Boolean(this.pending); };
      checkbox.addEventListener('change', sync); sync(); this.propertyControls.set(key, { checked: checkbox, inputs }); editor.append(row);
    }
  }
  private input(): BuilderInput {
    const properties: Record<string, Json> = {};
    for (const [key, control] of this.propertyControls) {
      if (!control.checked.checked) continue;
      const value = control.inputs[0]!.value;
      properties[key] = ['Size', 'Position', 'Color'].includes(key) ? { type: key === 'Color' ? 'Color3' : 'Vector3', value: control.inputs.map(v => v.value.trim() ? Number(v.value) : NaN) } : ['Anchored', 'CanCollide'].includes(key) ? value === 'true' : key === 'Transparency' ? value.trim() ? Number(value) : NaN : value;
    }
    return { root: this.value('command-root'), limit: Number(this.value('limit')), query: this.value('query'), ref: this.ref, browseParent: this.checked('browse-parent'), className: this.value('create-class'), name: this.value('create-name'), properties, source: this.value('source'), baseline: this.value('method') === 'script.update' ? this.sourceBaseline : this.propertyBaseline };
  }
  private guard(): void {
    if (!this.online) throw new Error('Refresh the daemon successfully before sending a command.');
    if (!this.historyReady) throw new Error('Load this exact session’s command history before sending.');
    if (this.busy || this.pending) throw new Error('Resolve the current request before sending another command.');
    if (this.commands.some(inProgress)) throw new Error('This session has a queued, dispatched or uncertain command. Wait for its receipt or reconcile it explicitly.');
    const session = this.active();
    if (session && (!Number.isFinite(Date.parse(session.lastSeenAt)) || Date.now() - Date.parse(session.lastSeenAt) > 20000)) throw new Error('The plugin heartbeat is stale. Reconnect the intended window and refresh before sending.');
  }
  private renderControls() {
    const write = isMutation(this.value('method') as StudioMethod);
    let validation = '', preview = '';
    try { const command = prepareCommand(this.active(), this.value('method'), this.input()); preview = json({ sessionId: this.sessionId, requestId: '(fresh UUID on submit)', ...command }); this.guard(); validation = write ? 'Write grant required. Studio rechecks edit mode and the exact baseline.' : 'Read-only operation for this exact session.'; }
    catch (error) { validation = error instanceof Error ? error.message : String(error); }
    this.text('command-preview', preview || validation);
    this.text('command-validation', validation);
    const valid = Boolean(preview) && validation.startsWith(write ? 'Write grant required.' : 'Read-only operation');
    this.el<HTMLButtonElement>('send').disabled = !valid;
    this.text('send', this.busy ? 'Sending…' : write ? 'Send write command' : 'Send read command');
    this.badge('command-status', this.pending ? 'Outcome unknown' : this.busy ? 'Sending request' : this.commands.some(inProgress) ? 'Awaiting / uncertain' : valid ? write ? 'Write ready' : 'Read ready' : 'Input required', this.pending || write && valid || this.commands.some(inProgress) ? 'warning' : valid ? 'good' : 'neutral');
    const active = this.active(), canAct = this.online && !this.busy && !this.pending;
    this.el<HTMLSelectElement>('session-picker').disabled = this.busy || Boolean(this.pending);
    this.el<HTMLButtonElement>('revoke').disabled = !canAct || !active || Boolean(active.revokedAt);
    let guarded = false; try { this.guard(); guarded = Boolean(active && !active.revokedAt); } catch { /* Status is displayed above. */ }
    this.el<HTMLButtonElement>('inspect-target').disabled = !guarded || !this.ref;
    this.el<HTMLButtonElement>('read-source').disabled = !guarded || !this.ref || !['Script', 'LocalScript', 'ModuleScript'].includes(this.ref.className);
    this.el<HTMLButtonElement>('copy-ref').disabled = !this.ref;
    this.el<HTMLButtonElement>('clear-ref').disabled = this.busy || Boolean(this.pending);
    for (const id of ['method', 'command-root', 'limit', 'query', 'create-class', 'create-name', 'source', 'browse-parent']) this.el<HTMLInputElement>(id).disabled = this.busy || Boolean(this.pending);
    for (const control of this.propertyControls.values()) { control.checked.disabled = this.busy || Boolean(this.pending); for (const input of control.inputs) input.disabled = !control.checked.checked || this.busy || Boolean(this.pending); }
    const command = this.chosenCommand();
    this.el<HTMLButtonElement>('restore').disabled = !guarded || !command || !active?.allowWrites || !mutationReceipt(command);
    this.el<HTMLButtonElement>('use-baseline').disabled = this.busy || Boolean(this.pending);
    this.el('unknown-request').hidden = !this.pending;
    if (this.pending) this.text('unknown-message', 'Outcome unknown for request ' + this.pending.requestId + ' in session ' + this.pending.sessionId + '. The request may have reached the daemon. Find its receipt, or explicitly retry this identical idempotent request. No new request is created.');
    this.el<HTMLButtonElement>('retry-request').disabled = this.busy;
    this.el<HTMLButtonElement>('recover-request').disabled = this.busy;
  }

  private async refreshStudioKeys() {
    try {
      const data = await this.api.keys(); this.studioKeys = readStudioKeyRecords(data.keys); this.keyAvailable = true;
      if (this.keyUnknown) this.keyReadAfterUnknown = true;
      if (this.issuedKey && this.studioKeys.some(key => key.keyId === this.issuedKey!.keyId && key.revokedAt)) this.clearStudioKey();
      this.badge('key-status', 'Key service responding', 'good'); this.renderKeyHistory();
    } catch {
      this.keyAvailable = false; this.keyReadAfterUnknown = false;
      this.badge('key-status', 'Key service unavailable', 'warning');
      this.text('key-notice', 'Refresh key records from the local daemon before issuing or revoking an API key.');
    } finally { this.renderKeyControls(); }
  }
  private keyGrant() { return prepareStudioKeyGrant([...this.doc.querySelectorAll<HTMLInputElement>('input[name="key-root"]:checked')].map(input => input.value), this.checked('key-writes')); }
  private renderKeyControls() {
    let valid = false; try { this.keyGrant(); valid = true; } catch { /* Explicit access selection is required. */ }
    this.el<HTMLButtonElement>('key-issue').disabled = !this.token || !this.keyAvailable || this.keyBusy || Boolean(this.issuedKey) || Boolean(this.keyUnknown) || !valid;
    this.doc.querySelectorAll<HTMLInputElement>('#key-form input').forEach(input => { input.disabled = this.keyBusy || Boolean(this.issuedKey); });
    this.el('key-unknown').hidden = !this.keyUnknown; this.text('key-unknown-message', this.keyUnknown);
    this.el<HTMLButtonElement>('key-acknowledge').disabled = !this.keyAvailable || !this.keyReadAfterUnknown || this.keyBusy;
    this.doc.querySelectorAll<HTMLButtonElement>('#key-history button').forEach(button => { const key = this.studioKeys.find(key => key.keyId === button.dataset.keyId); button.disabled = !this.keyAvailable || this.keyBusy || Boolean(this.keyUnknown) || !key || Boolean(key.revokedAt); });
  }
  private renderIssuedKey() {
    const key = this.issuedKey; this.el('key-result').hidden = !key;
    this.text('key-secret', key ? this.keyRevealed ? key.apiKey : 'arcane_local_v1_' + new URL(this.origin).port + '_' + '•'.repeat(16) : '');
    this.text('key-grants', key ? key.keyId + ' · ' + (key.allowWrites ? 'Writes granted' : 'Read-only') + ' · ' + key.allowedRoots.join(', ') : '');
    this.text('key-reveal', this.keyRevealed ? 'Mask key' : 'Reveal key'); this.el('key-reveal').setAttribute('aria-pressed', String(this.keyRevealed));
    this.el<HTMLButtonElement>('key-copy').disabled = !key; this.el<HTMLButtonElement>('key-reveal').disabled = !key;
    this.renderKeyControls();
  }
  private clearStudioKey() { this.keySecretEpoch++; this.issuedKey = null; this.keyRevealed = false; this.renderIssuedKey(); }
  private renderKeyHistory() {
    const list = this.el('key-history'); list.replaceChildren();
    if (!this.studioKeys.length) list.append(this.make('p', 'No API keys recorded. Issue a key to connect the Arcane plugin.', 'hint'));
    for (const key of this.studioKeys) {
      const row = this.make('article', undefined, 'key-record');
      row.append(this.make('h3', key.keyId), this.make('p', key.revokedAt ? 'Revoked · ' + key.revokedAt : key.allowWrites ? 'Active · writes granted' : 'Active · read-only', 'hint'), this.make('p', key.allowedRoots.join(', '), 'hint'), this.make('p', 'Issued ' + key.issuedAt + ' · last used ' + (key.lastUsedAt ?? 'Not reported'), 'hint'));
      const revoke = this.make('button', 'Revoke API key', 'quiet danger'); revoke.type = 'button'; revoke.dataset.keyId = key.keyId; revoke.addEventListener('click', () => this.reviewKeyRevocation(key)); row.append(revoke); list.append(row);
    }
  }
  private keyFailure(error: unknown, operation: string) {
    const unknown = !(error instanceof StudioRequestError) || error.outcome === 'unknown';
    this.text('key-notice', unknown ? operation + ' outcome unknown. Inspect recorded keys before another action.' : error.message);
    if (unknown) { this.keyUnknown = operation + ' outcome unknown. Refresh the metadata list and revoke any unwanted key. The secret cannot be recovered from history; issuance is never automatically retried.'; this.keyReadAfterUnknown = false; }
  }
  private async issueStudioKey() {
    if (!this.keyAvailable || this.keyBusy || this.issuedKey || this.keyUnknown) return;
    let grant: ReturnType<typeof prepareStudioKeyGrant>; try { grant = this.keyGrant(); } catch { this.text('key-notice', 'Choose explicit service access first.'); return; }
    const epoch = ++this.keySecretEpoch; this.keyBusy = true; this.renderKeyControls(); this.text('key-notice', 'Issuing an Arcane API key…');
    try {
      const result = await this.api.issueKey(grant), key = readIssuedStudioKey(result, this.origin, grant);
      if (!this.stopped && epoch === this.keySecretEpoch) { this.issuedKey = key; this.keyRevealed = false; this.renderIssuedKey(); this.text('key-notice', 'API key issued. Copy it into the Arcane plugin and press Connect. The secret is shown only in this issuance view.'); }
      else if (!this.stopped) this.text('key-notice', 'Key issued; its secret was cleared by navigation. Revoke the record and issue a new key if needed.');
    } catch (error) { this.keyFailure(error, 'Key issuance'); }
    finally { this.keyBusy = false; if (!this.stopped) await this.refreshStudioKeys(); this.renderKeyControls(); }
  }
  private reviewKeyRevocation(key: StudioKeyRecord) {
    if (!this.keyAvailable || this.keyBusy || this.keyUnknown || key.revokedAt) return;
    this.confirm('Revoke this Arcane API key?', 'This key will no longer connect the plugin. The daemon also revokes sessions created with it. An operation already dispatched may still need reconciliation.', key, 'Revoke API key', async () => {
      const current = this.studioKeys.find(record => record.keyId === key.keyId);
      if (!this.keyAvailable || this.keyBusy || this.keyUnknown || !current || current.revokedAt) return;
      if (this.issuedKey?.keyId === key.keyId) this.clearStudioKey();
      this.keyBusy = true; this.renderKeyControls();
      try { const result = await this.api.revokeKey(key.keyId); if (result.revoked !== true) throw new StudioRequestError('The key revocation result could not be confirmed.', 'unknown'); this.text('key-notice', 'API key revoked: ' + key.keyId + '.'); }
      catch (error) { this.keyFailure(error, 'Key revocation'); }
      finally { this.keyBusy = false; await this.refresh(); this.renderKeyControls(); }
    }, 'I checked this key ID and its granted service access.');
  }
  private async send(override?: StudioMethod) {
    try {
      this.guard(); const method = override ?? this.value('method');
      const prepared = prepareCommand(this.active(), method, this.input());
      const requestId = crypto.randomUUID();
      await this.submit({ path: '/v1/studio/commands', body: { sessionId: this.sessionId, requestId, ...prepared }, sessionId: this.sessionId, requestId });
    } catch (error) { this.error(error); }
  }
  private async submit(request: PendingRequest) {
    if (this.busy) return;
    const wasUnknown = this.pending?.requestId === request.requestId;
    this.busy = true; this.notice('Submitting ' + request.requestId + ' to the daemon…'); this.renderControls();
    try {
      const response = await this.api.request<{ command: StudioCommand }>(request.path, request.body);
      if (!response.command || response.command.sessionId !== request.sessionId || response.command.requestId !== request.requestId) throw new StudioRequestError('The daemon response did not identify the exact submitted request.', 'unknown');
      this.pending = null;
      if (this.sessionId === request.sessionId) { this.rememberCommand(response.command); this.commandId = response.command.id; this.renderHistory(); this.renderReceipt(); }
      this.notice('Command ' + response.command.id + ' recorded as ' + response.command.state + '. ' + STATE_EXPLANATIONS[response.command.state], response.command.state === 'succeeded' ? '' : 'warning');
    } catch (error) {
      if (error instanceof StudioRequestError && error.outcome === 'unknown') { this.pending = request; this.notice(error.message + ' Outcome unknown. The identical request is retained for explicit recovery.', 'warning'); }
      else if (wasUnknown) { this.pending = request; this.notice('The identical retry was rejected: ' + (error instanceof Error ? error.message : String(error)) + ' The original outcome remains unknown until a receipt is found.', 'warning'); }
      else { this.pending = null; this.error(error); }
    } finally { this.busy = false; this.renderReceipt(); this.renderControls(); }
  }
  private rememberCommand(command: StudioCommand) { this.commands = [command, ...this.commands.filter(c => c.id !== command.id)]; }
  private resolvePending() {
    if (!this.pending || this.pending.sessionId !== this.sessionId) return;
    const found = this.commands.find(c => c.requestId === this.pending!.requestId);
    if (found) { this.pending = null; this.commandId = found.id; this.notice('Recovered request receipt: ' + found.id + ' · ' + found.state + '. ' + STATE_EXPLANATIONS[found.state], found.state === 'succeeded' ? '' : 'warning'); }
  }
  private async recover() {
    await this.refresh();
    if (this.pending) this.notice('No receipt was found for ' + this.pending.requestId + ' in the bounded history. Its outcome remains unknown. An explicit identical retry preserves the original idempotency key.', 'warning');
  }

  private renderHistory() {
    const list = this.el('command-history'); list.replaceChildren(); const filter = this.value('history-filter');
    const commands = this.commands.filter(c => filter === 'all' || filter === 'active' && inProgress(c) || filter === 'succeeded' && c.state === 'succeeded' || filter === 'failed' && ['failed', 'cancelled'].includes(c.state));
    if (!commands.length) list.append(this.make('p', !this.sessionId ? 'Select a session to load its history.' : !this.historyReady ? 'Loading exact session history…' : 'No commands match this filter. History is bounded to the latest 100 records.', 'empty'));
    for (const command of commands) {
      const button = this.make('button', undefined, 'history-item'); button.type = 'button'; button.setAttribute('aria-pressed', String(command.id === this.commandId)); button.append(this.make('span', command.method, 'history-title'), this.make('span', command.state.replaceAll('_', ' '), 'badge ' + stateTone(command.state)), this.make('span', new Date(command.createdAt).toLocaleString() + ' · ' + command.id, 'history-meta'));
      button.addEventListener('click', () => { this.commandId = command.id; this.renderHistory(); this.renderReceipt(); this.renderControls(); }); list.append(button);
    }
  }
  private renderReceipt() {
    const command = this.chosenCommand(); this.el('receipt-empty').hidden = Boolean(command); this.el('receipt-content').hidden = !command;
    if (!command) return;
    this.text('receipt-title', command.method); this.badge('receipt-state', command.state.replaceAll('_', ' '), stateTone(command.state)); this.text('receipt-explanation', STATE_EXPLANATIONS[command.state]);
    this.identity('receipt-meta', [['Command', command.id], ['Request', command.requestId], ['Session', command.sessionId], ['Client session', command.clientSessionId], ['Created', command.createdAt], ['Finished', command.finishedAt ?? 'Not recorded'], ['Lease / expiry', command.leaseEpoch + ' / ' + command.expiresAt]]);
    this.el('receipt-error').hidden = !command.error; this.text('receipt-error', command.error ?? ''); this.text('receipt-result', json(command.result)); this.text('receipt-args', json(command.args));
    const nodes = this.el('receipt-nodes'); nodes.replaceChildren(); const session = this.active();
    if (session && command.state === 'succeeded' && record(command.result)) {
      if (command.result.truncated === true) nodes.append(this.make('p', 'Results truncated by the plugin. Narrow the search or browse a smaller parent.', 'notice warning'));
      const candidates = Array.isArray(command.result.items) ? command.result.items : command.result.ref ? [command.result] : [];
      for (const candidate of candidates) {
        if (!record(candidate)) continue;
        let ref: InstanceRef; try { ref = readReference(candidate.ref, session); } catch { nodes.append(this.make('p', 'A returned reference was invalid for this session and cannot be selected.', 'notice error')); continue; }
        const row = this.make('div', undefined, 'node-row'); row.append(this.make('p', typeof candidate.name === 'string' ? candidate.name : ref.pathSegments.at(-1) ?? ref.className), this.make('p', ref.className + ' · ' + ref.root + ' / ' + ref.pathSegments.join(' / ') + ' · opaque ID ' + ref.instanceId + (typeof candidate.childCount === 'number' ? ' · ' + candidate.childCount + ' children' : ''), 'node-meta'));
        const actions = this.make('div', undefined, 'button-row'), use = this.make('button', 'Use reference', 'secondary'), copy = this.make('button', 'Copy reference', 'quiet'); use.type = 'button'; copy.type = 'button'; use.disabled = this.busy || Boolean(this.pending); use.addEventListener('click', () => { this.setRef(ref); this.notice('Selected returned reference ' + ref.instanceId + ' in exact session ' + ref.sessionId + '. Edit baselines cleared.'); }); copy.addEventListener('click', () => { void this.copy(json(ref)); }); actions.append(use, copy); row.append(actions); nodes.append(row);
      }
    }
    let baseline = false; try { if (session) { baselineFromReceipt(command, session); baseline = true; } } catch { /* Baselines must match the original read request. */ }
    this.el('use-baseline').hidden = !baseline;
    const mutation = mutationReceipt(command); this.el('mutation-preview').hidden = !mutation;
    if (mutation) { this.text('mutation-before', json(mutation.before)); this.text('mutation-after', json(mutation.after)); }
  }
  private useBaseline() {
    const command = this.chosenCommand(), session = this.active();
    if (!command || command.state !== 'succeeded' || !session || !record(command.result)) return;
    try {
      const baseline = baselineFromReceipt(command, session); this.setRef(baseline.ref);
      if (baseline.properties) { this.propertyBaseline = baseline; this.el<HTMLSelectElement>('method').value = 'scene.update'; }
      else if (baseline.source !== undefined) { this.sourceBaseline = baseline; this.el<HTMLTextAreaElement>('source').value = baseline.source; this.el<HTMLSelectElement>('method').value = 'script.update'; }
      this.renderForm(true); this.notice('Exact edit baseline captured from receipt ' + command.id + '. The plugin will refuse conflicting edits.');
    } catch (error) { this.error(error); }
  }
  private confirm(title: string, description: string, preview: unknown, label: string, action: () => Promise<void>, acknowledgement = 'I checked the exact session and recorded change.') {
    this.text('confirm-check-text', acknowledgement);
    this.text('confirm-title', title); this.text('confirm-description', description); this.text('confirm-preview', json(preview)); this.text('confirm-action', label); this.el<HTMLInputElement>('confirm-check').checked = false; this.el<HTMLButtonElement>('confirm-action').disabled = true; this.confirmation = action; this.el<HTMLDialogElement>('confirm-dialog').showModal();
  }
  private reviewRestore() {
    try {
      this.guard(); const command = this.chosenCommand(); if (!command) throw new Error('Choose a receipt to restore.');
      const requestId = crypto.randomUUID(), body = prepareRestore(command, this.active(), requestId), mutation = mutationReceipt(command)!;
      this.confirm('Restore this recorded change?', 'The daemon constructs the inverse from this immutable receipt. The plugin compares the exact after-state before restoration. Later changes cause a conflict. This sends a new restore command to the same session.', { sessionId: command.sessionId, clientSessionId: command.clientSessionId, receiptCommandId: command.id, kind: mutation.kind, reference: mutation.ref, expectedCurrent: mutation.after, restoreTo: mutation.before }, 'Confirm restore', async () => {
        try { this.guard(); prepareRestore(command, this.active(), requestId); await this.submit({ path: '/v1/studio/restore', body, sessionId: command.sessionId, requestId }); } catch (error) { this.error(error); }
      });
    } catch (error) { this.error(error); }
  }
  private reviewRevoke() {
    const session = this.active(); if (!session || this.busy || this.pending) return;
    this.confirm('Revoke this Studio session?', 'Revoke this exact paired window’s access. Queued commands may be cancelled; a dispatched operation can have an uncertain outcome. Connect again with an active API key for a new session.', { sessionId: session.id, clientSessionId: session.clientSessionId, name: session.name, placeId: session.placeId }, 'Revoke session', async () => {
      this.busy = true; this.renderControls();
      try { await this.api.request('/v1/studio/revoke', { sessionId: session.id }); this.notice('Session revoked: ' + session.id + '. Refreshing its recorded state.'); await this.refresh(); }
      catch (error) { this.error(error); }
      finally { this.busy = false; this.renderControls(); }
    });
  }
  private async refreshWork() {
    const reads = await Promise.allSettled([this.api.runs(), this.api.ready()]);
    try {
      const runs = reads[0]!, ready = reads[1]!;
      if (runs.status === 'rejected') throw runs.reason;
      if (ready.status === 'rejected') throw ready.reason;
      if (!Array.isArray(runs.value.runs) || !Array.isArray(ready.value.tasks)) throw new Error('Invalid work endpoint response.');
      this.workRuns = runs.value.runs; this.readyIds = new Set(ready.value.tasks.map(t => t.id));
      this.workAvailable = true; if (this.workUnknown) this.workReadAfterUnknown = true;
      const picker = this.el<HTMLSelectElement>('work-run-picker'), previous = picker.value;
      picker.replaceChildren(); this.option(picker, '', 'All recorded runs');
      this.workRuns.forEach(run => this.option(picker, run.id, run.title + ' · ' + run.id));
      if (this.workRuns.some(run => run.id === previous)) picker.value = previous;
      this.badge('work-status', 'WorkStore responding', 'good');
      this.text('work-summary', this.workRuns.length + ' runs · ' + this.workRuns.flatMap(r => r.tasks).filter(t => t.state === 'needs_review').length + ' awaiting review · ' + this.readyIds.size + ' ready');
      this.renderWorkBoard(); this.renderWorkTask();
    } catch (error) {
      this.workAvailable = false; this.workReadAfterUnknown = false;
      this.badge('work-status', 'WorkStore unavailable', 'error');
      this.text('work-summary', 'Cached work may be stale. Create and review require fresh runs and readiness.');
      this.text('work-notice', error instanceof Error ? error.message : String(error));
    } finally { this.renderWorkControls(); }
  }
  private addWorkTask() {
    const editor = this.el('work-task-editor'); if (editor.children.length >= 64) return;
    const row = this.make('fieldset', undefined, 'work-task-draft'); row.append(this.make('legend', 'Task definition'));
    const fields: [string, string, number, boolean][] = [['key', 'Task key', 64, false], ['title', 'Task title', 200, false], ['scope', 'File scopes · one relative path per line', 6020, true], ['dependencies', 'Dependency keys · comma separated, empty for none', 4160, false], ['instructions', 'Worker instructions', 16000, true], ['acceptance', 'Acceptance criteria', 4000, true]];
    for (const [key, title, max, multiline] of fields) {
      const label = this.make('label', title), input = multiline ? this.make('textarea') : this.make('input');
      input.dataset.field = key; input.maxLength = max; input.required = key !== 'dependencies';
      if (key === 'key') input.value = 'task-' + (editor.children.length + 1);
      if (multiline) (input as HTMLTextAreaElement).rows = 3;
      label.append(input); row.append(label);
    }
    const remove = this.make('button', 'Remove task', 'quiet danger'); remove.type = 'button';
    remove.addEventListener('click', () => { row.remove(); this.renderWorkControls(); }); row.append(remove); editor.append(row);
    this.renderWorkControls();
  }
  private workInput(): WorkRunInput {
    const tasks = [...this.el('work-task-editor').children].map(row => {
      const get = (key: string) => (row.querySelector('[data-field="' + key + '"]') as HTMLInputElement).value;
      return { key: get('key'), title: get('title'), instructions: get('instructions'), acceptance: get('acceptance'), scope: get('scope').split(/\r?\n/).map(p => p.trim()).filter(Boolean), dependencies: get('dependencies').split(',').map(d => d.trim()).filter(Boolean) };
    });
    return prepareWorkRun({ title: this.value('work-title'), objective: this.value('work-objective'), tasks });
  }
  private currentWorkTask() { return this.workRuns.flatMap(r => r.tasks).find(t => t.id === this.workTaskId); }
  private renderWorkBoard() {
    const board = this.el('work-tasks'); board.replaceChildren();
    const filter = this.value('work-filter'), runId = this.value('work-run-picker');
    for (const run of this.workRuns.filter(r => !runId || r.id === runId)) {
      const group = this.make('section', undefined, 'work-run');
      group.append(this.make('h3', run.title), this.make('p', run.objective, 'hint'), this.make('p', run.id + ' · ' + run.createdAt, 'mono hint'));
      const cards = this.make('div', undefined, 'build-tasks');
      for (const task of run.tasks) {
        if (filter !== 'all' && !(filter === 'ready' ? this.readyIds.has(task.id) : task.state === filter)) continue;
        const card = this.make('button', undefined, 'build-task work-task-card'); card.type = 'button'; card.dataset.taskId = task.id; card.setAttribute('aria-pressed', String(task.id === this.workTaskId));
        const top = this.make('div', undefined, 'task-top');
        top.append(this.make('span', task.key, 'task-id'), this.make('span', task.state.replaceAll('_', ' '), 'badge ' + (task.state === 'complete' ? 'good' : task.state === 'needs_review' || task.state === 'interrupted' ? 'warning' : 'neutral')));
        const dependencies = task.dependencies.map(key => key + ' (' + (run.tasks.find(t => t.key === key)?.state.replaceAll('_', ' ') ?? 'missing') + ')').join(', ');
        card.append(top, this.make('h3', task.title), this.make('p', task.acceptance), this.make('p', 'Dependencies: ' + (dependencies || 'None')), this.make('p', 'Worker: ' + (task.worker ?? 'Unassigned')), this.make('p', this.readyIds.has(task.id) ? 'Ready for an explicit worker claim' : task.state === 'pending' ? 'Waiting for reviewed dependencies' : task.progress || 'No progress recorded'), this.make('p', task.evidence.length + ' evidence artifacts'));
        card.addEventListener('click', () => { this.workTaskId = task.id; this.el<HTMLTextAreaElement>('work-review-note').value = ''; this.renderWorkBoard(); this.renderWorkTask(); this.renderWorkControls(); }); cards.append(card);
      }
      if (cards.children.length) { group.append(cards); board.append(group); }
    }
    if (!board.children.length) board.append(this.make('p', this.workRuns.length ? 'No tasks match this filter.' : 'No durable runs recorded. Create a run with explicit tasks below.', 'empty'));
  }
  private renderWorkTask() {
    const task = this.currentWorkTask(); this.el('work-task-empty').hidden = Boolean(task); this.el('work-task-detail').hidden = !task;
    if (!task) return;
    this.text('work-task-title', task.title); this.text('work-task-instructions', task.instructions); this.text('work-task-acceptance', task.acceptance);
    this.identity('work-task-meta', [['Task / run', task.id + ' / ' + task.runId], ['State', task.state.replaceAll('_', ' ')], ['Scopes', task.scope.join('\n')], ['Dependencies', task.dependencies.join(', ') || 'None'], ['Worker / lease', (task.worker ?? 'Unassigned') + ' / ' + (task.leaseUntil ?? 'No active lease')], ['Progress', task.progress || 'None recorded'], ['Last review', task.reviewNote ?? 'No human review recorded'], ['Updated', task.updatedAt]]);
    const evidence = this.el('work-task-evidence'); evidence.replaceChildren();
    if (!task.evidence.length) evidence.append(this.make('p', 'No evidence submitted.', 'empty'));
    for (const artifact of task.evidence) {
      const item = this.make('article', undefined, 'evidence-artifact');
      item.append(this.make('h3', artifact.path), this.make('p', artifact.note), this.make('p', 'SHA-256 ' + artifact.sha256, 'mono'), this.make('p', artifact.bytes + ' bytes · submitted ' + artifact.addedAt, 'hint'));
      const copy = this.make('button', 'Copy evidence path', 'quiet'); copy.type = 'button'; copy.addEventListener('click', () => { void this.copy(artifact.path); }); item.append(copy); evidence.append(item);
    }
    this.el('work-review-form').hidden = task.state !== 'needs_review';
  }
  private renderWorkControls() {
    const blocked = this.workBusy || !this.workAvailable || Boolean(this.workUnknown);
    let valid = false;
    try { const input = this.workInput(); this.text('work-create-preview', json(input)); valid = true; }
    catch (error) { this.text('work-create-preview', error instanceof Error ? error.message : String(error)); }
    this.el<HTMLButtonElement>('work-create').disabled = blocked || !valid;
    this.el<HTMLButtonElement>('work-add-task').disabled = this.workBusy || this.el('work-task-editor').children.length >= 64;
    this.doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('#work-create-form input, #work-create-form textarea, #work-task-editor button').forEach(el => { el.disabled = this.workBusy; });
    let reviewable = false; try { prepareWorkReview(this.currentWorkTask(), false, this.value('work-review-note')); reviewable = true; } catch { /* A decision note and submitted state are required. */ }
    this.el<HTMLButtonElement>('work-approve').disabled = blocked || !reviewable || !this.currentWorkTask()?.evidence.length;
    this.el<HTMLButtonElement>('work-changes').disabled = blocked || !reviewable;
    this.el<HTMLTextAreaElement>('work-review-note').disabled = this.workBusy;
    this.el('work-unknown').hidden = !this.workUnknown; this.text('work-unknown-message', this.workUnknown);
    this.el<HTMLButtonElement>('work-acknowledge').disabled = !this.workReadAfterUnknown || !this.workAvailable || this.workBusy;
  }
  private async createWork() {
    if (!this.workAvailable || this.workBusy || this.workUnknown) return;
    let input: WorkRunInput; try { input = this.workInput(); } catch (error) { this.text('work-notice', String(error)); return; }
    this.workBusy = true; this.renderWorkControls();
    try {
      const response = await this.api.createRun(input);
      if (!response.run?.id || !Array.isArray(response.run.tasks)) throw new StudioRequestError('Create returned no durable run identity.', 'unknown');
      this.text('work-notice', 'Run recorded: ' + response.run.id + '. Tasks require explicit worker claims and human evidence review.');
      await this.refreshWork(); this.el<HTMLSelectElement>('work-run-picker').value = response.run.id; this.renderWorkBoard();
    } catch (error) { this.workFailure(error, 'Create run'); }
    finally { this.workBusy = false; this.renderWorkControls(); }
  }
  private workFailure(error: unknown, operation: string) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof StudioRequestError && error.outcome === 'unknown') {
      this.workUnknown = operation + ': ' + message + ' Outcome unknown. Refresh and inspect recorded runs before another decision. This endpoint has no idempotency key; the UI does not replay it.'; this.workReadAfterUnknown = false;
    }
    this.text('work-notice', message);
  }
  private reviewWork(approved: boolean) {
    if (!this.workAvailable || this.workBusy || this.workUnknown) return;
    try {
      const task = this.currentWorkTask(), input = prepareWorkReview(task, approved, this.value('work-review-note'));
      this.confirm(approved ? 'Approve submitted work?' : 'Request changes?', approved ? 'Approve only after checking the acceptance criteria and local evidence. The daemon rehashes submitted files before acceptance. Reviewed completion releases dependent tasks.' : 'Return this task to pending with your decision note. Dependent tasks remain blocked until acceptance.', { taskId: task!.id, runId: task!.runId, acceptance: task!.acceptance, scope: task!.scope, evidence: task!.evidence, decision: input }, approved ? 'Approve work' : 'Request changes', async () => {
        if (!this.workAvailable || this.workBusy || this.workUnknown || this.currentWorkTask()?.id !== input.taskId) return;
        try { if (this.currentWorkTask()?.updatedAt !== task!.updatedAt || json(this.currentWorkTask()?.evidence) !== json(task!.evidence)) throw new Error('This submission changed during confirmation. Refresh and review its current evidence.'); prepareWorkReview(this.currentWorkTask(), approved, input.note); } catch (error) { this.text('work-notice', String(error)); return; }
        this.workBusy = true; this.renderWorkControls();
        try {
          const response = await this.api.reviewTask(input);
          if (response.task?.id !== input.taskId || response.task.state !== (approved ? 'complete' : 'pending')) throw new StudioRequestError('Review response did not identify the expected task decision.', 'unknown');
          this.text('work-notice', approved ? 'Human review recorded. Dependency readiness will be refreshed.' : 'Changes requested. Task returned to pending.');
        } catch (error) { this.workFailure(error, 'Review task ' + input.taskId); }
        finally { this.workBusy = false; await this.refreshWork(); this.renderWorkControls(); }
      }, 'I checked this task’s acceptance criteria and submitted evidence.');
    } catch (error) { this.text('work-notice', error instanceof Error ? error.message : String(error)); }
  }

  private async refreshAssets() {
    try {
      const data = await this.api.assetJobs(); if (!Array.isArray(data.jobs)) throw new Error('Invalid asset job response.');
      this.assetJobs = data.jobs; this.assetAvailable = true;
      if (this.assetUnknown) this.assetReadAfterUnknown = true;
      const picker = this.el<HTMLSelectElement>('asset-job-picker'); picker.replaceChildren(); this.option(picker, '', 'Choose a recorded asset job');
      this.assetJobs.forEach(job => this.option(picker, job.jobId, job.request.name + ' · ' + job.state.replaceAll('_', ' ') + ' · ' + job.jobId));
      if (this.assetJobs.some(j => j.jobId === this.assetJobId)) picker.value = this.assetJobId; else { this.assetJobId = ''; this.clearAssetPreview(); }
      this.badge('asset-status', 'Asset service responding', 'good'); this.renderAssetJob();
    } catch (error) {
      this.assetAvailable = false; this.assetProbed = false; this.assetReadAfterUnknown = false;
      this.badge('asset-status', 'Asset service unavailable', 'warning');
      this.text('asset-notice', (error instanceof Error ? error.message : String(error)) + ' Start and cancel require the connected local asset service.');
    } finally { this.renderAssetControls(); }
  }
  private assetInput() {
    const number = (id: string) => this.value(id).trim() ? Number(this.value(id)) : NaN;
    return prepareAssetInput({ template: this.value('asset-template'), name: this.value('asset-name'), seed: number('asset-seed'), sizeMeters: this.value('asset-size').split(',').map(s => s.trim() ? Number(s) : NaN), color: this.value('asset-color').split(',').map(s => s.trim() ? Number(s) : NaN), triangleBudget: number('asset-budget'), renderResolution: number('asset-resolution'), renderSamples: number('asset-samples') });
  }
  private currentAssetJob() { return this.assetJobs.find(j => j.jobId === this.assetJobId); }
  private renderAssetControls() {
    const running = this.assetJobs.some(j => j.state === 'running'), interrupted = this.assetJobs.some(j => j.state === 'interrupted'), blocked = !this.assetAvailable || this.assetBusy || Boolean(this.assetUnknown);
    let valid = false; try { this.text('asset-request-preview', json(this.assetInput())); valid = true; } catch (error) { this.text('asset-request-preview', error instanceof Error ? error.message : String(error)); }
    this.el<HTMLButtonElement>('asset-start').disabled = blocked || !valid || !this.assetProbed || running || interrupted;
    this.el<HTMLButtonElement>('asset-probe').disabled = blocked || running || interrupted;
    this.el<HTMLButtonElement>('asset-cancel').disabled = blocked || this.currentAssetJob()?.state !== 'running';
    this.el<HTMLButtonElement>('asset-load-manifest').disabled = blocked || !this.currentAssetJob()?.manifestAvailable || this.currentAssetJob()?.state !== 'succeeded';
    this.el<HTMLSelectElement>('asset-job-picker').disabled = this.assetBusy;
    this.el('asset-unknown').hidden = !this.assetUnknown; this.text('asset-unknown-message', this.assetUnknown);
    this.el<HTMLButtonElement>('asset-acknowledge').disabled = !this.assetAvailable || !this.assetReadAfterUnknown || this.assetBusy;
    this.text('asset-gate', interrupted ? 'Worker supervision was lost. Inspect retained output and resolve it through trusted host configuration.' : running ? 'A job is running. Its stage and final manifest are recorded below.' : !this.assetProbed ? 'Probe the installed Blender runtime before starting a template job.' : 'Local runtime observed. Start runs only the selected fixed template.');
  }
  private renderAssetJob() {
    const job = this.currentAssetJob(); this.text('asset-job-record', job ? json(job) : 'No asset job selected.');
    this.text('asset-job-summary', job ? job.request.name + ' · ' + job.state.replaceAll('_', ' ') + ' · stage ' + job.stage + (job.error ? ' · ' + job.error.code + ': ' + job.error.message : '') : 'Choose an exact recorded job to inspect progress and evidence.');
  }
  private assetFailure(error: unknown, operation: string) {
    const message = error instanceof Error ? error.message : String(error); this.text('asset-notice', message);
    if (error instanceof StudioRequestError && error.outcome === 'unknown') { this.assetUnknown = operation + ': outcome unknown. Refresh and inspect jobs before another action. Start and cancel are never automatically retried.'; this.assetReadAfterUnknown = false; }
  }
  private async probeAsset() {
    if (!this.assetAvailable || this.assetBusy || this.assetUnknown) return;
    this.assetBusy = true; this.assetProbed = false; this.text('asset-notice', 'Probing installed Blender capabilities…'); this.renderAssetControls();
    try {
      const data = await this.api.assetProbe(), capabilities = data.probe.blender?.capabilities; this.assetProbed = data.probe.available === true && record(capabilities) && (['glbExport', 'glbImport', 'fbxExport', 'fbxImport', 'cycles'] as const).every(key => capabilities[key] === true);
      this.text('asset-runtime', json(data.probe)); this.text('asset-notice', this.assetProbed ? 'Installed runtime capabilities observed. A template job can now start.' : 'No available Blender runtime was reported. Inspect probe attempts.');
    } catch (error) { this.assetFailure(error, 'Probe runtime'); }
    finally { this.assetBusy = false; await this.refreshAssets(); this.renderAssetControls(); }
  }
  private async startAsset() {
    if (!this.assetAvailable || !this.assetProbed || this.assetBusy || this.assetUnknown || this.assetJobs.some(j => j.state === 'running' || j.state === 'interrupted')) return;
    let input: AssetInput; try { input = this.assetInput(); } catch (error) { this.assetFailure(error, 'Validate template'); return; }
    this.assetBusy = true; this.renderAssetControls();
    try {
      const data = await this.api.assetStart(input); if (!data.job?.jobId || data.job.request?.name !== input.name || data.job.request?.template !== input.template) throw new StudioRequestError('Start returned no matching recorded job.', 'unknown');
      this.assetJobId = data.job.jobId; this.clearAssetPreview(); this.text('asset-notice', 'Asset job recorded: ' + data.job.jobId + '. Completion and preview evidence arrive through its manifest.');
    } catch (error) { this.assetFailure(error, 'Start template job'); }
    finally { this.assetBusy = false; await this.refreshAssets(); this.renderAssetControls(); }
  }
  private async cancelAsset() {
    const job = this.currentAssetJob(); if (!job || job.state !== 'running' || !this.assetAvailable || this.assetBusy || this.assetUnknown) return;
    this.assetBusy = true; this.renderAssetControls();
    try { const data = await this.api.assetCancel(job.jobId); if (data.job?.jobId !== job.jobId) throw new StudioRequestError('Cancel did not identify the selected job.', 'unknown'); this.text('asset-notice', 'Recorded cancellation result: ' + data.job.state.replaceAll('_', ' ') + '. Inspect retained evidence.'); }
    catch (error) { this.assetFailure(error, 'Cancel job ' + job.jobId); }
    finally { this.assetBusy = false; await this.refreshAssets(); this.renderAssetControls(); }
  }
  private clearAssetPreview() { this.assetDownloads.clear(); this.assetPreviewEpoch++; this.el('asset-previews').replaceChildren(); this.text('asset-manifest', 'Load a verified completed manifest for this exact job.'); }
  private async loadAssetManifest() {
    const job = this.currentAssetJob(); if (!job || job.state !== 'succeeded' || !job.manifestAvailable || !this.assetAvailable || this.assetBusy) return;
    this.assetBusy = true; this.assetDownloads.clear(); const epoch = ++this.assetPreviewEpoch; this.renderAssetControls(); this.el('asset-previews').replaceChildren();
    try {
      const { manifest } = await this.api.assetManifest(job.jobId);
      if (manifest.jobId !== job.jobId || manifest.request.template !== job.request.template || manifest.request.name !== job.request.name) throw new Error('Manifest identity does not match the selected job.');
      if (this.stopped || epoch !== this.assetPreviewEpoch) return;
      this.text('asset-manifest', json(manifest));
      const previews = manifest.artifacts.filter(a => a.role === 'preview' && ['preview-hero.png', 'preview-side.png'].includes(a.path));
      const reads = await Promise.allSettled(previews.map(async artifact => {
        const blob = await this.api.assetPreview(job.jobId, artifact.path);
        if (blob.size !== artifact.bytes) throw new Error('Preview byte count does not match its manifest.');
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
        if (digest !== artifact.sha256) throw new Error('Preview hash does not match its manifest.');
        const bitmap = await createImageBitmap(blob);
        try {
          if (this.stopped || epoch !== this.assetPreviewEpoch) return;
          const figure = this.make('figure'), canvas = this.make('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', artifact.path + ' for job ' + job.jobId); canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
          figure.append(canvas, this.make('figcaption', artifact.path + ' · SHA-256 verified')); this.el('asset-previews').append(figure);
        } finally { bitmap.close(); }
      }));
      if (epoch === this.assetPreviewEpoch) this.text('asset-notice', reads.some(r => r.status === 'rejected') ? 'Manifest loaded; one or more previews failed authentication, decoding or integrity verification. Inspect the recorded manifest.' : 'Manifest and authenticated previews loaded. Review validation warnings and limitations before using exports.');
    } catch (error) { this.assetFailure(error, 'Load manifest'); }
    finally { this.assetBusy = false; this.renderAssetControls(); }
  }

  private nativeSecrets() { return [this.token, this.nativeToken, this.issuedKey?.apiKey ?? '']; }
  private nativeText(value: unknown, maximum = NATIVE_DISPLAY_BYTES) { return sanitizeNativeText(typeof value === 'string' ? value : json(value) ?? 'Not reported', this.nativeSecrets(), maximum); }
  private nativeInput(): NativeReadInput { return { path: this.value('diagnostics-path'), datamodel: this.value('diagnostics-datamodel'), query: this.value('diagnostics-query'), instanceType: this.value('diagnostics-type'), limit: Number(this.value('diagnostics-limit')), depth: Number(this.value('diagnostics-depth')), startLine: Number(this.value('diagnostics-start')), endLine: Number(this.value('diagnostics-end')) }; }
  private clearNativeReceipt(message: string) {
    this.text('diagnostics-output', message); this.text('diagnostics-result-target', this.nativeStudioId || 'No target selected');
    this.el('diagnostics-provenance').replaceChildren(); this.text('diagnostics-metadata', 'No metadata for this request.');
    this.badge('diagnostics-status', 'No current receipt', 'neutral');
  }
  private selectNativeStudio() {
    this.nativeStudioId = this.value('diagnostics-studio'); this.nativeViewEpoch++;
    this.clearNativeReceipt('No read result for this exact target.'); this.text('diagnostics-connection', 'No receipt for the selected target');
    this.text('diagnostics-notice', this.nativeObserverBusy ? 'Target changed while a request is in flight. Its result will not be attached to this target.' : this.nativeStudioId ? 'Exact native studio_id selected: ' + this.nativeStudioId + '. Choose a read explicitly.' : 'Choose an exact Studio ID. No first window is selected automatically.');
    this.renderNativeControls();
  }
  private renderNativeForm() {
    const method = this.value('diagnostics-method'), tree = method === 'search_game_tree', source = method === 'script_read', query = tree || method === 'script_search' || method === 'script_grep';
    for (const [id, visible] of [['diagnostics-path-field', tree || source || method === 'inspect_instance'], ['diagnostics-tree-fields', tree], ['diagnostics-query-field', query], ['diagnostics-source-fields', source]] as const) this.el(id).hidden = !visible;
    this.el<HTMLInputElement>('diagnostics-path').required = source || method === 'inspect_instance'; this.el<HTMLInputElement>('diagnostics-query').required = method === 'script_search' || method === 'script_grep';
    this.text('diagnostics-path-label', source ? 'Exact native script path' : tree ? 'Tree path · optional' : 'Exact native instance path');
    this.renderNativeControls();
  }
  private renderNativeControls() {
    this.el<HTMLButtonElement>('diagnostics-probe').disabled = this.stopped || !this.token || this.nativeObserverBusy;
    this.el<HTMLSelectElement>('diagnostics-studio').disabled = !this.nativeObservation?.studios?.length;
    const method = this.value('diagnostics-method'), tree = method === 'search_game_tree', source = method === 'script_read';
    for (const [id, used] of [['diagnostics-method', true], ['diagnostics-path', tree || source || method === 'inspect_instance'], ['diagnostics-query', tree || method === 'script_search' || method === 'script_grep'], ['diagnostics-datamodel', tree], ['diagnostics-limit', tree], ['diagnostics-depth', tree], ['diagnostics-type', tree], ['diagnostics-start', source], ['diagnostics-end', source]] as const) this.el<HTMLInputElement>(id).disabled = this.nativeObserverBusy || !used;
    const methods = this.el<HTMLSelectElement>('diagnostics-method');
    for (const option of Array.from(methods.options)) option.disabled = !this.nativeObservation || !nativeMethodAvailable(this.nativeObservation, option.value);
    let ready = false, message = '';
    try {
      if (!this.nativeInventoryReady) throw new Error('Observe current native tools and Studio choices before reading.');
      const request = prepareNativeRead(this.nativeObservation, this.nativeStudioId, this.value('diagnostics-method'), this.nativeInput()); this.text('diagnostics-preview', json(request)); ready = true; message = this.nativeObserverBusy ? 'A native request is in flight. The selected target may be changed; no second request is sent.' : 'Read-only request for exact studio_id ' + this.nativeStudioId + '. The adapter rechecks the current inventory.';
    } catch (error) { message = error instanceof Error ? error.message : String(error); this.text('diagnostics-preview', message); }
    this.text('diagnostics-validation', message); this.el<HTMLButtonElement>('diagnostics-read').disabled = this.stopped || !this.token || !ready || this.nativeObserverBusy;
  }
  private renderNativeObservation(observation: NativeObservation) {
    const metadata = observation.native.metadata;
    this.text('diagnostics-connection', 'Closed after this request');
    this.identity('diagnostics-provenance', [['Request', observation.method ? 'Explicit native read' : 'Capability inventory · no targeted read'], ['Exact Studio ID', observation.studio_id ?? 'No targeted read'], ['Method', observation.method ?? 'list_roblox_studios'], ['Evidence', this.nativeText(metadata.evidenceKind)], ['Observed', this.nativeText(metadata.observedAt)], ['Transport', this.nativeText(metadata.transport)], ['Server', this.nativeText(metadata.server)], ['Requests used / budget', metadata.requestsUsed + ' / ' + metadata.limits.maxRequests], ['Timeout / result bound', metadata.limits.timeoutMs + ' ms / ' + metadata.limits.resultBytes + ' bytes']]);
    this.text('diagnostics-metadata', this.nativeText(metadata, 24 * 1024));
    const tools = this.el('diagnostics-tools'); tools.replaceChildren();
    for (const tool of metadata.tools) {
      const row = this.make('tr'); row.append(this.make('td', tool.name), this.make('td', tool.allowed ? 'Read allowlisted' : 'Blocked'), this.make('td', this.nativeText(tool.blockedReason ?? (tool.name === 'list_roblox_studios' ? 'Inventory enumeration' : 'Policy accepted'), 512))); tools.append(row);
    }
    this.badge('diagnostics-status', metadata.evidenceKind === 'fixture' ? 'Fixture observation' : 'Native observation', metadata.evidenceKind === 'fixture' ? 'warning' : 'neutral');
  }
  private async observeNative() {
    if (this.stopped || !this.token || this.nativeObserverBusy) return;
    const requestEpoch = ++this.nativeRequestEpoch;
    this.clearNativeReceipt('Capability observation requested; no targeted read result.'); this.text('diagnostics-result-target', 'Capability inventory · no targeted read');
    this.nativeObserverBusy = true; this.nativeInventoryReady = false; this.text('diagnostics-request-status', 'Capability observation in flight'); this.text('diagnostics-connection', 'Connection lifecycle pending'); this.text('diagnostics-notice', 'Observing native tools and Studio choices. No targeted read is sent.'); this.renderNativeControls();
    const epoch = this.nativeViewEpoch;
    try {
      const observation = readNativeObservation(await this.api.nativeCapabilities(), true);
      if (this.stopped || requestEpoch !== this.nativeRequestEpoch) return;
      if (epoch !== this.nativeViewEpoch) { this.text('diagnostics-request-status', 'Previous capability observation completed · result discarded'); this.text('diagnostics-connection', 'Previous request reported closed'); return; }
      this.nativeObservation = observation; this.nativeInventoryReady = true; this.renderNativeObservation(observation);
      const picker = this.el<HTMLSelectElement>('diagnostics-studio'); picker.replaceChildren(); this.option(picker, '', 'Choose an exact native studio_id');
      for (const studio of observation.studios!) this.option(picker, studio.id, this.nativeText(studio.name, 512) + ' · ' + studio.id);
      if (this.nativeStudioId && !observation.studios!.some(studio => studio.id === this.nativeStudioId)) { this.nativeStudioId = ''; this.nativeViewEpoch++; this.text('diagnostics-output', 'The previous exact Studio ID is absent. Choose a target explicitly.'); }
      picker.value = this.nativeStudioId;
      this.text('diagnostics-request-status', 'Capability observation complete'); this.text('diagnostics-notice', observation.studios!.length ? observation.studios!.length + ' native Studio choices observed. Select an exact ID; each read opens and closes its own connection.' : 'No native Studio windows were reported. No target was selected.');
    } catch (error) { if (!this.stopped && requestEpoch === this.nativeRequestEpoch) this.nativeFailure(error, epoch, 'Capability observation'); }
    finally { if (requestEpoch === this.nativeRequestEpoch) { this.nativeObserverBusy = false; this.renderNativeControls(); } }
  }
  private nativeFailure(error: unknown, epoch: number, action: string, request?: NativeReadRequest) {
    this.text('diagnostics-request-status', action + ' failed'); this.text('diagnostics-connection', 'Connection closure not reported in this response');
    if (epoch !== this.nativeViewEpoch) { this.text('diagnostics-notice', 'Previous native request failed. Its response was discarded after the target changed.'); return; }
    const details = error instanceof StudioRequestError ? error.details : undefined;
    this.text('diagnostics-notice', this.nativeText(error instanceof Error ? error.message : String(error)));
    this.badge('diagnostics-status', details?.code === 'AUTH' ? 'Human control required' : 'Read unavailable', 'warning');
    if (details?.code === 'STUDIO_NOT_FOUND') { this.nativeInventoryReady = false; this.nativeStudioId = ''; this.nativeViewEpoch++; this.el<HTMLSelectElement>('diagnostics-studio').value = ''; this.text('diagnostics-output', 'Exact target was denied as stale. No other Studio was substituted.'); }
    else if (details?.code === 'STUDIO_TOOL_ERROR') {
      try {
        if (!request) throw new Error('Tool error has no explicit read request.');
        const observation = readNativeReceipt(details.payload, request, true), output = nativeResultText(observation.result, this.nativeSecrets());
        this.renderNativeObservation(observation); this.text('diagnostics-output', output);
      } catch { this.nativeInventoryReady = false; this.text('diagnostics-output', 'Native tool error contained no valid bounded text receipt for this exact request.'); }
    } else this.nativeInventoryReady = false;
  }
  private async readNative() {
    if (this.stopped || !this.token || !this.nativeInventoryReady || this.nativeObserverBusy) return;
    let request: NativeReadRequest; try { request = prepareNativeRead(this.nativeObservation, this.nativeStudioId, this.value('diagnostics-method'), this.nativeInput()); } catch (error) { this.text('diagnostics-notice', this.nativeText(String(error))); return; }
    const epoch = this.nativeViewEpoch, requestEpoch = ++this.nativeRequestEpoch; this.clearNativeReceipt('No read receipt yet.'); this.nativeObserverBusy = true; this.text('diagnostics-output', 'Waiting for a read receipt from ' + request.args.studio_id + '.'); this.text('diagnostics-result-target', request.args.studio_id + ' · ' + request.method); this.text('diagnostics-request-status', 'Read in flight · ' + request.args.studio_id); this.text('diagnostics-connection', 'Connection lifecycle pending'); this.renderNativeControls();
    try {
      const observation = readNativeReceipt(await this.api.nativeRead(request), request);
      if (this.stopped || requestEpoch !== this.nativeRequestEpoch) return;
      if (epoch !== this.nativeViewEpoch || this.nativeStudioId !== request.args.studio_id) { this.text('diagnostics-request-status', 'Previous read completed · result discarded'); this.text('diagnostics-connection', 'Previous request reported closed'); this.text('diagnostics-notice', 'Previous read finished for ' + request.args.studio_id + '. Its result was discarded because the selected target changed.'); return; }
      const output = nativeResultText(observation.result, this.nativeSecrets());
      this.renderNativeObservation(observation); this.text('diagnostics-output', output); this.text('diagnostics-request-status', 'Read complete · ' + request.args.studio_id); this.text('diagnostics-notice', 'Read receipt observed for ' + request.args.studio_id + '. Output is sanitized text; this is not a persistent connection.');
    } catch (error) { if (!this.stopped && requestEpoch === this.nativeRequestEpoch) this.nativeFailure(error, epoch, 'Native read', request); }
    finally { if (requestEpoch === this.nativeRequestEpoch) { this.nativeObserverBusy = false; this.renderNativeControls(); } }
  }

  private async getNativeToken() {
    if (!this.token || this.nativeBusy) return;
    const epoch = ++this.nativeSecretEpoch;
    this.nativeBusy = true; this.nativeToken = ''; this.text('native-token', ''); this.el('native-token-result').hidden = true; this.el<HTMLButtonElement>('native-copy-token').disabled = true; this.el<HTMLButtonElement>('native-get-token').disabled = true;
    try {
      const data = await this.api.agentToken();
      if (!/^[a-f0-9]{64}$/.test(data.token) || data.token === this.token || data.canReview !== false || data.expires !== 'daemon lifetime') throw new Error('Daemon did not return a distinct scoped agent token with human review disabled.');
      if (this.stopped || epoch !== this.nativeSecretEpoch) return;
      this.nativeToken = data.token; this.text('native-token', data.token); this.text('native-scopes', json(data.scopes));
      this.text('native-notice', 'Scoped agent token · expires at daemon shutdown · human review disabled.');
      this.el('native-token-result').hidden = false; this.el<HTMLButtonElement>('native-copy-token').disabled = false;
    } catch (error) { if (!this.stopped && epoch === this.nativeSecretEpoch) this.text('native-notice', error instanceof Error ? error.message : String(error)); }
    finally { this.nativeBusy = false; this.el<HTMLButtonElement>('native-get-token').disabled = !this.token; }
  }

  private async copy(value: string) {
    try { await navigator.clipboard.writeText(value); this.notice('Copied to clipboard.'); }
    catch { this.notice('Clipboard permission is unavailable. Select and copy the displayed text manually.', 'warning'); }
  }
}

/** Subscribe to trusted controller observations, not DOM labels or polling events. */
export function createWorkflowContextOptions(
  getToken: () => string,
  workbench: Pick<StudioWorkbench, 'historyProjectPath' | 'subscribeProjectChange'>,
  chat: Pick<CodexChat, 'workflowConversation' | 'subscribeWorkflowContextChange'> & Partial<Pick<CodexChat,'workflowModelSelection'>>,
  refresh: () => void,
): WorkflowPanelOptions {
  const signature = () => JSON.stringify([getToken(), workbench.historyProjectPath(), chat.workflowConversation(), chat.workflowModelSelection?.()??null]);
  return {
    getToken,
    getProjectPath: () => workbench.historyProjectPath() || null,
    getNativeConversation: () => chat.workflowConversation(),
    getModelSelection: () => chat.workflowModelSelection?.()??null,
    subscribeContextChange(invalidate) {
      let previous = signature(), active = true, refreshQueued = false;
      const changed = () => {
        const next = signature();
        if (next === previous) return;
        previous = next;
        invalidate();
        if (!refreshQueued) {
          refreshQueued = true;
          queueMicrotask(() => { refreshQueued = false; if (active) refresh(); });
        }
      };
      const removeProject = workbench.subscribeProjectChange(changed);
      const removeNative = chat.subscribeWorkflowContextChange(changed);
      return () => { active = false; removeProject(); removeNative(); };
    },
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let storage: Pick<Storage, 'getItem' | 'setItem'>;
  try { storage = window.sessionStorage; } catch { storage = { getItem: () => null, setItem: () => {} }; }
  const token = takeControlToken(window.location, window.history, storage);
  const workbench = new StudioWorkbench(document, new StudioApi(token), window.location.origin, token);
  const codexChat = new CodexChat(document, new CodexChatApi(token));
  const learningPanel = new LearningPanel(document, token); learningPanel.start();
  const historyPanel = new CodexHistoryPanel(document, { getToken: () => token, getProjectPath: () => workbench.historyProjectPath() }); historyPanel.start();
  let workflows: ReturnType<typeof startWorkflowPanel> | null = null;
  let workflowsStopped = false;
  const refreshWorkflowContext = () => { if (!workflowsStopped) void workflows?.resume(); };
  // Keep workflow loading optional so an older daemon's missing module cannot break chat.
  void import('./workflow-panel.js').then(module => {
    workflows = module.startWorkflowPanel(document, createWorkflowContextOptions(() => token, workbench, codexChat, refreshWorkflowContext));
    if (!workflowsStopped) return workflows.start();
  }).catch(() => { const mount = document.getElementById('workflow-panel'); if (mount) mount.textContent = 'Restart Arcane to load the workflow tools.'; });
  const dismissConnectionSecrets = () => workbench.dismissConnectionSecrets();
  let workspaceShell = startWorkspaceShell(document, dismissConnectionSecrets);
  window.addEventListener('pagehide', () => { workflowsStopped = true; workspaceShell.cleanup(); workbench.stop(); codexChat.stop(); learningPanel.stop(); historyPanel.stop();workflows?.stop(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { workflowsStopped = false; workspaceShell = startWorkspaceShell(document, dismissConnectionSecrets); workbench.resume(); codexChat.resume(); learningPanel.resume(); historyPanel.resume();void workflows?.resume(); } });
  void codexChat.start().catch(() => { const notice = document.getElementById('codex-notice'); if (notice) notice.textContent = 'Native conversation UI unavailable. Refresh recorded state before continuing.'; });
  void workbench.start().catch(error => { const notice = document.getElementById('notice'); if (notice) { notice.textContent = error instanceof Error ? error.message : String(error); notice.className = 'notice error'; } });
}


