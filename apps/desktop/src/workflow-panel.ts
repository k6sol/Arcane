/// <reference lib="dom" />
import type { HumanGate, RequestedModel, WorkflowRecipe, WorkflowRecipeRequest, WorkflowSubmission } from '../../../packages/core/src/workflow-recipes.js';
import type { WorkflowSnapshot } from '../../daemon/src/workflow-service.js';
import type { WorkflowPreview, WorkflowPreviewInput } from '../../daemon/src/workflow-host.js';

export const WORKFLOW_RESPONSE_BYTES = 4 * 1024 * 1024;
export const WORKFLOW_REQUEST_BYTES = 128 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATES = ['creating', 'active', 'uncertain', 'halted'];
const KINDS = ['create-recipe', 'recipe-gate', 'submit-evidence', 'review-evidence', 'reconcile'];
const RESULTS = ['created', 'decided', 'submitted', 'reviewed', 'reconciled'];
const GATES: readonly HumanGate[] = ['model-handoff', 'plan-acceptance', 'local-write', 'studio-write', 'studio-playtest', 'preview-acceptance', 'final-review'];
const ROLES = ['brief', 'requirements', 'plan', 'diagnosis', 'patch', 'blend-source', 'engine-export', 'preview', 'hero-preview', 'profile-preview', 'scale-preview', 'reference-comparison', 'report', 'studio-receipt', 'playtest-log', 'reproduction', 'review'];
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
type Row = Record<string, unknown>;
export type PanelWorkflowPreview = WorkflowPreview & Record<string, unknown>;
export interface NativeWorkflowConversation {
  provider: 'codex' | 'claude-code'; threadId: string; sessionId: string | null; connectionId?: string; projectPath?: string;
}
export interface WorkflowPanelOptions {
  getToken(): string | null;
  getProjectPath(): string | null;
  /** Observed from the existing native controller, never from an input element. */
  getNativeConversation?(): NativeWorkflowConversation | null;
  getModelSelection?(): RequestedModel | null;
  /** Notify synchronously on changes, including a change away and back. */
  subscribeContextChange?(invalidate: () => void): () => void;
  /** Trusted adapter for server-attested conversation metadata using another schema. */
  isWorkflowInNativeConversation?(value: WorkflowSnapshot | PanelWorkflowPreview, conversation: NativeWorkflowConversation): boolean;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export interface WorkflowPanelController {
  start(): Promise<void>; resume(): Promise<void>; stop(): void; cleanup(): void;
}
export class WorkflowPanelError extends Error {
  constructor(message: string, readonly unknownOutcome = false) { super(message); }
}
function invalid(): never { throw new WorkflowPanelError('Invalid workflow data. Refresh explicitly.'); }
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Row;
}
function exact(value: unknown, required: string[], optional: string[] = []): Row {
  const result = row(value);
  if (required.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return result;
}
function string(value: unknown, max = 8000): string {
  if (typeof value !== 'string' || !value.trim() || bytes(value) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value) || /[\ud800-\udfff]/u.test(value)) invalid();
  return value;
}
function identifier(value: unknown): string { const result = string(value, 64); if (!ID.test(result)) invalid(); return result; }
function hash(value: unknown): string { const result = string(value, 64); if (!HASH.test(result)) invalid(); return result; }
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
function member(value: unknown, choices: readonly string[]): string { const result = string(value); if (!choices.includes(result)) invalid(); return result; }
function integer(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(); return value as number; }
/** Bound every value, including attested extensions, before copying/rendering. */
function jsonCopy<T>(value: T, maximum = WORKFLOW_RESPONSE_BYTES, depthLimit = 40, nodeLimit = 160000): T {
  let nodes = 0;
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > nodeLimit || depth > depthLimit) invalid();
    if (item && typeof item === 'object') {
      if (![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(item))) invalid();
      for (const key of Object.keys(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor)) invalid();
        walk(descriptor.value, depth + 1);
      }
    } else if (item !== null && typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))) invalid();
  };
  walk(value, 0);
  const serialized = JSON.stringify(value);
  if (bytes(serialized) > maximum) invalid();
  return JSON.parse(serialized) as T;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Row)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function relativePath(value: unknown): string {
  const result = string(value, 300).replaceAll('\\', '/');
  const forbidden = ['.git', '.codex', '.agents', '.aws', '.ssh', '.azure', '.env', 'node_modules'];
  if (result.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || forbidden.includes(part.toLowerCase()) || part.toLowerCase().startsWith('.env.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) invalid();
  return result;
}
function observedModel(value: RequestedModel | null): RequestedModel | null {
  if (value === null) return null;
  const model = exact(value, ['provider', 'model', 'effort', 'connectionRevision']);
  member(model.provider, ['codex', 'claude']); string(model.model, 160); string(model.connectionRevision, 160);
  member(model.effort, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  return jsonCopy(value);
}
function nativeConversation(value: NativeWorkflowConversation): NativeWorkflowConversation {
  const native = exact(value, ['provider', 'threadId', 'sessionId'], ['connectionId', 'projectPath']);
  member(native.provider, ['codex', 'claude-code']); string(native.threadId, 256);
  if (native.sessionId !== null) string(native.sessionId, 256);
  if (native.connectionId !== undefined) string(native.connectionId, 256);
  if (native.projectPath !== undefined) string(native.projectPath, 4096);
  return jsonCopy(value);
}
function recipe(value: unknown): WorkflowRecipe {
  const r = row(value);
  string(r.id, 100); string(r.title); string(r.objective); member(r.deliverable, ['code-change', 'production-asset', 'playtest-repair']); member(r.engine, ['roblox', 'blender']); row(r.policy);
  const keys = new Set<string>();
  for (const value of array(r.steps, 24)) {
    const s = row(value), key = identifier(s.key);
    if (keys.has(key)) invalid(); keys.add(key);
    string(s.title); string(s.instructions); string(s.acceptance); string(s.stage, 64); string(s.action, 64);
    member(s.execution, ['human', 'native-handoff', 'local-authoring', 'local-verification', 'studio-handoff']);
    for (const path of array(s.scope, 20)) relativePath(path);
    for (const key of array(s.dependencies, 24)) identifier(key);
    for (const key of array(s.subjectSteps, 24)) identifier(key);
    for (const gate of array(s.gates, 7)) member(gate, GATES);
    for (const cap of array(s.capabilities, 24)) string(cap, 256);
    const quality = row(s.quality);
    for (const role of array(quality.roles, 20)) member(role, ROLES);
    for (const value of array(quality.checks, 20)) { const check = row(value); string(check.id, 64); member(check.rule, ['pass', 'at-most', 'at-least']); if (check.limit !== null && (typeof check.limit !== 'number' || !Number.isFinite(check.limit))) invalid(); }
    row(s.retry);
  }
  if (!keys.size) invalid();
  return value as WorkflowRecipe;
}
function artifact(value: unknown, pinned = false): void {
  const a = exact(value, ['path', 'role', 'sha256', 'bytes', ...(pinned ? ['stepKey'] : [])]);
  relativePath(a.path); member(a.role, ROLES); hash(a.sha256); integer(a.bytes, 1, 16 * 1024 * 1024);
  if (pinned) identifier(a.stepKey);
}
/** Actual file references only; no fabricated hashes or inferred check results. */
export function readWorkflowSubmission(value: unknown): WorkflowSubmission {
  const copy = jsonCopy(value, WORKFLOW_REQUEST_BYTES, 16, 16000);
  const s = exact(copy, ['key', 'artifacts', 'subjectHashes', 'checks']); identifier(s.key);
  const artifacts = array(s.artifacts, 20); artifacts.forEach(value => artifact(value));
  if (new Set(artifacts.map(a => String(row(a).path).toLowerCase())).size !== artifacts.length || new Set(artifacts.map(a => row(a).sha256)).size !== artifacts.length) invalid();
  array(s.subjectHashes, 480).forEach(hash);
  const checks = array(s.checks, 20);
  for (const value of checks) {
    const c = exact(value, ['id', 'outcome', 'evidenceSha256', 'subjectDigest'], ['value']); string(c.id, 64); member(c.outcome, ['pass', 'fail', 'pending', 'unsupported']); hash(c.evidenceSha256); hash(c.subjectDigest);
    if (c.value !== undefined && (typeof c.value !== 'number' || !Number.isFinite(c.value) || c.value < 0)) invalid();
  }
  if (new Set(checks.map(c => row(c).id)).size !== checks.length) invalid();
  const normalized = copy as WorkflowSubmission;
  for (const artifact of normalized.artifacts) artifact.path = relativePath(artifact.path);
  normalized.artifacts.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  normalized.subjectHashes = [...new Set(normalized.subjectHashes)].sort();
  normalized.checks.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return normalized;
}
export interface WorkflowList { projectId: string; workflows: { id: string; recipeId: string; state: string }[] }
export function readWorkflowList(value: unknown): WorkflowList {
  const result = jsonCopy(value), r = row(result); hash(r.projectId);
  const workflows = array(r.workflows, 64);
  workflows.forEach(value => { const w = row(value); identifier(w.id); string(w.recipeId, 100); member(w.state, STATES); });
  if (new Set(workflows.map(w => row(w).id)).size !== workflows.length) invalid();
  return result as WorkflowList;
}
export function readWorkflowSnapshot(value: unknown, projectId: string): WorkflowSnapshot {
  const result = jsonCopy(value), r = row(result), w = row(r.workflow);
  if (hash(w.projectId) !== projectId) invalid(); identifier(w.id); recipe(w.recipe); member(w.state, STATES); hash(w.creationReceiptHash); integer(w.revision, 0, Number.MAX_SAFE_INTEGER);
  if (w.runId !== null) identifier(w.runId);
  row(w.taskIds); row(w.taskStates); array(w.decisions, 256); array(w.attempts, 48);
  array(w.submissions, 24).forEach(readWorkflowSubmission);
  if (w.operation !== null) { const op = row(w.operation); identifier(op.key); string(op.kind, 64); if (op.stepKey !== null) identifier(op.stepKey); }
  array(r.tasks, 24).forEach(value => { const t = row(value); identifier(t.key); string(t.state, 64); });
  if (r.assessment !== null) {
    const a = row(r.assessment);
    if (a.workflowId !== row(w.recipe).id) invalid();
    const steps = array(a.steps, 24);
    if (steps.length !== (row(w.recipe).steps as unknown[]).length || new Set(steps.map(v => row(v).key)).size !== steps.length) invalid();
    for (const value of steps) {
      const step = row(value); identifier(step.key); member(step.state, ['pending', 'needs_review', 'complete', 'failed']); member(step.disposition, ['pending', 'verify', 'human-handoff', 'needs_review', 'complete', 'failed']);
      if (!(row(w.recipe).steps as Row[]).some(s => s.key === step.key)) invalid();
      array(step.blockers, 100).forEach(value => { const b = row(value); member(b.code, ['dependency', 'capability', 'provider', 'studio', 'human', 'evidence', 'state']); string(b.requirement); });
    }
  }
  return result as WorkflowSnapshot;
}
export function readWorkflowPreview(value: unknown, input: WorkflowPreviewInput, projectId: string): PanelWorkflowPreview {
  // Preserve the entire returned object, including optional attested extensions.
  const result = jsonCopy(value), r = row(result), p = row(r.prepared);
  if (r.conversation !== undefined) nativeConversation(r.conversation as NativeWorkflowConversation);
  hash(r.receiptHash); hash(p.binding); if (hash(p.projectId) !== projectId) invalid(); recipe(p.recipe); member(p.kind, KINDS); member(p.decision, ['approved', 'rejected']);
  array(p.subjectHashes, 480).forEach(hash); array(p.inputArtifacts, 480).forEach(value => artifact(value, true));
  if (p.submission !== null) readWorkflowSubmission(p.submission);
  if (p.operation !== null) row(p.operation);
  if (p.recipeGate !== null) row(p.recipeGate);
  const kinds = { recipe: 'create-recipe', gate: 'recipe-gate', handoff: 'submit-evidence', review: 'review-evidence', reconcile: 'reconcile' };
  if (p.kind !== kinds[input.action]) invalid();
  if (input.action === 'recipe') {
    if (p.workflowId !== null || p.stepKey !== null || p.decision !== 'approved' || canonical(r.request) !== canonical(input.request)) invalid();
  } else {
    if (p.workflowId !== input.workflowId) invalid();
    if (input.action === 'gate' || input.action === 'review') {
      if (p.stepKey !== input.stepKey || p.decision !== input.decision) invalid();
      if (input.action === 'gate') { const gate = row(p.recipeGate); if (gate.gate !== input.gate || gate.stepKey !== input.stepKey || gate.decision !== input.decision || gate.workflowId !== row(p.recipe).id) invalid(); hash(gate.binding); }
    }
    if (input.action === 'handoff' && (p.stepKey !== input.submission.key || p.decision !== 'approved' || canonical(readWorkflowSubmission(p.submission)) !== canonical(readWorkflowSubmission(input.submission)))) invalid();
    if (input.action === 'reconcile' && (r.resolution !== input.resolution || p.decision !== (input.resolution === 'halt' ? 'rejected' : 'approved') || canonical(r.observedRun ?? null) !== canonical(input.observedRun ?? null) || p.operation === null)) invalid();
  }
  jsonCopy({ preview: result, idempotencyKey: 'x'.repeat(64) }, WORKFLOW_REQUEST_BYTES, 16, 16000);
  return result as PanelWorkflowPreview;
}

/** Same-origin bounded transport; execute is never retried, even after cancellation. */
export class WorkflowPanelApi {
  constructor(private readonly token: string, private readonly transport: typeof fetch = globalThis.fetch, private readonly timeoutMs = 10000) {
    if (!token || /[\r\n]/.test(token) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) invalid();
  }
  private async request(path: string, method: 'GET' | 'POST', payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    const execute = path === '/execute';
    const body = payload === undefined ? undefined : JSON.stringify(jsonCopy(payload, WORKFLOW_REQUEST_BYTES, 16, 16000));
    if (body?.normalize('NFKC').includes(this.token)) throw new WorkflowPanelError('Workflow content contains the control token.');
    if (signal?.aborted) throw new WorkflowPanelError('Request cancelled.');
    const controller = new AbortController();
    let dispatched = false, definitive = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined;
    let rejectAbort: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const cancel = (): void => { controller.abort(); rejectAbort(new WorkflowPanelError('Request cancelled. Refresh explicitly.', execute && dispatched)); };
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      dispatched = true;
      response = await Promise.race([this.transport('/v1/workflows' + path, {
        method, headers: { Authorization: 'Bearer ' + this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body }), signal: controller.signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer',
      }), aborted]);
      definitive = response.status >= 400 && response.status < 500;
      if (response.status === 202) throw new WorkflowPanelError('Outcome unknown. Refresh and explicitly reconcile the workflow. Nothing was retried.', execute);
      if (response.status !== 200) throw new WorkflowPanelError(definitive ? 'Workflow request refused. Refresh before preparing another decision.' : 'Workflow response could not confirm the outcome.', execute && !definitive);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('Content-Type') ?? '')) invalid();
      const declared = response.headers.get('Content-Length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > WORKFLOW_RESPONSE_BYTES)) invalid();
      if (!response.body) invalid();
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true }), chunks: string[] = [];
      let size = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > WORKFLOW_RESPONSE_BYTES) invalid();
        chunks.push(decoder.decode(chunk.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return jsonCopy(JSON.parse(chunks.join('')) as unknown);
    } catch (error) {
      if (execute && dispatched && !definitive) throw new WorkflowPanelError('Outcome unknown. Refresh and explicitly reconcile the workflow. Nothing was retried.', true);
      if (error instanceof WorkflowPanelError) throw error;
      throw new WorkflowPanelError('Workflow request could not be read. Refresh explicitly.');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else if (response?.body) void response.body.cancel().catch(() => {});
    }
  }
  list(signal?: AbortSignal): Promise<unknown> { return this.request('', 'GET', undefined, signal); }
  currentFlow(signal?: AbortSignal): Promise<unknown> { return this.request('/current-flow', 'GET', undefined, signal); }
  get(id: string, signal?: AbortSignal): Promise<unknown> { return this.request('/' + identifier(id), 'GET', undefined, signal); }
  preview(input: WorkflowPreviewInput, signal?: AbortSignal): Promise<unknown> { return this.request('/preview', 'POST', input, signal); }
  receipt(preview: PanelWorkflowPreview, idempotencyKey: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('/receipt', 'POST', { preview, idempotencyKey: identifier(idempotencyKey) }, signal);
  }
  execute(preview: PanelWorkflowPreview, idempotencyKey: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('/execute', 'POST', { preview, idempotencyKey: identifier(idempotencyKey) }, signal);
  }
}

