import { startScriptEditorDrafts, type ScriptDraftTarget, type AppliedScriptDraft } from './script-editor-drafts.js';
import type { EditorDraft } from './editor-drafts.js';
import { EditorDraftStore, type EditorDraftBridge } from './editor-drafts.js';
import { startProjectMemory } from './project-memory.js';
import { startLearnedPreferences } from './learned-preferences.js';
import { startRuntimeRecovery } from './runtime-recovery.js';
import type { startWorkflowPanel, WorkflowPanelOptions } from './workflow-panel.js';
import { CodexHistoryPanel } from './codex-history.js';
import { LearningPanel } from './learning-panel.js';
/// <reference lib="dom" />
import { CodexChat, CodexChatApi, providerLogo, setProjectMemorySaver } from './codex-chat.js';
import { startWorkspaceShell, WORKSPACE_ASSET_ACTIVITY_EVENT, type WorkspaceAssetActivity } from './workspace-shell.js';
import { startProviderSetup } from './provider-setup.js';
import { startSetupChecklist, startStudioConnectionBanner } from './setup-checklist.js';
import { startStarterGallery } from './starter-gallery.js';
import { startWelcomeTour } from './welcome-tour.js';
import { ClaudeChat, linkChatProviders, setChatFeedbackHooks } from './claude-chat.js';
import { SharedConversations } from './shared-conversations.js';
import type { ChatQueueBridge } from '../../../packages/protocol/src/chat-queue.js';
import { startNativeHandoff } from './native-handoff.js';
import { codexContextWindow, startComposerChrome, startTaskUsageFooter, type ComposerChromeController } from './task-usage-ui.js';
import type { TaskUsageView } from './task-usage.js';
import { startDesktopVerification } from './desktop-verification.js';
import { ArtifactDownloads } from './asset-downloads.js';
import { AssetViewerPanel } from './asset-viewer.js';
import { AssetConversationSelection } from './asset-conversation-selection.js';
import { installAssetReviewSelection } from './asset-review.js';
import { AutomaticAssetPreviews } from './automatic-asset-previews.js';
import { startPlaytestPanel } from './playtest-panel.js';
import { startToolboxPolicy } from './toolbox-policy.js';
import { startPlaytestToggle } from './playtest-toggle.js';
import { StudioKeySettings, StudioPairing, trustedKeyAction } from './studio-key-settings.js';
import type { NativeStudioMetadata, NativeStudioInventoryItem } from '../../../packages/studio-adapter/src/session.js';
import type { NativeStudioReadMethod } from '../../../packages/studio-adapter/src/policy.js';
import type { AssetInput, AssetProbe } from '../../../packages/asset-pipeline/src/types.js';
import { decodeAssetJobError } from '../../../packages/asset-pipeline/src/failure-diagnostics.js';
import type { ConvertedGlbRequest } from '../../../packages/asset-pipeline/src/converted-glb.js';
import type { ConvertedGlbCreation } from '../../../packages/asset-pipeline/src/converted-glb-creation.js';
import type { AssetPreviewManifest as AssetManifest, AssetJobRecord, ConvertedAssetJobRecord } from '../../daemon/src/asset-service.js';
import type { WorkRun, WorkTask } from '../../../packages/storage/src/work-store.js';
import type { InstanceRef, Json, MutationReceipt, StudioCommand, StudioMethod, StudioRoot, StudioSession } from '../../../packages/protocol/src/studio.js';

// Runtime dependencies are deliberately browser-only; the shared protocol import
// is erased by TypeScript. Keep these literals checked against its types.
export const STUDIO_ROOTS = ['Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPlayer', 'Lighting'] as const satisfies readonly StudioRoot[];
export const BUILDER_METHODS = ['scene.children', 'scene.search', 'script.search', 'scene.inspect', 'selection.read', 'script.read', 'scene.create', 'scene.update', 'script.update', 'script.set_enabled'] as const satisfies readonly StudioMethod[];
const CREATE_CLASSES = ['Folder', 'Model', 'Part', 'Script', 'LocalScript', 'ModuleScript'];
const WRITABLE_PROPERTIES = ['Name', 'Size', 'Position', 'Color', 'Anchored', 'CanCollide', 'Transparency', 'Material'];
const MATERIALS = ['Plastic', 'SmoothPlastic', 'Metal', 'Wood', 'WoodPlanks', 'Concrete', 'Brick', 'Glass', 'Neon', 'Slate', 'Sand', 'Fabric'];
const TOKEN_KEY = 'arcane-lab-session';
const utf8 = (value: string) => new TextEncoder().encode(value).length;
const json = (value: unknown) => JSON.stringify(value, null, 2);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isMutation = (method: StudioMethod) => ['scene.create', 'scene.update', 'script.update', 'script.set_enabled', 'scene.restore'].includes(method);
export const inProgress = (command: StudioCommand) => command.state === 'queued' || command.state === 'dispatched' || command.state === 'needs_reconciliation';

export function readReference(value: unknown, session: StudioSession): InstanceRef {
  if (!record(value) || typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 256 || value.instanceId.includes('\0') || value.sessionId !== session.id || !session.allowedRoots.includes(value.root as StudioRoot) || typeof value.className !== 'string' || !value.className || !Array.isArray(value.pathSegments) || value.pathSegments.length > 64 || value.pathSegments.some(p => typeof p !== 'string' || p.length > 256)) {
    throw new Error('The returned reference is not valid for this exact session and its root grants.');
  }
  return { instanceId: value.instanceId, sessionId: session.id, root: value.root as StudioRoot, pathSegments: value.pathSegments as string[], className: value.className };
}
const sameRef = (a: InstanceRef, b: InstanceRef) => a.instanceId === b.instanceId && a.sessionId === b.sessionId && a.root === b.root;
export interface Baseline { ref: InstanceRef; commandId: string; properties?: Record<string, Json>; source?: string; enabled?: boolean }
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
    case 'scene.children': case 'scene.search': case 'script.search': {
      if (!session.allowedRoots.includes(input.root as StudioRoot)) throw new Error('Choose one of this session’s granted service roots.');
      const maximum = operation === 'script.search' ? 100 : 200;
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > maximum) throw new Error('Result limit must be an integer from 1 to ' + maximum + '.');
      args = { root: input.root, limit: input.limit };
      if (operation === 'script.search') {
        if (!input.query.length || utf8(input.query) > 256 || /[\x00-\x1f\x7f]/.test(input.query) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(input.query)) throw new Error('Enter a literal single-line query of at most 256 UTF-8 bytes.');
        args.query = input.query; args.caseSensitive = true;
      } else if (operation === 'scene.search') {
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
    case 'script.set_enabled': {
      const ref = needRef(), baseline = input.baseline;
      if (!['Script', 'LocalScript'].includes(ref.className)) throw new Error('Only Script and LocalScript have an execution state.');
      if (!baseline || !sameRef(baseline.ref, ref) || typeof baseline.source !== 'string' || typeof baseline.enabled !== 'boolean') throw new Error('Read this exact script and use its source/execution receipt as the baseline.');
      if (utf8(baseline.source) > 100 * 1024 || baseline.source.includes('\0')) throw new Error('The source baseline must be at most 100 KiB without NUL bytes.');
      if (!baseline.enabled && !baseline.source.trim()) throw new Error('An empty placeholder cannot be activated.');
      args = {ref: ref as unknown as Json, expectedSource:baseline.source, expectedEnabled:baseline.enabled, enabled:!baseline.enabled}; break;
    }
    default: throw new Error('Use the receipt restore flow.');
  }
  if (utf8(JSON.stringify(args)) > 256 * 1024) throw new Error('Command arguments exceed 256 KiB.');
  return { method: operation, args };
}

export function mutationReceipt(command: StudioCommand): MutationReceipt | null {
  if (command.state !== 'succeeded' || !record(command.result) || !record(command.result.mutation)) return null;
  const m = command.result.mutation;
  if (!['scene.create', 'scene.update', 'script.update', 'script.set_enabled'].includes(String(m.kind)) || m.kind !== command.method || !record(m.ref) || m.ref.sessionId !== command.sessionId || !record(m.after) || (m.before !== null && !record(m.before))) return null;
  if (m.kind === 'script.set_enabled' && (!record(m.before) || m.before.source !== command.args.expectedSource || m.after.source !== command.args.expectedSource || typeof m.before.enabled !== 'boolean' || typeof m.after.enabled !== 'boolean' || m.before.enabled !== command.args.expectedEnabled || m.after.enabled !== command.args.enabled)) return null;
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
  if (command.method === 'script.read' && typeof command.result.source === 'string') return { ref, commandId: command.id, source: command.result.source, ...(typeof command.result.enabled === 'boolean' ? {enabled:command.result.enabled} : {}) };
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

export const ASSET_CONVERSATION_BYTES = 524288;
export interface AssetConversation { provider: 'codex' | 'claude-code' | 'arcane'; threadId: string; sessionId: string | null }
export interface AssetConversationPage {
  projectId: string; projectPath: string; conversation: AssetConversation;
  jobs: AssetJobRecord[]; nextCursor: string | null; byteLimit: 524288;
  unavailable?:AssetHistoryUnavailable[];
}
export interface AssetHistoryUnavailable {jobId:string;name?:string;status:'missing'|'changed'|'conflict'|'unclassified'}
export interface AssetConversationStart {
  projectId: string; projectPath: string; conversation: AssetConversation;
  jobId: string; association: 'bound' | 'unknown'; retry: false; job: AssetJobRecord;
}
export interface StudioWorkbenchOptions {
  isSignedIn?: () => boolean;
  subscribeSignInChange?: (listener: () => void) => () => void;
  /** Production uses trusted observations from the existing chat controller. */
  getProjectPath?: () => string | null;
  getNativeConversation?: () => (AssetConversation & { projectPath?: string }) | null;
  subscribeContextChange?: (listener: () => void) => () => void;
  assetMode?: 'conversation' | 'standalone';
  allowUnscopedAssetStart?: boolean;
}
function assetFields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Invalid asset response fields.');
  return value;
}
const assetText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f]/.test(value);
const assetId = (value: unknown): value is string => assetText(value, 64) && /^[A-Za-z0-9_-]+$/.test(value);
const convertedId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/.test(value);
const convertedHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const convertedName = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}(?![\s\S])/.test(value) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:-|$)/i.test(value);
const convertedInteger = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high;
const conversionRequestFields = ['schemaVersion', 'fidelityPolicy', 'kind', 'jobId', 'parentJobId', 'parentManifestSha256', 'name',
  'sourceSha256', 'sourceBytes', 'importSha256', 'importBytes', 'sourceMapSha256', 'collision', 'renderResolution', 'renderSamples'] as const;
/** Browser wire data only. Node's source/worker/manifest validators remain authoritative. */
function convertedAssetData(input: unknown): Record<string, unknown> {
  let nodes = 0, bytes = 0;
  const charge = (count: number) => { bytes += count; if (bytes > ASSET_CONVERSATION_BYTES) throw new Error('Converted asset response exceeds its bound.'); };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 16) throw new Error('Invalid converted asset response structure.');
    if (value === null || typeof value === 'boolean') { charge(JSON.stringify(value).length); return value; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Invalid converted asset number.'); charge(JSON.stringify(value).length); return value === 0 ? 0 : value; }
    if (typeof value === 'string') {
      if (value.length > ASSET_CONVERSATION_BYTES || new TextDecoder().decode(new TextEncoder().encode(value)) !== value) throw new Error('Invalid converted asset text.');
      charge(utf8(JSON.stringify(value))); return value;
    }
    if (!value || typeof value !== 'object') throw new Error('Converted assets require plain data.');
    const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('Converted assets require plain data.');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string')) throw new Error('Invalid converted asset fields.');
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>; let entries = 0; charge(2);
    for (const key of keys) {
      if (typeof key !== 'string' || array && key === 'length') continue;
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || key.length > 64 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Converted asset fields must be own data.');
      if (entries) charge(1); if (!array) charge(utf8(JSON.stringify(key)) + 1);
      out[key] = copy(descriptor.value as unknown, depth + 1); entries++;
    }
    if (!array) return out;
    const length = descriptors.length;
    if (!length || !Object.hasOwn(length, 'value') || !convertedInteger(length.value, 0, 4096) || length.value !== entries ||
        Object.keys(out).some(key => !/^(0|[1-9][0-9]*)(?![\s\S])/.test(key) || Number(key) >= length.value)) throw new Error('Converted asset arrays must be bounded and dense.');
    return Array.from({ length: length.value as number }, (_, at) => out[String(at)]);
  };
  const result = copy(input, 0); if (!record(result)) throw new Error('Invalid converted asset record.'); return result;
}
function readConvertedRequest(value: unknown): ConvertedGlbRequest {
  const r = assetFields(value, conversionRequestFields);
  if (r.schemaVersion !== 2 || r.fidelityPolicy !== 'arcane-static-fidelity-v1' || r.kind !== 'converted-glb' ||
      !convertedId(r.jobId) || !convertedId(r.parentJobId) || r.jobId === r.parentJobId || !convertedHash(r.parentManifestSha256) || !convertedName(r.name) ||
      !convertedHash(r.sourceSha256) || !convertedInteger(r.sourceBytes, 20, 64 * 1024 * 1024) || !convertedHash(r.importSha256) ||
      !convertedInteger(r.importBytes, 20, 64 * 1024 * 1024) || !convertedHash(r.sourceMapSha256) ||
      (r.collision !== 'none' && r.collision !== 'convex-hull') || !convertedInteger(r.renderResolution, 128, 1024) || !convertedInteger(r.renderSamples, 1, 64)) throw new Error('Invalid prepared converted asset request.');
  return Object.freeze(r) as unknown as ConvertedGlbRequest;
}
function readConvertedCreation(value: unknown): ConvertedGlbCreation {
  const r = assetFields(value, ['schemaVersion', 'kind', 'jobId', 'parentJobId', 'parentManifestSha256', 'name', 'collision', 'renderResolution', 'renderSamples']);
  if (r.schemaVersion !== 1 || r.kind !== 'arcane-glb-conversion-creation' || !convertedId(r.jobId) || !convertedId(r.parentJobId) || r.jobId === r.parentJobId ||
      !convertedHash(r.parentManifestSha256) || !convertedName(r.name) || (r.collision !== 'none' && r.collision !== 'convex-hull') ||
      !convertedInteger(r.renderResolution, 128, 1024) || !convertedInteger(r.renderSamples, 1, 64) || utf8(JSON.stringify(r)) > 1024) throw new Error('Invalid converted asset creation.');
  return Object.freeze(r) as unknown as ConvertedGlbCreation;
}
function readConvertedAssetJob(value: unknown): ConvertedAssetJobRecord {
  const r = assetFields(convertedAssetData(value), ['schemaVersion', 'kind', 'form', 'jobId', 'directory', 'manifestPath', 'request', 'state', 'stage', 'startedAt', 'updatedAt', 'events', 'manifestAvailable', 'error'], ['creation', 'finishedAt', 'resolution', 'retention', 'reportId']);
  const states = ['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'];
  const time = (v: unknown) => assetText(v, 64) && Number.isFinite(Date.parse(v));
  if (r.schemaVersion !== 1 || r.kind !== 'converted-glb' || !convertedId(r.jobId) || !assetText(r.directory, 4096) ||
      !(r.manifestPath === null || assetText(r.manifestPath, 4096)) || typeof r.state !== 'string' || !states.includes(r.state) ||
      !assetText(r.stage, 256) || !time(r.startedAt) || !time(r.updatedAt) || Object.hasOwn(r, 'finishedAt') && !time(r.finishedAt) ||
      typeof r.manifestAvailable !== 'boolean' || !Array.isArray(r.events) || r.events.length > 64) throw new Error('Invalid recorded converted asset job.');
  const hasCreation = Object.hasOwn(r, 'creation'), creation = hasCreation ? readConvertedCreation(r.creation) : null;
  const request = r.request === null ? null : readConvertedRequest(r.request);
  const form = creation ? request ? 'new-prepared' : 'new-pending' : request ? 'legacy-prepared' : 'legacy-pending';
  if (r.form !== form || creation && creation.jobId !== r.jobId || request && request.jobId !== r.jobId ||
      request === null && (r.manifestAvailable || r.manifestPath !== null) || (r.manifestPath !== null) !== r.manifestAvailable ||
      r.manifestAvailable && r.state !== 'succeeded' || r.state === 'succeeded' && (request === null || r.error !== null)) throw new Error('Contradictory converted asset job metadata.');
  if (creation && request && ['parentJobId', 'parentManifestSha256', 'name', 'collision', 'renderResolution', 'renderSamples'].some(key => creation[key as keyof ConvertedGlbCreation] !== request[key as keyof ConvertedGlbRequest])) throw new Error('Converted asset creation and request disagree.');
  if (r.retention !== undefined) { const retained = assetFields(r.retention, ['status', 'archivedAt']); if (retained.status !== 'archived' || !time(retained.archivedAt) || r.state === 'running') throw new Error('Invalid converted asset retention.'); }
  if (r.resolution !== undefined) {
    const resolved = record(r.resolution) && r.resolution.status === 'resolved';
    const resolution = assetFields(r.resolution, resolved ? ['status', 'resolvedAt'] : ['status']);
    if (r.state !== 'interrupted' || !['resolved', 'invalid', 'uncertain'].includes(String(resolution.status)) || resolved && !time(resolution.resolvedAt)) throw new Error('Invalid converted asset worker status.');
  }
  if (r.retention !== undefined && r.state === 'interrupted' && (!record(r.resolution) || r.resolution.status !== 'resolved')) throw new Error('Archived converted asset worker closure is unresolved.');
  for (const event of r.events) { const e = assetFields(event, ['jobId', 'at', 'stage', 'state']); if (e.jobId !== r.jobId || !time(e.at) || !assetText(e.stage, 256) || typeof e.state !== 'string' || !states.includes(e.state)) throw new Error('Invalid converted asset event.'); }
  if (r.error !== null) r.error = decodeAssetJobError(r.error);
  if (r.reportId !== undefined && (!convertedId(r.reportId) || r.error === null)) throw new Error('Invalid converted asset report reference.');
  r.request = request; if (creation) r.creation = creation;
  return r as unknown as ConvertedAssetJobRecord;
}
export function assetJobName(job: AssetJobRecord): string {
  return job.kind === 'converted-glb' ? job.form === 'new-pending' || job.form === 'new-prepared' ? job.creation.name : job.request?.name ?? 'Legacy conversion' : job.request.name;
}
export function assetJobKind(job: AssetJobRecord): string { return job.kind === 'converted-glb' ? 'converted-glb' : job.request.template; }
export function assetManifestMatchesJob(manifest: AssetManifest, job: AssetJobRecord): boolean {
  if (manifest.jobId !== job.jobId) return false;
  const converted = 'origin' in manifest && manifest.origin === 'converted-glb';
  if (job.kind === 'converted-glb') {
    if (!converted || job.request === null) return false;
    const selectedRequest = job.request;
    try { const request = readConvertedRequest(convertedAssetData(manifest.request)); return conversionRequestFields.every(key => request[key] === selectedRequest[key]); } catch { return false; }
  }
  return !converted && 'template' in manifest.request && manifest.request.template === job.request.template && manifest.request.name === job.request.name;
}
function readAssetConversation(value: unknown): AssetConversation {
  const r = assetFields(value, ['provider', 'threadId', 'sessionId']);
  if (!['codex', 'claude-code', 'arcane'].includes(String(r.provider)) || !assetText(r.threadId, 256) || !(r.sessionId === null || assetText(r.sessionId, 256))) throw new Error('Invalid exact asset conversation.');
  return { provider: r.provider as AssetConversation['provider'], threadId: r.threadId, sessionId: r.sessionId };
}
export function readAssetJob(value: unknown): AssetJobRecord {
  if (record(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value), request = descriptors.request?.value as unknown;
    if (['kind', 'form', 'creation'].some(key => Object.hasOwn(descriptors, key)) || record(request) && Object.getOwnPropertyDescriptor(request, 'kind')?.value === 'converted-glb') return readConvertedAssetJob(value);
  }
  const r = assetFields(value, ['schemaVersion', 'jobId', 'directory', 'manifestPath', 'request', 'state', 'stage', 'startedAt', 'updatedAt', 'events', 'manifestAvailable', 'error'], ['finishedAt', 'resolution','retention']);
  const states = ['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'];
  const time = (v: unknown) => assetText(v, 64) && Number.isFinite(Date.parse(v));
  if(r.retention!==undefined){const retention=assetFields(r.retention,['status','archivedAt']);
    if(retention.status!=='archived'||!time(retention.archivedAt)||r.state==='running')throw new Error('Invalid retained asset classification.');}
  if (r.resolution !== undefined) {
    // Display-only worker-status check for an interrupted job; never success, artifacts or retry.
    const resolution = r.state === 'interrupted' && record(r.resolution) && r.resolution.status === 'resolved'
      ? assetFields(r.resolution, ['status', 'resolvedAt']) : assetFields(r.resolution, ['status']);
    if (r.state !== 'interrupted' || !['resolved', 'invalid', 'uncertain'].includes(String(resolution.status)) || (resolution.status === 'resolved' && !time(resolution.resolvedAt))) throw new Error('Invalid recorded worker status check.');
  }
  if (r.schemaVersion !== 1 || !assetId(r.jobId) || !assetText(r.directory, 4096) || !(r.manifestPath === null || assetText(r.manifestPath, 4096)) || !states.includes(String(r.state)) || !assetText(r.stage, 256) || !time(r.startedAt) || !time(r.updatedAt) || (r.finishedAt !== undefined && !time(r.finishedAt)) || typeof r.manifestAvailable !== 'boolean' || !Array.isArray(r.events) || r.events.length > 4096) throw new Error('Invalid recorded asset job.');
  if (record(r.request) && r.request.template === 'adopted-glb') {
    const request=assetFields(r.request,['schemaVersion','template','name','path','sourceSha256','sourceBytes']);
    if(request.schemaVersion!==1||typeof request.name!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(request.name)
      ||!assetText(request.path,4096)||!request.path.toLowerCase().endsWith('.glb')||/[\\:\x00-\x1f]/.test(request.path)
      ||request.path.split('/').some(s=>!s||s==='.'||s==='..')||typeof request.sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(request.sourceSha256)
      ||typeof request.sourceBytes!=='number'||!Number.isSafeInteger(request.sourceBytes)||request.sourceBytes<1||request.sourceBytes>64*1024*1024) throw new Error('Invalid adopted GLB request.');
  } else {
  const request = assetFields(r.request, ['schemaVersion', 'template', 'name', 'seed', 'sizeMeters', 'color', 'triangleBudget', 'renderResolution', 'renderSamples'], ['recipe', 'procedural']);
  if (request.schemaVersion !== 1 || !['hero-prop', 'environment-kit', 'custom-assembly', 'procedural'].includes(String(request.template))) throw new Error('Invalid recorded asset request.');
  const { schemaVersion: _schema, recipe, procedural, ...parameters } = request;
  if (request.template === 'procedural' ? !record(procedural) || recipe !== undefined : procedural !== undefined) throw new Error('Invalid recorded procedural asset.');
  if (request.template !== 'procedural') prepareAssetInput({ ...parameters, ...(request.template === 'custom-assembly' ? { template: 'hero-prop', sizeMeters: [1, 1, 1] } : {}) });
  if (request.template === 'custom-assembly' && (!Array.isArray(request.sizeMeters) || request.sizeMeters.length !== 3 || request.sizeMeters.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0.01 || value > 40))) throw new Error('Invalid recorded custom asset dimensions.');
  if (request.template === 'custom-assembly' ? !record(recipe) : recipe !== undefined && request.template !== 'procedural') throw new Error('Invalid recorded asset recipe.');
  }
  for (const event of r.events) {
    const e = assetFields(event, ['jobId', 'at', 'stage', 'state']);
    if (e.jobId !== r.jobId || !time(e.at) || !assetText(e.stage, 256) || !states.includes(String(e.state))) throw new Error('Invalid recorded asset event.');
  }
  if (r.error !== null) { const e = assetFields(r.error, ['code', 'message']); if (!assetText(e.code, 256) || !assetText(e.message, 16000)) throw new Error('Invalid recorded asset error.'); }
  return r as unknown as AssetJobRecord;
}
function assetEnvelope(value: unknown, keys: readonly string[],optional:readonly string[]=[]): Record<string, unknown> {
  const r = assetFields(value, keys,optional);
  if (utf8(JSON.stringify(r)) > ASSET_CONVERSATION_BYTES || typeof r.projectId !== 'string' || !/^[a-f0-9]{64}$/.test(r.projectId) || !assetText(r.projectPath, 4096)) throw new Error('Invalid bounded asset project envelope.');
  return r;
}
export function readAssetConversationPage(value: unknown, limit = 32): AssetConversationPage {
  const r = assetEnvelope(value, ['projectId', 'projectPath', 'conversation', 'jobs', 'nextCursor', 'byteLimit'],['unavailable']);
  if (!Number.isInteger(limit) || limit < 1 || limit > 64 || !Array.isArray(r.jobs) || r.jobs.length > limit || r.byteLimit !== ASSET_CONVERSATION_BYTES || !(r.nextCursor === null || assetText(r.nextCursor, 1024))) throw new Error('Invalid bounded asset history page.');
  const jobs = r.jobs.map(readAssetJob);
  const unavailable=readUnavailableHistory(r.unavailable,jobs,limit);
  return { ...r, conversation: readAssetConversation(r.conversation), jobs,...(unavailable.length?{unavailable}:{}) } as AssetConversationPage;
}
function readUnavailableHistory(value:unknown,jobs:AssetJobRecord[],limit:number):AssetHistoryUnavailable[]{
  const rows:AssetHistoryUnavailable[]=[],ids=new Set(jobs.map(job=>job.jobId));
  if(ids.size!==jobs.length)throw new Error('Duplicate asset jobs in history page.');
  if(value===undefined)return rows;
  if(!Array.isArray(value)||jobs.length+value.length>limit)throw new Error('Retained history exceeds its page bound.');
  for(const raw of value){const item=assetFields(raw,['jobId','status'],['name']);
    if(!workerJobId(item.jobId)||ids.has(item.jobId)||!['missing','changed','conflict','unclassified'].includes(String(item.status))||
      item.name!==undefined&&(typeof item.name!=='string'||!/^[a-z][a-z0-9-]{0,47}(?![\s\S])/.test(item.name)))throw new Error('Invalid unavailable asset history.');
    ids.add(item.jobId);rows.push({...item} as unknown as AssetHistoryUnavailable);
  }return rows;
}
export function readAssetConversationStart(value: unknown): AssetConversationStart {
  const r = assetEnvelope(value, ['projectId', 'projectPath', 'conversation', 'jobId', 'association', 'retry', 'job']);
  const job = readAssetJob(r.job);
  if (!assetId(r.jobId) || r.jobId !== job.jobId || !['bound', 'unknown'].includes(String(r.association)) || r.retry !== false) throw new Error('Invalid asset start receipt; do not retry.');
  return { ...r, conversation: readAssetConversation(r.conversation), job } as AssetConversationStart;
}
export interface AssetContextTicket { epoch: number; projectPath: string; conversation: AssetConversation | null; global: boolean }
/** Response identity is evidence to compare, never a replacement for the live chat. */
export class AssetConversationController {
  private epoch = 0;
  private signature = '';
  private projectId: string | null = null;
  private path = '';
  private native: AssetConversation | null = null;
  private global: boolean;
  private readonly uncertain: { projectPath: string; conversation: AssetConversation | null; jobId: string | null; job: AssetJobRecord | null; message: string }[] = [];
  constructor(private readonly options: StudioWorkbenchOptions = {}) { this.global = options.assetMode === 'standalone'; this.sync(); }
  sync(): boolean {
    const path = this.options.getProjectPath?.() ?? '', observed = this.options.getNativeConversation?.() ?? null;
    let native: AssetConversation | null = null;
    try { if (assetText(path, 4096) && observed?.projectPath === path) native = readAssetConversation({ provider: observed.provider, threadId: observed.threadId, sessionId: observed.sessionId }); } catch { /* Missing or mismatched trusted context cannot grant same-chat access. */ }
    const signature = JSON.stringify([path, native]);
    if (signature === this.signature) return false;
    this.signature = signature; this.path = path; this.native = native; this.projectId = null; this.epoch++;
    return true;
  }
  invalidate(): void { this.epoch++; this.projectId = null; }
  setGlobal(global: boolean): boolean { if (global === this.global) return false; this.global = global; this.invalidate(); return true; }
  capture(): AssetContextTicket { this.sync(); return { epoch: this.epoch, projectPath: this.path, conversation: this.native ? { ...this.native } : null, global: this.global }; }
  current(ticket: AssetContextTicket): boolean { this.sync(); return ticket.epoch === this.epoch && ticket.projectPath === this.path && ticket.global === this.global && JSON.stringify(ticket.conversation) === JSON.stringify(this.native); }
  matches(ticket: AssetContextTicket, receipt: Pick<AssetConversationPage, 'projectId' | 'projectPath' | 'conversation'>): boolean {
    if (!this.current(ticket) || ticket.global || !ticket.conversation || receipt.projectPath !== ticket.projectPath || JSON.stringify(receipt.conversation) !== JSON.stringify(ticket.conversation) || (this.projectId !== null && receipt.projectId !== this.projectId)) return false;
    this.projectId = receipt.projectId; return true;
  }
  ready(): boolean { const ticket = this.capture(); return ticket.global || Boolean(ticket.projectPath && ticket.conversation); }
  canStart(): boolean { const ticket = this.capture(); return this.ready() && (!ticket.global || this.options.assetMode === 'standalone' || this.options.allowUnscopedAssetStart === true); }
  retainUnknown(ticket: AssetContextTicket, value: unknown, message: string): void {
    let receipt: AssetConversationStart | null = null;
    try { receipt = readAssetConversationStart(value); } catch { /* Preserve a safe known ID even when the remaining receipt cannot be trusted. */ }
    const id = receipt?.jobId ?? (record(value) && assetId(value.jobId) ? value.jobId : record(value) && record(value.job) && assetId(value.job.jobId) ? value.job.jobId : null);
    if (id && this.uncertain.some(item => item.projectPath === ticket.projectPath && item.jobId === id)) return;
    this.uncertain.push({ projectPath: ticket.projectPath, conversation: ticket.conversation, jobId: id, job: receipt?.projectPath === ticket.projectPath ? receipt.job : null, message });
  }
  unknownDetails(): readonly { jobId: string | null; job: AssetJobRecord | null; message: string }[] {
    const ticket = this.capture();
    return this.uncertain.filter(item => item.projectPath === ticket.projectPath && (ticket.global || JSON.stringify(item.conversation) === JSON.stringify(ticket.conversation)));
  }
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
async function boundedNativeJson(response: Response, label = 'Native'): Promise<unknown> {
  const chunks: Uint8Array[] = []; let length = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new StudioRequestError(label + ' response has no readable JSON body.', 'unavailable');
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > NATIVE_HTTP_RESULT_BYTES) { await reader.cancel(); throw new StudioRequestError(label + ' response exceeded 512 KiB.', 'unavailable'); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; } catch { throw new StudioRequestError(label + ' endpoint returned unreadable UTF-8 JSON.', 'unavailable'); }
}