/** A receipt check observes the original command; it never replays it. */
export function readWorkflowReceipt(value: unknown, preview: PanelWorkflowPreview, idempotencyKey: string): {
  state: string; command: {idempotencyKey: string; kind: string; workflowId: string; result: string | null} | null;
  association: string | null; snapshot: WorkflowSnapshot | null; snapshotStatus: string; retry: false;
} {
  const copy = jsonCopy(value, 512 * 1024), r = exact(copy, ['state','command','association','snapshot','snapshotStatus','retry']);
  const state = member(r.state, ['not-recorded','running','uncertain','done']);
  const snapshotStatus = member(r.snapshotStatus, ['not-recorded','unbound','available','unavailable','too-large']);
  if (r.retry !== false) invalid();
  const association = r.association === null ? null : member(r.association, ['unknown','unscoped','bound']);
  if (r.command === null) {
    if (state !== 'not-recorded' || association !== null || r.snapshot !== null || snapshotStatus !== 'not-recorded') invalid();
    return {state,command:null,association,snapshot:null,snapshotStatus,retry:false};
  }
  const c = exact(r.command, ['idempotencyKey','kind','workflowId','result']);
  const key = identifier(c.idempotencyKey), kind = member(c.kind, KINDS), workflowId = identifier(c.workflowId);
  if (key !== idempotencyKey || kind !== preview.prepared.kind || state === 'not-recorded' || association === null || snapshotStatus === 'not-recorded' ||
      (preview.prepared.workflowId !== null && preview.prepared.workflowId !== workflowId)) invalid();
  const expected = {'create-recipe':'created','recipe-gate':'decided','submit-evidence':'submitted','review-evidence':'reviewed',reconcile:'reconciled'};
  const result = c.result === null ? null : member(c.result, RESULTS);
  if (state === 'done' ? result !== expected[kind as keyof typeof expected] : result !== null) invalid();
  let snapshot: WorkflowSnapshot | null = null;
  if (snapshotStatus === 'available') {
    if (association !== 'bound' || r.snapshot === null) invalid();
    snapshot = readWorkflowSnapshot(r.snapshot, preview.prepared.projectId);
    if (snapshot.workflow.id !== workflowId || snapshot.workflow.recipe.id !== preview.prepared.recipe.id ||
        (kind === 'create-recipe' && snapshot.workflow.creationReceiptHash !== preview.receiptHash)) invalid();
  } else if (r.snapshot !== null || (snapshotStatus === 'unbound' ? association === 'bound' : association !== 'bound')) invalid();
  return {state,command:{idempotencyKey:key,kind,workflowId,result},association,snapshot,snapshotStatus,retry:false};
}

interface Context { token: string; path: string; native: NativeWorkflowConversation | null; model: RequestedModel | null; fingerprint: string; owner: string }
interface Receipt { preview: PanelWorkflowPreview; idempotencyKey: string; state: 'confirmed' | 'unknown' | 'recorded' | 'refused' | 'reconciled'; workflowId: string | null; owner: string; result?: string }
const panels = new WeakMap<Document, WorkflowPanelController>();

/** Builds only its owned subtree inside the parent's mount. Construction makes no request. */
export function startWorkflowPanel(doc: Document, options: WorkflowPanelOptions): WorkflowPanelController {
  panels.get(doc)?.cleanup();
  const mount = doc.getElementById('workflow-panel');
  if (!mount) throw new Error('Parent must provide #workflow-panel.');
  const root = doc.createElement('section'); root.className = 'arcane-workflow'; root.setAttribute('aria-label', 'Workflow controls');
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] => { const el = doc.createElement(tag); el.textContent = text; return el; };
  root.append(make('h3', 'Workflow'));
  const notice = make('p', 'Workflow controls are stopped.'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); root.append(notice);
  const contextLine = make('p'); root.append(contextLine);
  const button = (label: string, action: string, parent: HTMLElement, primary = false): HTMLButtonElement => {
    const el = make('button', label); el.type = 'button'; el.setAttribute('data-workflow-action', action); if (primary) el.setAttribute('data-primary', ''); parent.append(el); return el;
  };
  const refreshButton = button('Refresh workflows', 'refresh', root);
  const field = <K extends 'input' | 'textarea' | 'select'>(parent: HTMLElement, title: string, tag: K, name: string): HTMLElementTagNameMap[K] => {
    const label = make('label', title), el = make(tag); el.id = 'workflow-' + name; el.setAttribute('name', name); label.setAttribute('for', el.id); label.append(el); parent.append(label); return el;
  };
  const choices = (select: HTMLSelectElement, values: readonly (readonly [string, string])[]): void => {
    select.replaceChildren(); for (const [value, title] of values) { const option = make('option', title); option.value = value; select.append(option); } select.value = values[0]?.[0] ?? '';
  };
  const selectedFlow = field(root, 'Stored workflow', 'select', 'stored'); choices(selectedFlow, [['', 'No workflow loaded']]);
  const inspectButton = button('Inspect selected workflow', 'inspect', root);
  const form = make('form'); form.setAttribute('aria-label', 'Prepare workflow'); root.append(form);
  const fields = make('fieldset'); form.append(fields); fields.append(make('legend', 'Requested work'));
  const deliverable = field(fields, 'Deliverable', 'select', 'deliverable'); choices(deliverable, [['code-change', 'Code change'], ['production-asset', 'Production asset'], ['playtest-repair', 'Playtest repair']]);
  const engine = field(fields, 'Engine', 'select', 'engine'); choices(engine, [['roblox', 'Roblox'], ['blender', 'Blender']]);
  const title = field(fields, 'Title', 'input', 'title'); title.required = true; title.maxLength = 300;
  const prompt = field(fields, 'Prompt', 'textarea', 'prompt'); prompt.required = true; prompt.maxLength = 8000;
  const scope = field(fields, 'File scope (one relative path per line)', 'textarea', 'scope'); scope.required = true; scope.maxLength = 6020;
  fields.append(make('p', 'Model selection comes from the existing conversation. Unavailable selections and capabilities remain blockers.'));
  const recipeButton = button('Preview workflow', 'recipe', fields, true);
  const flowView = make('div'); root.append(flowView);
  const actions = make('form'); actions.setAttribute('aria-label', 'Prepare workflow decision'); root.append(actions);
  const actionFields = make('fieldset'); actions.append(actionFields); actionFields.append(make('legend', 'Workflow decision'));
  const stepSelect = field(actionFields, 'Step', 'select', 'step');
  const actionSelect = field(actionFields, 'Action', 'select', 'action'); choices(actionSelect, [['gate', 'Gate decision'], ['handoff', 'Submit actual evidence'], ['review', 'Review submitted evidence'], ['reconcile', 'Reconcile interrupted operation']]);
  const gateSelect = field(actionFields, 'Gate', 'select', 'gate');
  const decision = field(actionFields, 'Decision', 'select', 'decision'); choices(decision, [['approved', 'Approve'], ['rejected', 'Reject']]);
  const evidence = field(actionFields, 'Evidence submission JSON', 'textarea', 'evidence'); evidence.maxLength = WORKFLOW_REQUEST_BYTES;
  const evidenceHelp = make('p', 'Use the exact submission fields: key, artifacts [{path, role, sha256, bytes}], subjectHashes, checks [{id, outcome, evidenceSha256, subjectDigest, value?}]. Reference real files and measured reports. Verification steps require the host verifier.'); actionFields.append(evidenceHelp);
  const resolution = field(actionFields, 'Resolution', 'select', 'resolution'); choices(resolution, [['halt', 'Halt workflow'], ['accept-observed', 'Accept exact observed outcome']]);
  const mapping = field(actionFields, 'Observed WorkStore mapping JSON (interrupted creation only)', 'textarea', 'mapping'); mapping.maxLength = 8000;
  const mappingHelp = make('p', 'For interrupted creation, supply the actual {runId, taskIds: {stepKey: taskId}} mapping. Native conversation IDs come only from the parent controller.'); actionFields.append(mappingHelp);
  const actionButton = button('Preview decision', 'decision', actionFields, true);
  const previewView = make('section'); previewView.className = 'workflow-preview'; previewView.hidden = true; previewView.setAttribute('aria-label', 'Human confirmation'); root.append(previewView);
  const previewText = make('div'); previewView.append(previewText);
  const confirmButton = button('Confirm exact preview', 'confirm', previewView, true);
  const cancelButton = button('Discard preview', 'discard', previewView);
  const receiptView = make('div'); receiptView.setAttribute('aria-label', 'Command receipts'); root.append(receiptView);
  mount.append(root);

  let running = false, disposed = false, busy = false, generation = 0;
  let context: Context | null = null, current: WorkflowSnapshot | null = null, listing: WorkflowList | null = null;
  let preview: { value: PanelWorkflowPreview; context: Context; generation: number } | null = null;
  let pendingController: AbortController | null = null;
  const receipts: Receipt[] = [], ownedFlows = new Map<string, string>();
  const transport = options.fetch ?? doc.defaultView?.fetch.bind(doc.defaultView) ?? globalThis.fetch;
  const removers: (() => void)[] = [];
  const announce = (message: string): void => { notice.textContent = message; };
  const readContext = (): Context => {
    const token = options.getToken(), path = options.getProjectPath();
    if (!token || !path) throw new WorkflowPanelError('Select a project and connect the existing control session.');
    string(path, 4096);
    const native = options.getNativeConversation ? options.getNativeConversation() : null;
    if (native) nativeConversation(native);
    if (native?.projectPath !== undefined && native.projectPath !== path) throw new WorkflowPanelError('Native conversation belongs to a different project.');
    const model = observedModel(options.getModelSelection?.() ?? null);
    const owner = canonical({ path, native });
    return { token, path, native: native ? jsonCopy(native) : null, model, owner, fingerprint: canonical({ token, path, native, model }) };
  };
  const unknownReceipt = (): Receipt | undefined => receipts.find(r => r.owner === context?.owner && (r.state === 'unknown' || r.state === 'confirmed'));
  const belongs = (value: WorkflowSnapshot | PanelWorkflowPreview, allowNew = false): boolean => {
    if (!context) return false;
    if (!options.getNativeConversation) return true;
    const native = context.native; if (!native) return false;
    const record = 'prepared' in value ? row(value.prepared) : row(value.workflow);
    
    const workflowId = record.workflowId ?? record.id;
    const argumentsValue = value;
    const attestations = [(value as unknown as Row).conversation, record.conversation].filter(v => v !== undefined);
    if (attestations.length) {
      try {
        return attestations.every(value => {
          const attested = row(value);
          if (attested.provider !== undefined || attested.threadId !== undefined || attested.sessionId !== undefined) {
            const binding = nativeConversation(attested as unknown as NativeWorkflowConversation);
            return binding.provider === native.provider && binding.threadId === native.threadId && binding.sessionId === native.sessionId;
          }
          return options.isWorkflowInNativeConversation?.(argumentsValue, native) === true;
        });
      } catch { return false; }
    }
    if (options.isWorkflowInNativeConversation) {
      try { return options.isWorkflowInNativeConversation(value, native) === true; } catch { return false; }
    }
    if (allowNew && record.kind === 'create-recipe') return true;
    return typeof workflowId === 'string' && ownedFlows.get(workflowId) === context.owner;
  };
  const erasePreview = (): void => { preview = null; previewView.hidden = true; previewText.replaceChildren(); };
  const showReceipts = (): void => {
    receiptView.replaceChildren();
    for (const receipt of receipts.filter(r => r.owner === context?.owner)) {
      const item = make('details'), summary = make('summary', 'Receipt: ' + receipt.state + (receipt.result ? ' (' + receipt.result + ')' : ''));
      item.append(summary, make('p', 'Idempotency key: ' + receipt.idempotencyKey + '\nHuman receipt: ' + receipt.preview.receiptHash + '\nWorkflow: ' + (receipt.workflowId ?? 'Not yet observed')));
      item.append(make('pre', JSON.stringify({ preview: receipt.preview, idempotencyKey: receipt.idempotencyKey }, null, 2)));
      if (receipt.state === 'unknown') {
        const check = button('Check original receipt', 'receipt', item);
        check.setAttribute('data-workflow-receipt', receipt.idempotencyKey);
        check.disabled = !running || disposed || busy;
      }
      receiptView.append(item);
    }
  };
  const controls = (): void => {
    const active = running && !disposed && !busy;
    refreshButton.disabled = !active; inspectButton.disabled = !active || !selectedFlow.value; selectedFlow.disabled = !active;
    fields.disabled = !active || !!unknownReceipt() || !!preview || !!(options.getNativeConversation && !context?.native);
    recipeButton.disabled = fields.disabled || !listing;
    const editable = !!current && belongs(current) && current.workflow.state !== 'halted';
    actionFields.disabled = !active || !editable || !!preview;
    const step = current?.workflow.recipe.steps.find(s => s.key === stepSelect.value), mode = actionSelect.value;
    const uncertain = current?.workflow.state === 'uncertain' && !!current.workflow.operation;
    actionButton.disabled = actionFields.disabled || !listing || (mode === 'reconcile' ? !uncertain : !!unknownReceipt() || uncertain || !step) ||
      (mode === 'handoff' && step?.execution === 'local-verification') || (mode === 'gate' && !gateSelect.value) ||
      (mode === 'review' && current?.workflow.taskStates[stepSelect.value] !== 'needs_review');
    stepSelect.parentElement!.hidden = mode === 'reconcile'; gateSelect.parentElement!.hidden = mode !== 'gate';
    decision.parentElement!.hidden = mode !== 'gate' && mode !== 'review';
    evidence.parentElement!.hidden = mode !== 'handoff'; evidenceHelp.hidden = mode !== 'handoff';
    resolution.parentElement!.hidden = mode !== 'reconcile';
    const needsMapping = mode === 'reconcile' && resolution.value === 'accept-observed' && current?.workflow.operation?.kind === 'create-recipe';
    mapping.parentElement!.hidden = !needsMapping; mappingHelp.hidden = !needsMapping;
    confirmButton.disabled = !active || !preview; cancelButton.disabled = !active || !preview;
    actions.hidden = !current; showReceipts();
  };
  const showFlow = (): void => {
    flowView.replaceChildren();
    if (!current) { flowView.append(make('p', 'No current workflow was returned.')); choices(stepSelect, []); choices(gateSelect, []); controls(); return; }
    const { workflow, assessment } = current;
    flowView.append(make('h4', workflow.recipe.title), make('p', 'Workflow ' + workflow.id + '\nState: ' + workflow.state + '\nProject: ' + workflow.projectId));
    if (!belongs(current)) flowView.append(make('p', 'This stored workflow has no attested link to the current native conversation. Decisions are unavailable.'));
    if (!assessment) flowView.append(make('p', 'No active step assessment was returned. Inspect the interrupted operation before reconciliation.'));
    if (workflow.operation) flowView.append(make('pre', 'Interrupted operation\n' + JSON.stringify(workflow.operation, null, 2)));
    const steps = make('ol');
    for (const step of workflow.recipe.steps) {
      const a = assessment?.steps.find(s => s.key === step.key), item = make('li'), detail = make('details');
      item.append(make('p', step.title + ': ' + (a?.state ?? workflow.taskStates[step.key] ?? 'Not assessed')));
      if (a?.blockers.length) { const blockers = make('ul'); for (const b of a.blockers) blockers.append(make('li', b.code + ': ' + b.requirement)); item.append(blockers); }
      detail.append(make('summary', 'Scope, evidence and gates'), make('p', 'Execution: ' + step.execution + '\nScope: ' + step.scope.join(', ') + '\nGates: ' + (step.gates.join(', ') || 'None') + '\nDependencies: ' + (step.dependencies.join(', ') || 'None')),
        make('p', step.instructions), make('p', step.acceptance), make('pre', JSON.stringify({ quality: step.quality, provider: step.provider, studio: step.studio, retry: step.retry }, null, 2)));
      item.append(detail); steps.append(item);
    }
    flowView.append(steps);
    const previous = stepSelect.value; choices(stepSelect, workflow.recipe.steps.map(s => [s.key, s.title] as const));
    if (workflow.recipe.steps.some(s => s.key === previous)) stepSelect.value = previous;
    choices(gateSelect, (workflow.recipe.steps.find(s => s.key === stepSelect.value)?.gates ?? []).map(g => [g, g] as const));
    controls();
  };
  const invalidate = (message: string, clear = true): void => {
    generation++; pendingController?.abort(); pendingController = null; busy = false; erasePreview();
    for (const r of receipts) if (r.state === 'confirmed') r.state = 'unknown';
    if (clear) { current = null; listing = null; context = null; title.value = ''; prompt.value = ''; scope.value = ''; evidence.value = ''; mapping.value = ''; choices(selectedFlow, [['', 'Refresh to load workflows']]); flowView.replaceChildren(); contextLine.textContent = ''; }
    announce(message); controls();
  };
  const checkContext = (): Context => {
    let next: Context;
    try { next = readContext(); } catch { invalidate('Context is unavailable. Refresh before preparing another decision.'); throw new WorkflowPanelError('Context is unavailable. Refresh before preparing another decision.'); }
    if (!context || next.fingerprint !== context.fingerprint) { invalidate('Context changed. Refresh before preparing another decision.'); throw new WorkflowPanelError('Context changed. Refresh before preparing another decision.'); }
    return next;
  };
  const api = (ctx: Context): WorkflowPanelApi => new WorkflowPanelApi(ctx.token, transport, options.timeoutMs ?? 10000);
  const begin = (): { ctx: Context; epoch: number; controller: AbortController } => {
    if (!running || disposed || busy) throw new WorkflowPanelError('Workflow controls are unavailable.');
    const ctx = checkContext(), controller = new AbortController(); pendingController = controller; busy = true; controls(); return { ctx, epoch: generation, controller };
  };
  const live = (operation: { ctx: Context; epoch: number }): boolean => {
    if (disposed || !running || operation.epoch !== generation) return false;
    try { return checkContext().fingerprint === operation.ctx.fingerprint; } catch { return false; }
  };
  const end = (epoch: number): void => { if (epoch === generation) { busy = false; pendingController = null; controls(); } };
  const observeReceipt = (snapshot: WorkflowSnapshot): void => {
    for (const r of receipts) {
      if (r.owner === context?.owner && (r.workflowId === snapshot.workflow.id || (r.preview.prepared.kind === 'create-recipe' && r.preview.receiptHash === snapshot.workflow.creationReceiptHash))) {
        r.workflowId = snapshot.workflow.id; ownedFlows.set(snapshot.workflow.id, r.owner);
        // Refresh locates the workflow; it never declares an unknown command successful.
      }
    }
  };
  const refresh = async (): Promise<void> => {
    if (!running || disposed || busy) return;
    erasePreview();
    let refreshEpoch = generation;
    try {
      const next = readContext();
      if (context?.fingerprint !== next.fingerprint) invalidate('Refreshing current context.');
      context = next; contextLine.textContent = 'Project: ' + next.path + (next.native ? '\nConversation: ' + next.native.threadId : '\nNative conversation: not observed') + '\nModel: ' + (next.model ? next.model.provider + ' / ' + next.model.model + ' / ' + next.model.effort : 'Not selected');
      const op = begin(); refreshEpoch = op.epoch;
      try {
        announce('Reading workflows…');
        const listValue = readWorkflowList(await api(op.ctx).list(op.controller.signal));
        if (!live(op)) return;
        const flowValue = await api(op.ctx).currentFlow(op.controller.signal);
        const snapshot = flowValue === null ? null : readWorkflowSnapshot(flowValue, listValue.projectId);
        if (!live(op)) return;
        listing = listValue; current = snapshot;
        if (snapshot) observeReceipt(snapshot);
        choices(selectedFlow, [['', 'Select a stored workflow'], ...listValue.workflows.map(w => [w.id, w.id + ' (' + w.state + ')'] as const)]);
        if (snapshot) selectedFlow.value = snapshot.workflow.id;
        showFlow(); announce(unknownReceipt() ? 'Outcome remains unknown. Inspect the receipt and workflow, then explicitly reconcile.' : 'Workflow state read.');
      } finally { end(op.epoch); }
    } catch (error) { if (refreshEpoch === generation && running && !disposed) invalidate(error instanceof WorkflowPanelError ? error.message : 'Workflow state could not be read. Refresh explicitly.'); }
  };
  const inspect = async (): Promise<void> => {
    const op = begin(); erasePreview();
    try {
      if (!listing) invalid();
      const id = identifier(selectedFlow.value), value = readWorkflowSnapshot(await api(op.ctx).get(id, op.controller.signal), listing.projectId);
      if (value.workflow.id !== id) invalid();
      if (!live(op)) return;
      current = value; observeReceipt(value); showFlow(); announce(unknownReceipt() ? 'Outcome remains unknown. Inspect the interrupted operation before reconciliation.' : 'Selected workflow read.');
    } finally { end(op.epoch); }
  };
  const recipeInput = (): WorkflowPreviewInput => {
    if (unknownReceipt()) throw new WorkflowPanelError('Reconcile the unknown command before creating more work.');
    if (options.getNativeConversation && !context?.native) throw new WorkflowPanelError('Use an observed native conversation before preparing work.');
    const paths = scope.value.split(/\r?\n/).map(p => p.trim()).filter(Boolean).map(relativePath);
    if (!paths.length || paths.length > 20) throw new WorkflowPanelError('Enter 1–20 relative file scopes.');
    const request: WorkflowRecipeRequest = {
      deliverable: member(deliverable.value, ['code-change', 'production-asset', 'playtest-repair']) as WorkflowRecipeRequest['deliverable'],
      engine: member(engine.value, ['roblox', 'blender']) as WorkflowRecipeRequest['engine'],
      title: string(title.value.trim(), 300), prompt: string(prompt.value.trim()), scope: [...new Set(paths)].sort(), model: context?.model ?? null,
    };
    if (request.deliverable === 'playtest-repair' && request.engine !== 'roblox') throw new WorkflowPanelError('Playtest repair requires Roblox.');
    return { action: 'recipe', request };
  };
  const decisionInput = (): WorkflowPreviewInput => {
    if (!current || !belongs(current)) throw new WorkflowPanelError('Inspect a workflow linked to the current conversation.');
    const workflowId = current.workflow.id, action = member(actionSelect.value, ['gate', 'handoff', 'review', 'reconcile']);
    if (action === 'reconcile') {
      if (current.workflow.state !== 'uncertain' || !current.workflow.operation) throw new WorkflowPanelError('Refresh and inspect an uncertain workflow first.');
      const resolve = member(resolution.value, ['halt', 'accept-observed']) as 'halt' | 'accept-observed';
      let observedRun: { runId: string; taskIds: Record<string, string> } | undefined;
      if (resolve === 'accept-observed' && current.workflow.operation.kind === 'create-recipe') {
        const input = exact(JSON.parse(mapping.value) as unknown, ['runId', 'taskIds']), taskIds = row(input.taskIds);
        if (Object.keys(taskIds).length > 24) invalid();
        for (const [key, id] of Object.entries(taskIds)) { identifier(key); identifier(id); }
        observedRun = jsonCopy({ runId: identifier(input.runId), taskIds: taskIds as Record<string, string> }, WORKFLOW_REQUEST_BYTES, 16, 16000);
      }
      return { action: 'reconcile', workflowId, resolution: resolve, ...(observedRun ? { observedRun } : {}) };
    }
    if (unknownReceipt() || current.workflow.state !== 'active') throw new WorkflowPanelError('Refresh and reconcile before another decision.');
    const step = current.workflow.recipe.steps.find(s => s.key === stepSelect.value); if (!step) invalid();
    if (action === 'handoff') {
      if (step.execution === 'local-verification') throw new WorkflowPanelError('Verification evidence must come from the host verifier.');
      const submission = readWorkflowSubmission(JSON.parse(evidence.value) as unknown);
      if (submission.key !== step.key) throw new WorkflowPanelError('Submission key must match the selected step.');
      return { action: 'handoff', workflowId, submission };
    }
    const choice = member(decision.value, ['approved', 'rejected']) as 'approved' | 'rejected';
    if (action === 'review') {
      if (current.workflow.taskStates[step.key] !== 'needs_review') throw new WorkflowPanelError('Only submitted evidence can be reviewed.');
      return { action: 'review', workflowId, stepKey: step.key, decision: choice };
    }
    const gate = member(gateSelect.value, step.gates) as HumanGate;
    return { action: 'gate', workflowId, stepKey: step.key, gate, decision: choice };
  };
  const prepare = async (input: WorkflowPreviewInput): Promise<void> => {
    const op = begin(); erasePreview();
    try {
      if (!listing) invalid();
      announce('Preparing human review…');
      const value = readWorkflowPreview(await api(op.ctx).preview(input, op.controller.signal), input, listing.projectId);
      if (!live(op)) return;
      if (!belongs(value, input.action === 'recipe')) throw new WorkflowPanelError('Preview is not linked to the current native conversation.');
      preview = { value, context: op.ctx, generation: op.epoch };
      previewText.append(make('h4', 'Review before confirming'), make('p', 'Action: ' + value.prepared.kind + '\nDecision: ' + value.prepared.decision + '\nProject: ' + value.prepared.projectId + '\nWorkflow: ' + (value.prepared.workflowId ?? 'New workflow') + '\nStep: ' + (value.prepared.stepKey ?? 'Entire recipe')),
        make('p', 'Cost: no cost estimate is supplied by the base contract. Any server cost fields are shown below. Model execution requires a separate native action.'),
        make('p', 'The complete prepared scope, gates, evidence, policy, decision and any server-attested metadata follow. Confirming records only this workflow command.'));
      const plan = make('ol');
      for (const step of value.prepared.recipe.steps) {
        const item = make('li', step.title + '\nExecution: ' + step.execution + '\nScope: ' + step.scope.join(', ') + '\nGates: ' + (step.gates.join(', ') || 'None') + '\nRequired evidence: ' + step.quality.roles.join(', ') + '\nAcceptance: ' + step.acceptance);
        plan.append(item);
      }
      previewText.append(make('p', value.prepared.recipe.objective), plan,
        make('p', 'Pinned input evidence: ' + (value.prepared.inputArtifacts.length ? value.prepared.inputArtifacts.map(a => a.stepKey + ': ' + a.path + ' (' + a.bytes + ' bytes) SHA-256 ' + a.sha256).join('\n') : 'None returned')),
        make('p', 'Subject hashes: ' + (value.prepared.subjectHashes.join('\n') || 'None returned')),
        make('pre', JSON.stringify(value, null, 2)));
      previewView.hidden = false; announce('Preview prepared. Review every field, then confirm explicitly.');
    } finally { end(op.epoch); }
  };
  const confirm = async (): Promise<void> => {
    const selected = preview;
    if (!selected || selected.generation !== generation || checkContext().fingerprint !== selected.context.fingerprint) throw new WorkflowPanelError('Preview is stale. Prepare it again.');
    const op = begin();
    let receipt: Receipt | undefined, dispatched = false;
    try {
      const crypto = doc.defaultView?.crypto ?? globalThis.crypto;
      const idempotencyKey = identifier(crypto.randomUUID());
      receipt = { preview: selected.value, idempotencyKey, state: 'confirmed', workflowId: selected.value.prepared.workflowId, owner: op.ctx.owner };
      if (receipts.length >= 32) { const removable = receipts.findIndex(r => r.state !== 'unknown' && r.state !== 'confirmed'); if (removable < 0) throw new WorkflowPanelError('Reconcile pending receipts before more commands.'); receipts.splice(removable, 1); }
      receipts.push(receipt); erasePreview(); showReceipts(); announce('Awaiting the exact workflow command receipt…');
      dispatched = true;
      const raw = await api(op.ctx).execute(selected.value, idempotencyKey, op.controller.signal);
      const snapshot = readWorkflowSnapshot(raw, selected.value.prepared.projectId), result = member(row(raw).result, RESULTS);
      const expected = { 'create-recipe': 'created', 'recipe-gate': 'decided', 'submit-evidence': 'submitted', 'review-evidence': 'reviewed', reconcile: 'reconciled' };
      if (result !== expected[selected.value.prepared.kind] || (receipt.workflowId !== null && snapshot.workflow.id !== receipt.workflowId) || snapshot.workflow.recipe.id !== selected.value.prepared.recipe.id || (selected.value.prepared.kind === 'create-recipe' && snapshot.workflow.creationReceiptHash !== selected.value.receiptHash)) invalid();
      if (snapshot.workflow.operation !== null || snapshot.workflow.state !== (selected.value.prepared.kind === 'reconcile' && selected.value.resolution === 'halt' ? 'halted' : 'active')) invalid();
      if (((raw as Row).conversation !== undefined || (snapshot.workflow as unknown as Row).conversation !== undefined || options.isWorkflowInNativeConversation) && !belongs(snapshot)) invalid();
      if (!live(op)) { receipt.state = 'unknown'; return; }
      receipt.state = 'recorded'; receipt.result = result; receipt.workflowId = snapshot.workflow.id; ownedFlows.set(snapshot.workflow.id, op.ctx.owner);
      if (result === 'reconciled') for (const previous of receipts) { if (previous !== receipt && previous.owner === op.ctx.owner && previous.state === 'unknown' && previous.workflowId === snapshot.workflow.id) previous.state = 'reconciled'; }
      current = snapshot; showFlow(); announce('Workflow command recorded: ' + result + '. Step completion and blockers come from the returned assessment.');
    } catch (error) {
      if (receipt) receipt.state = !dispatched || error instanceof WorkflowPanelError && !error.unknownOutcome && error.message !== 'Invalid workflow data. Refresh explicitly.' ? 'refused' : 'unknown';
      if (live(op)) announce(receipt?.state === 'unknown' ? 'Outcome unknown. Refresh and explicitly reconcile. Nothing was retried.' : error instanceof WorkflowPanelError ? error.message : 'Workflow command could not be confirmed.');
    } finally { end(op.epoch); }
  };
  const checkReceipt = async (key: string): Promise<void> => {
    const receipt = receipts.find(r => r.idempotencyKey === key && r.owner === context?.owner && r.state === 'unknown');
    if (!receipt) throw new WorkflowPanelError('Inspect an unknown original receipt first.');
    const op = begin();
    try {
      announce('Checking the original command. Nothing will be replayed…');
      const result = readWorkflowReceipt(await api(op.ctx).receipt(receipt.preview, receipt.idempotencyKey, op.controller.signal), receipt.preview, receipt.idempotencyKey);
      if (!live(op)) return;
      if (result.snapshot && !belongs(result.snapshot)) invalid();
      if (result.command) receipt.workflowId = result.command.workflowId;
      if (result.state === 'done' && result.association === 'bound' && result.snapshot && result.command?.result) {
        receipt.state = 'recorded'; receipt.result = result.command.result;
        if (result.command.result === 'reconciled') {
          for (const previous of receipts) if (previous !== receipt && previous.owner === op.ctx.owner && previous.state === 'unknown' && previous.workflowId === result.snapshot.workflow.id) previous.state = 'reconciled';
        }
        ownedFlows.set(result.snapshot.workflow.id, op.ctx.owner);
        current = result.snapshot; showFlow();
        announce('Original command receipt confirmed: ' + result.command.result + '. No command was retried.');
      } else {
        if (result.snapshot) { current = result.snapshot; showFlow(); }
        announce(result.state === 'not-recorded' ? 'No original command receipt was recorded. Outcome remains unknown; do not replay it automatically.' :
          result.association !== 'bound' ? 'The command has no confirmed conversation association. Outcome remains unknown.' :
          result.state !== 'done' ? 'Original command remains ' + result.state + '. Inspect and explicitly reconcile; nothing was retried.' :
          'Receipt exists, but its current workflow could not be verified. Outcome remains unknown.');
      }
    } finally { end(op.epoch); }
  };
  const listen = (type: string, handler: EventListener): void => { root.addEventListener(type, handler); removers.push(() => root.removeEventListener(type, handler)); };
  listen('submit', event => { event.preventDefault(); }); // Never navigate through native form defaults.
  listen('click', event => {
    let target = event.target as HTMLElement | null;
    while (target && target !== root && !target.getAttribute('data-workflow-action')) target = target.parentElement;
    const action = target?.getAttribute('data-workflow-action');
    if (!action) return;
    event.preventDefault();
    if (!event.isTrusted || !running || disposed || busy || (target as HTMLButtonElement).disabled) return;
    const run = async (): Promise<void> => {
      if (action === 'refresh') { await refresh(); return; }
      checkContext();
      if (action === 'receipt') await checkReceipt(identifier(target!.getAttribute('data-workflow-receipt')));
      else if (action === 'inspect') await inspect();
      else if (action === 'recipe') await prepare(recipeInput());
      else if (action === 'decision') await prepare(decisionInput());
      else if (action === 'confirm') await confirm();
      else if (action === 'discard') { erasePreview(); announce('Preview discarded. No command was executed.'); controls(); }
    };
    const actionEpoch = generation;
    void run().catch(error => { if (actionEpoch === generation && running && !disposed) { announce(error instanceof WorkflowPanelError ? error.message : 'Check the form and refresh explicitly.'); controls(); } });
  });
  const edited: EventListener = event => {
    if (!running || disposed) return;
    const target = event.target as HTMLElement;
    if (target === selectedFlow) { invalidate('Stored workflow selection changed. Inspect it before a decision.', false); current = null; showFlow(); return; }
    if (preview || busy) invalidate('Form changed. Prepare a new preview.', false);
    if (target === stepSelect) choices(gateSelect, (current?.workflow.recipe.steps.find(s => s.key === stepSelect.value)?.gates ?? []).map(g => [g, g] as const));
    controls();
  };
  listen('input', edited); listen('change', edited);
  const controller: WorkflowPanelController = {
    async start() { if (disposed || running) return; running = true; await refresh(); },
    async resume() { if (disposed) return; running = true; await refresh(); },
    stop() { if (disposed) return; running = false; invalidate('Workflow controls stopped. Dispatched commands may still need receipt reconciliation.'); },
    cleanup() { if (disposed) return; controller.stop(); disposed = true; for (const remove of removers) remove(); root.remove(); if (panels.get(doc) === controller) panels.delete(doc); },
  };
  panels.set(doc, controller);
  if (options.subscribeContextChange) removers.push(options.subscribeContextChange(() => { if (!disposed) invalidate('Context changed. Refresh before preparing another decision.'); }));
  controls(); return controller;
}