export class StudioRequestError extends Error {
  constructor(message: string, readonly outcome: 'rejected' | 'unknown' | 'unavailable', readonly details?: { code: string; status: number; payload: unknown }) { super(message); }
}
export interface AssetWorkerStatus {
  jobId:string;status:'resolved';resolvedAt:string;evidence:('closed-exit-observed'|'closed-not-started'|'pid-absent'|'pid-reused')[];alreadyResolved:boolean;
}
const workerJobId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export function readAssetWorkerStatus(value:unknown,jobId:string):AssetWorkerStatus{
  const envelope=assetFields(value,['resolution']);
  const result=assetFields(envelope.resolution,['jobId','status','resolvedAt','evidence','alreadyResolved']);
  if(utf8(JSON.stringify(value))>8192||!workerJobId(jobId)||result.jobId!==jobId||result.status!=='resolved'||
      !assetText(result.resolvedAt,64)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(result.resolvedAt)||!Number.isFinite(Date.parse(result.resolvedAt))||
      new Date(result.resolvedAt).toISOString()!==result.resolvedAt.slice(0,23)+'Z'||typeof result.alreadyResolved!=='boolean'||
      !Array.isArray(result.evidence)||result.evidence.length<1||result.evidence.length>6||
      result.evidence.some(value=>!['closed-exit-observed','closed-not-started','pid-absent','pid-reused'].includes(value)))
    throw new Error('Invalid worker status receipt.');
  return structuredClone(result) as unknown as AssetWorkerStatus;
}
export const ASSET_HISTORY_REASONS=Object.freeze(['ledger-invalid','ledger-changed','scan-limit','directory-invalid','duplicate-job','active-limit','archived-evidence','commit-uncertain'] as const);
export type AssetHistoryReason=typeof ASSET_HISTORY_REASONS[number];
export interface AssetHistoryHealth {degraded:boolean;reasons:AssetHistoryReason[];active:number;archived:number;unclassified:number;unavailable:number}
export interface AssetHistoryChange {active:number;archived:number;unavailable:number;degraded:boolean;backup:string|null}
const boundedCount=(value:unknown,max:number)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=max;
/** Exact bounded history health. Degraded is consistent with its reasons; nothing is inferred as healthy. */
export function readAssetHistoryHealth(value:unknown):AssetHistoryHealth{
  const envelope=assetFields(value,['history']),r=assetFields(envelope.history,['degraded','reasons','active','archived','unclassified','unavailable']);
  if(utf8(JSON.stringify(value))>4096||typeof r.degraded!=='boolean'||!Array.isArray(r.reasons)||r.reasons.length>ASSET_HISTORY_REASONS.length||
    r.reasons.some(reason=>!ASSET_HISTORY_REASONS.includes(reason as AssetHistoryReason))||new Set(r.reasons).size!==r.reasons.length||r.degraded!==(r.reasons.length>0||Number(r.unavailable)>0||Number(r.unclassified)>0)||
    !boundedCount(r.active,4416)||!boundedCount(r.archived,4096)||!boundedCount(r.unclassified,4416)||!boundedCount(r.unavailable,256))
    throw new Error('Invalid retained history health.');
  return structuredClone(r) as unknown as AssetHistoryHealth;
}
/** Exact rebuild/confirm receipt. A backup is only an owned basename, never a path. */
export function readAssetHistoryChange(value:unknown,key:'rebuilt'|'confirmed'):AssetHistoryChange{
  const envelope=assetFields(value,[key]),r=assetFields(envelope[key],['active','archived','unavailable','degraded','backup']);
  if(utf8(JSON.stringify(value))>4096||!boundedCount(r.active,256)||!boundedCount(r.archived,4096)||!boundedCount(r.unavailable,256)||typeof r.degraded!=='boolean'||
    !(r.backup===null||typeof r.backup==='string'&&/^archive-ledger\.backup-[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin(?![\s\S])/.test(r.backup)))
    throw new Error('Invalid retained history change receipt.');
  return structuredClone(r) as unknown as AssetHistoryChange;
}
const HISTORY_REASON_TEXT:Record<AssetHistoryReason,string>={
  'ledger-invalid':'The saved history index could not be read.','ledger-changed':'The saved history index changed outside Arcane.',
  'scan-limit':'There are more entries than can be checked at once.','directory-invalid':'Some job folders have unexpected names or links.',
  'duplicate-job':'A job appears in more than one folder.','active-limit':'More than 256 jobs are active.',
  'archived-evidence':'Some archived jobs changed or are missing.','commit-uncertain':'The last history change was not confirmed.'};
export interface AssetHistoryRestore {jobId:string;swappedOut:string|null;activeAfter:number}
export function readAssetHistoryRestore(value:unknown,jobId:string):AssetHistoryRestore{
  const envelope=assetFields(value,['restored']),r=assetFields(envelope.restored,['jobId','swappedOut','activeAfter']);
  if(utf8(JSON.stringify(value))>4096||!workerJobId(jobId)||r.jobId!==jobId||
    !(r.swappedOut===null||workerJobId(r.swappedOut)&&r.swappedOut!==jobId)||
    typeof r.activeAfter!=='number'||!Number.isSafeInteger(r.activeAfter)||r.activeAfter<1||r.activeAfter>256)
    throw new Error('Invalid history restoration receipt.');
  return structuredClone(r) as unknown as AssetHistoryRestore;
}
function workerStatusMessage(error:unknown):string{
  if(error instanceof StudioRequestError&&error.details?.code==='RECONCILIATION_UNVERIFIED'&&record(error.details.payload)){
    const reason=error.details.payload.reason;
    if(reason==='same-worker-running')return 'This job’s worker is still running. Wait for it to finish, then check again.';
    if(['reservation-unresolved','no-workers-recorded','records-invalid'].includes(String(reason)))return 'Arcane has no complete worker record for this job. Asset work remains paused; inspect the retained job details.';
    return 'The worker’s status could not be confirmed. Asset work remains paused.';
  }
  return error instanceof StudioRequestError&&error.outcome==='unknown'
    ?'The worker check’s outcome is unknown. Refresh the recorded job before checking again.'
    :'The worker status check could not finish. Refresh the recorded job and try again.';
}
export class StudioApi {
  constructor(private readonly token: string, private readonly transport: typeof fetch = fetch, private readonly deadline = 12000) {}
  async request<T>(path: string, input?: unknown, format: 'json' | 'preview' = 'json', deadline = this.deadline, signal?:AbortSignal): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new StudioRequestError('Open /studio with the launcher’s local control token. This tab has no valid token.', 'rejected');
    const nativeRoute = /^\/v1\/native\/(?:capabilities|read)$/.test(path);
    const conversationRoute = /^\/v1\/assets\/conversation-(?:jobs(?:\?[^#]*)?|start)$/.test(path);
    const workerRoute=path==='/v1/assets/resolve-interrupted';
    const historyRestoreRoute=path==='/v1/assets/restore-history';
    const historyStatusRoute=path==='/v1/assets/history-status',historyChangeRoute=path==='/v1/assets/rebuild-history'||path==='/v1/assets/confirm-history';
    const exactWorkRun=/^\/v1\/work\/runs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(path);
    if(exactWorkRun&&(input!==undefined||format!=='json'))throw new StudioRequestError('Recorded work lookup is read-only.','rejected');
    if (!(exactWorkRun || nativeRoute || conversationRoute || workerRoute || historyRestoreRoute || historyStatusRoute || historyChangeRoute || /^\/v1\/(?:studio\/(?:sessions|keys(?:\/(?:revoke|rotate))?|pairing|revoke|restore|commands(?:\/[a-zA-Z0-9_%.-]+)?)|product\/(?:state|mcp-token)|work\/(?:runs|ready|create|review)|assets\/(?:jobs|probe|start|cancel|manifest|preview))(?:\?[^#]*)?$/.test(path)) || new URL(path, 'http://127.0.0.1').pathname !== path.split('?')[0]) throw new StudioRequestError('Unsupported local control route.', 'rejected');
    if(workerRoute&&(!record(input)||Object.keys(input).length!==1||!workerJobId(input.jobId)||format!=='json'))throw new StudioRequestError('Choose one exact interrupted asset job.','rejected');
    if(historyRestoreRoute&&(!record(input)||Object.keys(input).length!==1||!workerJobId(input.jobId)||format!=='json'))throw new StudioRequestError('Choose one exact archived asset job.','rejected');
    if(historyStatusRoute&&(input!==undefined||format!=='json'))throw new StudioRequestError('History health is a read-only request.','rejected');
    if(historyChangeRoute&&(!record(input)||Reflect.ownKeys(input).length!==0||format!=='json'))throw new StudioRequestError('History changes take an exact empty request.','rejected');
    if (conversationRoute) {
      const route = new URL(path, 'http://127.0.0.1'), query = route.searchParams;
      const listing = route.pathname.endsWith('/conversation-jobs');
      if (format !== 'json' || (listing ? input !== undefined : input === undefined) || [...query.keys()].some(key => !['limit', 'after'].includes(key) || query.getAll(key).length !== 1) || (query.has('limit') && (!/^(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(query.get('limit')!))) || (query.has('after') && !assetText(query.get('after'), 1024))) throw new StudioRequestError('Unsupported local asset conversation request.', 'rejected');
      if (!listing) input = prepareAssetInput(input);
    }
    if(signal?.aborted)throw new StudioRequestError('The local request was cancelled before dispatch.','rejected');
    const post = input !== undefined, controller = new AbortController(),abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
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
      try { data = nativeRoute || conversationRoute || workerRoute || historyRestoreRoute || historyStatusRoute || historyChangeRoute || /^\/v1\/assets\/jobs\?limit=/.test(path) ? await boundedNativeJson(response, nativeRoute ? 'Native' : workerRoute?'Worker status':'Asset history') : await response.json(); } catch (error) { if (nativeRoute && error instanceof StudioRequestError) throw error; throw new StudioRequestError(error instanceof Error ? error.message : 'The daemon returned an unreadable response (HTTP ' + response.status + ').', post && response.status < 400 || response.status >= 500 && post ? 'unknown' : 'unavailable'); }
      if (!response.ok) {
        const detail = record(data) && typeof data.message === 'string' ? data.message : 'Local request failed.';
        const code = record(data) && typeof data.error === 'string' ? data.error + ': ' : '';
        throw new StudioRequestError(code + detail + ' (HTTP ' + response.status + ')', post ? response.status >= 500 ? 'unknown' : 'rejected' : 'unavailable', { code: record(data) && typeof data.error === 'string' ? data.error : '', status: response.status, payload: data });
      }
      return data as T;
    } catch (error) {
      if (error instanceof StudioRequestError) throw error;
      throw new StudioRequestError(controller.signal.aborted ? 'The local request timed out.' : error instanceof Error ? error.message : 'The local request could not be completed.', post ? 'unknown' : 'unavailable');
    } finally { clearTimeout(timer);signal?.removeEventListener('abort',abort); }
  }
  async assetWorkerStatus(jobId:string,signal?:AbortSignal):Promise<AssetWorkerStatus>{
    if(!workerJobId(jobId))throw new StudioRequestError('Choose one exact interrupted asset job.','rejected');
    const value=await this.request('/v1/assets/resolve-interrupted',{jobId},'json',30000,signal);
    try{return readAssetWorkerStatus(value,jobId);}
    catch{throw new StudioRequestError('The worker status receipt could not be confirmed.','unknown');}
  }
  async assetHistoryHealth(signal?:AbortSignal):Promise<AssetHistoryHealth>{
    const value=await this.request('/v1/assets/history-status',undefined,'json',15000,signal);
    try{return readAssetHistoryHealth(value);}catch{throw new StudioRequestError('History health could not be read.','unavailable');}
  }
  /** One explicit change. A lost, malformed or oversized receipt is unknown and never replayed here. */
  async assetChangeHistory(kind:'rebuild'|'confirm',signal?:AbortSignal):Promise<AssetHistoryChange>{
    const value=await this.request(kind==='rebuild'?'/v1/assets/rebuild-history':'/v1/assets/confirm-history',{},'json',60000,signal);
    try{return readAssetHistoryChange(value,kind==='rebuild'?'rebuilt':'confirmed');}catch{throw new StudioRequestError('The history change receipt could not be confirmed.','unknown');}
  }
  async assetRestoreHistory(jobId:string,signal?:AbortSignal):Promise<AssetHistoryRestore>{
    if(!workerJobId(jobId))throw new StudioRequestError('Choose one exact archived asset job.','rejected');
    const value=await this.request('/v1/assets/restore-history',{jobId},'json',30000,signal);
    try{return readAssetHistoryRestore(value,jobId);}catch{throw new StudioRequestError('The history restoration receipt could not be confirmed.','unknown');}
  }
  nativeCapabilities() { return this.request<NativeObservation>('/v1/native/capabilities', undefined, 'json', 45000); }
  nativeRead(input: NativeReadRequest) { return this.request<NativeObservation>('/v1/native/read', input, 'json', 45000); }
  keys() { return this.request<{ keys: StudioKeyRecord[] }>('/v1/studio/keys'); }
  issueKey(input: { allowedRoots: StudioRoot[]; allowWrites: boolean }) { return this.request<IssuedStudioKey>('/v1/studio/keys', input); }
  rotateKey() { return this.request<IssuedStudioKey>('/v1/studio/keys/rotate', {}); }
  revokeKey(keyId: string) { return this.request<{ revoked: true }>('/v1/studio/keys/revoke', { keyId }); }
  agentToken() { return this.request<{ token: string; scopes: unknown; canReview: false; expires: string }>('/v1/product/mcp-token', {}); }
  assetJobs() { return this.request<{ jobs: AssetJobRecord[] }>('/v1/assets/jobs'); }
  async assetGlobalJobs(limit = 32, after?: string): Promise<{ jobs: AssetJobRecord[]; nextCursor: string | null;unavailable?:AssetHistoryUnavailable[] }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64 || (after !== undefined && !assetText(after, 1024))) throw new StudioRequestError('Invalid global asset page request.', 'rejected');
    const value = await this.request<unknown>('/v1/assets/jobs?limit=' + limit + (after === undefined ? '' : '&after=' + encodeURIComponent(after)));
    const r = assetFields(value, ['schemaVersion', 'jobs', 'total', 'nextCursor', 'byteLimit'],['unavailable']);
    if (utf8(JSON.stringify(r)) > ASSET_CONVERSATION_BYTES || r.schemaVersion !== 1 || r.byteLimit !== ASSET_CONVERSATION_BYTES || !Array.isArray(r.jobs) || r.jobs.length > limit || typeof r.total !== 'number' || !Number.isSafeInteger(r.total) || r.total < r.jobs.length || !(r.nextCursor === null || assetText(r.nextCursor, 1024))) throw new Error('Invalid bounded global asset page.');
    const jobs = r.jobs.map(readAssetJob);
    const unavailable=readUnavailableHistory(r.unavailable,jobs,limit);
    if((r.total as number)<jobs.length+unavailable.length||(r.total as number)>8768)throw new Error('Invalid retained history count.');
    return { jobs, nextCursor: r.nextCursor,...(unavailable.length?{unavailable}:{}) };
  }
  async assetConversationJobs(limit = 32, after?: string): Promise<AssetConversationPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64 || (after !== undefined && !assetText(after, 1024))) throw new StudioRequestError('Choose an asset page limit from 1 to 64 and a bounded opaque cursor.', 'rejected');
    return readAssetConversationPage(await this.request('/v1/assets/conversation-jobs?limit=' + limit + (after === undefined ? '' : '&after=' + encodeURIComponent(after))), limit);
  }
  async assetConversationStart(input: AssetInput): Promise<AssetConversationStart> {
    const value = await this.request<unknown>('/v1/assets/conversation-start', prepareAssetInput(input));
    try { return readAssetConversationStart(value); }
    catch { throw new StudioRequestError('Start receipt is invalid. Inspect global asset history; do not retry.', 'unknown', { code: 'ASSET_RECEIPT', status: 200, payload: value }); }
  }
  assetProbe() { return this.request<{ probe: AssetProbe }>('/v1/assets/probe', {}, 'json', 60000); }
  assetStart(input: AssetInput) { return this.request<{ job: AssetJobRecord }>('/v1/assets/start', input); }
  assetCancel(jobId: string) { return this.request<{ job: AssetJobRecord }>('/v1/assets/cancel', { jobId }); }
  assetManifest(jobId: string) { return this.request<{ manifest: AssetManifest }>('/v1/assets/manifest?jobId=' + encodeURIComponent(jobId)); }
  assetPreview(jobId: string, path: string) {
    if (!['preview-hero.png', 'preview-side.png'].includes(path)) throw new StudioRequestError('Choose a fixed manifest preview.', 'rejected');
    return this.request<Blob>('/v1/assets/preview?jobId=' + encodeURIComponent(jobId) + '&path=' + encodeURIComponent(path), undefined, 'preview');
  }
  runs() { return this.request<{ runs: WorkRun[] }>('/v1/work/runs'); }
  run(runId:string) {
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId))throw new StudioRequestError('Choose one recorded work run.','rejected');
    return this.request<{run:WorkRun}>('/v1/work/runs/'+encodeURIComponent(runId));
  }
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

interface ProductState { projectId?: string; projectPath: string; protocolVersion: 1; studioSessions: unknown; commandCounts: unknown; features: unknown; buildTasks: unknown }
interface PendingRequest { path: '/v1/studio/commands' | '/v1/studio/restore'; body: Record<string, unknown>; sessionId: string; requestId: string }
interface PropertyControl { checked: HTMLInputElement; inputs: (HTMLInputElement | HTMLSelectElement)[] }
const HELP: Record<string, string> = {
  'scene.children': 'Browse a granted service root, or enable browsing inside a returned instance. Paths are display-only.',
  'scene.search': 'Search names inside one granted root. The plugin bounds traversal and may truncate results.',
  'script.search': 'Find literal, case-sensitive text in current editor scripts inside one granted root. Matches have line/byte columns and excerpts. Read source again before editing; truncated results are incomplete.',
  'scene.inspect': 'Read allowlisted properties from the exact selected instance. Use the receipt to capture an edit baseline.',
  'selection.read': 'Read the current Studio selection within granted roots. No instance reference is required.',
  'script.read': 'Read current editor text through ScriptEditorService, including unsaved edits.',
  'scene.create': 'Create one supported instance inside the exact selected parent. Studio must be in edit mode.',
  'scene.update': 'Change checked properties only. The plugin compares every expected baseline value before writing.',
  'script.update': 'Replace editor source only if it still matches the exact captured baseline. Conflicts are refused.',
  'script.set_enabled': 'Toggle the execution state from an exact script-read baseline. Enabling requires trusted syntax verification and saved source.'
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
  private canonicalProjectId: string | null = null;
  private productMetadataEpoch = 0;
  /** True once the daemon has reported any Studio session (live or retained) for this project. */
  hasStudioSessions(): boolean { return this.sessions.length > 0; }

  getCurrentProduct(): Readonly<{ projectId: string; projectPath: string }> | null {
    return !this.stopped && this.canonicalProjectId
      ? Object.freeze({ projectId: this.canonicalProjectId, projectPath: this.canonicalProjectPath }) : null;
  }
  getPlaytestReportContext():Readonly<{projectId:string;projectEpoch:number}>|null {
    return !this.stopped&&this.canonicalProjectId?Object.freeze({projectId:this.canonicalProjectId,projectEpoch:this.productMetadataEpoch}):null;
  }
  historyProjectPath(): string { return this.canonicalProjectPath; }
  private readonly sourceDraftContexts = new Set<() => void>();
  private readonly sourceDraftApplied = new Set<(value: AppliedScriptDraft) => void>();
  private readonly sourceDraftRequests = new Map<string, {effect: AppliedScriptDraft; session: StudioSession}>();
  private sourceDraftKey(ref: InstanceRef): string {
    return JSON.stringify({sessionId: ref.sessionId, instanceId: ref.instanceId, root: ref.root, className: ref.className});
  }
  sourceDraftTarget(): ScriptDraftTarget | null {
    if (this.stopped) return null;
    const canRestore = this.online && this.historyReady && !this.busy && !this.pending;
    if (this.ref && this.sourceBaseline && sameRef(this.ref, this.sourceBaseline.ref) && typeof this.sourceBaseline.source === 'string') {
      const title = this.ref.root + ' / ' + this.ref.pathSegments.join(' / ');
      return {context: this.sourceDraftKey(this.ref), title: [...title].slice(0, 100).join(''), baseline: this.sourceBaseline.source, canRestore};
    }
    return {context: 'unassigned', title: 'Unassigned script draft', baseline: '', canRestore: canRestore && !this.ref};
  }
  restoreSourceDraft(value: EditorDraft): boolean {
    const target = this.sourceDraftTarget(), input = this.el<HTMLTextAreaElement>('source');
    if (value.kind !== 'script-source' || !target?.canRestore || target.context !== value.context || target.baseline !== value.baseline ||
        input.value !== target.baseline && input.value !== value.text) return false;
    input.value = value.text; this.el<HTMLSelectElement>('method').value = 'script.update'; this.renderForm(true); return true;
  }
  clearSourceDraft(value: EditorDraft): boolean {
    const target = this.sourceDraftTarget(), input = this.el<HTMLTextAreaElement>('source');
    if (!target || target.context !== value.context || target.baseline !== value.baseline || input.value !== value.text) return false;
    input.value = target.baseline; this.renderForm(true); return true;
  }
  subscribeSourceDraftContext(listener: () => void): () => void {
    this.sourceDraftContexts.add(listener); return () => {this.sourceDraftContexts.delete(listener);};
  }
  subscribeSourceDraftApplied(listener: (value: AppliedScriptDraft) => void): () => void {
    this.sourceDraftApplied.add(listener); return () => {this.sourceDraftApplied.delete(listener);};
  }
  private publishSourceDraftContext(): void {for (const listener of this.sourceDraftContexts) {try {listener();} catch {}}}
  private captureSourceDraftRequest(request: PendingRequest): void {
    if (this.sourceDraftRequests.has(request.requestId) || request.path !== '/v1/studio/commands' || !record(request.body) || request.body.method !== 'script.update' || !record(request.body.args)) return;
    const target = this.sourceDraftTarget(), session = this.active(), args = request.body.args;
    if (!target || !session || request.sessionId !== session.id || request.body.sessionId !== session.id || request.body.requestId !== request.requestId ||
        args.expectedSource !== target.baseline || args.source !== this.value('source') || typeof args.source !== 'string') return;
    try {
      const ref = readReference(args.ref, session); if (this.sourceDraftKey(ref) !== target.context) return;
      this.sourceDraftRequests.set(request.requestId, {session, effect: {context: target.context, baseline: target.baseline, text: args.source}});
      if (this.sourceDraftRequests.size > 64) this.sourceDraftRequests.delete(this.sourceDraftRequests.keys().next().value!);
    } catch { /* Only a source request bound to the active editor may settle its draft. */ }
  }
  private reconcileSourceDrafts(): void {
    for (const command of this.commands) {
      const captured = this.sourceDraftRequests.get(command.requestId); if (!captured) continue;
      if (['failed', 'cancelled', 'needs_reconciliation'].includes(command.state)) {this.sourceDraftRequests.delete(command.requestId); continue;}
      if (command.state !== 'succeeded') continue;
      this.sourceDraftRequests.delete(command.requestId);
      const {effect, session} = captured, mutation = mutationReceipt(command);
      if (command.method !== 'script.update' || command.sessionId !== session.id || command.clientSessionId !== session.clientSessionId ||
          !mutation || mutation.kind !== 'script.update' || mutation.before?.source !== effect.baseline || mutation.after.source !== effect.text ||
          command.args.expectedSource !== effect.baseline || command.args.source !== effect.text) continue;
      try {
        if (this.sourceDraftKey(readReference(command.args.ref, session)) !== effect.context || this.sourceDraftKey(readReference(mutation.ref, session)) !== effect.context) continue;
      } catch {continue;}
      for (const listener of this.sourceDraftApplied) {try {listener(Object.freeze({...effect}));} catch {}}
    }
  }

  private readonly projectListeners = new Set<() => void>();
  subscribeProjectChange(listener: () => void): () => void {
    this.projectListeners.add(listener);
    return () => { this.projectListeners.delete(listener); };
  }
  // Setup checklist signal: a reported, non-revoked Studio session with a recent heartbeat. Read-only; null before the first session read.
  private readonly studioListeners = new Set<() => void>();
  private studioLive: boolean | null = null;
  studioConnected(): boolean | null { return this.stopped ? null : this.studioLive; }
  subscribeStudioChange(listener: () => void): () => void {
    this.studioListeners.add(listener);
    return () => { this.studioListeners.delete(listener); };
  }
  // Plugin currency of the live Studio session(s), from the daemon's display-only report: null with no live session.
  private outdatedPluginSessions = new Set<string>();
  private studioPluginFresh: boolean | null = null;
  studioPluginCurrent(): boolean | null { return this.stopped ? null : this.studioPluginFresh; }
  private observePluginReport(value: unknown): void {
    const ids = (value as { outdatedSessionIds?: unknown } | null)?.outdatedSessionIds;
    this.outdatedPluginSessions = new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 1000) : []);
  }
  // The live session's place name (the chosen session, else the only live one); null with none or several. Display only.
  private studioPlace: string | null = null;
  studioPlaceName(): string | null { return this.stopped ? null : this.studioPlace; }
  private observeStudioSessions(): void {
    const liveSessions = this.sessions.filter(session => !session.revokedAt && Date.now() - Date.parse(session.lastSeenAt) <= 30000);
    const live = liveSessions.length > 0, fresh = live ? !liveSessions.some(session => this.outdatedPluginSessions.has(session.id)) : null;
    const placed = liveSessions.find(session => session.id === this.sessionId) ?? (liveSessions.length === 1 ? liveSessions[0] : undefined);
    const place = typeof placed?.name === 'string' ? placed.name.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim().slice(0, 100) || null : null;
    if (live === this.studioLive && fresh === this.studioPluginFresh && place === this.studioPlace) return;
    this.studioLive = live; this.studioPluginFresh = fresh; this.studioPlace = place;
    for (const listener of [...this.studioListeners]) { try { listener(); } catch { /* Observers cannot interrupt refresh. */ } }
  }
  private observeProjectPath(value: unknown, identity: unknown = null): void {
    const validPath = typeof value === 'string' && !!value.trim() && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
    const projectId = validPath && typeof identity === 'string' && identity.length === 64 && /^[a-f0-9]{64}$/.test(identity) ? identity : null;
    const path = validPath ? value : this.canonicalProjectPath;
    if (path === this.canonicalProjectPath && projectId === this.canonicalProjectId) return;
    this.productMetadataEpoch++;
    this.dismissConnectionSecrets(); this.studioKeys = [];
    this.canonicalProjectPath = path; this.canonicalProjectId = projectId;
    this.keySettings.setProject(projectId);
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
  private assetActivitySignature = '';
  private readonly automaticAssets = new AutomaticAssetPreviews();
  private assetCardsSignature = '';
  private assetCardsEpoch = 0;
  private assetCardsLimit = 8;
  private assetAvailable = false;
  private assetBusy = false;
  private assetWorkerCheck:AbortController|null=null;
  private assetHistoryChange:AbortController|null=null;
  private assetAcknowledgementBound=false;
  private assetHealthRead:AbortController|null=null;
  private assetHealth:AssetHistoryHealth|null=null;
  private assetHealthResult='';
  private assetHealthBound=false;
  private readonly assetHistoryMessages=new Map<string,string>();
  private readonly assetWorkerMessages=new Map<string,string>();
  private assetProbed = false;
  private assetUnknown = '';
  private assetReadAfterUnknown = false;
  private assetPreviewEpoch = 0;
  private assetReadEpoch = 0;
  private assetNextCursor: string | null = null;
  private assetUnavailable:AssetHistoryUnavailable[]=[];
  private readonly assetContext: AssetConversationController;
  private removeAssetContext: (() => void) | null = null;
  private removeAssetProject: (() => void) | null = null;
  private removeSignIn: (() => void) | null = null;
  private workRuns: WorkRun[] = [];
  private workNavigation=0;
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
  // Receipt recovery may outlive the writable target (including revocation).
  private historySessionId = '';
  private sessionSelectionEpoch = 0;
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
  private readonly assetViewer: AssetViewerPanel;
  private readonly keySettings: StudioKeySettings;
  constructor(private readonly doc: Document, private readonly api: StudioApi, private readonly origin: string, private readonly token: string, options: StudioWorkbenchOptions = {}) {
    this.keySettings = new StudioKeySettings(doc, origin);
    this.assetDownloads = new ArtifactDownloads(doc, token);
    this.assetViewer = new AssetViewerPanel(doc, token);
    this.assetContext = new AssetConversationController({ ...options, getProjectPath: options.getProjectPath ?? (() => this.historyProjectPath() || null) });
    this.assetOptions = options;
  }
  private readonly assetOptions: StudioWorkbenchOptions;
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
  private active() { return this.sessions.find(s => s.id === this.sessionId && !s.revokedAt); }
  private chosenCommand() { return this.commands.find(c => c.id === this.commandId); }
  private option(select: HTMLSelectElement, value: string, label: string) { const o = this.make('option', label); o.value = value; select.append(o); }
  private identity(id: string, entries: [string, string][]) { const list = this.el(id); list.replaceChildren(); for (const [key, value] of entries) list.append(this.make('dt', key), this.make('dd', value)); }
  private on(id: string, event: string, action: (event: Event) => void) { this.el(id).addEventListener(event, action); }

  async start(): Promise<void> {
    this.el<HTMLAnchorElement>('providers-link').href = this.token ? '/diagnostics#' + this.token : '/diagnostics';
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
    this.on('asset-form', 'submit', event => { event.preventDefault(); void this.startAsset(); });
    this.on('asset-form', 'input', () => this.renderAssetControls());
    this.on('asset-template', 'change', () => { this.el<HTMLInputElement>('asset-size').value = this.value('asset-template') === 'hero-prop' ? '1, 0.65, 0.7' : '3, 3, 2.8'; this.renderAssetControls(); });
    this.on('asset-probe', 'click', () => { void this.probeAsset(); });
    this.on('asset-job-picker', 'change', () => { this.selectAssetJob(this.value('asset-job-picker'), true); });
    this.on('asset-cancel', 'click', () => { void this.cancelAsset(); });
    this.on('asset-load-manifest', 'click', () => { void this.loadAssetManifest(); });
    this.on('asset-history-scope', 'change', () => {
      if (this.assetContext.setGlobal(this.value('asset-history-scope') === 'global')) { this.resetAssetContext(); void this.refreshAssets(); }
    });
    this.on('asset-history-more', 'click', () => { if (this.assetNextCursor) void this.refreshAssets(true); });
    this.subscribeAssetContext();
    this.on('asset-refresh', 'click', () => { void this.refresh(); });
    this.bindAssetAcknowledgement();
    this.renderAssetControls();
    this.on('work-create-form', 'submit', event => { event.preventDefault(); void this.createWork(); });
    this.on('work-add-task', 'click', () => this.addWorkTask());
    this.on('work-create-form', 'input', () => this.renderWorkControls());
    this.on('work-run-picker', 'change', () => {this.workNavigation++;this.renderWorkBoard();});
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
    this.on('key-form', 'submit', event => { const trusted = trustedKeyAction(event); event.preventDefault(); if (trusted) void this.issueStudioKey(); });
    for (const id of ['settings-key-generate', 'key-setup-generate']) {
      this.doc.getElementById(id)?.addEventListener('click', event => { if (trustedKeyAction(event)) void this.issueStudioKey(); });
    }
    this.subscribeSignIn();
    this.on('key-form', 'change', () => this.renderKeyControls());
    this.on('key-reveal', 'click', event => { if (!trustedKeyAction(event) || !this.issuedKey) return; this.keyRevealed = !this.keyRevealed; this.renderIssuedKey(); });
    this.on('key-copy', 'click', event => { if (trustedKeyAction(event) && this.issuedKey) void this.copy(this.issuedKey.apiKey); });
    this.on('key-dismiss', 'click', () => this.clearStudioKey());
    this.on('key-refresh', 'click', () => { void this.refresh(); });
    this.on('key-acknowledge', 'click', () => { if (!this.keyAvailable || !this.keyReadAfterUnknown || this.keyBusy) return; this.keyUnknown = ''; this.keyReadAfterUnknown = false; this.renderKeyControls(); });
    this.doc.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('a[href]')) this.clearStudioKey(); });
    this.doc.getElementById('settings-drawer')?.addEventListener('close', () => this.dismissConnectionSecrets());
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
  resume() { this.stopped = false; this.keySettings.resume(); this.subscribeAssetContext(); this.subscribeSignIn(); this.syncAssetContext(); this.renderNativeControls(); void this.refresh().finally(() => this.schedule()); }
  dismissConnectionSecrets(): void {
    this.clearStudioKey(); this.nativeSecretEpoch++; this.nativeToken = '';
    this.text('native-token', ''); this.text('native-scopes', '');
    this.el('native-token-result').hidden = true;
    this.el<HTMLButtonElement>('native-copy-token').disabled = true;
  }
  stop() {
    this.assetHistoryChange?.abort();this.assetHistoryChange=null;this.assetHealthRead?.abort();this.assetHealthRead=null;
    this.assetWorkerCheck?.abort();this.assetWorkerCheck=null;
    this.productMetadataEpoch++; this.observeProjectPath(null);
    this.removeAssetContext?.(); this.removeAssetContext = null; this.removeAssetProject?.(); this.removeAssetProject = null;
    this.removeSignIn?.(); this.removeSignIn = null;
    this.assetContext.invalidate(); this.resetAssetContext();
    this.nativeViewEpoch++; this.nativeRequestEpoch++; this.nativeObserverBusy = false;
    this.nativeInventoryReady = false; this.nativeObservation = null; this.nativeStudioId = '';
    const picker = this.el<HTMLSelectElement>('diagnostics-studio'); picker.replaceChildren(); this.option(picker, '', 'Observe Studio choices first');
    this.el('diagnostics-tools').replaceChildren(); this.clearNativeReceipt('Native view cleared after page exit. Observe capabilities again.');
    this.text('diagnostics-request-status', 'Previous request discarded after page exit'); this.text('diagnostics-connection', 'No current request receipt');
    this.dismissConnectionSecrets(); this.keySettings.stop(); this.assetDownloads.clear(); this.assetViewer.clear(); this.assetPreviewEpoch++; this.clearChatAssets(); this.automaticAssets.reset(); this.stopped = true;
    if (this.timer) clearTimeout(this.timer); this.renderNativeControls();
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => { if (!this.doc.hidden && this.checked('auto-refresh')) void this.refresh().finally(() => this.schedule()); else this.schedule(); }, Math.min(30000, 3000 * 2 ** Math.min(this.refreshFailures, 3)));
  }
  async refresh(): Promise<void> {
    if (this.stopped || this.refreshing || !this.token) return;
    this.refreshing = true; this.el<HTMLButtonElement>('refresh').disabled = true;
    const capturedSession = this.historySessionId, selectionEpoch = this.sessionSelectionEpoch;
    let productEpoch = this.productMetadataEpoch;
    let projectId = this.canonicalProjectId, projectPath = this.canonicalProjectPath;
    const current = () => !this.stopped && productEpoch === this.productMetadataEpoch && projectId === this.canonicalProjectId && projectPath === this.canonicalProjectPath;
    const historyCurrent = () => current() && selectionEpoch === this.sessionSelectionEpoch && capturedSession === this.historySessionId;
    const workRead = Promise.allSettled([this.refreshWork(), this.refreshAssets()]);
    const reads = await Promise.allSettled([this.api.sessions(), this.api.product(), ...(capturedSession ? [this.api.commands(capturedSession)] : [])]);
    try {
      if (!current()) return;
      // Project/chat metadata does not depend on Studio availability.
      const product = reads[1]!;
      if (!this.stopped && productEpoch === this.productMetadataEpoch) {
        if (product.status === 'fulfilled') this.renderProduct(product.value as ProductState);
        else this.observeProjectPath(null);
        projectId = this.canonicalProjectId; projectPath = this.canonicalProjectPath; productEpoch = this.productMetadataEpoch;
      }
      if (!this.stopped && productEpoch === this.productMetadataEpoch) await this.refreshStudioKeys();
      if (!current()) return;
      if (product.status === 'rejected') { this.text('product-evidence', 'Product state unavailable: ' + String(product.reason)); this.text('project-path', 'Product state unavailable'); this.text('command-counts', 'Unknown'); this.text('build-tasks', 'Build board unavailable: ' + String(product.reason)); }
      const sessionRead = reads[0]!;
      if (sessionRead.status === 'rejected') throw sessionRead.reason;
      const sessionData = sessionRead.value as { sessions: StudioSession[]; plugin?: unknown };
      if (!Array.isArray(sessionData.sessions)) throw new Error('The session endpoint returned an invalid payload.');
      this.sessions = sessionData.sessions; this.observePluginReport(sessionData.plugin ?? null);
      this.online = true;
      this.renderSessions(); this.observeStudioSessions();
      if (capturedSession && historyCurrent()) {
        const commandRead = reads[2]!;
        if (commandRead.status === 'rejected') throw commandRead.reason;
        const data = commandRead.value as { commands: StudioCommand[] };
        if (!Array.isArray(data.commands) || data.commands.some(c => c.sessionId !== capturedSession)) throw new Error('The history endpoint returned records for a different session.');
        // A bounded history read cannot settle an omitted in-flight command.
        this.commands = [...data.commands, ...this.commands.filter(c => inProgress(c) && !data.commands.some(next => next.id === c.id))];
        this.historyReady = true;
        // The selected receipt may have aged beyond the bounded history window.
        if (this.commandId && !data.commands.some(c => c.id === this.commandId)) {
          const receipt = await this.api.command(this.commandId);
          if (!historyCurrent()) return;
          if (receipt.command.sessionId === capturedSession) this.rememberCommand(receipt.command);
        }
        this.resolvePending();
        this.renderHistory(); this.renderReceipt();
      }
      this.refreshFailures = 0;
      this.badge('connection-status', product.status === 'rejected' ? 'Product status unavailable' : 'Daemon responding', product.status === 'rejected' ? 'warning' : 'good');
      this.text('last-refresh', new Date().toLocaleTimeString());
      if (this.el('notice').textContent?.startsWith('Checking') || this.el('notice').textContent?.startsWith('Refresh unavailable')) this.notice('Local daemon responding. Choose an exact session to work in Studio.');
    } catch (error) {
      if (!current() || selectionEpoch !== this.sessionSelectionEpoch) return;
      this.online = false; this.historyReady = false; this.refreshFailures++;
      this.badge('connection-status', 'Refresh unavailable', 'error');
      this.notice('Refresh unavailable: ' + (error instanceof Error ? error.message : String(error)) + ' Cached records may be stale. Command outcomes have not been inferred.', 'error');
    } finally {
      await workRead;
      this.refreshing = false;
      if (!this.stopped) { this.el<HTMLButtonElement>('refresh').disabled = false; this.renderControls(); this.renderKeyControls(); }
    }
  }

  private renderProduct(state: ProductState) {
    this.observeProjectPath(state.protocolVersion === 1 ? state.projectPath : null, state.projectId);
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
    const activeSessions = this.sessions.filter(session => !session.revokedAt);
    const picker = this.el<HTMLSelectElement>('session-picker'); picker.replaceChildren(); this.option(picker, '', 'Choose a session explicitly');
    for (const session of activeSessions) this.option(picker, session.id, session.name + ' · place ' + session.placeId + ' · ' + session.id + (session.allowWrites ? ' · writes' : ' · read-only'));
    this.text('session-count', String(activeSessions.length) + ' active');
    if (this.sessionId && !this.active()) {
      this.sessionId = ''; this.dismissConnectionSecrets(); this.setRef(null); this.renderReceipt();
      this.notice('The selected session is revoked or no longer reported. Choose a session explicitly; its recorded history is retained.', 'warning');
    }
    picker.value = this.sessionId;
    const session = this.active();
    if (!session) { this.badge('session-mode', 'No target'); this.text('session-summary', 'Connect the Arcane plugin with an API key, then choose its exact session.'); this.el('session-details').replaceChildren(); return; }
    this.badge('session-mode', session.allowWrites ? 'Writes granted' : 'Read-only', session.allowWrites ? 'warning' : 'good');
    const age = Date.now() - Date.parse(session.lastSeenAt), heartbeat = Number.isFinite(age) ? Math.max(0, Math.floor(age / 1000)) + 's ago' : 'Unknown';
    this.text('session-summary', session.name + ' · heartbeat ' + heartbeat + (age > 20000 ? ' · plugin may be disconnected' : ''));
    this.identity('session-details', [['Session', session.id], ['Client session', session.clientSessionId], ['Place / universe', session.placeId + ' / ' + session.universeId], ['Plugin', session.pluginVersion + ' · protocol ' + session.protocolVersion], ['Granted roots', session.allowedRoots.join(', ')], ['Last seen', session.lastSeenAt], ['Capabilities', session.capabilities.join(', ') || 'None reported']]);
    const root = this.el<HTMLSelectElement>('command-root'), previous = root.value; root.replaceChildren();
    for (const allowed of session.allowedRoots) this.option(root, allowed, allowed);
    if (session.allowedRoots.includes(previous as StudioRoot)) root.value = previous;
  }
  private clearTarget() {
    this.commands = []; this.commandId = ''; this.historyReady = false; this.setRef(null); this.renderHistory(); this.renderReceipt();
  }
  private selectSession(id: string) {
    if (this.busy || this.pending || !this.sessionId && this.commands.some(inProgress)) { this.el<HTMLSelectElement>('session-picker').value = this.sessionId; return; }
    this.clearStudioKey(); this.sessionId = this.sessions.find(session => session.id === id && !session.revokedAt)?.id ?? '';
    this.historySessionId = this.sessionId; this.sessionSelectionEpoch++;
    this.clearTarget(); this.renderSessions(); this.renderForm(true);
    this.notice(this.sessionId ? 'Exact session selected: ' + this.sessionId + '. Loading its command history…' : 'No Studio session selected.');
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
    const method = this.value('method'), browse = method === 'scene.children', search = method === 'scene.search' || method === 'script.search';
    this.el<HTMLInputElement>('limit').max = method === 'script.search' ? '100' : '200';
    this.el<HTMLInputElement>('query').maxLength = method === 'script.search' ? 256 : 100;
    for (const [id, visible] of [['root-field', browse || search], ['limit-field', browse || search], ['query-field', search], ['browse-parent-field', browse], ['ref-field', !search && method !== 'selection.read'], ['create-fields', method === 'scene.create'], ['properties-field', method === 'scene.create' && this.value('create-class') === 'Part' || method === 'scene.update'], ['source-fields', method === 'script.update']] as [string, boolean][]) this.el(id).hidden = !visible;
    this.el<HTMLInputElement>('query').required = search;
    this.el<HTMLInputElement>('limit').required = browse || search;
    this.el<HTMLInputElement>('create-name').required = method === 'scene.create';
    this.text('method-help', HELP[method] ?? 'Choose a supported operation.');
    this.text('properties-legend', method === 'scene.create' ? 'Optional Part properties' : 'Checked properties will be changed');
    this.text('property-baseline', this.propertyBaseline ? 'Baseline from inspect receipt ' + this.propertyBaseline.commandId + '. Current values must still match.' : method === 'scene.update' ? 'Inspect the target and use its receipt as a baseline before editing.' : 'Unchecked fields are omitted. The plugin validates all properties before creation.');
    this.text('source-baseline', this.sourceBaseline ? 'Editor baseline: receipt ' + this.sourceBaseline.commandId + ' · ' + utf8(this.sourceBaseline.source ?? '') + ' UTF-8 bytes.' + (this.sourceBaseline.enabled === undefined ? '' : this.sourceBaseline.enabled ? ' Enabled.' : ' Disabled.') : 'Read the editor source, then use its receipt as a baseline.');
    this.text('expected-source', this.sourceBaseline?.source ?? 'No baseline captured.');
    if (rebuildProperties) this.renderProperties();
    this.renderControls();
    this.publishSourceDraftContext();
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
    return { root: this.value('command-root'), limit: Number(this.value('limit')), query: this.value('query'), ref: this.ref, browseParent: this.checked('browse-parent'), className: this.value('create-class'), name: this.value('create-name'), properties, source: this.value('source'), baseline: ['script.update','script.set_enabled'].includes(this.value('method')) ? this.sourceBaseline : this.propertyBaseline };
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
    this.el<HTMLSelectElement>('session-picker').disabled = this.busy || Boolean(this.pending) || !this.sessionId && this.commands.some(inProgress);
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
    const project = this.canonicalProjectId, generation = this.productMetadataEpoch;
    try {
      const data = await this.api.keys();
      if (this.stopped || project !== this.canonicalProjectId || generation !== this.productMetadataEpoch) return;
      this.studioKeys = readStudioKeyRecords(data.keys); this.keyAvailable = true;
      this.keySettings.setRecords(this.studioKeys);
      if (this.keyUnknown) this.keyReadAfterUnknown = true;
      if (this.issuedKey && this.studioKeys.some(key => key.keyId === this.issuedKey!.keyId && key.revokedAt)) this.clearStudioKey();
      this.badge('key-status', 'Key service responding', 'good'); this.renderKeyHistory();
    } catch {
      if (this.stopped || project !== this.canonicalProjectId || generation !== this.productMetadataEpoch) return;
      this.keyAvailable = false; this.keyReadAfterUnknown = false;
      this.keySettings.metadataUnavailable();
      this.badge('key-status', 'Key service unavailable', 'warning');
      this.text('key-notice', 'Refresh key records from the local daemon before issuing or revoking an API key.');
    } finally { this.renderKeyControls(); }
  }
  private keyGrant() { return prepareStudioKeyGrant([...STUDIO_ROOTS], true); }
  private renderKeyControls() {
    const active = this.studioKeys.some(key => !key.revokedAt) || !!this.issuedKey;
    const ready = this.assetOptions.isSignedIn?.() ?? true;
    const disabled = !this.token || !this.keyAvailable || this.keyBusy || Boolean(this.keyUnknown) || !ready;
    for (const id of ['key-issue', 'settings-key-generate', 'key-setup-generate']) {
      const button = this.doc.getElementById(id) as HTMLButtonElement | null;
      if (button) { button.disabled = disabled; button.textContent = this.keyBusy ? 'Generating…' : active ? 'Regenerate API key' : 'Generate API key'; }
    }
    const setup = this.doc.getElementById('key-setup-gate');
    if (setup) setup.hidden = !ready || active;
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
  private clearStudioKey() { this.keySecretEpoch++; this.issuedKey = null; this.keyRevealed = false; this.keySettings.hide(); this.renderIssuedKey(); }
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
    if (!this.keyAvailable || this.keyBusy || this.keyUnknown || this.assetOptions.isSignedIn?.() === false) return;
    const grant = this.keyGrant();
    // Opening Settings dismisses connection secrets. Navigate before requesting
    // the key so the returned secret remains usable if desktop storage fails.
    const drawer = this.doc.getElementById('settings-drawer') as HTMLDialogElement | null;
    if (drawer && !drawer.open) this.doc.dispatchEvent(new CustomEvent('workspace:settingsrequest', { detail: { target: 'workspace-settings' } }));
    const epoch = ++this.keySecretEpoch; this.keyBusy = true; this.renderKeyControls(); this.text('key-notice', 'Issuing an Arcane API key…');
    try {
      const result = await this.api.rotateKey(), key = readIssuedStudioKey(result, this.origin, grant);
      if (!this.stopped && epoch === this.keySecretEpoch) {
        this.issuedKey = key; this.keyRevealed = true;
        await this.keySettings.rememberIssuedKey(key);
        this.renderIssuedKey();
        this.text('key-notice', 'API key generated. Previous keys no longer work.');
      }
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
      try { const result = await this.api.revokeKey(key.keyId); if (result.revoked !== true) throw new StudioRequestError('The key revocation result could not be confirmed.', 'unknown'); await this.keySettings.forget(key.keyId); this.text('key-notice', 'API key revoked: ' + key.keyId + '.'); }
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
    this.captureSourceDraftRequest(request);
    const wasUnknown = this.pending?.requestId === request.requestId;
    this.busy = true; this.notice('Submitting ' + request.requestId + ' to the daemon…'); this.renderControls();
    try {
      const response = await this.api.request<{ command: StudioCommand }>(request.path, request.body);
      if (!response.command || response.command.sessionId !== request.sessionId || response.command.requestId !== request.requestId) throw new StudioRequestError('The daemon response did not identify the exact submitted request.', 'unknown');
      this.pending = null;
      if (this.historySessionId === request.sessionId) { this.rememberCommand(response.command); this.commandId = response.command.id; this.renderHistory(); this.renderReceipt(); }
      this.notice('Command ' + response.command.id + ' recorded as ' + response.command.state + '. ' + STATE_EXPLANATIONS[response.command.state], response.command.state === 'succeeded' ? '' : 'warning');
    } catch (error) {
      if (error instanceof StudioRequestError && error.outcome === 'unknown') { this.pending = request; this.notice(error.message + ' Outcome unknown. The identical request is retained for explicit recovery.', 'warning'); }
      else if (wasUnknown) { this.pending = request; this.notice('The identical retry was rejected: ' + (error instanceof Error ? error.message : String(error)) + ' The original outcome remains unknown until a receipt is found.', 'warning'); }
      else { this.pending = null; this.error(error); }
    } finally { this.busy = false; this.renderReceipt(); this.renderControls(); }
  }
  private rememberCommand(command: StudioCommand) { this.commands = [command, ...this.commands.filter(c => c.id !== command.id)]; }
  private resolvePending() {
    if (!this.pending || this.pending.sessionId !== this.historySessionId) return;
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
    if (!commands.length) list.append(this.make('p', !this.historySessionId ? 'Select a session to load its history.' : !this.historyReady ? 'Loading exact session history…' : 'No commands match this filter. History is bounded to the latest 100 records.', 'empty'));
    for (const command of commands) {
      const button = this.make('button', undefined, 'history-item'); button.type = 'button'; button.setAttribute('aria-pressed', String(command.id === this.commandId)); button.append(this.make('span', command.method, 'history-title'), this.make('span', command.state.replaceAll('_', ' '), 'badge ' + stateTone(command.state)), this.make('span', new Date(command.createdAt).toLocaleString() + ' · ' + command.id, 'history-meta'));
      button.addEventListener('click', () => { this.commandId = command.id; this.renderHistory(); this.renderReceipt(); this.renderControls(); }); list.append(button);
    }
  }
  private renderReceipt() {
    this.reconcileSourceDrafts();
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
        if (command.method === 'script.search' && Number.isSafeInteger(candidate.line) && Number(candidate.line) > 0 && Number.isSafeInteger(candidate.column) && Number(candidate.column) > 0 && typeof candidate.excerpt === 'string' && utf8(candidate.excerpt) <= 512) {
          row.append(this.make('p', 'Line ' + candidate.line + ' · UTF-8 byte column ' + candidate.column + (candidate.excerptTruncated === true ? ' · excerpt' : ''), 'node-meta'), this.make('pre', candidate.excerpt, 'message-text'));
        }
        const actions = this.make('div', undefined, 'button-row'), use = this.make('button', 'Use reference', 'secondary'), copy = this.make('button', 'Copy reference', 'quiet'); use.type = 'button'; copy.type = 'button'; use.disabled = this.busy || Boolean(this.pending); use.addEventListener('click', () => { this.setRef(ref); if (command.method === 'script.search') { this.el<HTMLSelectElement>('method').value = 'script.read'; this.renderForm(); } this.notice('Selected returned reference ' + ref.instanceId + ' in exact session ' + ref.sessionId + '. Edit baselines cleared.'); }); copy.addEventListener('click', () => { void this.copy(json(ref)); }); actions.append(use, copy); row.append(actions); nodes.append(row);
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
  async openWorkRun(runId:string,isCurrent:()=>boolean):Promise<boolean> {
    if(this.stopped||this.workBusy||!isCurrent())return false;
    const navigation=++this.workNavigation;
    // Fetch the exact run: older evidence remains reachable beyond the recent list.
    const {run}=await this.api.run(runId);
    if(this.stopped||this.workBusy||navigation!==this.workNavigation||!isCurrent())return false;
    if(run.id!==runId||!Array.isArray(run.tasks)||run.tasks.length>64)throw new Error('Invalid recorded work run.');
    this.workRuns=[run,...this.workRuns.filter(row=>row.id!==runId)].slice(0,101);
    const picker=this.el<HTMLSelectElement>('work-run-picker');picker.replaceChildren();this.option(picker,'','All recorded runs');
    for(const row of this.workRuns)this.option(picker,row.id,row.title+' · '+row.id);
    picker.value=runId;this.el<HTMLSelectElement>('work-filter').value='all';
    this.workTaskId=(run.tasks.find(task=>task.state==='needs_review')??run.tasks[0])?.id??'';
    this.el<HTMLTextAreaElement>('work-review-note').value='';
    // Navigation never grants review authority; normal fresh-work checks still apply.
    this.renderWorkBoard();this.renderWorkTask();this.renderWorkControls();return true;
  }
  private async refreshWork() {
    const navigation=this.workNavigation,selected=this.value('work-run-picker');
    const reads = await Promise.allSettled([this.api.runs(), this.api.ready()]);
    try {
      const runs = reads[0]!, ready = reads[1]!;
      if (runs.status === 'rejected') throw runs.reason;
      if (ready.status === 'rejected') throw ready.reason;
      if (!Array.isArray(runs.value.runs) || !Array.isArray(ready.value.tasks)) throw new Error('Invalid work endpoint response.');
      if(this.stopped||navigation!==this.workNavigation)return;
      if(selected&&!runs.value.runs.some(run=>run.id===selected)){
        const {run}=await this.api.run(selected);
        if(this.stopped||navigation!==this.workNavigation)return;
        if(run.id!==selected||!Array.isArray(run.tasks)||run.tasks.length>64)throw new Error('Invalid recorded work run.');
        runs.value.runs=[run,...runs.value.runs].slice(0,101);
      }
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

  private subscribeAssetContext() {
    const changed = () => this.syncAssetContext();
    this.removeAssetContext ??= this.assetOptions.subscribeContextChange?.(changed) ?? null;
    this.removeAssetProject ??= this.subscribeProjectChange(changed);
  }
  private subscribeSignIn(): void {
    this.removeSignIn ??= this.assetOptions.subscribeSignInChange?.(() => {
      if (this.stopped) return;
      this.renderKeyControls(); this.assetContext.invalidate(); this.resetAssetContext();
      if (this.assetSignedIn() && this.assetContext.ready()) queueMicrotask(() => { if (!this.stopped && this.assetSignedIn()) void this.refreshAssets(); });
    }) ?? null;
  }
  private syncAssetContext(refresh = true) {
    if (!this.assetContext.sync()) return;
    this.resetAssetContext();
    if (refresh) queueMicrotask(() => { if (!this.stopped && this.assetContext.ready()) void this.refreshAssets(); });
  }
  private resetAssetContext() {
    this.assetHistoryChange?.abort();this.assetHistoryChange=null;this.assetHistoryMessages.clear();
    this.assetHealthRead?.abort();this.assetHealthRead=null;this.assetHealth=null;this.assetHealthResult='';this.renderAssetHealth();
    this.assetWorkerCheck?.abort();this.assetWorkerCheck=null;this.assetWorkerMessages.clear();
    this.assetReadEpoch++; this.assetNextCursor = null; this.assetJobs = []; this.assetUnavailable=[];this.assetJobId = '';
    this.automaticAssets.reset(); this.clearChatAssets(); this.assetCardsLimit = 8;
    this.assetAvailable = false; this.assetBusy = false; this.assetProbed = false; this.assetUnknown = ''; this.assetReadAfterUnknown = false;
    this.clearAssetPreview(); this.renderAssetPicker(); this.renderAssetJob();
    this.text('asset-runtime', 'No runtime probe requested for this chat.');
    this.text('asset-notice', this.assetContext.ready() ? 'Asset view cleared. Loading the chosen history.' : 'Open a native chat in this exact project to view its assets.');
    this.text('asset-status', 'No current asset history'); this.renderAssetControls();
  }
  private assetTicket() { this.syncAssetContext(false); return this.assetContext.capture(); }
  private assetCurrent(ticket: AssetContextTicket) { return !this.stopped && this.assetSignedIn() && this.assetContext.current(ticket); }
  private assetSignedIn(): boolean { try { return !this.assetOptions.isSignedIn || this.assetOptions.isSignedIn() === true; } catch { return false; } }
  private renderAssetPicker() {
    const picker = this.el<HTMLSelectElement>('asset-job-picker'); picker.replaceChildren(); this.option(picker, '', 'Choose a recorded asset job');
    for (const job of this.assetJobs) {
      const ambiguous = this.assetContext.unknownDetails().some(item => item.jobId === job.jobId);
      this.option(picker, job.jobId, assetJobName(job) + ' · ' + job.state.replaceAll('_', ' ') + (ambiguous ? ' · association unknown' : '') + ' · ' + job.jobId);
    }
    if (this.assetJobs.some(job => job.jobId === this.assetJobId)) picker.value = this.assetJobId;
    else { this.assetJobId = ''; this.clearAssetPreview(); }
  }
  private async refreshAssets(more = false) {
    if (this.stopped) return;
    const ticket = this.assetTicket(), requestEpoch = ++this.assetReadEpoch, after = more ? this.assetNextCursor : null;
    if (!this.assetSignedIn()) {
      if (this.assetAvailable || this.assetJobs.length || this.assetJobId) { this.assetContext.invalidate(); this.resetAssetContext(); }
      this.renderAssetControls(); return;
    }
    if (!this.assetContext.ready() || (more && !after)) { this.renderAssetControls(); return; }
    try {
      let jobs: AssetJobRecord[], cursor: string | null = null,unavailable:AssetHistoryUnavailable[]=[];
      if (ticket.global) {
        if (this.assetOptions.assetMode === 'standalone') {
          const data = await this.api.assetJobs(); if (!Array.isArray(data.jobs) || data.jobs.length > 256) throw new Error('Invalid global asset history.');
          jobs = data.jobs.map(readAssetJob);unavailable=readUnavailableHistory((data as {unavailable?:unknown}).unavailable,jobs,64);
        } else {
          const data = await this.api.assetGlobalJobs(32, after ?? undefined); jobs = data.jobs; cursor = data.nextCursor;unavailable=data.unavailable??[];
        }
      } else {
        const data = await this.api.assetConversationJobs(32, after ?? undefined);
        if (!this.assetCurrent(ticket) || requestEpoch !== this.assetReadEpoch) return;
        if (!this.assetContext.matches(ticket, data)) throw new Error('Asset history does not match this exact project and native chat.');
        jobs = data.jobs; cursor = data.nextCursor;unavailable=data.unavailable??[];
      }
      if (!this.assetCurrent(ticket) || requestEpoch !== this.assetReadEpoch) return;
      if (after && cursor === after) throw new Error('Asset history returned a nonadvancing cursor.');
      const combined = more ? [...this.assetJobs, ...jobs] : jobs;
      if (ticket.global) for (const item of this.assetContext.unknownDetails()) if (item.job && !combined.some(job => job.jobId === item.jobId)) combined.push(item.job);
      const unique = [...new Map(combined.map(job => [job.jobId, job])).values()];
      const unavailableRows=[...new Map([...(more?this.assetUnavailable:[]),...unavailable].filter(item=>!unique.some(job=>job.jobId===item.jobId)).map(item=>[item.jobId,item])).values()];
      let windowed=false;
      const withinView=()=>unique.length+unavailableRows.length<=256&&utf8(JSON.stringify([unique,unavailableRows]))<=ASSET_CONVERSATION_BYTES;
      while(more&&!withinView()){
        const old=unique.findIndex(job=>!jobs.some(incoming=>incoming.jobId===job.jobId));
        if(old>=0){unique.splice(old,1);windowed=true;continue;}
        const oldUnavailable=unavailableRows.findIndex(item=>!unavailable.some(incoming=>incoming.jobId===item.jobId));
        if(oldUnavailable>=0){unavailableRows.splice(oldUnavailable,1);windowed=true;continue;}break;
      }
      if(!withinView())throw new Error('This history page exceeds its bounded view. Inspect a smaller recorded page.');
      // Only a current, matched native-chat receipt may drive presentation.
      // Global and paginated history never turns an old asset into new work.
      if (!ticket.global) this.automaticAssets.observe(jobs, more);
      this.assetJobs = unique;this.assetUnavailable=unavailableRows; this.assetNextCursor = cursor; this.assetAvailable = true;
      if(windowed)this.text('asset-notice','Showing a bounded window of loaded history. Earlier items remain in recorded history.');
      else if(unavailableRows.length)this.text('asset-notice',unavailableRows.length+' retained '+(unavailableRows.length===1?'job needs':'jobs need')+' inspection. Files are kept.');
      if (this.assetUnknown) this.assetReadAfterUnknown = true;
      this.renderAssetPicker(); this.text('asset-status', ticket.global ? 'Global asset history' : 'Assets for this chat'); this.renderAssetJob();
      if(!more)void this.readAssetHealth(ticket);
      this.renderChatAssets();
      if (!ticket.global) this.presentAutomaticAsset(ticket);
    } catch (error) {
      if (!this.assetCurrent(ticket) || requestEpoch !== this.assetReadEpoch) return;
      this.assetAvailable = false; this.assetProbed = false; this.assetReadAfterUnknown = false;
      // Refused or mismatched history must not leave selectable cached jobs.
      this.assetJobs = [];this.assetUnavailable=[]; this.assetJobId = ''; this.assetNextCursor = null; this.clearAssetPreview(); this.renderAssetPicker(); this.renderAssetJob();
      this.clearChatAssets();
      this.text('asset-status', 'Asset history unavailable');
      this.text('asset-notice', error instanceof Error ? error.message : String(error));
    } finally { if (this.assetCurrent(ticket) && requestEpoch === this.assetReadEpoch) this.renderAssetControls(); }
  }
  private assetInput() {
    const number = (id: string) => this.value(id).trim() ? Number(this.value(id)) : NaN;
    return prepareAssetInput({ template: this.value('asset-template'), name: this.value('asset-name'), seed: number('asset-seed'), sizeMeters: this.value('asset-size').split(',').map(s => s.trim() ? Number(s) : NaN), color: this.value('asset-color').split(',').map(s => s.trim() ? Number(s) : NaN), triangleBudget: number('asset-budget'), renderResolution: number('asset-resolution'), renderSamples: number('asset-samples') });
  }
  private currentAssetJob() { return this.assetJobs.find(j => j.jobId === this.assetJobId); }
  /** Imported assets (asset-imports.ts): the shared viewer, the generated models a chat card could show now, the same
   * View action and a release so an import can take the viewer. Imports never enter this job history. */
  assetLibrary(): import('./asset-imports.js').AssetLibrary {
    const viewable = (jobId: string) => !this.stopped && this.assetAvailable && !this.assetUnknown && this.assetJobs.some(job => job.jobId === jobId && job.state === 'succeeded' && job.manifestAvailable);
    return {
      viewer: this.assetViewer,
      generated: () => this.assetJobs.filter(job => viewable(job.jobId)).slice(0, 32).map(job => ({ jobId: job.jobId, name: assetJobName(job).replaceAll('-', ' ') })),
      view: jobId => {
        if (this.assetBusy || !viewable(jobId)) return false;
        this.selectAssetJob(jobId, true); this.renderAssetPicker(); void this.loadAssetManifest(); return true;
      },
      release: () => { if (this.assetJobId) { this.selectAssetJob('', true); this.renderAssetPicker(); } else this.clearAssetPreview(); },
    };
  }
  private selectAssetJob(jobId: string, manual: boolean): void {
    if (manual) this.automaticAssets.muteObserved();
    this.assetJobId = this.assetJobs.some(job => job.jobId === jobId) ? jobId : '';
    this.clearAssetPreview(); this.renderAssetJob(); this.renderAssetControls(); this.renderChatAssets();
  }
  private presentAutomaticAsset(ticket: AssetContextTicket): void {
    if (!this.assetCurrent(ticket) || ticket.global || !ticket.conversation || !this.assetSignedIn() || !this.assetAvailable || this.assetBusy || this.assetUnknown) return;
    const ready = this.automaticAssets.ready();
    if (ready) {
      const job = this.assetJobs.find(item => item.jobId === ready);
      if (!job || job.state !== 'succeeded' || !job.manifestAvailable) return;
      // Claim before any asynchronous read. Failed reads need an explicit
      // human retry; polling cannot repeatedly download/allocate a model.
      this.automaticAssets.markReady(ready);
      this.selectAssetJob(ready, false); this.renderAssetPicker();
      queueMicrotask(() => { if (this.assetCurrent(ticket) && this.assetJobId === ready && !this.assetBusy) void this.loadAssetManifest(); });
      return;
    }
    const pending = this.automaticAssets.pending();
    if (pending && this.assetJobs.some(job => job.jobId === pending && job.state === 'running')) {
      this.automaticAssets.markPending(pending);
      this.selectAssetJob(pending, false); this.renderAssetPicker();
      // renderAssetJob opens the toggleable panel only for observed real work.
    }
  }
  private clearChatAssets(): void {
    this.assetCardsEpoch++; this.assetCardsSignature = '';
    const host = this.doc.getElementById('chat-assets'); if (host) { host.replaceChildren(); host.hidden = true; }
  }
  private renderChatAssets(): void {
    const host = this.doc.getElementById('chat-assets'); if (!host) return;
    const ticket = this.assetContext.capture();
    if (this.stopped || ticket.global || !ticket.conversation || !this.assetSignedIn() || !this.assetAvailable || !(this.assetJobs.length||this.assetUnavailable.length)) { this.clearChatAssets(); return; }
    const jobs = this.assetJobs.slice(0, this.assetCardsLimit);
    const signature = JSON.stringify([ticket.epoch, this.assetJobId, this.assetBusy, this.assetNextCursor, this.assetCardsLimit,this.assetUnavailable, jobs.map(job => [job.jobId, job.state, job.manifestAvailable, assetJobName(job),assetJobKind(job),job.resolution,job.retention,this.assetWorkerMessages.get(job.jobId),this.assetHistoryMessages.get(job.jobId)])]);
    if (signature === this.assetCardsSignature) return;
    this.assetCardsSignature = signature; const epoch = ++this.assetCardsEpoch;
    const section = this.make('div', undefined, 'chat-asset-list'); section.setAttribute('role', 'list');
    for(const item of this.assetUnavailable.slice(0,this.assetCardsLimit)){
      const card=this.make('article',undefined,'chat-asset-card');card.setAttribute('role','listitem');card.setAttribute('data-asset-unavailable',item.jobId);
      card.append(this.make('strong',item.name?item.name.replaceAll('-',' '):'Retained asset'),this.make('p','Saved history needs inspection. Files are kept.','hint'));section.append(card);
    }
    const labels: Record<string, string> = { running: 'Building', succeeded: 'Ready', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out', interrupted: 'Interrupted' };
    const current = () => epoch === this.assetCardsEpoch && this.assetCurrent(ticket) && this.assetSignedIn() && this.assetAvailable && !this.assetUnknown;
    for (const job of jobs) {
      const card = this.make('article', undefined, 'chat-asset-card'); card.setAttribute('role', 'listitem'); card.setAttribute('data-job-id', job.jobId);
      const name = assetJobName(job).replaceAll('-', ' '), title = this.make('strong', name.charAt(0).toUpperCase() + name.slice(1));
      const state = this.make('span', (job.state === 'succeeded' && !job.manifestAvailable ? 'Finalizing' : labels[job.state]) + (assetJobKind(job) === 'adopted-glb' ? ' · Adopted GLB · preview only' : assetJobKind(job) === 'converted-glb' ? ' · Converted GLB' : ''), 'chat-asset-state');
      const info = this.make('div', undefined, 'chat-asset-info'); info.append(title, state); card.append(info);
      this.renderWorkerStatus(card,job,current);
      this.renderRetentionStatus(card,job,current);
      if (job.state === 'succeeded' && job.manifestAvailable) {
        const view = this.make('button', 'View', 'secondary'); view.type = 'button'; view.setAttribute('aria-label', 'View ' + name); view.disabled = this.assetBusy;
        view.addEventListener('click', () => {
          if (!current() || this.assetBusy || !this.assetJobs.some(item => item.jobId === job.jobId && item.state === 'succeeded' && item.manifestAvailable)) return;
          this.selectAssetJob(job.jobId, true); this.renderAssetPicker();
          this.doc.getElementById('preview-model-tab')?.click();
          const toggle = this.doc.getElementById('workspace-preview-toggle');
          if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
          void this.loadAssetManifest();
        }); card.append(view);
      }
      if (job.jobId === this.assetJobId) card.setAttribute('data-selected', 'true');
      section.append(card);
    }
    const heading = this.make('h3', 'Assets', 'chat-assets-heading'); host.replaceChildren(heading, section); host.hidden = false;
    if (this.assetJobs.length > this.assetCardsLimit || this.assetNextCursor) {
      const more = this.make('button', 'More assets', 'quiet'); more.type = 'button'; more.disabled = this.assetBusy;
      more.addEventListener('click', () => {
        if (!current() || this.assetBusy) return;
        this.assetCardsLimit = Math.min(256, this.assetCardsLimit + 8);
        if (this.assetCardsLimit > this.assetJobs.length && this.assetNextCursor) void this.refreshAssets(true); else this.renderChatAssets();
      }); host.append(more);
    }
  }
  private renderAssetControls() {
    const ticket = this.assetContext.capture(), running = this.assetJobs.some(j => j.state === 'running'), interrupted = this.assetJobs.some(j => j.state === 'interrupted'&&assetJobKind(j)!=='adopted-glb'&&j.resolution?.status!=='resolved'), blocked = !this.assetSignedIn() || !this.assetAvailable || this.assetBusy || Boolean(this.assetUnknown) || !this.assetContext.ready();
    let valid = false; try { this.text('asset-request-preview', json(this.assetInput())); valid = true; } catch (error) { this.text('asset-request-preview', error instanceof Error ? error.message : String(error)); }
    this.el<HTMLButtonElement>('asset-start').disabled = blocked || !valid || !this.assetProbed || running || interrupted || !this.assetContext.canStart();
    this.text('asset-start', ticket.global ? 'Start unscoped template job' : 'Start template job in this chat');
    this.el<HTMLSelectElement>('asset-history-scope').value = ticket.global ? 'global' : 'conversation';
    this.text('asset-scope-detail', ticket.global ? 'All chats and retained unscoped jobs in this project. These records do not establish a binding to the current chat.' : ticket.conversation ? 'Assets recorded for this exact native chat and project.' : 'Open a native chat in this exact project. Global asset history is available for retained jobs.');
    this.el<HTMLButtonElement>('asset-history-more').disabled = !this.assetNextCursor || this.assetBusy || !this.assetAvailable;
    this.el('asset-history-more').hidden = !this.assetNextCursor;
    this.text('asset-history-more', ticket.global ? 'Load more global jobs' : 'Load more jobs for this chat');
    const uncertain = this.assetContext.unknownDetails();
    this.el('asset-ambiguous').hidden = !uncertain.length;
    this.text('asset-ambiguous-records', uncertain.length ? json(uncertain.map(item => ({ jobId: item.jobId, association: 'unknown', retry: false, message: item.message, ...(ticket.global && item.job ? { job: item.job } : {}) }))) : '');
    this.el<HTMLButtonElement>('asset-probe').disabled = blocked || running || interrupted;
    this.el<HTMLButtonElement>('asset-cancel').disabled = blocked || this.currentAssetJob()?.state !== 'running';
    this.el<HTMLButtonElement>('asset-load-manifest').disabled = blocked || !this.currentAssetJob()?.manifestAvailable || this.currentAssetJob()?.state !== 'succeeded';
    this.el<HTMLSelectElement>('asset-job-picker').disabled = this.assetBusy;
    this.el('asset-unknown').hidden = !this.assetUnknown; this.text('asset-unknown-message', this.assetUnknown);
    this.renderAssetHealth();
    this.el<HTMLButtonElement>('asset-acknowledge').disabled = !this.assetAvailable || !this.assetReadAfterUnknown || this.assetBusy;
    this.text('asset-gate', !this.assetContext.ready() ? 'A native chat in this exact project is required.' : ticket.global && !this.assetContext.canStart() ? 'Global history is for inspection. Choose This chat to start a template job.' : interrupted ? 'An interrupted job pauses new asset work. Check its worker status in the asset card or recorded job.' : running ? 'A job is running. Its stage and final manifest are recorded below.' : !this.assetProbed ? 'Probe the installed Blender runtime before starting a template job.' : ticket.global ? 'This start is unscoped and will not be bound to a chat.' : 'Local runtime observed. Start runs only the selected fixed template in this chat.');
    this.renderChatAssets();
  }
  private renderAssetJob() {
    const job = this.currentAssetJob(); this.text('asset-job-record', job ? json(job) : 'No asset job selected.');
    const workerHost=this.doc.getElementById('asset-worker-status');
    if(workerHost){workerHost.replaceChildren();if(job){const current=()=>this.currentAssetJob()?.jobId===job.jobId;this.renderWorkerStatus(workerHost,job,current);this.renderRetentionStatus(workerHost,job,current);}}
    const summary = this.el('asset-job-summary'); summary.setAttribute('data-asset-state', job?.state ?? ''); summary.setAttribute('data-asset-name', job ? assetJobName(job) : '');
    if (job?.state === 'running' && this.assetAvailable) {
      const key = this.historyProjectPath() + '\0' + job.jobId;
      if (key !== this.assetActivitySignature) { this.assetActivitySignature = key;
        const EventType = this.doc.defaultView?.CustomEvent;
        if (EventType) this.doc.dispatchEvent(new EventType<WorkspaceAssetActivity>(WORKSPACE_ASSET_ACTIVITY_EVENT, {detail:{jobId:job.jobId,state:'running'},bubbles:false}));
      }
    }
    this.text('asset-job-summary', job ? assetJobName(job) + (assetJobKind(job) === 'adopted-glb' ? ' · adopted GLB; engine import unavailable' : assetJobKind(job) === 'converted-glb' ? ' · converted GLB; Studio verification pending' : '') + ' · ' + job.state.replaceAll('_', ' ') + ' · stage ' + job.stage + (job.error ? ' · ' + job.error.code + ': ' + job.error.message : '') : 'Choose an exact recorded job to inspect progress and evidence.');
  }
  private bindAssetAcknowledgement():void{
    const button=this.doc.getElementById('asset-acknowledge');if(!button||this.assetAcknowledgementBound)return;
    this.assetAcknowledgementBound=true;button.addEventListener('click',event=>{
      const click=event as MouseEvent;
      if(!event.isTrusted||event.defaultPrevented||click.button!==0||click.altKey||click.ctrlKey||click.metaKey||click.shiftKey||!this.assetAvailable||!this.assetReadAfterUnknown||this.assetBusy)return;
      this.assetUnknown='';this.assetReadAfterUnknown=false;this.renderAssetControls();
    });
  }
  private renderRetentionStatus(host:HTMLElement,job:AssetJobRecord,current:()=>boolean):void{
    const message=this.assetHistoryMessages.get(job.jobId);
    if(!job.retention&&!message)return;
    const note=this.make('p',message??'Archived in recorded history. Files are kept.','hint');
    note.setAttribute('role','status');note.setAttribute('aria-live','polite');note.setAttribute('data-asset-retained-note',job.jobId);note.tabIndex=-1;
    if(job.retention){
      const button=this.make('button',this.assetHistoryChange&&this.assetBusy?'Restoring history…':'Restore to active history','secondary');button.type='button';
      button.setAttribute('aria-label','Restore '+assetJobName(job).replaceAll('-',' ')+' to active history');
      button.disabled=this.assetBusy||!this.assetAvailable||!this.assetSignedIn()||!!this.assetUnknown||!this.assetContext.ready();
      button.addEventListener('click',event=>{if(event.isTrusted&&!event.defaultPrevented&&event.button===0&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&current())
        void this.restoreAssetHistory(job.jobId,host.id==='asset-worker-status'?'asset-worker-status':'chat-assets');});host.append(button);
    }host.append(note);
  }
  /** Trusted, unmodified primary activation only; keyboard activation of a button dispatches a trusted click. */
  private onTrusted(id:string,action:()=>void):void{
    const element=this.doc.getElementById(id);if(!element)return;
    element.addEventListener('click',event=>{const input=event as MouseEvent;
      if(event.isTrusted===true&&!event.defaultPrevented&&input.button===0&&!input.altKey&&!input.ctrlKey&&!input.metaKey&&!input.shiftKey&&!(element as HTMLButtonElement).disabled)action();});
  }
  private async readAssetHealth(ticket:AssetContextTicket):Promise<void>{
    this.assetHealthRead?.abort();const controller=new AbortController();this.assetHealthRead=controller;
    try{
      const health=await this.api.assetHistoryHealth(controller.signal);
      if(!this.assetCurrent(ticket)||this.assetHealthRead!==controller)return;
      this.assetHealth=health;
    }catch{
      if(!this.assetCurrent(ticket)||this.assetHealthRead!==controller)return;
      this.assetHealth=null; // Unknown health is never shown as healthy.
    }finally{if(this.assetHealthRead===controller){this.assetHealthRead=null;this.renderAssetHealth();}}
  }
  private renderAssetHealth():void{
    const host=this.doc.getElementById('asset-history-health');if(!host)return;
    if(!this.assetHealthBound){this.assetHealthBound=true; // Bound once on first render, independent of the boot path.
      this.onTrusted('asset-history-rebuild',()=>{void this.changeAssetHistory('rebuild');});
      this.onTrusted('asset-history-confirm',()=>{void this.changeAssetHistory('confirm');});}
    const health=this.assetHealth,visible=!!health&&this.assetAvailable&&this.assetSignedIn()&&!this.stopped;
    host.hidden=!visible;if(!visible||!health){this.text('asset-history-health-status','');this.text('asset-history-health-result',this.assetHealthResult);return;}
    host.className=health.degraded?'notice warning':'notice';
    const counts=health.active+' active · '+health.archived+' archived'+(health.unavailable?' · '+health.unavailable+' need inspection':'')+(health.unclassified?' · '+health.unclassified+' not yet classified':'');
    this.text('asset-history-health-status',health.degraded
      ?'Saved history needs attention. '+health.reasons.map(reason=>HISTORY_REASON_TEXT[reason]).join(' ')+' '+counts+'. Files are kept. Archiving and restoring stay paused until this is resolved.'
      :'Saved history is healthy. '+counts+'.');
    const blocked=this.assetBusy||!!this.assetUnknown||!this.assetContext.ready()||!this.assetSignedIn();
    const rebuild=this.el<HTMLButtonElement>('asset-history-rebuild'),confirm=this.el<HTMLButtonElement>('asset-history-confirm');
    rebuild.hidden=!health.degraded;rebuild.disabled=blocked||!health.degraded;
    confirm.hidden=!health.reasons.includes('commit-uncertain');confirm.disabled=blocked||confirm.hidden;
    const pending=this.assetHistoryChange&&this.assetBusy;
    this.text('asset-history-rebuild',pending?'Working…':'Rebuild history index');this.text('asset-history-confirm',pending?'Working…':'Confirm last change');
    this.text('asset-history-health-help',health.degraded?'Rebuild re-checks every job folder and saves a new index; the previous index is kept as a backup. Confirm re-checks only the last unconfirmed change. Neither moves, deletes or restarts any job.':'');
    this.text('asset-history-health-result',this.assetHealthResult);
  }
  private async changeAssetHistory(kind:'rebuild'|'confirm'):Promise<void>{
    if(this.assetBusy||this.assetHistoryChange||!this.assetAvailable||this.assetUnknown||!this.assetSignedIn()||!this.assetContext.ready()||!this.assetHealth?.degraded)return;
    if(kind==='confirm'&&!this.assetHealth.reasons.includes('commit-uncertain'))return;
    const ticket=this.assetTicket(),controller=new AbortController();this.assetHistoryChange=controller;this.assetBusy=true;
    this.assetHealthResult=kind==='rebuild'?'Rebuilding the history index…':'Checking the last change…';this.renderAssetControls();
    try{
      const change=await this.api.assetChangeHistory(kind,controller.signal);
      if(!this.assetCurrent(ticket)||this.assetHistoryChange!==controller)return;
      this.assetHealthResult=(kind==='rebuild'?'History index rebuilt: ':'Last change confirmed: ')+change.active+' active, '+change.archived+' archived'+
        (change.unavailable?', '+change.unavailable+' still need inspection':'')+'.'+(change.backup?' The previous index was kept as a backup.':'')+
        ' No job was moved, deleted or restarted.'+(change.degraded?' History still needs attention.':'');
      this.assetHistoryChange=null;this.assetBusy=false;
      await this.refreshAssets();
    }catch(error){
      if(!this.assetCurrent(ticket)||this.assetHistoryChange!==controller)return;
      const unknown=error instanceof StudioRequestError&&error.outcome==='unknown';
      this.assetHealthResult=unknown?'The outcome of this change is unknown. It was not repeated. Refresh recorded history before another change.'
        :(kind==='rebuild'?'History could not be rebuilt. Saved job files are kept; inspect the reasons above.':'The last change could not be confirmed. It stays unconfirmed; rebuild or inspect the reasons above.');
      if(unknown){this.assetUnknown=this.assetHealthResult;this.assetReadAfterUnknown=false;}
    }finally{
      if(this.assetCurrent(ticket)&&(this.assetHistoryChange===controller||this.assetHistoryChange===null)){
        if(this.assetHistoryChange===controller){this.assetHistoryChange=null;this.assetBusy=false;}
        this.renderAssetControls();
        if(!this.doc.activeElement||this.doc.activeElement===this.doc.body||(this.doc.activeElement as HTMLButtonElement).disabled)this.doc.getElementById('asset-history-health-result')?.focus();
      }
    }
  }
  private async restoreAssetHistory(jobId:string,focusHost:'asset-worker-status'|'chat-assets'):Promise<void>{
    if(this.assetBusy||!this.assetAvailable||this.assetUnknown||!this.assetSignedIn()||!this.assetContext.ready())return;
    const job=this.assetJobs.find(item=>item.jobId===jobId);if(!job?.retention)return;
    const ticket=this.assetTicket(),controller=new AbortController();this.assetHistoryChange=controller;this.assetBusy=true;
    this.assetHistoryMessages.set(jobId,'Restoring this job to active history…');this.renderAssetControls();this.renderAssetJob();
    try{
      await this.api.assetRestoreHistory(jobId,controller.signal);
      if(!this.assetCurrent(ticket)||this.assetHistoryChange!==controller)return;
      delete job.retention;this.assetHistoryMessages.set(jobId,'Restored to active history. Generation was not restarted.');
      await this.refreshAssets();
    }catch(error){
      if(!this.assetCurrent(ticket)||this.assetHistoryChange!==controller)return;
      const unknown=error instanceof StudioRequestError&&error.outcome==='unknown';
      const message=unknown?'The restoration outcome is unknown. Refresh recorded history before another change.':'History could not be restored. Refresh the retained job and check again.';
      this.assetHistoryMessages.set(jobId,message);this.text('asset-notice',message);
      if(unknown){this.assetUnknown=message;this.assetReadAfterUnknown=false;}
    }finally{
      if(this.assetCurrent(ticket)&&this.assetHistoryChange===controller){
        this.assetHistoryChange=null;this.assetBusy=false;this.renderAssetControls();this.renderAssetJob();
        if(!this.doc.activeElement||this.doc.activeElement===this.doc.body)this.doc.getElementById(focusHost)?.querySelector<HTMLElement>('[data-asset-retained-note="'+jobId+'"]')?.focus();
      }
    }
  }
  private renderWorkerStatus(host:HTMLElement,job:AssetJobRecord,current:()=>boolean):void{
    if(job.state!=='interrupted'||assetJobKind(job)==='adopted-glb')return;
    const notice=this.make('p',this.assetWorkerMessages.get(job.jobId)??(job.resolution?.status==='resolved'?'Worker confirmed stopped. Partial files are kept; this job remains interrupted.':'Partial files are kept while this job’s worker status is checked.'),'hint');
    notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');notice.setAttribute('data-worker-status-note',job.jobId);notice.tabIndex=-1;
    if(job.resolution?.status!=='resolved'){
      const button=this.make('button',this.assetWorkerCheck&&this.assetBusy?'Checking worker…':'Check worker status','secondary');button.type='button';
      button.setAttribute('aria-label','Check worker status for '+assetJobName(job).replaceAll('-',' '));
      button.disabled=this.assetBusy||!this.assetAvailable||!this.assetSignedIn()||!!this.assetUnknown||!workerJobId(job.jobId);
      button.addEventListener('click',event=>{if(event.isTrusted&&!event.defaultPrevented&&current())void this.checkAssetWorker(job.jobId,host.id==='asset-worker-status'?'asset-worker-status':'chat-assets');});host.append(button);
    }
    host.append(notice);
  }
  private async checkAssetWorker(jobId:string,focusHost?:'asset-worker-status'|'chat-assets'):Promise<void>{
    if(this.assetBusy||!this.assetAvailable||this.assetUnknown||!this.assetSignedIn())return;
    const job=this.assetJobs.find(item=>item.jobId===jobId);
    if(!job||job.state!=='interrupted'||assetJobKind(job)==='adopted-glb'||job.resolution?.status==='resolved')return;
    const ticket=this.assetTicket(),controller=new AbortController();
    if(!this.assetContext.ready())return;
    this.assetWorkerCheck=controller;this.assetBusy=true;this.assetWorkerMessages.set(jobId,'Checking this job’s worker status…');this.renderAssetControls();this.renderAssetJob();
    try{
      const result=await this.api.assetWorkerStatus(jobId,controller.signal);
      if(!this.assetCurrent(ticket)||this.assetWorkerCheck!==controller)return;
      job.resolution={status:'resolved',resolvedAt:result.resolvedAt};
      this.assetWorkerMessages.set(jobId,'Worker confirmed stopped. Partial files are kept; this job remains interrupted.');
      await this.refreshAssets();
    }catch(error){
      if(!this.assetCurrent(ticket)||this.assetWorkerCheck!==controller)return;
      const message=workerStatusMessage(error);this.assetWorkerMessages.set(jobId,message);this.text('asset-notice',message);
      if(error instanceof StudioRequestError&&error.outcome==='unknown'){this.assetUnknown=message;this.assetReadAfterUnknown=false;}
    }finally{
      if(this.assetCurrent(ticket)&&this.assetWorkerCheck===controller){
        this.assetWorkerCheck=null;this.assetBusy=false;this.renderAssetControls();this.renderAssetJob();
        if(focusHost&&(!this.doc.activeElement||this.doc.activeElement===this.doc.body))this.doc.getElementById(focusHost)?.querySelector<HTMLElement>('[data-worker-status-note="'+jobId+'"]')?.focus();
      }
    }
  }
  private assetFailure(error: unknown, operation: string) {
    const message = error instanceof Error ? error.message : String(error); this.text('asset-notice', message);
    if (error instanceof StudioRequestError && error.outcome === 'unknown') { this.assetUnknown = operation + ': outcome unknown. Refresh and inspect jobs before another action. Start and cancel are never automatically retried.'; this.assetReadAfterUnknown = false; }
  }
  private async probeAsset() {
    if (!this.assetAvailable || this.assetBusy || this.assetUnknown) return;
    const ticket = this.assetTicket(); if (!this.assetSignedIn() || !this.assetContext.ready()) return;
    this.assetBusy = true; this.assetProbed = false; this.text('asset-notice', 'Probing installed Blender capabilities…'); this.renderAssetControls();
    try {
      const data = await this.api.assetProbe(); if (!this.assetCurrent(ticket)) return;
      const capabilities = data.probe.blender?.capabilities; this.assetProbed = data.probe.available === true && record(capabilities) && (['glbExport', 'glbImport', 'fbxExport', 'fbxImport', 'cycles'] as const).every(key => capabilities[key] === true);
      this.text('asset-runtime', json(data.probe)); this.text('asset-notice', this.assetProbed ? 'Installed runtime capabilities observed. A template job can now start.' : 'No available Blender runtime was reported. Inspect probe attempts.');
    } catch (error) { if (this.assetCurrent(ticket)) this.assetFailure(error, 'Probe runtime'); }
    finally { if (this.assetCurrent(ticket)) { this.assetBusy = false; await this.refreshAssets(); if (this.assetCurrent(ticket)) this.renderAssetControls(); } }
  }
  private async startAsset() {
    const ticket = this.assetTicket(); if (!this.assetSignedIn() || !this.assetContext.canStart()) return;
    if (!this.assetAvailable || !this.assetProbed || this.assetBusy || this.assetUnknown || this.assetJobs.some(j => j.state === 'running' || j.state === 'interrupted')) return;
    let input: AssetInput; try { input = this.assetInput(); } catch (error) { this.assetFailure(error, 'Validate template'); return; }
    this.assetBusy = true; this.assetReadEpoch++; this.renderAssetControls();
    try {
      const data = ticket.global ? await this.api.assetStart(input) : await this.api.assetConversationStart(input);
      if (!ticket.global) {
        const receipt = data as AssetConversationStart;
        if (receipt.association === 'unknown' || receipt.projectPath !== ticket.projectPath || JSON.stringify(receipt.conversation) !== JSON.stringify(ticket.conversation)) this.assetContext.retainUnknown(ticket, receipt, 'Job was created; association is unknown. Inspect its ID in global history. Do not retry, rebind or recreate it.');
        if (!this.assetCurrent(ticket)) return;
        if (!this.assetContext.matches(ticket, receipt) || receipt.association !== 'bound') {
          this.assetContext.retainUnknown(ticket, receipt, 'The start receipt did not establish a binding to this exact chat. Do not retry, rebind or recreate the job.');
          this.assetUnknown = 'Job ' + receipt.jobId + ' was created with an unknown chat association. Inspect global asset history. Do not retry, rebind or recreate it.';
          this.assetReadAfterUnknown = false; this.text('asset-notice', this.assetUnknown); return;
        }
      }
      if (!this.assetCurrent(ticket)) return;
      if (!data.job?.jobId || data.job.kind === 'converted-glb' || data.job.request?.name !== input.name || data.job.request?.template !== input.template) throw new StudioRequestError('Start returned no matching recorded job.', 'unknown', { code: 'ASSET_RECEIPT', status: 200, payload: data });
      this.assetJobs = [data.job, ...this.assetJobs.filter(job => job.jobId !== data.job.jobId)];
      if (!ticket.global) this.automaticAssets.observe([data.job]);
      this.assetJobId = data.job.jobId; this.clearAssetPreview(); this.text('asset-notice', 'Asset job recorded: ' + data.job.jobId + '. Completion and preview evidence arrive through its manifest.');
    } catch (error) {
      if (!(error instanceof StudioRequestError) || error.outcome === 'unknown') this.assetContext.retainUnknown(ticket, error instanceof StudioRequestError ? error.details?.payload : null, 'Start outcome unknown. Inspect global history; do not retry or recreate the job.');
      if (this.assetCurrent(ticket)) this.assetFailure(error instanceof StudioRequestError ? error : new StudioRequestError('Start outcome unknown. Inspect global history; do not retry.', 'unknown'), 'Start template job');
    }
    finally { if (this.assetCurrent(ticket)) { this.assetBusy = false; await this.refreshAssets(); if (this.assetCurrent(ticket)) this.renderAssetControls(); } }
  }
  private async cancelAsset() {
    const ticket = this.assetTicket();
    const job = this.currentAssetJob(); if (!this.assetSignedIn() || !job || job.state !== 'running' || !this.assetAvailable || this.assetBusy || this.assetUnknown) return;
    this.assetBusy = true; this.assetReadEpoch++; this.renderAssetControls();
    try { const data = await this.api.assetCancel(job.jobId); if (!this.assetCurrent(ticket)) return; if (data.job?.jobId !== job.jobId) throw new StudioRequestError('Cancel did not identify the selected job.', 'unknown'); this.text('asset-notice', 'Recorded cancellation result: ' + data.job.state.replaceAll('_', ' ') + '. Inspect retained evidence.'); }
    catch (error) { if (this.assetCurrent(ticket)) this.assetFailure(error, 'Cancel job ' + job.jobId); }
    finally { if (this.assetCurrent(ticket)) { this.assetBusy = false; await this.refreshAssets(); if (this.assetCurrent(ticket)) this.renderAssetControls(); } }
  }
  private clearAssetPreview() { this.assetDownloads.clear(); this.assetViewer.clear(); this.assetPreviewEpoch++; this.el('asset-previews').replaceChildren(); this.text('asset-manifest', 'Load a verified completed manifest for this exact job.'); }
  private async loadAssetManifest() {
    const ticket = this.assetTicket();
    const job = this.currentAssetJob(); if (!this.assetSignedIn() || !job || job.state !== 'succeeded' || !job.manifestAvailable || !this.assetAvailable || this.assetBusy) return;
    this.assetBusy = true; this.assetDownloads.clear(); this.assetViewer.clear(); const epoch = ++this.assetPreviewEpoch; this.renderAssetControls(); this.el('asset-previews').replaceChildren();
    try {
      const { manifest } = await this.api.assetManifest(job.jobId);
      if (!assetManifestMatchesJob(manifest, job)) throw new Error('Manifest identity does not match the selected job.');
      if (!this.assetCurrent(ticket) || epoch !== this.assetPreviewEpoch || this.assetJobId !== job.jobId) return;
      this.text('asset-manifest', json(manifest));
      this.assetDownloads.show(manifest, job.jobId);
      const viewer = this.assetViewer.show(manifest, job.jobId, () => this.assetCurrent(ticket) && epoch === this.assetPreviewEpoch && this.assetJobId === job.jobId);
      const previews = manifest.artifacts.filter(a => a.role === 'preview' && ['preview-hero.png', 'preview-side.png'].includes(a.path));
      const reads = await Promise.allSettled(previews.map(async artifact => {
        const blob = await this.api.assetPreview(job.jobId, artifact.path);
        if (!this.assetCurrent(ticket) || epoch !== this.assetPreviewEpoch || this.assetJobId !== job.jobId) return;
        if (blob.size !== artifact.bytes) throw new Error('Preview byte count does not match its manifest.');
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
        if (digest !== artifact.sha256) throw new Error('Preview hash does not match its manifest.');
        if (!this.assetCurrent(ticket) || epoch !== this.assetPreviewEpoch || this.assetJobId !== job.jobId) return;
        const bitmap = await createImageBitmap(blob);
        try {
          if (!this.assetCurrent(ticket) || epoch !== this.assetPreviewEpoch || this.assetJobId !== job.jobId) return;
          const figure = this.make('figure'), canvas = this.make('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', artifact.path + ' for job ' + job.jobId); canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
          figure.append(canvas, this.make('figcaption', artifact.path + ' · SHA-256 verified')); this.el('asset-previews').append(figure);
          const EventType = this.doc.defaultView?.CustomEvent;
          if (EventType) this.doc.dispatchEvent(new EventType<WorkspaceAssetActivity>(WORKSPACE_ASSET_ACTIVITY_EVENT, {detail:{jobId:job.jobId,state:'succeeded'},bubbles:false}));
        } finally { bitmap.close(); }
      }));
      await viewer;
      if (this.assetCurrent(ticket) && epoch === this.assetPreviewEpoch && this.assetJobId === job.jobId) this.text('asset-notice', reads.some(r => r.status === 'rejected') ? 'Manifest loaded; one or more previews failed authentication, decoding or integrity verification. Inspect the recorded manifest.' : 'Manifest and authenticated previews loaded. Review validation warnings and limitations before using exports.');
    } catch (error) { if (this.assetCurrent(ticket) && epoch === this.assetPreviewEpoch) this.assetFailure(error, 'Load manifest'); }
    finally { if (this.assetCurrent(ticket) && epoch === this.assetPreviewEpoch) { this.assetBusy = false; this.renderAssetControls(); } }
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

export { appendWorkflowText as appendWorkflowDraft } from './codex-chat.js';

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

/** C31 motion, exits: menus, popovers, the settings drawer, in-app dialogs, the compact sheet and a collapsing folder leave
 * with a short fade instead of vanishing. The real element still hides at once, so focus, hit testing, the accessibility
 * tree and every script see it gone immediately; what fades is a still copy of its last shown frame, drawn in an inert,
 * aria-hidden, closed shadow root (studio.css adopted, the copy's own motion and pointer events off) that is removed when
 * the fade ends. Opacity and the transform family only (plus a clip for the folder), on the exit curve and shorter than the
 * entrances; nothing runs with reduced motion, while the page is hidden, or on a surface that reopens. Presentation only. */
export function startExitMotion(doc: Document): { stop(): void; resume(): void } {
  const win = doc.defaultView;
  type Snap = { chain: Element[]; leaf: HTMLElement; rect: DOMRect; backdrop?: { background: string; filter: string } | undefined; anchor?: { selector: string; top: number } };
  type Surface = { el: HTMLElement; leaf: HTMLElement; late: boolean; rise: number; prepare: (copy: HTMLElement) => void; snap: Snap | null };
  const token = (name: string, fallback: string) => (win ? win.getComputedStyle(doc.documentElement).getPropertyValue(name).trim() : '') || fallback;
  const ms = (value: string) => { const n = parseFloat(value); return /ms$/.test(value) ? n : n * 1000; };
  const still = () => !win || doc.visibilityState === 'hidden' || !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let fast = 120, base = 180, slow = 240, exit = 'cubic-bezier(.4,0,1,1)', emph = 'cubic-bezier(.3,0,0,1)';
  let sheets: CSSStyleSheet[] | null | undefined, building = false;
  // studio.css, adopted by every copy and built once while the window is idle: the file's own text (a CSSOM round trip
  // drops var() shorthands that a later longhand overrides), with :root qualifiers moved to the host (which carries the
  // document element's attributes, as the shadow tree has no :root). A second sheet turns the copy's own entrances,
  // transitions and pointer events off. Until it is ready, surfaces simply close as they did before.
  const styles = (): CSSStyleSheet[] | null => sheets ?? null;
  const build = async () => {
    if (sheets !== undefined || building || !win) return;
    building = true;
    try {
      const source = Array.from(doc.styleSheets).find(sheet => /\/studio\.css(?:[?#]|$)/.test(sheet.href ?? ''));
      if (!source?.href || typeof CSSStyleSheet !== 'function') { sheets = null; return; }
      let text = '';
      try { const response = await win.fetch(source.href, { credentials: 'same-origin' }); if (response.ok) text = await response.text(); } catch { /* The parsed rules below stand in. */ }
      if (!text) text = Array.from(source.cssRules, rule => rule.cssText).join('\n');
      text = text.replace(/@font-face\s*\{[^}]*\}/g, '')
        .replace(/:root((?:\[[^\]]*\]|:not\(\[[^\]]*\]\))*)/g, (_all, qualifiers: string) => qualifiers ? ':host(' + qualifiers + ')' : ':host');
      const copy = new CSSStyleSheet(), off = new CSSStyleSheet();
      copy.replaceSync(text);
      off.replaceSync('*,*::before,*::after,*::backdrop,*::details-content{animation:none!important;transition:none!important;pointer-events:none!important;caret-color:transparent!important}[data-exit-chain]::before,[data-exit-chain]::after{content:none!important}');
      sheets = [copy, off];
    } catch { sheets = null; } finally { building = false; }
  };
  const snapshot = (el: HTMLElement, leaf: HTMLElement, deep: boolean, measured?: DOMRect): Snap | null => {
    const rect = measured ?? leaf.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const chain: Element[] = [];
    for (let node = leaf.parentElement; node && node !== doc.documentElement; node = node.parentElement) chain.unshift(node.cloneNode(false) as Element);
    const snap: Snap = { chain, leaf: (deep ? leaf.cloneNode(true) : leaf) as HTMLElement, rect };
    if (el instanceof HTMLDialogElement && win) { const style = win.getComputedStyle(el, '::backdrop'); snap.backdrop = { background: style.background, filter: style.backdropFilter }; }
    return snap;
  };
  const hosts = new Map<HTMLElement, HTMLElement>();
  const clear = (el: HTMLElement) => { const host = hosts.get(el); if (host) { host.remove(); hosts.delete(el); } };
  const set = (el: HTMLElement, values: Record<string, string>, important = '') => { for (const [key, value] of Object.entries(values)) el.style.setProperty(key, value, important); };
  /** Draws the copy at its last shown place and fades it; returns false when it cannot (no stylesheet, nothing measured). */
  const ghost = (key: HTMLElement, snap: Snap, frames: Keyframe[] | ((shift: number) => Keyframe[]), duration: number, easing: string, behind?: (root: ShadowRoot) => Animation | null): boolean => {
    const adopted = styles();
    if (!adopted) { void build(); return false; }
    if (!win || typeof Element.prototype.attachShadow !== 'function') return false;
    clear(key);
    const host = doc.createElement('arcane-exit');
    for (const attr of Array.from(doc.documentElement.attributes)) if (attr.name !== 'id' && attr.name !== 'style') host.setAttribute(attr.name, attr.value);
    host.setAttribute('aria-hidden', 'true'); host.inert = true;
    set(host, { position: 'fixed', top: '0', left: '0', width: '0', height: '0', margin: '0', padding: '0', border: '0', overflow: 'visible', 'z-index': '2147483646', 'pointer-events': 'none', display: 'block', contain: 'none' }, 'important');
    const root = host.attachShadow({ mode: 'closed' });
    root.adoptedStyleSheets = adopted;
    const fade = behind?.(root) ?? null;
    let parent: Node = root;
    for (const node of snap.chain) {
      node.setAttribute('data-exit-chain', ''); (node as HTMLElement).style?.setProperty('display', 'contents', 'important');
      // A details ancestor keeps its content shown, and an empty hidden summary stands in for the browser's default one.
      if (node instanceof HTMLDetailsElement) { node.open = true; const summary = doc.createElement('summary'); summary.style.setProperty('display', 'none', 'important'); node.prepend(summary); }
      parent.appendChild(node); parent = node;
    }
    const leaf = snap.leaf, r = snap.rect;
    leaf.hidden = false; leaf.removeAttribute('inert');
    for (const field of Array.from(leaf.querySelectorAll<HTMLInputElement>('input[type=password]'))) field.value = '';
    set(leaf, { position: 'fixed', inset: 'auto', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: '0', 'box-sizing': 'border-box',
      'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0', visibility: 'visible' }, 'important');
    set(leaf, { transform: 'none', translate: 'none', scale: 'none' });
    parent.appendChild(leaf);
    doc.documentElement.appendChild(host); hosts.set(key, host);
    // Line the copy up with what was on screen where an anchor was measured (a hovered row can change the layout above it).
    let shift = 0;
    const anchor = snap.anchor ? leaf.querySelector(snap.anchor.selector) : null;
    if (snap.anchor && anchor) { shift = snap.anchor.top - anchor.getBoundingClientRect().top; if (Math.abs(shift) >= .5) set(leaf, { top: r.top + shift + 'px' }, 'important'); else shift = 0; }
    let animation: Animation | null = null;
    try { animation = leaf.animate(typeof frames === 'function' ? frames(shift) : frames, { duration, easing, fill: 'forwards' }); } catch { /* Presentation only. */ }
    const done = () => { if (hosts.get(key) === host) hosts.delete(key); host.remove(); };
    if (!animation) { done(); return false; }
    void Promise.all([animation.finished, fade?.finished]).then(done, done);
    win.setTimeout(done, duration + 1000);
    return true;
  };
  const popover = (rise: number, scale = .98): Keyframe[] => [{ opacity: 1, scale: '1', translate: '0 0' }, { opacity: 0, scale: String(scale), translate: '0 ' + rise + 'px' }];
  const none = () => {};
  // Surfaces that hide in place: [selector, the shown test, the element that is drawn, late copy (closing does not change what
  // it showed, so it is copied at the close), travel in px (back towards its anchor), what puts the copy back in its open state].
  const kinds: [string, (el: HTMLElement) => boolean, (el: HTMLElement) => HTMLElement | null, boolean, number, (copy: HTMLElement) => void][] = [
    ['.composer-model-popover,.composer-command-menu', el => !el.hidden, el => el, false, 4, none],
    ['.studio-diagnostics-panel,.workspace-search-results,.vw-menu,.queue-menu,.import-picker', el => !el.hidden, el => el, false, -4, none],
    ['details.chat-head-more', el => (el as HTMLDetailsElement).open, el => el.querySelector<HTMLElement>(':scope>.chat-head-menu'), false, -4, none],
    // The chat chip's list is the details content: the copy keeps the details (its summary hidden, the real chip stays).
    ['.workspace-topbar details.chat-tabs-history', el => (el as HTMLDetailsElement).open && !el.hidden, el => el, false, -4,
      copy => copy.querySelector<HTMLElement>(':scope>summary')?.style.setProperty('visibility', 'hidden', 'important')],
    ['#sidebar-menu', el => el.getAttribute('data-open') === 'true', el => el, false, 4, none],
    ['dialog.settings-drawer', el => (el as HTMLDialogElement).open, el => el, true, 8,
      copy => { copy.setAttribute('open', ''); for (const page of Array.from(copy.querySelectorAll('[data-settings-section][hidden]'))) page.remove(); }],
    ['#app-sidebar', el => el.getAttribute('data-sheet') === 'open', el => el, true, -8, copy => copy.setAttribute('data-sheet', 'open')],
    ['#compact-scrim', el => el.getAttribute('data-open') === 'true', el => el, true, 0, copy => copy.setAttribute('data-open', 'true')],
  ];
  const tracked = new Map<HTMLElement, Surface>();
  const kindOf = (el: Element) => kinds.find(([selector]) => el.matches(selector));
  const capture = (surface: Surface) => { if (!surface.late || !surface.snap) surface.snap = snapshot(surface.el, surface.leaf, !surface.late); else surface.snap.rect = surface.leaf.getBoundingClientRect(); };
  const refresh = () => { for (const surface of tracked.values()) { try { capture(surface); } catch { surface.snap = null; } } };
  const shown = (el: HTMLElement, kind: NonNullable<ReturnType<typeof kindOf>>) => {
    clear(el);
    const leaf = kind[2](el); if (!leaf) return;
    const surface: Surface = { el, leaf, late: kind[3], rise: kind[4], prepare: kind[5], snap: null };
    tracked.set(el, surface);
    // Measure once the entrance has laid out; every press and key (just before a close) measures again.
    win?.requestAnimationFrame(() => win.requestAnimationFrame(() => { if (tracked.get(el) === surface) { try { capture(surface); } catch { /* Presentation only. */ } } }));
  };
  const hidden = (el: HTMLElement) => {
    const surface = tracked.get(el); tracked.delete(el);
    if (!surface?.snap || still()) return;
    let snap = surface.snap;
    // Late copies (the drawer, the sheet, the scrim) are taken now: closing does not change what they showed.
    if (surface.late) { const fresh = snapshot(el, surface.leaf, true, snap.rect); if (!fresh) return; fresh.backdrop = snap.backdrop ?? fresh.backdrop; snap = fresh; }
    surface.prepare(snap.leaf);
    if (el.matches('#compact-scrim')) { ghost(el, snap, [{ opacity: 1 }, { opacity: 0 }], base, exit); return; }
    if (el.matches('dialog.settings-drawer')) {
      const backdrop = snap.backdrop;
      ghost(el, snap, popover(surface.rise, 1), base, exit, backdrop ? root => {
        const layer = doc.createElement('div');
        set(layer, { position: 'fixed', inset: '0', background: backdrop.background, 'backdrop-filter': backdrop.filter, 'pointer-events': 'none' }, 'important');
        root.appendChild(layer);
        try { return layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: base, easing: exit, fill: 'forwards' }); } catch { return null; }
      } : undefined);
      return;
    }
    if (el.matches('#app-sidebar')) { ghost(el, snap, [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 ' + surface.rise + 'px' }], base, exit); return; }
    ghost(el, snap, popover(surface.rise), fast, exit);
  };
  const check = (el: HTMLElement) => {
    const kind = kindOf(el); if (!kind) return;
    const open = kind[1](el), known = tracked.has(el);
    if (open && !known) shown(el, kind);
    else if (open) clear(el);
    else if (known) hidden(el);
  };
  // Removed surfaces: an in-app dialog layer leaves the body; the folder menu and a collapsing folder leave with a rebuild.
  let layers: { el: HTMLElement; snap: Snap }[] = [];
  let folderMenu: { snap: Snap; at: number } | null = null, folder: { key: string; snap: Snap; radius: string; at: number } | null = null;
  const recent = (at: number) => performance.now() - at < 1500;
  const press = (event: Event) => {
    refresh();
    for (const layer of Array.from(doc.querySelectorAll<HTMLElement>('body>.arcane-modal-layer'))) {
      const box = layer.querySelector<HTMLElement>('.arcane-modal'), snap = snapshot(layer, layer, true);
      layers = layers.filter(entry => entry.el !== layer); if (snap && box) layers.push({ el: layer, snap });
    }
    const menu = doc.getElementById('library-folder-menu');
    const menuSnap = menu ? snapshot(menu, menu, true) : null;
    folderMenu = menuSnap ? { snap: menuSnap, at: performance.now() } : null;
    const toggle = (event.target as Element | null)?.closest?.('.library-folder-toggle[aria-expanded=true]');
    const card = toggle?.closest<HTMLElement>('.library-folder'), key = (toggle as HTMLElement | null | undefined)?.dataset.libraryFocus;
    const snap = card ? snapshot(card, card, true) : null;
    const firstRow = card?.querySelector('.library-chat');
    if (snap && firstRow) snap.anchor = { selector: '.library-chat', top: firstRow.getBoundingClientRect().top };
    folder = snap && key && card && win ? { key, snap, radius: win.getComputedStyle(card).borderRadius, at: performance.now() } : null;
  };
  const libraryChanged = () => {
    const library = doc.getElementById('conversation-library');
    if (folderMenu && !doc.getElementById('library-folder-menu')) { if (!still() && recent(folderMenu.at)) ghost(library ?? doc.documentElement, folderMenu.snap, popover(-4), fast, exit); folderMenu = null; }
    if (!folder || !library) return;
    if (!recent(folder.at)) { folder = null; return; }
    const toggle = library.querySelector<HTMLElement>('.library-folder-toggle[data-library-focus="' + CSS.escape(folder.key) + '"]');
    if (toggle?.getAttribute('aria-expanded') !== 'false') return;
    const card = toggle.closest<HTMLElement>('.library-folder'), after = card?.getBoundingClientRect(), { snap, radius } = folder; folder = null;
    const kept = after?.height ?? 0, height = snap.rect.height;
    if (!card || height - kept < 1 || still()) return;
    // Only what the collapse removes (the chats under the folder row) is drawn; it closes up from below in step with the
    // cards beneath, which slide up with the list FLIP (same duration and curve), and fades as it goes.
    const corners = 'round 0 0 ' + radius + ' ' + radius;
    ghost(card, snap, shift => { const top = Math.max(0, kept - shift);
      return [{ opacity: 1, clipPath: 'inset(' + top + 'px 0 ' + Math.max(0, shift) + 'px 0 ' + corners + ')' }, { opacity: 0, clipPath: 'inset(' + top + 'px 0 ' + Math.max(0, height - top) + 'px 0 ' + corners + ')' }]; }, slow, emph);
  };
  let observer: MutationObserver | null = null, removals: MutationObserver | null = null, idle = 0;
  const start = () => {
    if (!win || typeof win.MutationObserver !== 'function' || typeof Element.prototype.animate !== 'function' || observer) return;
    fast = ms(token('--m-fast', '120ms')); base = ms(token('--m-base', '180ms')); slow = ms(token('--m-slow', '240ms'));
    exit = token('--m-exit', exit); emph = token('--m-emph', emph);
    observer = new win.MutationObserver(records => {
      const seen = new Set<HTMLElement>();
      for (const record of records) if (record.type === 'attributes' && record.target instanceof HTMLElement && !seen.has(record.target)) { seen.add(record.target); check(record.target); }
      if (records.some(record => record.type === 'childList' && (record.target as Element).closest?.('#conversation-library'))) libraryChanged();
    });
    observer.observe(doc.documentElement, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'data-open', 'data-sheet'] });
    const library = doc.getElementById('conversation-library');
    if (library) observer.observe(library, { subtree: true, childList: true });
    removals = new win.MutationObserver(records => {
      for (const record of records) for (const node of Array.from(record.removedNodes)) {
        const entry = layers.find(layer => layer.el === node); if (!entry) continue;
        layers = layers.filter(layer => layer !== entry);
        if (!still()) ghost(entry.el, entry.snap, [{ opacity: 1 }, { opacity: 0 }], base, exit);
      }
      for (const record of records) for (const node of Array.from(record.addedNodes)) if (node instanceof HTMLElement && node.matches('.arcane-modal-layer'))
        win.requestAnimationFrame(() => win.requestAnimationFrame(() => { if (!node.isConnected) return; const snap = snapshot(node, node, true); if (snap) { layers = layers.filter(layer => layer.el !== node); layers.push({ el: node, snap }); } }));
    });
    if (doc.body) removals.observe(doc.body, { childList: true });
    for (const kind of kinds) for (const el of Array.from(doc.querySelectorAll<HTMLElement>(kind[0]))) if (kind[1](el)) shown(el, kind);
    doc.addEventListener('pointerdown', press, true); doc.addEventListener('keydown', press, true); win.addEventListener('resize', refresh);
    // Build the copy's stylesheet while the window is idle, so the first close does not pay for it.
    const prepare = () => { if (!still()) void build(); };
    idle = typeof win.requestIdleCallback === 'function' ? win.requestIdleCallback(prepare, { timeout: 1500 }) : win.setTimeout(prepare, 500);
  };
  start();
  return {
    stop() {
      observer?.disconnect(); removals?.disconnect(); observer = null; removals = null;
      doc.removeEventListener('pointerdown', press, true); doc.removeEventListener('keydown', press, true); win?.removeEventListener('resize', refresh);
      if (idle && win) { if (typeof win.cancelIdleCallback === 'function') win.cancelIdleCallback(idle); else win.clearTimeout(idle); } idle = 0;
      for (const el of Array.from(hosts.keys())) clear(el);
      tracked.clear(); layers = []; folderMenu = null; folder = null;
    },
    resume() { start(); },
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let chatTabController: import('./chat-tabs.js').ChatTabsController | null = null;
  let storage: Pick<Storage, 'getItem' | 'setItem'>;
  try { storage = window.sessionStorage; } catch { storage = { getItem: () => null, setItem: () => {} }; }
  const token = takeControlToken(window.location, window.history, storage);
  const editorBridge=(window as unknown as {arcaneDesktop?:{toolDrafts?:EditorDraftBridge}}).arcaneDesktop?.toolDrafts;
  const editorDrafts=editorBridge?new EditorDraftStore(editorBridge):null;
  const memory = startProjectMemory(document, {token:()=>token,drafts:editorDrafts});
  let scriptDrafts:ReturnType<typeof startScriptEditorDrafts>|null=null;
  setProjectMemorySaver(note=>memory.append(note));
  window.addEventListener('pagehide',()=>{memory.stop();setProjectMemorySaver(null);});
  window.addEventListener('pageshow',event=>{if(event.persisted){memory.resume();setProjectMemorySaver(note=>memory.append(note));}});
  // Learning from feedback: chat rating controls, implicit signals and Settings > What Arcane has learned (local only).
  const learned = startLearnedPreferences(document, {token:()=>token});
  setChatFeedbackHooks(learned.hooks);
  const codexApi=new CodexChatApi(token);
  const codexChat = new CodexChat(document, codexApi);
  codexChat.setFeedbackHooks(learned.hooks);
  window.addEventListener('pagehide',()=>{learned.stop();setChatFeedbackHooks(null);codexChat.setFeedbackHooks(null);});
  window.addEventListener('pageshow',event=>{if(event.persisted){learned.resume();setChatFeedbackHooks(learned.hooks);codexChat.setFeedbackHooks(learned.hooks);}});
  // signInPage: the first launch shows the full sign-in page until a usable sign-in or Continue without signing in.
  const providerSetup = startProviderSetup(document, {chat:codexChat, autoSelectSignedIn:true, signInPage:true});
  // Window chrome (desktop only): the native window buttons' background follows the surface, the sign-in page or the workspace.
  const windowChrome = (window as unknown as { arcaneDesktop?: { windowChrome?: { tone(value: 'workspace' | 'page'): void } } }).arcaneDesktop?.windowChrome;
  if (windowChrome) {
    let tone = '';
    const syncTone = () => {
      const next = document.documentElement.getAttribute('data-provider-view') === 'workspace' ? 'workspace' : 'page';
      if (next !== tone) { tone = next; try { windowChrome.tone(next); } catch { /* Presentation only. */ } }
    };
    syncTone();
    const toneWatch = new MutationObserver(syncTone);
    toneWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-provider-view'] });
    window.addEventListener('pagehide', () => { toneWatch.disconnect(); tone = ''; });
    window.addEventListener('pageshow', event => { if (event.persisted) { syncTone(); toneWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-provider-view'] }); } });
  }
  // Both providers share one chat surface (tabs, transcript, composer and model picker). While provider setup reports
  // the Claude surface, Codex pauses drawing there (its state is never destroyed) and the Claude chat renders instead.
  const claudeChat = document.getElementById('codex-compose') ? new ClaudeChat(document) : null;
  const chatQueue = (window as unknown as {arcaneDesktop?:{chatQueue?:ChatQueueBridge}}).arcaneDesktop?.chatQueue ?? null;
  // Each provider recovers its own encrypted text before admitting queued work.
  // The controllers await these reads during restart; direct Send stays responsive.
  void Promise.all([codexChat.setQueuePersistence(chatQueue), claudeChat?.setQueuePersistence(chatQueue)]);
  let claudeChatStopped = false;
  let sharedConversations:SharedConversations|null=null;
  // The composer model list shows ChatGPT and Claude models; picking the other provider's model switches provider
  // explicitly and carries the unsent draft. The link also owns the surface hand-off below.
  const chatLink = claudeChat ? linkChatProviders({ codex: codexChat, claude: claudeChat, provider: providerSetup, enabled: () => !claudeChatStopped,
    beforeProviderSwitch:(from,to)=>sharedConversations?.beforeProviderSwitch(from,to)??Promise.resolve(true) }) : null;
  const showClaudeChat = () => {
    if (chatLink) { chatLink.sync(); return; }
    try { codexChat.yieldSurface(false); } catch { /* A surface hand-off is presentation only and cannot break the workspace. */ }
  };
  if (!chatLink) { providerSetup.subscribeChatSurface(showClaudeChat); showClaudeChat(); }
  // Arcane Credits chat (desktop only): a third model column and chat surface once the user's Arcane account is connected
  // to a configured gateway. Loaded lazily; while not configured it stays hidden and requests nothing over the network.
  let arcaneChat: import('./arcane-chat.js').ArcaneChat | null = null;
  // Bind review to the actual provider transcript, never the shared library row.
  const reviewDesktop = (window as unknown as { arcaneDesktop?: { runtime?: string; selectAssetConversation?: (selection: import('./asset-conversation-selection.js').AssetConversationSelectionValue) => Promise<{state:'selected'|'unavailable'}> } }).arcaneDesktop;
  const reviewSelection = reviewDesktop?.runtime === 'desktop' ? new AssetConversationSelection({
    select: selection => reviewDesktop.selectAssetConversation ? reviewDesktop.selectAssetConversation(selection) : Promise.reject(new Error('Model review conversation is unavailable.')),
  }) : null;
  let reviewSelectionPaused = false;
  let reviewProjectPath: () => string | null = () => null;
  let reviewFocusSignature = '';
  let selectedAssetScope: (AssetConversation & {projectPath:string}) | null = null;
  const assetScopeListeners = new Set<() => void>();
  const publishAssetScope = () => { for (const listener of [...assetScopeListeners]) { try { listener(); } catch { /* One view cannot block other invalidations. */ } } };
  const syncReviewSelection = () => {
    if (!reviewSelection) return;
    const provider = providerSetup.chatSurface();
    const peer = provider === 'claude' ? claudeChat : provider === 'arcane' ? arcaneChat : codexChat;
    const transcript = peer?.recordedTranscript();
    const draft = !peer || peer.isDraftConversation();
    const id = transcript?.conversationId;
    const project = reviewProjectPath();
    const native = provider === 'codex' ? codexChat.workflowConversation() : null;
    const key = JSON.stringify([project, provider, transcript?.projectPath ?? null, id ?? null, transcript?.sessionId ?? null, draft, reviewSelectionPaused, native]);
    if (key === reviewFocusSignature) return;
    reviewFocusSignature = key;
    selectedAssetScope = null; publishAssetScope();
    try {
      const empty = reviewSelectionPaused || draft || !id || !project || transcript?.projectPath !== project ||
        provider === 'codex' && (!native || native.projectPath !== project);
      reviewSelection.update(empty ? null :
        provider === 'codex' ? { provider: 'codex' } : { provider: provider === 'claude' ? 'claude-code' : 'arcane', conversationId: id }, key);
      if (!empty && transcript?.projectPath && id) {
        const scope = provider === 'codex' && native ? { ...native, projectPath: transcript.projectPath } : { provider: provider === 'claude' ? 'claude-code' as const : 'arcane' as const,
          threadId: 'app:' + id, sessionId: null, projectPath: transcript.projectPath };
        void reviewSelection.ready().then(current => {
          if (!current() || key !== reviewFocusSignature || reviewSelectionPaused) return;
          selectedAssetScope = scope; publishAssetScope();
        }).catch(() => { /* Unknown selection never publishes another chat's assets. */ });
      }
    } catch { reviewSelection.update(null, null); }
  };
  if (reviewSelection) {
    const unbind = installAssetReviewSelection(document, reviewSelection);
    const unsubscribers = [codexChat.subscribeTranscriptChange(syncReviewSelection),
      providerSetup.subscribeChatSurface(syncReviewSelection), ...(claudeChat ? [claudeChat.subscribeTranscriptChange(syncReviewSelection)] : [])];
    syncReviewSelection();
    window.addEventListener('pagehide', event => {
      reviewSelectionPaused = true; syncReviewSelection();
      if (!event.persisted) { for (const unsubscribe of unsubscribers) unsubscribe(); reviewSelection.dispose(); unbind(); }
    });
    window.addEventListener('pageshow', event => { if (event.persisted) { reviewSelectionPaused = false; syncReviewSelection(); } });
  }
  if (chatLink && (window as unknown as { arcaneDesktop?: { arcaneChat?: unknown } }).arcaneDesktop?.arcaneChat) void import('./arcane-chat.js').then(module => {
    if (claudeChatStopped) return;
    const chat = arcaneChat = new module.ArcaneChat(document);
    if (reviewSelection) chat.subscribeTranscriptChange(syncReviewSelection);
    syncReviewSelection();
    // The sign-in card offers Arcane Credits when usable, or says plainly what is missing (an account, or the service).
    chat.subscribeModels(() => { providerSetup.setArcaneAvailable(chat.usable()); providerSetup.setArcaneSetup?.(chat.arcaneStatus()?.state === 'signed-out' ? 'signed-out' : 'none'); });
    chatLink.setArcane(chat); void chat.loadModels();
  }).catch(() => { /* Arcane Credits chat is optional; ChatGPT and Claude are unaffected. */ });
  void import('./desktop-update.js').then(module=>{
    const updates=module.startDesktopUpdates(document,{beforeRestart:async()=>{await memory.prepareForRestart();await scriptDrafts?.prepareForRestart();await arcaneChat?.prepareForRestart();await claudeChat?.prepareForRestart();await codexChat.prepareForRestart();await sharedConversations?.prepareForRestart();}});
    window.addEventListener('pagehide',()=>updates.stop());window.addEventListener('pageshow',event=>{if(event.persisted)updates.resume();});
  }).catch(()=>{});
  let recovery:ReturnType<typeof startRuntimeRecovery>|null=null;
  {
    recovery=startRuntimeRecovery(document,{checkpoint:async()=>{await memory.prepareForRestart();await scriptDrafts?.prepareForRestart();await arcaneChat?.prepareForRuntimeRecovery();await claudeChat?.prepareForRuntimeRecovery();await codexChat.prepareForRuntimeRecovery();}});
    window.addEventListener('pagehide',()=>recovery?.stop());
    window.addEventListener('pageshow',event=>{if(event.persisted)recovery?.resume();});
  }
  const nativeHandoff = startNativeHandoff(document, {provider:providerSetup});
  // The latest Codex usage view feeds the composer's context ring (started below, once the workbench exists).
  let codexUsageView: TaskUsageView | null = null, composerChrome: ComposerChromeController | null = null;
  const taskUsageFooter = startTaskUsageFooter(document, codexChat, { onView: view => { codexUsageView = view; composerChrome?.refresh(); } });
  const playtestRoot=document.getElementById('playtest-panel');
  // Composer Playtest switch (remembered per project); when on, the panel approves the managed chat's requests itself.
  const toolboxPolicy=startToolboxPolicy(document,{token:()=>token});
  window.addEventListener('pagehide',()=>toolboxPolicy.stop());
  window.addEventListener('pageshow',event=>{if(event.persisted)toolboxPolicy.resume();});
  const playtestToggle=startPlaytestToggle(document,{projectKey:()=>workbench.getCurrentProduct()?.projectId??null});
  let playtests:ReturnType<typeof startPlaytestPanel>|null=null,playtestAuthEpoch=0,removePlaytestAuth:(()=>void)|null=null;
  const workbench = new StudioWorkbench(document, new StudioApi(token), window.location.origin, token, {
    isSignedIn: () => providerSetup.isSignedIn(),
    subscribeSignInChange: listener => providerSetup.subscribeSignInChange(listener),
    assetMode: 'conversation', getNativeConversation: () => reviewSelection ? selectedAssetScope : codexChat.workflowConversation(),
    subscribeContextChange: listener => {
      if (!reviewSelection) return codexChat.subscribeWorkflowContextChange(listener);
      assetScopeListeners.add(listener); return () => { assetScopeListeners.delete(listener); };
    },
  });
  const startTests=()=>{
    removePlaytestAuth?.();removePlaytestAuth=providerSetup.subscribeSignInChange(()=>{playtestAuthEpoch++;void playtests?.refresh();});
    return playtestRoot?startPlaytestPanel({root:playtestRoot,token:()=>token,isSignedIn:()=>providerSetup.isSignedIn(),reports:true,
      reportContext:()=>{const current=workbench.getPlaytestReportContext();return current?{...current,authEpoch:playtestAuthEpoch}:null;},autoApprove:()=>playtestToggle.enabled()}):null;
  };
  const stopTests=()=>{removePlaytestAuth?.();removePlaytestAuth=null;playtests?.stop();playtests=null;};
  playtests=startTests();
  reviewProjectPath = () => workbench.historyProjectPath() || null;
  if (reviewSelection) workbench.subscribeProjectChange(syncReviewSelection);
  syncReviewSelection();
  // Runs synchronously before the product read draws the new project, so one project's unsent draft is never shown in another.
  workbench.subscribeProjectChange(() => { try { codexChat.observeWorkspaceProject(workbench.historyProjectPath() || null); } catch { /* Presentation only. */ } });
  // Script-editor drafts: recovered source text only fills the editor on an explicit click and never submits a command.
  if (editorDrafts) {
    scriptDrafts = startScriptEditorDrafts(document, { drafts: editorDrafts, target: () => workbench.sourceDraftTarget(),
      restore: value => workbench.restoreSourceDraft(value), clear: value => workbench.clearSourceDraft(value),
      subscribeContext: listener => workbench.subscribeSourceDraftContext(listener),
      subscribeApplied: listener => workbench.subscribeSourceDraftApplied(listener) });
    window.addEventListener('pagehide', () => scriptDrafts?.stop());
    window.addEventListener('pageshow', event => { if (event.persisted) scriptDrafts?.resume(); });
  }
  const desktopVerification = startDesktopVerification(document, {
    getProjectId: () => workbench.getCurrentProduct()?.projectId ?? null,
    subscribeProjectChange: listener => workbench.subscribeProjectChange(listener),
  });
  const learningPanel = new LearningPanel(document, token); learningPanel.start();
  const historyPanel = new CodexHistoryPanel(document, { getToken: () => token, getProjectPath: () => workbench.historyProjectPath() }); historyPanel.start();
  // First-run setup checklist and the Settings plugin card: local status reads only, one-click fixes on explicit clicks.
  let checklistStorage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
  try { checklistStorage = window.localStorage; } catch { checklistStorage = null; }
  // One-click Studio pairing: a trusted click opens a short-lived code; the plugin claims it with one click.
  const studioPairing = new StudioPairing(document, window.location.origin, token);
  const setupChecklist = startSetupChecklist(document, { provider: providerSetup, workbench, storage: checklistStorage,
    desktop: (window as unknown as { arcaneDesktop?: unknown }).arcaneDesktop, pairing: studioPairing });
  window.addEventListener('pagehide', () => { setupChecklist.stop(); studioPairing.stop(); });
  // Mid-build disconnects: a banner above the chat while the live Studio session is gone (reconnecting / Reconnect Studio).
  const studioBanner = startStudioConnectionBanner(document, { workbench });
  window.addEventListener('pagehide', () => studioBanner.stop());
  // Composer chrome (presentation only): Pyx perch, agents count, context ring, closed model chip, queue card placement.
  // Pyx's pop-out window is C23 (desktop host/IPC); until the preload exposes arcaneDesktop.pyx.open the click only dispatches 'arcane:pyxopen'.
  const pyxHost = (window as unknown as { arcaneDesktop?: { pyx?: { open?: () => unknown } } }).arcaneDesktop?.pyx;
  composerChrome = startComposerChrome(document, {
    surface: () => providerSetup.chatSurface(), subscribeSurface: listener => providerSetup.subscribeChatSurface(listener),
    studioConnected: () => workbench.studioConnected(), subscribeStudio: listener => workbench.subscribeStudioChange(listener),
    subagents: () => claudeChat?.subagents() ?? [],
    contextWindow: () => providerSetup.chatSurface() === 'codex' ? codexContextWindow(codexUsageView) : null,
    turnFailed: () => codexUsageView?.status === 'failed',
    providerLogo: provider => providerLogo(document, provider),
    ...(typeof pyxHost?.open === 'function' ? { openPyx: () => { void pyxHost.open?.(); } } : {}),
  });
  window.addEventListener('pagehide', () => composerChrome?.stop());
  // Pyx pop-out bar, workspace side: publish what the workspace shows and route the bar's instructions through the main
  // composer's own controls (send, queue or steer exactly as Enter here). Dynamic import keeps the static module list unchanged.
  if (pyxHost && typeof (pyxHost as { publish?: unknown }).publish === 'function') void import('./pyx-link.js').then(({ startPyxLink }) => {
    const link = startPyxLink(document, { bridge: pyxHost as unknown as import('./pyx-link.js').PyxHostBridge,
      surface: () => providerSetup.chatSurface(), subscribeSurface: listener => providerSetup.subscribeChatSurface(listener) });
    window.addEventListener('pagehide', () => link.stop());
  }).catch(() => { /* Pyx is optional; the workspace is unaffected. */ });
  window.addEventListener('pageshow', event => { if (event.persisted) composerChrome?.resume(); });
  // C31 motion: keyed FLIP for the chat library and the composer queues (presentation only; nothing with reduced motion).
  const listMotion = startListMotion(document);
  window.addEventListener('pagehide', () => listMotion.stop());
  window.addEventListener('pageshow', event => { if (event.persisted) listMotion.resume(); });
  // C31 motion, exits: a closing menu, popover, drawer, dialog, sheet or folder fades as a still copy (presentation only).
  const exitMotion = startExitMotion(document);
  window.addEventListener('pagehide', () => exitMotion.stop());
  window.addEventListener('pageshow', event => { if (event.persisted) exitMotion.resume(); });
  window.addEventListener('pageshow', event => { if (event.persisted) studioBanner.resume(); });
  // Top bar and chat header (presentation only): Studio pill from the current session, chat title, menus, resting notice line.
  // Optional like the Studio output dock: without it the top bar keeps its static markup and every control still works.
  let workspaceTopbar: { stop(): void; resume(): void } | null = null, workspaceTopbarStopped = false;
  void import('./workspace-topbar.js').then(module => { workspaceTopbar = module.startWorkspaceTopbar(document, { workbench }); if (workspaceTopbarStopped) workspaceTopbar.stop(); }).catch(() => {});
  window.addEventListener('pagehide', () => { workspaceTopbarStopped = true; workspaceTopbar?.stop(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { workspaceTopbarStopped = false; workspaceTopbar?.resume(); } });
  // Quick-start gallery on the empty chat: a click only fills the composer for review.
  startStarterGallery(document);
  // Optional welcome tour: once after sign-in on the desktop app's first launch, and from Settings › Guide › Replay tour.
  const welcomeTour = startWelcomeTour(document, { storage: checklistStorage, autoStart: !!(window as unknown as { arcaneDesktop?: unknown }).arcaneDesktop });
  window.addEventListener('pagehide', () => welcomeTour.close('paused'));
  window.addEventListener('pageshow', event => { if (event.persisted) { setupChecklist.resume(); studioPairing.resume(); } });
  let workflows: ReturnType<typeof startWorkflowPanel> | null = null;
  let workflowsStopped = false;
  const refreshWorkflowContext = () => { if (!workflowsStopped) void workflows?.resume(); };
  // Keep workflow loading optional so an older daemon's missing module cannot break chat.
  void import('./workflow-panel.js').then(module => {
    workflows = module.startWorkflowPanel(document, {...createWorkflowContextOptions(() => token, workbench, codexChat, refreshWorkflowContext),
      appendToDraft:(text,provenance)=>{
        const appended=codexChat.appendWorkflowDraft(text,provenance);
        if(appended)workspaceShell.showConversation();
        return appended;
      }});
    if (!workflowsStopped) return workflows.start();
  }).catch(() => { const mount = document.getElementById('workflow-panel'); if (mount) mount.textContent = 'Restart Arcane to load the workflow tools.'; });
  const dismissConnectionSecrets = () => workbench.dismissConnectionSecrets();
  let workspaceShell = startWorkspaceShell(document, dismissConnectionSecrets);
  let taskPlanCard:ReturnType<typeof import('./task-plan-boot.js').startTaskPlanCard>|null=null;
  void import('./task-plan-boot.js').then(module=>{
    taskPlanCard=module.startTaskPlanCard(document,{chat:codexChat,api:codexApi,
      openReview:async(runId,isCurrent)=>{if(await workbench.openWorkRun(runId,isCurrent)&&isCurrent())workspaceShell.showRecordedWork();}});
    if(workflowsStopped)taskPlanCard.stop();
  }).catch(()=>{const mount=document.getElementById('codex-task-plan');if(mount)mount.textContent='Restart Arcane to load task progress.';});
  // Live Studio error dock (studio-diagnostics.ts). Optional: a missing module never breaks the workspace.
  let studioDiagnostics:{stop():void;resume():void}|null=null;
  // Arcane-styled in-app dialogs and the per-project Permissions card (arcane-dialog.ts). Optional: without it the
  // desktop host keeps native dialogs and nothing is auto-approved.
  let arcaneDialogs:{stop():void;resume():void}|null=null;
  void import('./arcane-dialog.js').then(module=>{arcaneDialogs=module.startArcaneDialogs(document,{desktop:(window as unknown as {arcaneDesktop?:unknown}).arcaneDesktop,codex:codexChat});if(workflowsStopped)arcaneDialogs.stop();}).catch(()=>{});
  window.addEventListener('pagehide',()=>arcaneDialogs?.stop());
  window.addEventListener('pageshow',event=>{if(event.persisted)arcaneDialogs?.resume();});
  // Plans & credits: local Arcane actions usage and the checkout seam that stays disabled until configured.
  void import('./plans.js').then(module=>{const plans=module.startPlans(document,{token:()=>token,desktop:(window as unknown as {arcaneDesktop?:import('./plans.js').PlansOptions['desktop']}).arcaneDesktop??null,open:url=>{window.open(url,'_blank','noopener,noreferrer');}});window.addEventListener('pagehide',()=>plans.stop());window.addEventListener('pageshow',event=>{if(event.persisted)plans.resume();});}).catch(()=>{});
  // Project memory (Settings › Project memory): ARCANE.md that both providers read; chat "Save to project memory" buttons append through it.
  // Script sync (Settings › Project memory): opt-in mirror of granted Studio scripts into the project src folder.
  // Imported models and effects: "Choose an asset", the asset picker, drops on the preview. Files are opened only by the desktop host.
  void import('./asset-imports.js').then(module=>{const start=()=>module.startAssetImports(document,{token:()=>token,library:workbench.assetLibrary(),desktop:(window as unknown as {arcaneDesktop?:import('./asset-imports.js').AssetImportOptions['desktop']}).arcaneDesktop??null});let imports=start();window.addEventListener('pagehide',()=>imports.stop());window.addEventListener('pageshow',event=>{if(event.persisted)imports=start();});}).catch(()=>{});
  // Keep this mesh: assets panel + chat asset cards; the click goes to the desktop host's trusted confirmation.
  void import('./mesh-keep.js').then(module=>{const keep=module.startMeshKeep(document,{token:()=>token,desktop:(window as unknown as {arcaneDesktop?:import('./mesh-keep.js').MeshKeepOptions['desktop']}).arcaneDesktop??null});window.addEventListener('pagehide',()=>keep.stop());window.addEventListener('pageshow',event=>{if(event.persisted)keep.resume();});}).catch(()=>{});
  void import('./script-sync.js').then(module=>{const sync=module.startScriptSync(document,{token:()=>token});window.addEventListener('pagehide',()=>sync.stop());window.addEventListener('pageshow',event=>{if(event.persisted)sync.resume();});}).catch(()=>{});
  // Build-done notifications: one native notification when a chat turn ends while Arcane is in the background.
  void import('./notifications.js').then(module=>{const start=()=>module.startBuildNotifications(document,{desktop:(window as unknown as {arcaneDesktop?:import('./notifications.js').BuildNotificationOptions['desktop']}).arcaneDesktop??null,storage:checklistStorage});let notices=start();window.addEventListener('pagehide',()=>notices.stop());window.addEventListener('pageshow',event=>{if(event.persisted){notices.stop();notices=start();}});}).catch(()=>{});
  void import('./studio-diagnostics.js').then(module=>{studioDiagnostics=module.startStudioDiagnostics(document,{token:()=>token,active:()=>workbench.hasStudioSessions(),showConversation:()=>workspaceShell.showConversation()});if(workflowsStopped)studioDiagnostics.stop();}).catch(()=>{});
  window.addEventListener('pagehide', () => { workflowsStopped = true; claudeChatStopped = true; chatLink?.stop(); claudeChat?.stop(); arcaneChat?.stop(); taskPlanCard?.stop(); studioDiagnostics?.stop(); nativeHandoff.stop(); stopTests();chatTabController?.stop(); taskUsageFooter.stop(); providerSetup.stop(); desktopVerification.stop(); workspaceShell.cleanup(); workbench.stop(); codexChat.stop(); learningPanel.stop(); historyPanel.stop();workflows?.stop(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { workflowsStopped = false; claudeChatStopped = false; showClaudeChat(); taskPlanCard?.resume(); studioDiagnostics?.resume(); providerSetup.resume(); nativeHandoff.resume(); playtests=startTests(); desktopVerification.resume(); workspaceShell = startWorkspaceShell(document, dismissConnectionSecrets); workbench.resume(); codexChat.resume(); chatTabController?.resume(); taskUsageFooter.resume(); learningPanel.resume(); historyPanel.resume();void workflows?.resume(); } });
  void codexChat.start().then(async () => {
    const module = await import('./chat-tabs.js');
    chatTabController = await module.startChatTabs(document, { chat: codexChat, captureLegacyNewChat: true,
      beforeNewChat: () => {sharedConversations?.beginNewConversation();workspaceShell.showConversation();},
      // While the Claude surface is shown, sidebar New chat and Ctrl/Cmd+N start a new Claude conversation instead.
      alternateNewChat: { active: () => !claudeChatStopped && (!!claudeChat && providerSetup.chatSurface() === 'claude' || !!arcaneChat && providerSetup.chatSurface() === 'arcane'),
        start: () => { if (providerSetup.chatSurface() === 'arcane') arcaneChat?.newChat(); else claudeChat?.newChat(); } } });
    if(claudeChat){
      sharedConversations=new SharedConversations(document,{provider:()=>providerSetup.chatSurface(),requestProvider:p=>providerSetup.requestProvider(p),peers:{
        codex:{recordedTranscript:()=>codexChat.recordedTranscript(),isDraftConversation:()=>codexChat.isDraftConversation(),subscribeTranscriptChange:f=>codexChat.subscribeTranscriptChange(f),setBeforeMessageSubmit:f=>codexChat.setBeforeMessageSubmit(f),showConversationNotice:t=>codexChat.showConversationNotice(t),open:id=>codexChat.openSavedChat(id),newChat:()=>codexChat.newChat()},
        claude:{recordedTranscript:()=>claudeChat.recordedTranscript(),isDraftConversation:()=>claudeChat.isDraftConversation(),subscribeTranscriptChange:f=>claudeChat.subscribeTranscriptChange(f),setBeforeMessageSubmit:f=>claudeChat.setBeforeMessageSubmit(f),showConversationNotice:t=>claudeChat.showConversationNotice(t),open:id=>claudeChat.openRecordedConversation(id),newChat:async()=>{await claudeChat.readyForRuntimeRecovery();claudeChat.newChat();return claudeChat.isDraftConversation();}},
      }});
      window.addEventListener('pagehide',()=>sharedConversations?.stop());window.addEventListener('pageshow',e=>{if(e.persisted)sharedConversations?.resume();});
    }
    const attachments=await import('./chat-attachments.js');
    codexChat.enableTextAttachments(attachments.startChatAttachments(document,{
      getScope:()=>codexChat.textAttachmentScope(),onChange:()=>codexChat.attachmentPresentationChanged(),
      imageInputAvailable:()=>codexChat.referenceImageInputAvailable(),
    }));
    if (workflowsStopped) chatTabController.stop();
    if(!workflowsStopped){await arcaneChat?.readyForRuntimeRecovery();await claudeChat?.readyForRuntimeRecovery();await codexChat.readyForRuntimeRecovery();if(await memory.readyForRuntimeRecovery()&&(await scriptDrafts?.readyForRuntimeRecovery()??true))await recovery?.ready();}
  }).catch(() => { const notice = document.getElementById('codex-notice'); if (notice) notice.textContent = 'Chat could not be opened. Your saved history is unchanged.'; });
  void workbench.start().catch(error => { const notice = document.getElementById('notice'); if (notice) { notice.textContent = error instanceof Error ? error.message : String(error); notice.className = 'notice error'; } });
}

/** C31 motion: keyed FLIP for the two lists that scripts rebuild wholesale, the chat library and the composer queues. A CSS
 * entrance would replay on every rebuild, so this remembers where each keyed item sat and, after a rebuild, slides the
 * survivors from their old place, rises genuinely new items in, reveals a folder that opened and turns its chevron. Only
 * translate, rotate, opacity and clip-path move (Web Animations, 240 ms, emphasised curve); nothing runs with reduced
 * motion, while the page is hidden or on the first fill. Presentation only: no DOM, focus or state is changed. */
function startListMotion(doc: Document): { stop(): void; resume(): void } {
  const win = doc.defaultView;
  const EASE = 'cubic-bezier(.3,0,0,1)', SLOW = 240, FAST = 180;
  type Box = { x: number; y: number; w: number; h: number };
  type List = { root: Element; items: string; key: (el: HTMLElement) => string | null; mover: (el: HTMLElement) => HTMLElement; boxes: Map<string, Box> | null; expanded: Map<string, boolean> };
  const lists = new Map<Element, List>();
  let observer: MutationObserver | null = null, host: MutationObserver | null = null;
  const still = () => !win || doc.visibilityState === 'hidden' || !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const measure = (list: List) => {
    const base = list.root.getBoundingClientRect(), boxes = new Map<string, Box>();
    for (const el of Array.from(list.root.querySelectorAll<HTMLElement>(list.items))) {
      const key = list.key(el); if (!key || boxes.has(key)) continue;
      const r = list.mover(el).getBoundingClientRect();
      if (r.width || r.height) boxes.set(key, { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
    }
    return boxes;
  };
  const folders = (list: List) => new Map(Array.from(list.root.querySelectorAll<HTMLElement>('.library-folder-toggle[aria-controls]'))
    .map(el => [el.dataset.libraryFocus ?? '', el.getAttribute('aria-expanded') === 'true'] as const).filter(([key]) => !!key));
  const play = (el: Element, frames: Keyframe[], duration: number) => { try { el.animate(frames, { duration, easing: EASE }); } catch { /* Presentation only. */ } };
  const settle = (list: List) => {
    const before = list.boxes, opened = list.expanded;
    // A transiently empty list (a busy notice, Loading…) keeps the last real layout to compare against; the first fill is still.
    const after = measure(list); list.expanded = folders(list);
    if (!after.size) return;
    list.boxes = after;
    if (!before?.size || still()) return;
    const revealed: HTMLElement[] = [];
    for (const [key, open] of list.expanded) {
      const was = opened.get(key); if (was === undefined || was === open) continue;
      const toggle = list.root.querySelector<HTMLElement>('.library-folder-toggle[data-library-focus="' + CSS.escape(key) + '"]');
      const chevron = toggle?.querySelector('.library-chevron');
      if (chevron) play(chevron, [{ rotate: open ? '-90deg' : '90deg' }, { rotate: '0deg' }], SLOW);
      // An opened folder's card grows from its old height (a clip, no layout animation) while its chats fade in under the row.
      const group = toggle?.closest<HTMLElement>('.library-folder'), groupKey = group ? list.key(group) : null;
      const grew = groupKey ? (after.get(groupKey)?.h ?? 0) - (before.get(groupKey)?.h ?? 0) : 0;
      if (open && group && grew > 0) play(group, [{ clipPath: 'inset(0 0 ' + grew + 'px 0)' }, { clipPath: 'inset(0 0 0 0)' }], SLOW);
      const body = open && toggle ? doc.getElementById(toggle.getAttribute('aria-controls') ?? '') : null;
      if (body) { revealed.push(body); play(body, [{ opacity: 0, translate: '0 -4px' }, { opacity: 1, translate: '0 0' }], SLOW); }
    }
    const fresh: HTMLElement[] = [], seen = new Set<string>();
    for (const el of Array.from(list.root.querySelectorAll<HTMLElement>(list.items))) {
      const key = list.key(el); if (!key || seen.has(key)) continue; seen.add(key);
      const mover = list.mover(el), now = after.get(key), was = before.get(key);
      if (!now) continue;
      if (!was) { if (!revealed.some(body => body.contains(mover))) fresh.push(mover); continue; }
      const dx = was.x - now.x, dy = was.y - now.y;
      if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) play(mover, [{ translate: dx + 'px ' + dy + 'px' }, { translate: '0 0' }], SLOW);
    }
    // A bulk change (Show all, first load of a project) fades in together; a single new item rises 6 px.
    for (const mover of fresh) play(mover, fresh.length > 6 ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }], fresh.length > 6 ? FAST : SLOW);
  };
  const track = (root: Element, items: string, key: List['key'], mover: List['mover']) => {
    if (lists.has(root)) return;
    const list: List = { root, items, key, mover, boxes: null, expanded: new Map() };
    lists.set(root, list); list.boxes = measure(list); list.expanded = folders(list);
    observer?.observe(root, { childList: true, subtree: true });
  };
  const queues = () => {
    for (const strip of Array.from(doc.querySelectorAll('.queue-strip'))) track(strip, '.queue-row[data-queue-id]', el => el.dataset.queueId ?? null, el => el);
  };
  const start = () => {
    if (!win || typeof win.MutationObserver !== 'function' || typeof Element.prototype.animate !== 'function' || observer) return;
    observer = new win.MutationObserver(records => {
      const touched = new Set<List>();
      for (const record of records) for (const [root, list] of lists) if (root === record.target || root.contains(record.target)) touched.add(list);
      for (const list of touched) settle(list);
    });
    const library = doc.getElementById('conversation-library');
    // Folders move as whole cards (keyed by their actions button, which survives renaming); their rows ride along.
    if (library) track(library, '.library-folder,.library-heading,.library-create,[data-library-focus]:not([data-library-focus^="more:"]):not(input)',
      el => el.classList.contains('library-folder') ? 'group:' + (el.querySelector<HTMLElement>('.library-folder-more')?.dataset.libraryFocus ?? el.getAttribute('aria-label') ?? '')
        : el.closest('.library-folder') ? null : el.classList.contains('library-create') ? 'create' : el.dataset.libraryFocus ?? (el.id ? '#' + el.id : null), el => el);
    queues();
    // Queue strips are created on first use and moved beside the composer: watch the composer's parent (children only).
    const form = doc.getElementById('codex-compose')?.parentElement;
    if (form) { host = new win.MutationObserver(queues); host.observe(form, { childList: true }); }
  };
  start();
  return {
    stop() { observer?.disconnect(); host?.disconnect(); observer = null; host = null; lists.clear(); },
    resume() { start(); },
  };
}
