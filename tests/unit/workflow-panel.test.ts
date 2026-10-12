/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  startWorkflowPanel, WorkflowPanelApi, WorkflowPanelError, WORKFLOW_RESPONSE_BYTES, WORKFLOW_REQUEST_BYTES,
  readWorkflowPreview, readWorkflowSnapshot, readWorkflowSubmission, readWorkflowReceipt, readWorkflowEvidence, readWorkflowDraft, WORKFLOW_HELPER_RESPONSE_BYTES, WORKFLOW_DRAFT_BYTES,
  type NativeWorkflowConversation, type PanelWorkflowPreview, type WorkflowPanelOptions, type WorkflowEvidenceInput, type WorkflowDraftProvenance,
} from '../../apps/desktop/src/workflow-panel.js';
import { createWorkflowRecipe, type WorkflowRecipeRequest, type WorkflowSubmission, type RequestedModel } from '../../packages/core/src/workflow-recipes.js';
import type { WorkflowSnapshot } from '../../apps/daemon/src/workflow-service.js';
import type { WorkflowPreviewInput } from '../../apps/daemon/src/workflow-host.js';

const TOKEN = 'control-fixture-' + 'a'.repeat(64), PROJECT = 'b'.repeat(64), OTHER = 'c'.repeat(64);
const PATH = 'C:/offline/project';
const NATIVE: NativeWorkflowConversation = { provider: 'codex', threadId: 'observed-thread', sessionId: null, connectionId: 'observed-connection', projectPath: PATH };
const serverConversation = (native = NATIVE): Pick<NativeWorkflowConversation, 'provider' | 'threadId' | 'sessionId'> => ({ provider: native.provider, threadId: native.threadId, sessionId: native.sessionId });
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const REQUEST: WorkflowRecipeRequest = { deliverable: 'code-change', engine: 'roblox', title: 'Repair scoped movement', prompt: 'Repair movement and retain server validation.', scope: ['src'], model: null };
const SUBMISSION: WorkflowSubmission = { key: 'prompt', artifacts: [{ path: 'src/brief.txt', role: 'brief', sha256: digest('actual fixture bytes'), bytes: 20 }], subjectHashes: [], checks: [] };
function snapshot(request = REQUEST): WorkflowSnapshot {
  const recipe = createWorkflowRecipe(request);
  return {
    workflow: { id: 'flow_one', projectId: PROJECT, recipe, creationReceiptHash: digest('creation'), runId: 'run_one',
      taskIds: Object.fromEntries(recipe.steps.map(s => [s.key, 'task_' + s.key])), taskStates: Object.fromEntries(recipe.steps.map(s => [s.key, 'pending' as const])),
      state: 'active', submissions: [], decisions: [], attempts: [], operation: null, revision: 1 },
    tasks: [], assessment: { workflowId: recipe.id, steps: recipe.steps.map(s => ({ key: s.key, state: 'pending', disposition: 'pending', blockers: [{ code: 'provider', requirement: 'Select an observed model before native handoff.' }] })), audit: [],
      learning: { mode: 'context learning not weights', authority: 'untrusted_supplemental_hints', references: [] } },
  };
}
function previewFor(input: WorkflowPreviewInput, current = snapshot(), attested = true): PanelWorkflowPreview {
  const recipe = input.action === 'recipe' ? createWorkflowRecipe(input.request) : current.workflow.recipe;
  const kinds = { recipe: 'create-recipe', gate: 'recipe-gate', handoff: 'submit-evidence', review: 'review-evidence', reconcile: 'reconcile' } as const;
  const stepKey = input.action === 'recipe' ? null : input.action === 'handoff' ? input.submission.key : input.action === 'reconcile' ? current.workflow.operation?.stepKey ?? null : input.stepKey;
  const decision = input.action === 'gate' || input.action === 'review' ? input.decision : input.action === 'reconcile' && input.resolution === 'halt' ? 'rejected' : 'approved';
  return {
    prepared: { kind: kinds[input.action], projectId: PROJECT, workflowId: input.action === 'recipe' ? null : input.workflowId, recipe, stepKey, decision,
      binding: digest(JSON.stringify(input)), subjectHashes: [], inputArtifacts: [], submission: input.action === 'handoff' ? readWorkflowSubmission(input.submission) : null,
      operation: input.action === 'reconcile' ? clone(current.workflow.operation) : null,
      recipeGate: input.action === 'gate' ? { workflowId: recipe.id, stepKey: input.stepKey, gate: input.gate, decision: input.decision, binding: digest('gate') } : null },
    receiptHash: digest('preview-' + JSON.stringify(input)),
    ...(input.action === 'recipe' ? { request: clone(input.request) } : {}),
    ...(input.action === 'reconcile' ? { resolution: input.resolution, ...(input.observedRun ? { observedRun: clone(input.observedRun) } : {}) } : {}),
    ...(attested ? { conversation: serverConversation() } : {}),
  };
}

// Private offline DOM fixture. No production trust bypass exists. emit(..., true)
// invokes captured listeners with a trusted-action-shaped fixture; real Event
// objects remain untrusted and are tested separately. HTML sinks throw.
class ElementFixture {
  children: ElementFixture[] = []; parentElement: ElementFixture | null = null;
  value = ''; id = ''; type = ''; className = ''; disabled = false; hidden = false; required = false; maxLength = 0;
  private content = ''; private attrs = new Map<string, string>(); private listeners = new Map<string, EventListener[]>();
  constructor(readonly tagName: string) {}
  get textContent(): string { return this.content + this.children.map(c => c.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.content = value; }
  get innerHTML(): never { throw new Error('Forbidden HTML sink'); }
  set innerHTML(_value: string) { throw new Error('Forbidden HTML sink'); }
  append(...children: ElementFixture[]): void { children.forEach(c => { c.parentElement = this; this.children.push(c); }); }
  replaceChildren(...children: ElementFixture[]): void { this.children.forEach(c => c.parentElement = null); this.children = []; this.content = ''; this.append(...children); }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null; }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  addEventListener(type: string, handler: EventListener): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], handler]); }
  removeEventListener(type: string, handler: EventListener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(h => h !== handler)); }
  all(): ElementFixture[] { return this.children.flatMap(c => [c, ...c.all()]); }
  emit(type: string, trusted = false): { defaultPrevented: boolean } {
    const event = { type, target: this, isTrusted: trusted, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (let node: ElementFixture | null = this; node; node = node.parentElement) for (const handler of node.listeners.get(type) ?? []) handler(event as unknown as Event);
    return event;
  }
  dispatchEvent(event: Event): boolean {
    Object.defineProperty(event, 'target', { value: this });
    for (let node: ElementFixture | null = this; node; node = node.parentElement) for (const handler of node.listeners.get(event.type) ?? []) handler(event);
    return !event.defaultPrevented;
  }
}
class DocumentFixture {
  mount = new ElementFixture('DIV'); native = new ElementFixture('TEXTAREA');
  defaultView: { fetch: typeof fetch; crypto: Crypto };
  constructor(fetcher: typeof fetch) { this.mount.id = 'workflow-panel'; this.native.id = 'codex-composer'; this.native.value = 'Existing native draft'; this.defaultView = { fetch: fetcher, crypto: globalThis.crypto }; }
  createElement(tag: string): ElementFixture { return new ElementFixture(tag.toUpperCase()); }
  getElementById(id: string): ElementFixture | null { return [this.mount, this.native, ...this.mount.all()].find(e => e.id === id) ?? null; }
  field(name: string): ElementFixture { const found = this.getElementById('workflow-' + name); assert.ok(found); return found; }
  button(action: string): ElementFixture { const found = this.mount.all().find(e => e.getAttribute('data-workflow-action') === action); assert.ok(found); return found; }
  asDocument(): Document { return this as unknown as Document; }
}
interface Call { path: string; init: RequestInit; body: Record<string, unknown> | undefined }
function fixture(initial: WorkflowSnapshot | null = snapshot(), useNative = true, appendToDraft?: WorkflowPanelOptions['appendToDraft']) {
  const calls: Call[] = [];
  let current = initial, token: string | null = TOKEN, path: string | null = PATH, native: NativeWorkflowConversation | null = clone(NATIVE), model: RequestedModel | null = null;
  let notify: () => void = () => {}; let unsubscribed = false; let attested = true;
  let lastPreview: PanelWorkflowPreview | null = null;
  let handler = async (call: Call): Promise<Response> => {
    if (call.path === '/v1/workflows') return Response.json({ projectId: PROJECT, workflows: current ? [{ id: current.workflow.id, recipeId: current.workflow.recipe.id, state: current.workflow.state }] : [] });
    if (call.path.endsWith('/current-flow') || call.init.method === 'GET') return Response.json(current ? { ...clone(current), ...(attested ? { conversation: serverConversation() } : {}) } : null);
    if (call.path.endsWith('/preview')) { lastPreview = previewFor(call.body as unknown as WorkflowPreviewInput, current ?? snapshot(), attested); return Response.json(lastPreview); }
    if (call.path.endsWith('/execute')) {
      const preview = call.body!.preview as PanelWorkflowPreview, kind = preview.prepared.kind;
      if (kind === 'create-recipe') { current = snapshot(preview.request!); current.workflow.creationReceiptHash = preview.receiptHash; }
      assert.ok(current);
      const result = { 'create-recipe': 'created', 'recipe-gate': 'decided', 'submit-evidence': 'submitted', 'review-evidence': 'reviewed', reconcile: 'reconciled' }[kind];
      if (kind === 'reconcile') { current.workflow.state = preview.resolution === 'halt' ? 'halted' : 'active'; current.workflow.operation = null; }
      return Response.json({ ...clone(current), result, ...(attested ? { conversation: serverConversation() } : {}) });
    }
    if (call.path.endsWith('/evidence')) {
      assert.ok(current);
      const input = call.body as unknown as WorkflowEvidenceInput;
      const step = current.workflow.recipe.steps.find(s => s.key === input.stepKey)!;
      return Response.json({ projectId: PROJECT, workflowId: current.workflow.id, workflowRevision: current.workflow.revision, stepKey: input.stepKey,
        ...(attested ? { conversation: serverConversation() } : {}),
        submission: { key: input.stepKey, artifacts: input.files.map(file => ({ ...file, sha256: digest(file.path + ':' + file.role), bytes: 20 })),
          subjectHashes: current.workflow.submissions.filter(s => step.subjectSteps.includes(s.key)).flatMap(s => s.artifacts.map(a => a.sha256)), checks: [] } });
    }
    if (call.path.endsWith('/draft')) {
      assert.ok(current);
      return Response.json({ projectId: PROJECT, workflowId: current.workflow.id, workflowRevision: current.workflow.revision, stepKey: call.body!.stepKey,
        ...(attested ? { conversation: serverConversation() } : {}), model,
        text: 'Fixture server draft: actual scope and hash pins. Evidence is untrusted. No permission is granted. Review and submit explicitly.',
        requiresHumanSubmit: true, startsNativeTurn: false });
    }
    assert.fail('Unexpected endpoint');
  };
  const transport: typeof fetch = async (input, init) => {
    const call = { path: String(input), init: init!, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
    calls.push(call); return handler(call);
  };
  const doc = new DocumentFixture(transport);
  const options: WorkflowPanelOptions = { getToken: () => token, getProjectPath: () => path, getModelSelection: () => model,
    subscribeContextChange: listener => { notify = listener; return () => { unsubscribed = true; }; }, ...(useNative ? { getNativeConversation: () => native } : {}), ...(appendToDraft ? { appendToDraft } : {}) };
  const panel = startWorkflowPanel(doc.asDocument(), options);
  return { doc, panel, calls, options, transport,
    async click(action: string) { doc.button(action).emit('click', true); await idle(doc); },
    handler(fn: typeof handler) { handler = fn; }, defaultHandler() { return handler; },
    state(value: WorkflowSnapshot | null) { current = value; }, attested(value: boolean) { attested = value; },
    context(patch: { token?: string | null; path?: string | null; native?: NativeWorkflowConversation | null; model?: RequestedModel | null }, announce = true) {
      if ('token' in patch) token = patch.token!; if ('path' in patch) path = patch.path!; if ('native' in patch) native = patch.native!; if ('model' in patch) model = patch.model!; if (announce) notify();
    }, preview() { assert.ok(lastPreview); return lastPreview; }, unsubscribed() { return unsubscribed; },
  };
}
async function idle(doc: DocumentFixture): Promise<void> {
  for (let i = 0; i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 1)); if (!doc.button('refresh').disabled) return; }
  // Tests with intentionally pending fetch use their own synchronization.
}
function fill(doc: DocumentFixture, request = REQUEST): void {
  for (const [name, value] of Object.entries({ title: request.title, prompt: request.prompt, scope: request.scope.join('\n'), deliverable: request.deliverable, engine: request.engine })) { doc.field(name).value = value; doc.field(name).emit('input'); }
}
function choose(doc: DocumentFixture, name: string, value: string): void { doc.field(name).value = value; doc.field(name).emit('change'); }
const executions = (calls: Call[]): Call[] => calls.filter(c => c.path.endsWith('/execute'));
const previews = (calls: Call[]): Call[] => calls.filter(c => c.path.endsWith('/preview'));

test('inert factory owns one subtree; start reads only list/current and cleanup leaves native draft', async () => {
  const f = fixture(); const sentinel = new ElementFixture('P'); sentinel.textContent = 'Parent-owned content'; f.doc.mount.append(sentinel);
  assert.equal(f.calls.length, 0); assert.equal(f.doc.button('recipe').disabled, true);
  assert.ok(f.doc.mount.all().filter(e => e.tagName === 'BUTTON').every(e => e.type === 'button'));
  await f.panel.start();
  assert.deepEqual(f.calls.map(c => [c.path, c.init.method]), [['/v1/workflows', 'GET'], ['/v1/workflows/current-flow', 'GET']]);
  assert.match(f.doc.mount.textContent, /Select an observed model/);
  assert.equal(f.doc.native.value, 'Existing native draft');
  const form = f.doc.mount.all().find(e => e.tagName === 'FORM')!;
  assert.equal(form.dispatchEvent(new Event('submit', { cancelable: true })), false);
  f.panel.stop(); const count = f.calls.length;
  f.doc.button('refresh').emit('click', true); assert.equal(f.calls.length, count);
  await f.panel.resume(); assert.equal(f.calls.length, count + 2);
  f.panel.cleanup(); f.panel.cleanup(); assert.equal(f.unsubscribed(), true);
  assert.deepEqual(f.doc.mount.children, [sentinel]); assert.equal(f.doc.native.value, 'Existing native draft');
});

test('synthetic events cannot preview, confirm, inspect, or refresh', async () => {
  const f = fixture(); await f.panel.start(); fill(f.doc);
  for (const action of ['recipe', 'refresh', 'inspect', 'decision', 'confirm']) f.doc.button(action).dispatchEvent(new Event('click', { cancelable: true }));
  assert.equal(f.calls.length, 2);
  await f.click('recipe'); assert.equal(previews(f.calls).length, 1); assert.equal(executions(f.calls).length, 0);
  f.doc.button('confirm').dispatchEvent(new Event('click', { cancelable: true })); assert.equal(executions(f.calls).length, 0);
  f.panel.cleanup();
});

for (const [deliverable, engine] of [['code-change', 'roblox'], ['production-asset', 'blender'], ['playtest-repair', 'roblox']] as const) {
  test(deliverable + ' uses exact preview then explicit confirmation, retaining the complete receipt', async () => {
    const f = fixture(null); await f.panel.start(); fill(f.doc, { ...REQUEST, deliverable, engine }); await f.click('recipe');
    const input = previews(f.calls)[0]!.body!;
    assert.deepEqual(Object.keys(input).sort(), ['action', 'request']);
    assert.equal((input.request as WorkflowRecipeRequest).model, null);
    assert.equal((input.request as WorkflowRecipeRequest).deliverable, deliverable);
    assert.equal((input.request as WorkflowRecipeRequest).engine, engine);
    const returned = f.preview();
    assert.deepEqual(returned.conversation, { provider: 'codex', threadId: 'observed-thread', sessionId: null });
    assert.ok(!Object.hasOwn(returned.conversation!, 'connectionId'));
    assert.ok(!Object.hasOwn(returned.conversation!, 'projectPath'));
    assert.ok(f.doc.mount.textContent.includes(JSON.stringify(returned, null, 2)));
    assert.match(f.doc.mount.textContent, /Cost: no cost estimate/); assert.equal(executions(f.calls).length, 0);
    await f.click('confirm'); const execute = executions(f.calls)[0]!;
    assert.deepEqual(Object.keys(execute.body!).sort(), ['idempotencyKey', 'preview']);
    assert.deepEqual(execute.body!.preview, returned);
    assert.match(String(execute.body!.idempotencyKey), /^[A-Za-z0-9_-]{1,64}$/);
    assert.match(f.doc.mount.textContent, /Receipt: recorded \(created\)/);
    assert.match(f.doc.mount.textContent, /Select an observed model/);
    assert.equal(f.doc.native.value, 'Existing native draft');
    await f.click('confirm'); assert.equal(executions(f.calls).length, 1);
    f.panel.cleanup();
  });
}

test('model comes only from observed callback and each new confirmation uses a unique key', async () => {
  const f = fixture(null); const model: RequestedModel = { provider: 'codex', model: 'observed-model', effort: 'high', connectionRevision: 'observed-revision' };
  f.context({ model }); await f.panel.start(); fill(f.doc); await f.click('recipe');
  assert.deepEqual((previews(f.calls)[0]!.body!.request as WorkflowRecipeRequest).model, model);
  await f.click('confirm'); fill(f.doc, { ...REQUEST, title: 'Another scoped request' }); await f.click('recipe'); await f.click('confirm');
  assert.equal(executions(f.calls).length, 2);
  assert.notEqual(executions(f.calls)[0]!.body!.idempotencyKey, executions(f.calls)[1]!.body!.idempotencyKey);
  f.panel.cleanup();
});

test('form edits discard displayed previews and refresh discards without execution', async () => {
  const f = fixture(); await f.panel.start(); fill(f.doc); await f.click('recipe');
  f.doc.field('prompt').value += ' Changed'; f.doc.field('prompt').emit('input');
  assert.equal(f.doc.button('confirm').disabled, true); await f.click('confirm'); assert.equal(executions(f.calls).length, 0);
  await f.click('recipe'); await f.click('refresh'); assert.equal(f.doc.button('confirm').disabled, true);
  assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
});

for (const change of ['token', 'path', 'native', 'model', 'missing-token', 'missing-project', 'missing-native'] as const) {
  test(change + ' invalidates confirmation even without a notification', async () => {
    const f = fixture(); await f.panel.start(); fill(f.doc); await f.click('recipe');
    if (change === 'token') f.context({ token: 'new-control-token' }, false);
    if (change === 'path') f.context({ path: 'C:/offline/other' }, false);
    if (change === 'native') f.context({ native: { ...NATIVE, threadId: 'other-thread' } }, false);
    if (change === 'model') f.context({ model: { provider: 'codex', model: 'different', effort: 'high', connectionRevision: 'r2' } }, false);
    if (change === 'missing-token') f.context({ token: null }, false);
    if (change === 'missing-project') f.context({ path: null }, false);
    if (change === 'missing-native') f.context({ native: null }, false);
    await f.click('confirm'); assert.equal(executions(f.calls).length, 0); assert.equal(f.doc.button('confirm').disabled, true);
    f.panel.cleanup();
  });
}

test('context notification aborts pending preview; late responses and away/back changes stay stale', async () => {
  const f = fixture(); await f.panel.start(); fill(f.doc);
  let resolve!: (value: Response) => void; const base = f.defaultHandler();
  f.handler(call => call.path.endsWith('/preview') ? new Promise<Response>(r => { resolve = r; }) : base(call));
  f.doc.button('recipe').emit('click', true); assert.equal(previews(f.calls).length, 1);
  const signal = previews(f.calls)[0]!.init.signal!;
  f.context({ native: { ...NATIVE, threadId: 'other-thread' } }); f.context({ native: clone(NATIVE) });
  assert.equal(signal.aborted, true); resolve(Response.json(previewFor(previews(f.calls)[0]!.body as unknown as WorkflowPreviewInput)));
  await new Promise(r => setTimeout(r, 5)); assert.equal(f.doc.button('confirm').disabled, true); assert.equal(executions(f.calls).length, 0);
  f.panel.cleanup();
});

test('stored workflows are read-only without attestation; changing chat cannot reuse in-memory ownership', async () => {
  const f = fixture(); f.attested(false); await f.panel.start();
  assert.match(f.doc.mount.textContent, /no attested link/); assert.equal(f.doc.button('decision').disabled, true);
  fill(f.doc); await f.click('recipe'); await f.click('confirm');
  choose(f.doc, 'step', 'requirements'); assert.equal(f.doc.button('decision').disabled, false);
  f.context({ native: { ...NATIVE, threadId: 'another-thread' } }); await f.click('refresh');
  assert.equal(f.doc.button('decision').disabled, true); f.panel.cleanup();
});

test('server conversation mismatch refuses creation preview and unknown extension fields survive exact execution', async () => {
  const f = fixture(null); await f.panel.start(); fill(f.doc); const base = f.defaultHandler();
  f.handler(async call => { if (!call.path.endsWith('/preview')) return base(call); const value = previewFor(call.body as unknown as WorkflowPreviewInput); value.conversation = { ...serverConversation(), threadId: 'wrong-thread' }; return Response.json(value); });
  await f.click('recipe'); assert.equal(f.doc.button('confirm').disabled, true); assert.equal(executions(f.calls).length, 0);
  for (const conversation of [
    { provider: 'claude', threadId: NATIVE.threadId, sessionId: null },
    { provider: 'codex', threadId: NATIVE.threadId },
    { provider: 'codex', threadId: NATIVE.threadId, sessionId: 123 },
    { ...serverConversation(), sessionId: 'different-observed-session' },
  ]) {
    f.handler(async call => { if (!call.path.endsWith('/preview')) return base(call); return Response.json({ ...previewFor(call.body as unknown as WorkflowPreviewInput), conversation }); });
    await f.click('recipe'); assert.equal(f.doc.button('confirm').disabled, true); assert.equal(executions(f.calls).length, 0);
  }
  for (const provider of ['codex', 'claude-code'] as const) for (const sessionId of [null, 'observed-session']) {
    const input: WorkflowPreviewInput = { action: 'recipe', request: REQUEST };
    const conversation = { provider, threadId: NATIVE.threadId, sessionId };
    assert.deepEqual(readWorkflowPreview({ ...previewFor(input), conversation }, input, PROJECT).conversation, conversation);
  }
  let returned: PanelWorkflowPreview | null = null;
  f.handler(async call => { if (!call.path.endsWith('/preview')) return base(call); returned = previewFor(call.body as unknown as WorkflowPreviewInput); returned.attestation = { revision: 'server-v2', cost: { currency: 'USD', maximum: 2.5 } }; (returned.prepared as unknown as Record<string, unknown>).conversationEvidence = { observedAt: 'server timestamp' }; return Response.json(returned); });
  await f.click('recipe'); await f.click('confirm'); assert.deepEqual(executions(f.calls)[0]!.body!.preview, returned); f.panel.cleanup();
});

test('human gate/handoff/review actions use existing exact schemas and never dispatch native operations', async () => {
  const state = snapshot(); state.workflow.taskStates.prompt = 'needs_review'; state.workflow.submissions = [clone(SUBMISSION)];
  const f = fixture(state); await f.panel.start();
  choose(f.doc, 'step', 'requirements'); choose(f.doc, 'decision', 'rejected'); await f.click('decision');
  assert.deepEqual(previews(f.calls).at(-1)!.body, { action: 'gate', workflowId: 'flow_one', stepKey: 'requirements', gate: 'model-handoff', decision: 'rejected' });
  await f.click('discard'); choose(f.doc, 'step', 'prompt'); choose(f.doc, 'action', 'handoff'); f.doc.field('evidence').value = JSON.stringify(SUBMISSION); await f.click('decision');
  assert.deepEqual(previews(f.calls).at(-1)!.body, { action: 'handoff', workflowId: 'flow_one', submission: SUBMISSION });
  await f.click('discard'); choose(f.doc, 'action', 'review'); await f.click('decision');
  assert.deepEqual(previews(f.calls).at(-1)!.body, { action: 'review', workflowId: 'flow_one', stepKey: 'prompt', decision: 'rejected' });
  await f.click('confirm'); assert.equal(executions(f.calls).length, 1);
  assert.ok(f.calls.every(c => c.path.startsWith('/v1/workflows'))); f.panel.cleanup();
});

test('host verification cannot be submitted through handoff and invalid scope/evidence stays local', async () => {
  const f = fixture(); await f.panel.start(); choose(f.doc, 'step', 'verification'); choose(f.doc, 'action', 'handoff');
  assert.equal(f.doc.button('decision').disabled, true); await f.click('decision'); assert.equal(previews(f.calls).length, 0);
  for (const path of ['../escape', 'C:/absolute', '.env/key', '.agents/secret', 'src/CON.txt']) { fill(f.doc, { ...REQUEST, scope: [path] }); await f.click('recipe'); }
  assert.equal(previews(f.calls).length, 0);
  choose(f.doc, 'step', 'prompt'); f.doc.field('evidence').value = JSON.stringify({ ...SUBMISSION, nativeThreadId: 'browser-id' }); await f.click('decision'); assert.equal(previews(f.calls).length, 0);
  f.panel.cleanup();
});

test('202 execute is unknown, never retried; refresh preserves the receipt and reconciliation uses a new preview', async () => {
  const f = fixture(null); await f.panel.start(); fill(f.doc); await f.click('recipe');
  const creation = clone(f.preview()), base = f.defaultHandler();
  f.handler(async call => call.path.endsWith('/execute') ? Response.json({ error: 'WORKFLOW_UNCERTAIN', outcome: 'unknown', retry: false }, { status: 202 }) : base(call));
  await f.click('confirm'); assert.equal(executions(f.calls).length, 1); const exact = clone(executions(f.calls)[0]!.body!);
  assert.match(f.doc.mount.textContent, /Receipt: unknown/); assert.doesNotMatch(f.doc.mount.textContent, /Receipt: recorded/);
  const uncertain = snapshot(); uncertain.workflow.creationReceiptHash = creation.receiptHash; uncertain.workflow.state = 'uncertain'; uncertain.assessment = null;
  uncertain.workflow.operation = { key: String(exact.idempotencyKey), kind: 'create-recipe', stepKey: null, submission: null, approved: null };
  f.state(uncertain); await f.click('refresh'); assert.equal(executions(f.calls).length, 1); assert.equal(f.doc.button('recipe').disabled, true);
  assert.match(f.doc.mount.textContent, /Outcome remains unknown/); assert.ok(f.doc.mount.textContent.includes(String(exact.idempotencyKey)));
  choose(f.doc, 'action', 'reconcile'); await f.click('decision');
  assert.deepEqual(previews(f.calls).at(-1)!.body, { action: 'reconcile', workflowId: 'flow_one', resolution: 'halt' });
  assert.equal(executions(f.calls).length, 1); f.handler(base); await f.click('confirm');
  assert.equal(executions(f.calls).length, 2); assert.notEqual(executions(f.calls)[1]!.body!.idempotencyKey, exact.idempotencyKey);
  assert.deepEqual(executions(f.calls)[0]!.body, exact); assert.match(f.doc.mount.textContent, /Receipt: reconciled/); f.panel.cleanup();
});

test('accept-observed creation requires real WorkStore mapping and never turns mapping into a native ID', async () => {
  const state = snapshot(); state.workflow.state = 'uncertain'; state.assessment = null;
  state.workflow.operation = { key: 'unknown_key', kind: 'create-recipe', stepKey: null, submission: null, approved: null };
  const f = fixture(state); await f.panel.start(); choose(f.doc, 'action', 'reconcile'); choose(f.doc, 'resolution', 'accept-observed');
  await f.click('decision'); assert.equal(previews(f.calls).length, 0);
  const mapping = { runId: 'observed_work_run', taskIds: state.workflow.taskIds }; f.doc.field('mapping').value = JSON.stringify(mapping); await f.click('decision');
  assert.deepEqual(previews(f.calls).at(-1)!.body, { action: 'reconcile', workflowId: 'flow_one', resolution: 'accept-observed', observedRun: mapping });
  assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
});

test('stop during dispatch aborts transport and retains unknown receipt on resume', async () => {
  const f = fixture(null); await f.panel.start(); fill(f.doc); await f.click('recipe'); const base = f.defaultHandler();
  f.handler(call => call.path.endsWith('/execute') ? new Promise<Response>(() => {}) : base(call));
  f.doc.button('confirm').emit('click', true); assert.equal(executions(f.calls).length, 1); const signal = executions(f.calls)[0]!.init.signal!;
  f.panel.stop(); assert.equal(signal.aborted, true); f.handler(base); await f.panel.resume();
  assert.equal(executions(f.calls).length, 1); assert.match(f.doc.mount.textContent, /Receipt: unknown/); assert.equal(f.doc.button('recipe').disabled, true);
  f.panel.cleanup();
});

for (const [name, makeResponse] of [
  ['truncated JSON', () => new Response('{', { headers: { 'Content-Type': 'application/json' } })],
  ['wrong project', () => Response.json({ ...snapshot(), result: 'created', workflow: { ...snapshot().workflow, projectId: OTHER } })],
  ['wrong receipt', () => Response.json({ ...snapshot(), result: 'created' })],
  ['contradictory workflow state', () => Response.json({ ...snapshot(), result: 'created', workflow: { ...snapshot().workflow, state: 'uncertain' } })],
  ['wrong native conversation', () => Response.json({ ...snapshot(), result: 'created', conversation: { ...serverConversation(), threadId: 'wrong' } })],
  ['null result', () => Response.json({ ...snapshot(), result: null })],
  ['server failure', () => Response.json({ error: 'WORKFLOW_FAILED' }, { status: 500 })],
] as const) {
  test(name + ' cannot acknowledge a dispatched command', async () => {
    const f = fixture(null); await f.panel.start(); fill(f.doc); await f.click('recipe'); const base = f.defaultHandler();
    f.handler(call => call.path.endsWith('/execute') ? Promise.resolve(makeResponse()) : base(call)); await f.click('confirm');
    assert.match(f.doc.mount.textContent, /Receipt: unknown/); assert.equal(executions(f.calls).length, 1); assert.equal(f.doc.button('recipe').disabled, true); f.panel.cleanup();
  });
}

test('definitive HTTP refusal records refusal without exposing error text or bearer', async () => {
  const f = fixture(null); await f.panel.start(); fill(f.doc); await f.click('recipe'); const base = f.defaultHandler();
  f.handler(call => call.path.endsWith('/execute') ? Promise.resolve(Response.json({ message: TOKEN + ' host diagnostics' }, { status: 403 })) : base(call)); await f.click('confirm');
  assert.match(f.doc.mount.textContent, /Receipt: refused/); assert.ok(!f.doc.mount.textContent.includes(TOKEN)); assert.ok(!f.doc.mount.textContent.includes('host diagnostics')); f.panel.cleanup();
});

test('XSS-bearing title/prompt/evidence remain text and malformed previews fail closed', async () => {
  const f = fixture(null); await f.panel.start(); const attack = '<img src=x onerror=alert(1)>';
  fill(f.doc, { ...REQUEST, title: attack, prompt: '<script>window.evil=true</script>' }); await f.click('recipe');
  assert.ok(f.doc.mount.textContent.includes(attack)); assert.ok(!f.doc.mount.all().some(e => ['IMG', 'SCRIPT', 'IFRAME'].includes(e.tagName)));
  assert.ok(f.doc.mount.all().filter(e => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)).every(e => !/native|conversation|thread|connection/i.test(e.id)));
  f.panel.cleanup();
  const input: WorkflowPreviewInput = { action: 'recipe', request: REQUEST }, valid = previewFor(input);
  for (const patch of [{ receiptHash: 'bad' }, { prepared: { ...valid.prepared, projectId: OTHER } }, { prepared: { ...valid.prepared, kind: 'recipe-gate' } }, { request: { ...REQUEST, prompt: 'changed' } }, { prepared: { ...valid.prepared, inputArtifacts: [{ stepKey: 'prompt', path: '../escape', sha256: digest('a'), bytes: 1, role: 'brief' }] } }]) {
    assert.throws(() => readWorkflowPreview({ ...valid, ...patch }, input, PROJECT));
  }
});

test('submission validates exact fields, hashes, report measures and host-normalized ordering', () => {
  assert.deepEqual(readWorkflowSubmission(SUBMISSION), SUBMISSION);
  for (const invalid of [{ ...SUBMISSION, nativeId: 'browser' }, { ...SUBMISSION, artifacts: [{ ...SUBMISSION.artifacts[0], sha256: 'fake' }] }, { ...SUBMISSION, checks: [{ id: 'c', outcome: 'pass', evidenceSha256: digest('r'), subjectDigest: digest('s'), value: -1 }] }, JSON.parse('{"key":"prompt","artifacts":[],"subjectHashes":[],"checks":[],"__proto__":{}}')]) assert.throws(() => readWorkflowSubmission(invalid));
  assert.deepEqual(readWorkflowSubmission({ ...SUBMISSION, subjectHashes: [digest('b'), digest('a'), digest('a')] }).subjectHashes, [digest('b'), digest('a')].sort());
  assert.throws(() => readWorkflowSnapshot({ ...snapshot(), workflow: { ...snapshot().workflow, projectId: OTHER } }, PROJECT));
});

test('API uses only exact routes, no query strings, same-origin headers and bounded bodies', async () => {
  const calls: Call[] = []; const api = new WorkflowPanelApi(TOKEN, async (input, init) => { calls.push({ path: String(input), init: init!, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined }); return Response.json(null); });
  await api.list(); await api.currentFlow(); await api.get('flow_one');
  await api.preview({ action: 'recipe', request: REQUEST }); await api.execute(previewFor({ action: 'recipe', request: REQUEST }), 'exact_key');
  assert.deepEqual(calls.map(c => c.path), ['/v1/workflows', '/v1/workflows/current-flow', '/v1/workflows/flow_one', '/v1/workflows/preview', '/v1/workflows/execute']);
  for (const c of calls) { assert.equal((c.init.headers as Record<string, string>).Authorization, 'Bearer ' + TOKEN); assert.equal(c.init.redirect, 'error'); assert.equal(c.init.cache, 'no-store'); assert.equal(c.init.credentials, 'same-origin'); assert.equal(c.init.referrerPolicy, 'no-referrer'); }
  assert.throws(() => api.get('../escape')); assert.equal(calls.length, 5);
  await assert.rejects(api.preview({ action: 'recipe', request: { ...REQUEST, prompt: 'x'.repeat(WORKFLOW_REQUEST_BYTES) } }));
  await assert.rejects(api.preview({ action: 'recipe', request: { ...REQUEST, prompt: TOKEN } })); assert.equal(calls.length, 5);
});

test('response transport cancels oversize streams, rejects wrong MIME/UTF-8/status, and bounds declared size', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(WORKFLOW_RESPONSE_BYTES + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(new WorkflowPanelApi(TOKEN, async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } })).list());
  assert.equal(cancelled, true);
  for (const response of [new Response('{}', { headers: { 'Content-Type': 'text/html' } }), new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/json' } }), Response.json({}, { status: 202 }), Response.json({}, { status: 302 }), Response.json({}, { headers: { 'Content-Length': String(WORKFLOW_RESPONSE_BYTES + 1) } })]) await assert.rejects(new WorkflowPanelApi(TOKEN, async () => response).list());
});

test('deadline and body-read cancellation report execute uncertainty once, without retries', async () => {
  let calls = 0, signal: AbortSignal | undefined;
  const api = new WorkflowPanelApi(TOKEN, async (_input, init) => { calls++; signal = init!.signal!; return new Promise<Response>(() => {}); }, 5);
  const preview = previewFor({ action: 'recipe', request: REQUEST });
  await assert.rejects(api.execute(preview, 'one'), (e: unknown) => e instanceof WorkflowPanelError && e.unknownOutcome);
  assert.equal(calls, 1); assert.equal(signal!.aborted, true);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(new WorkflowPanelApi(TOKEN, async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }), 5).execute(preview, 'two'), (e: unknown) => e instanceof WorkflowPanelError && e.unknownOutcome);
  assert.equal(cancelled, true);
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(api.execute(preview, 'three', aborted.signal)); assert.equal(calls, 1);
});

test('emitted browser module has no native execution/storage/HTML dependencies', () => {
  const source = readFileSync(new URL('../../apps/desktop/src/workflow-panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|innerHTML|insertAdjacentHTML|\/v1\/codex|grant-writes|turn-start|thread-start|setInterval/);
  assert.doesNotMatch(source, /^import .*node:|^import .*workflow-service|^import .*workflow-host|^import .*workflow-recipes/m);
  assert.match(source, /event\.isTrusted/);
});





test('lost response uses explicit read-only original receipt lookup, never a second execute', async () => {
  const f = fixture(null); const base = f.defaultHandler();
  let observed: Record<string, unknown> | undefined;
  f.handler(async call => {
    if (call.path.endsWith('/execute')) { observed = await (await base(call)).json() as Record<string,unknown>; return new Response('', {status:202}); }
    if (call.path.endsWith('/receipt')) return Response.json({state:'done', command:{idempotencyKey:call.body!.idempotencyKey,kind:'create-recipe',workflowId:'flow_one',result:'created'},association:'bound',snapshot:observed,snapshotStatus:'available',retry:false});
    return base(call);
  });
  await f.panel.start(); fill(f.doc); await f.click('recipe'); await f.click('confirm');
  assert.match(f.doc.mount.textContent, /Receipt: unknown/); assert.equal(executions(f.calls).length,1);
  f.doc.button('receipt').dispatchEvent(new Event('click',{cancelable:true}));
  assert.equal(f.calls.filter(c => c.path.endsWith('/receipt')).length,0);
  await f.click('receipt');
  const original=executions(f.calls)[0]!, read=f.calls.find(c => c.path.endsWith('/receipt'))!;
  assert.deepEqual(read.body,original.body); assert.equal(read.init.method,'POST');
  assert.equal(executions(f.calls).length,1); assert.match(f.doc.mount.textContent,/Receipt: recorded \(created\)/);
  assert.match(f.doc.mount.textContent,/No command was retried/);
  assert.equal(f.doc.native.value,'Existing native draft'); f.panel.cleanup();
});

for (const state of ['not-recorded','running','uncertain','unbound','unavailable','wrong-key','wrong-kind','wrong-context','false-retry']) {
  test('receipt lookup '+state+' cannot turn uncertainty into success or replay work', async () => {
    const f=fixture(null), base=f.defaultHandler(); let observed: Record<string,unknown>|undefined;
    f.handler(async call => {
      if(call.path.endsWith('/execute')){observed=await(await base(call)).json() as Record<string,unknown>;return new Response('',{status:202});}
      if(call.path.endsWith('/receipt')){
        const payload: Record<string,unknown>={state:'done',command:{idempotencyKey:call.body!.idempotencyKey,kind:'create-recipe',workflowId:'flow_one',result:'created'},association:'bound',snapshot:observed,snapshotStatus:'available',retry:false};
        if(state==='not-recorded')Object.assign(payload,{state,command:null,association:null,snapshot:null,snapshotStatus:'not-recorded'});
        if(state==='running'||state==='uncertain'){payload.state=state;(payload.command as Record<string,unknown>).result=null;}
        if(state==='unbound')Object.assign(payload,{association:'unknown',snapshot:null,snapshotStatus:'unbound'});
        if(state==='unavailable')Object.assign(payload,{snapshot:null,snapshotStatus:'unavailable'});
        if(state==='wrong-key')(payload.command as Record<string,unknown>).idempotencyKey='other_key';
        if(state==='wrong-kind')(payload.command as Record<string,unknown>).kind='review-evidence';
        if(state==='wrong-context')payload.snapshot={...observed,conversation:{...serverConversation(),threadId:'other-thread'}};
        if(state==='false-retry')payload.retry=true;
        return Response.json(payload);
      }
      return base(call);
    });
    await f.panel.start();fill(f.doc);await f.click('recipe');await f.click('confirm');await f.click('receipt');
    assert.match(f.doc.mount.textContent,/Receipt: unknown/);assert.equal(executions(f.calls).length,1);
    assert.equal(f.doc.button('recipe').disabled,true);await f.click('confirm');assert.equal(executions(f.calls).length,1);
    f.panel.cleanup();
  });
}

test('receipt parser enforces exact bounded metadata and never treats snapshots alone as receipt proof',()=>{
  const p=previewFor({action:'recipe',request:REQUEST});
  const value={state:'not-recorded',command:null,association:null,snapshot:null,snapshotStatus:'not-recorded',retry:false};
  assert.equal(readWorkflowReceipt(value,p,'owned_key').state,'not-recorded');
  assert.throws(()=>readWorkflowReceipt({...value,extra:true},p,'owned_key'));
  assert.throws(()=>readWorkflowReceipt({...value,snapshot:snapshot()},p,'owned_key'));
  assert.throws(()=>readWorkflowReceipt({...value,retry:true},p,'owned_key'));
  assert.throws(()=>readWorkflowReceipt({...value,large:'x'.repeat(512*1024)},p,'owned_key'));
});


test('checking a lost reconciliation receipt reconciles only earlier unknown receipts in that same workflow',async()=>{
  const f=fixture(null),base=f.defaultHandler();let observed:Record<string,unknown>|undefined;
  f.handler(async call=>{
    if(call.path.endsWith('/execute')){
      const p=call.body!.preview as PanelWorkflowPreview;
      if(p.prepared.kind==='reconcile')observed=await(await base(call)).json() as Record<string,unknown>;
      return new Response('',{status:202});
    }
    if(call.path.endsWith('/receipt'))return Response.json({state:'done',command:{idempotencyKey:call.body!.idempotencyKey,kind:'reconcile',workflowId:'flow_one',result:'reconciled'},association:'bound',snapshot:observed,snapshotStatus:'available',retry:false});
    return base(call);
  });
  await f.panel.start();fill(f.doc);await f.click('recipe');const creation=clone(f.preview());await f.click('confirm');
  const uncertain=snapshot();uncertain.workflow.creationReceiptHash=creation.receiptHash;uncertain.workflow.state='uncertain';uncertain.assessment=null;
  uncertain.workflow.operation={key:String(executions(f.calls)[0]!.body!.idempotencyKey),kind:'create-recipe',stepKey:null,submission:null,approved:null};
  f.state(uncertain);await f.click('refresh');choose(f.doc,'action','reconcile');await f.click('decision');await f.click('confirm');
  assert.equal(executions(f.calls).length,2);
  const reconciliationKey=String(executions(f.calls)[1]!.body!.idempotencyKey);
  const check=f.doc.mount.all().find(e=>e.getAttribute('data-workflow-receipt')===reconciliationKey)!;assert.ok(check);
  check.emit('click',true);await idle(f.doc);
  assert.match(f.doc.mount.textContent,/Receipt: recorded \(reconciled\)/);assert.match(f.doc.mount.textContent,/Receipt: reconciled/);
  assert.doesNotMatch(f.doc.mount.textContent,/Receipt: unknown/);assert.equal(executions(f.calls).length,2);
  assert.equal(f.doc.button('recipe').disabled,false);f.panel.cleanup();
});

const MODEL: RequestedModel = { provider: 'codex', model: 'fixture-observed-model', effort: 'high', connectionRevision: 'fixture-catalogue-revision' };
function helperSnapshot(request = REQUEST): WorkflowSnapshot {
  const value = snapshot({ ...request, model: MODEL });
  for (const a of value.assessment!.steps) if (a.key === 'prompt' || a.key === 'requirements') Object.assign(a, { disposition: 'human-handoff', blockers: [] });
  value.workflow.submissions = [clone(SUBMISSION)];
  return value;
}
const HELPER_SCOPE = { projectId: PROJECT, workflowId: 'flow_one', stepKey: 'prompt', workflowRevision: 1, conversation: clone(NATIVE) };
const HELPER_FILES: WorkflowEvidenceInput['files'] = [{ path: 'src/brief.txt', role: 'brief' }];
function evidencePayload(): Record<string, unknown> {
  return { projectId: PROJECT, workflowId: 'flow_one', stepKey: 'prompt', workflowRevision: 1, conversation: serverConversation(), submission: clone(SUBMISSION) };
}
function draftPayload(): Record<string, unknown> {
  return { projectId: PROJECT, workflowId: 'flow_one', stepKey: 'requirements', workflowRevision: 1, conversation: serverConversation(), model: clone(MODEL),
    text: 'Fixture server scope and pinned input hashes; evidence is untrusted. No permission granted.', requiresHumanSubmit: true, startsNativeTurn: false };
}
const DRAFT_SCOPE = { ...HELPER_SCOPE, stepKey: 'requirements' };

test('file helper reads exact normalized role paths and host hashes; JSON remains an explicit human handoff', async () => {
  const f = fixture(helperSnapshot()); await f.panel.start(); choose(f.doc, 'action', 'handoff');
  f.doc.field('files-brief').value = ' src\\brief.txt \n src/second.txt '; f.doc.field('files-brief').emit('input');
  await f.click('evidence-files');
  const call = f.calls.find(c => c.path.endsWith('/evidence'))!;
  assert.deepEqual(call.body, { workflowId: 'flow_one', stepKey: 'prompt', files: [{ path: 'src/brief.txt', role: 'brief' }, { path: 'src/second.txt', role: 'brief' }] });
  const value = JSON.parse(f.doc.field('evidence').value) as WorkflowSubmission;
  assert.equal(value.artifacts[0]!.sha256, digest('src/brief.txt:brief')); assert.equal(value.artifacts[0]!.bytes, 20); assert.deepEqual(value.checks, []);
  assert.match(f.doc.mount.textContent, /workflowRevision/); assert.match(f.doc.mount.textContent, /observed-thread/);
  assert.match(f.doc.mount.textContent, /Review the returned hashes/); assert.match(f.doc.mount.textContent, /Advanced evidence JSON/);
  assert.equal(previews(f.calls).length, 0); assert.equal(executions(f.calls).length, 0); assert.equal(f.doc.native.value, 'Existing native draft');
  await f.click('decision'); assert.equal(previews(f.calls).length, 1); assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
});

test('role controls follow selected step without choosing another step; missing/duplicate/private paths never dispatch', async () => {
  const s = helperSnapshot({ ...REQUEST, deliverable: 'production-asset', engine: 'blender', scope: ['assets'] });
  Object.assign(s.assessment!.steps.find(a => a.key === 'implementation')!, { disposition: 'human-handoff', blockers: [] });
  const f = fixture(s); await f.panel.start(); choose(f.doc, 'step', 'implementation'); choose(f.doc, 'action', 'handoff');
  assert.ok(f.doc.field('files-blend-source')); assert.ok(f.doc.field('files-engine-export')); assert.equal(f.doc.getElementById('workflow-files-brief'), null);
  f.doc.field('files-blend-source').value = 'assets/fixture.blend'; await f.click('evidence-files');
  assert.equal(f.calls.filter(c => c.path.endsWith('/evidence')).length, 0); assert.match(f.doc.mount.textContent, /each required evidence role/);
  f.doc.field('files-engine-export').value = 'assets/fixture.blend'; await f.click('evidence-files');
  assert.equal(f.calls.filter(c => c.path.endsWith('/evidence')).length, 0);
  f.doc.field('files-engine-export').value = '../escape.glb'; await f.click('evidence-files'); assert.equal(f.calls.length, 2);
  f.doc.field('files-engine-export').value = 'assets/fixture.glb'; await f.click('evidence-files');
  assert.equal(f.calls.filter(c => c.path.endsWith('/evidence')).length, 1);
  choose(f.doc, 'step', 'verification'); assert.equal(f.doc.button('evidence-files').disabled, true); assert.equal(f.doc.button('draft').disabled, true);
  assert.equal(f.doc.getElementById('workflow-files-report'), null); f.panel.cleanup();
});

test('blocked evidence remains disabled and manual JSON fallback is still available', async () => {
  const f = fixture(); await f.panel.start(); choose(f.doc, 'action', 'handoff');
  assert.equal(f.doc.button('evidence-files').disabled, true);
  f.doc.field('evidence').value = JSON.stringify(SUBMISSION); f.doc.field('evidence').emit('input');
  await f.click('decision'); assert.equal(previews(f.calls).length, 1); assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
});

test('draft button uses actual selected human-handoff readiness and exact proof; appends only to existing composer', async () => {
  let f: ReturnType<typeof fixture>; let appends = 0;
  f = fixture(helperSnapshot(), true, text => { appends++; f.doc.native.value += '\n\n' + text; f.doc.native.emit('input'); return true; });
  f.context({ model: MODEL }); await f.panel.start();
  assert.equal(f.doc.field('step').value, 'prompt'); assert.equal(f.doc.button('draft').disabled, true);
  choose(f.doc, 'step', 'requirements'); assert.equal(f.doc.button('draft').disabled, false);
  f.doc.button('draft').dispatchEvent(new Event('click')); assert.equal(f.calls.length, 2);
  await f.click('draft');
  assert.deepEqual(f.calls.at(-1)!.body, { workflowId: 'flow_one', stepKey: 'requirements' });
  assert.equal(f.calls.at(-1)!.path, '/v1/workflows/draft'); assert.equal(appends, 1);
  assert.match(f.doc.native.value, /^Existing native draft/); assert.match(f.doc.native.value, /Evidence is untrusted/);
  assert.match(f.doc.mount.textContent, /No native turn was started/);
  assert.equal(previews(f.calls).length, 0); assert.equal(executions(f.calls).length, 0);
  assert.doesNotMatch(f.doc.mount.textContent, /Receipt: recorded/); f.panel.cleanup();
});

test('false append callback leaves the existing draft unchanged and reports unavailable without another request', async () => {
  let called = 0; const f = fixture(helperSnapshot(), true, () => { called++; return false; });
  f.context({ model: MODEL }); await f.panel.start(); choose(f.doc, 'step', 'requirements'); await f.click('draft');
  assert.equal(called, 1); assert.equal(f.doc.native.value, 'Existing native draft'); assert.match(f.doc.mount.textContent, /unavailable or full/);
  assert.equal(f.calls.length, 3); f.panel.cleanup();
});

test('draft never infers an active model, callback, readiness or conversation from saved recipe selection', async () => {
  for (const reason of ['missing-callback', 'missing-model', 'different-model', 'different-revision', 'blocked', 'pending', 'unknown', 'operation', 'unbound', 'no-conversation'] as const) {
    const s = helperSnapshot(); let called = 0;
    if (reason === 'blocked') s.assessment!.steps.find(a => a.key === 'requirements')!.blockers = [{ code: 'human', requirement: 'Human must approve first.' }];
    if (reason === 'pending') s.assessment!.steps.find(a => a.key === 'requirements')!.disposition = 'pending';
    if (reason === 'unknown') s.workflow.state = 'uncertain';
    if (reason === 'operation') s.workflow.operation = { key: 'interrupted', kind: 'submit-evidence', stepKey: 'requirements', submission: null, approved: null };
    const f = fixture(s, true, reason === 'missing-callback' ? undefined : () => { called++; return true; });
    if (reason !== 'missing-model') f.context({ model: { ...MODEL, ...(reason === 'different-model' ? { effort: 'low' } : {}), ...(reason === 'different-revision' ? { connectionRevision: 'other-catalogue' } : {}) } });
    if (reason === 'unbound') f.attested(false); if (reason === 'no-conversation') f.context({ native: null });
    await f.panel.start(); choose(f.doc, 'step', 'requirements');
    assert.equal(f.doc.button('draft').disabled, true, reason); await f.click('draft'); assert.equal(called, 0, reason); assert.equal(f.calls.length, 2, reason); f.panel.cleanup();
  }
});

test('evidence parser compares exact identity, revision, returned path-role list, actual hashes/bytes and dependency pins', () => {
  const accepted = readWorkflowEvidence(evidencePayload(), HELPER_SCOPE, HELPER_FILES, []);
  assert.deepEqual(accepted.submission, SUBMISSION); assert.deepEqual(accepted.conversation, serverConversation());
  for (const change of [
    (r: Record<string, unknown>) => { r.projectId = OTHER; }, (r: Record<string, unknown>) => { r.workflowId = 'other_flow'; }, (r: Record<string, unknown>) => { r.stepKey = 'requirements'; },
    (r: Record<string, unknown>) => { delete r.workflowRevision; }, (r: Record<string, unknown>) => { r.workflowRevision = 0; }, (r: Record<string, unknown>) => { r.workflowRevision = 1.5; },
    (r: Record<string, unknown>) => { delete r.conversation; }, (r: Record<string, unknown>) => { r.conversation = { ...serverConversation(), threadId: 'wrong-thread' }; },
    (r: Record<string, unknown>) => { r.conversation = { ...serverConversation(), sessionId: 'wrong-session' }; }, (r: Record<string, unknown>) => { r.conversation = { ...serverConversation(), provider: 'claude-code' }; },
    (r: Record<string, unknown>) => { r.extra = true; }, (r: Record<string, unknown>) => { (r.submission as WorkflowSubmission).key = 'requirements'; },
    (r: Record<string, unknown>) => { (r.submission as WorkflowSubmission).artifacts[0]!.path = 'src/other.txt'; },
    (r: Record<string, unknown>) => { (r.submission as WorkflowSubmission).artifacts[0]!.role = 'requirements'; },
    (r: Record<string, unknown>) => { (r.submission as WorkflowSubmission).artifacts[0]!.sha256 = 'not-a-hash'; },
    (r: Record<string, unknown>) => { (r.submission as WorkflowSubmission).artifacts[0]!.bytes = 0; },
    (r: Record<string, unknown>) => { (r.submission as WorkflowSubmission).checks = [{ id: 'invented-pass', outcome: 'pass', evidenceSha256: digest('fake'), subjectDigest: digest('fake') }]; },
    (r: Record<string, unknown>) => { (r.submission as WorkflowSubmission).subjectHashes = [digest('uninspected-input')]; },
    (r: Record<string, unknown>) => { (r.submission as WorkflowSubmission).artifacts = []; },
  ]) { const value = evidencePayload(); change(value); assert.throws(() => readWorkflowEvidence(value, HELPER_SCOPE, HELPER_FILES, []), WorkflowPanelError); }
  const pinned = evidencePayload(); (pinned.submission as WorkflowSubmission).subjectHashes = [digest('input')];
  assert.deepEqual(readWorkflowEvidence(pinned, HELPER_SCOPE, HELPER_FILES, [digest('input')]).submission.subjectHashes, [digest('input')]);
  assert.throws(() => readWorkflowEvidence(pinned, HELPER_SCOPE, HELPER_FILES, []));
});

test('draft parser requires exact model proof and canonical bound conversation, flags, revision, no invented authority', () => {
  assert.equal(readWorkflowDraft(draftPayload(), DRAFT_SCOPE, MODEL).text, draftPayload().text);
  for (const change of [
    (r: Record<string, unknown>) => { r.projectId = OTHER; }, (r: Record<string, unknown>) => { r.workflowId = 'other_flow'; }, (r: Record<string, unknown>) => { r.stepKey = 'plan'; },
    (r: Record<string, unknown>) => { delete r.workflowRevision; }, (r: Record<string, unknown>) => { r.workflowRevision = 2; }, (r: Record<string, unknown>) => { r.workflowRevision = -1; },
    (r: Record<string, unknown>) => { delete r.conversation; }, (r: Record<string, unknown>) => { r.conversation = { ...serverConversation(), threadId: 'wrong-thread' }; },
    (r: Record<string, unknown>) => { r.conversation = { ...serverConversation(), sessionId: 'wrong-session' }; }, (r: Record<string, unknown>) => { r.conversation = { ...serverConversation(), provider: 'claude-code' }; },
    (r: Record<string, unknown>) => { r.requiresHumanSubmit = false; }, (r: Record<string, unknown>) => { r.startsNativeTurn = true; }, (r: Record<string, unknown>) => { r.extra = 'authority'; },
    (r: Record<string, unknown>) => { r.model = null; }, (r: Record<string, unknown>) => { r.model = { ...MODEL, model: 'other' }; }, (r: Record<string, unknown>) => { r.model = { ...MODEL, effort: 'low' }; },
    (r: Record<string, unknown>) => { r.model = { ...MODEL, connectionRevision: 'guessed-revision' }; }, (r: Record<string, unknown>) => { r.model = { ...MODEL, provider: 'claude' }; },
  ]) { const value = draftPayload(); change(value); assert.throws(() => readWorkflowDraft(value, DRAFT_SCOPE, MODEL), WorkflowPanelError); }
  assert.throws(() => readWorkflowDraft(draftPayload(), { ...DRAFT_SCOPE, conversation: null }, MODEL));
});

test('draft text accepts 64 KiB UTF-8 intact, rejects even one extra byte, and never truncates multibyte text', () => {
  for (const text of ['x'.repeat(WORKFLOW_DRAFT_BYTES), '😀'.repeat(WORKFLOW_DRAFT_BYTES / 4), '<script>fixture only</script>']) {
    assert.equal(readWorkflowDraft({ ...draftPayload(), text }, DRAFT_SCOPE, MODEL).text, text);
    assert.throws(() => readWorkflowDraft({ ...draftPayload(), text: '😀'.repeat(WORKFLOW_DRAFT_BYTES / 4) + 'x' }, DRAFT_SCOPE, MODEL));
  }
});

for (const kind of ['evidence', 'draft'] as const) {
  test(kind + ' API uses exact body with no prompt/model authority and separate 512 KiB response budget', async () => {
    const calls: { path: string; init: RequestInit }[] = []; let oversized = false;
    const api = new WorkflowPanelApi(TOKEN, async (input, init) => {
      calls.push({ path: String(input), init: init! });
      return oversized ? new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(WORKFLOW_HELPER_RESPONSE_BYTES + 1) } }) : Response.json(kind === 'draft' ? draftPayload() : evidencePayload());
    });
    const input = { workflowId: 'flow_one', stepKey: kind === 'draft' ? 'requirements' : 'prompt' };
    const read = () => kind === 'draft' ? api.draft(input) : api.evidence({ ...input, files: HELPER_FILES });
    await read(); assert.equal(calls[0]!.path, '/v1/workflows/' + kind); assert.equal(calls[0]!.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), kind === 'draft' ? input : { ...input, files: HELPER_FILES });
    oversized = true; await assert.rejects(read(), WorkflowPanelError); assert.equal(calls.length, 2);
  });

  test(kind + ' rejects a stale revision without filling evidence, appending draft, refreshing or retrying', async () => {
    let appends = 0; const f = fixture(helperSnapshot(), true, () => { appends++; return true; }); f.context({ model: MODEL });
    const base = f.defaultHandler(); f.handler(async call => {
      const response = await base(call); if (!call.path.endsWith('/' + kind)) return response;
      const value = await response.json() as Record<string, unknown>; value.workflowRevision = 2; return Response.json(value);
    });
    await f.panel.start(); choose(f.doc, 'action', 'handoff'); if (kind === 'draft') choose(f.doc, 'step', 'requirements');
    else { f.doc.field('files-brief').value = 'src/brief.txt'; f.doc.field('evidence').value = 'Existing manual evidence'; }
    await f.click(kind === 'draft' ? 'draft' : 'evidence-files');
    assert.equal(appends, 0); assert.equal(f.doc.field('evidence').value, kind === 'draft' ? '' : 'Existing manual evidence');
    assert.match(f.doc.mount.textContent, /Workflow revision changed.*Refresh explicitly/); assert.equal(f.calls.length, 3);
    assert.equal(previews(f.calls).length, 0); assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
  });

  test(kind + ' late responses are discarded on context, form, selected-step, model, token and teardown changes', async () => {
    for (const mutation of ['native', 'project', 'model', 'token', 'role-path', 'manual-json', 'step', 'stop', 'cleanup'] as const) {
      let appends = 0; const f = fixture(helperSnapshot(), true, () => { appends++; return true; }); f.context({ model: MODEL });
      let release!: (value: Response) => void; let signal: AbortSignal | undefined; const base = f.defaultHandler();
      f.handler(async call => {
        if (!call.path.endsWith('/' + kind)) return base(call);
        signal = call.init.signal!; return new Promise<Response>(resolve => { release = resolve; });
      });
      await f.panel.start(); choose(f.doc, 'action', 'handoff');
      if (kind === 'draft') choose(f.doc, 'step', 'requirements');
      else f.doc.field('files-brief').value = 'src/brief.txt';
      f.doc.button(kind === 'draft' ? 'draft' : 'evidence-files').emit('click', true); await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(release);
      if (mutation === 'native') f.context({ native: { ...NATIVE, threadId: 'other-thread' } });
      if (mutation === 'project') f.context({ path: 'C:/offline/other-project' });
      if (mutation === 'model') f.context({ model: { ...MODEL, effort: 'low' } });
      if (mutation === 'token') f.context({ token: 'control-fixture-' + 'd'.repeat(64) });
      if (mutation === 'role-path') { f.doc.field(kind === 'draft' ? 'files-requirements' : 'files-brief').value = 'src/changed.txt'; f.doc.field(kind === 'draft' ? 'files-requirements' : 'files-brief').emit('input'); }
      if (mutation === 'manual-json') { f.doc.field('evidence').value = 'Keep edited manual evidence'; f.doc.field('evidence').emit('input'); }
      if (mutation === 'step') choose(f.doc, 'step', 'plan');
      if (mutation === 'stop') f.panel.stop(); if (mutation === 'cleanup') f.panel.cleanup();
      assert.equal(signal!.aborted, true, mutation); release(Response.json(kind === 'draft' ? draftPayload() : evidencePayload())); await new Promise(resolve => setTimeout(resolve, 3));
      assert.equal(appends, 0, mutation); assert.doesNotMatch(f.doc.getElementById('workflow-evidence')?.value ?? '', /"sha256"/);
      assert.equal(f.doc.native.value, 'Existing native draft'); assert.equal(f.calls.length, 3);
      f.panel.cleanup();
    }
  });

  test(kind + ' readonly unknown response never retries, claims success, or creates an execution receipt', async () => {
    const f = fixture(helperSnapshot(), true, () => true); f.context({ model: MODEL }); const base = f.defaultHandler();
    f.handler(call => call.path.endsWith('/' + kind) ? Promise.resolve(new Response('', { status: 202 })) : base(call));
    await f.panel.start(); choose(f.doc, 'action', 'handoff'); if (kind === 'draft') choose(f.doc, 'step', 'requirements'); else f.doc.field('files-brief').value = 'src/brief.txt';
    await f.click(kind === 'draft' ? 'draft' : 'evidence-files'); assert.equal(f.calls.length, 3);
    assert.doesNotMatch(f.doc.mount.textContent, /Receipt:|Step added|Evidence references prepared/);
    assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
  });
}
test('helper streamed response limits cancel at 512 KiB for both readonly routes, without retries', async () => {
  for (const kind of ['evidence', 'draft'] as const) {
    let calls = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(WORKFLOW_HELPER_RESPONSE_BYTES + 1)); }, cancel() { cancelled = true; } });
    const api = new WorkflowPanelApi(TOKEN, async () => { calls++; return new Response(stream, { headers: { 'content-type': 'application/json' } }); });
    const read = kind === 'draft' ? api.draft({ workflowId: 'flow_one', stepKey: 'requirements' }) : api.evidence({ workflowId: 'flow_one', stepKey: 'prompt', files: HELPER_FILES });
    await assert.rejects(read, (error: unknown) => error instanceof WorkflowPanelError && !error.unknownOutcome);
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
});

test('helpers accept canonical Claude binding without conflating its RequestedModel provider; local extras never leave the body', () => {
  const conversation: NativeWorkflowConversation = { ...NATIVE, provider: 'claude-code', sessionId: 'reported-session' };
  const model: RequestedModel = { ...MODEL, provider: 'claude' };
  const expected = { ...DRAFT_SCOPE, conversation };
  const response = { ...draftPayload(), conversation: serverConversation(conversation), model };
  assert.equal(readWorkflowDraft(response, expected, model).model.provider, 'claude');
  const evidence = { ...evidencePayload(), conversation: serverConversation(conversation) };
  assert.equal(readWorkflowEvidence(evidence, { ...HELPER_SCOPE, conversation }, HELPER_FILES, []).conversation!.provider, 'claude-code');
  assert.throws(() => readWorkflowDraft({ ...response, conversation: { ...serverConversation(conversation), connectionId: 'not-server-binding' } }, expected, model));
  assert.throws(() => readWorkflowDraft({ ...response, conversation: { provider: 'claude-code', threadId: conversation.threadId } }, expected, model));
});

test('full 64 KiB server text reaches the atomic callback intact; existing composer 128 KiB cap can refuse without truncation', async () => {
  const text = '😀'.repeat(WORKFLOW_DRAFT_BYTES / 4); let observed = ''; let appends = 0; let f: ReturnType<typeof fixture>;
  f = fixture(helperSnapshot(), true, value => {
    observed = value; appends++;
    const combined = f.doc.native.value + '\n\n' + value;
    if (new TextEncoder().encode(combined).byteLength > 128 * 1024) return false;
    f.doc.native.value = combined; f.doc.native.emit('input'); return true;
  });
  f.context({ model: MODEL }); const base = f.defaultHandler();
  f.handler(call => call.path.endsWith('/draft') ? Promise.resolve(Response.json({ ...draftPayload(), text })) : base(call));
  await f.panel.start(); choose(f.doc, 'step', 'requirements'); await f.click('draft');
  assert.equal(observed, text); assert.equal(appends, 1); assert.equal(f.doc.native.value, 'Existing native draft\n\n' + text);
  f.doc.native.value = 'x'.repeat(64 * 1024); await f.click('draft');
  assert.equal(observed, text); assert.equal(appends, 2); assert.equal(f.doc.native.value, 'x'.repeat(64 * 1024));
  assert.match(f.doc.mount.textContent, /unavailable or full/); assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
});

test('evidence helper actions and server text stay inert under genuine untrusted events and XSS data', async () => {
  const f = fixture(helperSnapshot()); await f.panel.start(); choose(f.doc, 'action', 'handoff'); f.doc.field('files-brief').value = 'src/brief.txt';
  f.doc.button('evidence-files').dispatchEvent(new Event('click')); assert.equal(f.calls.length, 2);
  let received = ''; const d = fixture(helperSnapshot(), true, text => { received = text; return true; }); d.context({ model: MODEL });
  const base = d.defaultHandler(); d.handler(call => call.path.endsWith('/draft') ? Promise.resolve(Response.json({ ...draftPayload(), text: '<img src=x onerror=fixture-only>' })) : base(call));
  await d.panel.start(); choose(d.doc, 'step', 'requirements'); await d.click('draft');
  assert.equal(received, '<img src=x onerror=fixture-only>'); assert.ok(d.doc.mount.all().every(el => el.tagName !== 'IMG' && el.tagName !== 'SCRIPT'));
  assert.equal(d.doc.native.value, 'Existing native draft'); f.panel.cleanup(); d.panel.cleanup();
});

test('generated evidence cannot silently carry across workflows, selected steps, revisions, or contexts', async () => {
  for (const change of ['workflow', 'step', 'revision', 'context'] as const) {
    const f = fixture(helperSnapshot()); await f.panel.start(); choose(f.doc, 'action', 'handoff');
    f.doc.field('files-brief').value = 'src/brief.txt'; await f.click('evidence-files');
    assert.ok(f.doc.field('evidence').value);
    if (change === 'workflow') {
      const other = helperSnapshot(); other.workflow.id = 'flow_two'; f.state(other);
      choose(f.doc, 'stored', 'flow_two'); assert.equal(f.doc.field('evidence').value, '');
      await f.click('inspect');
      assert.equal(f.doc.field('step').value, 'prompt');
    }
    if (change === 'step') choose(f.doc, 'step', 'requirements');
    if (change === 'revision') { const updated = helperSnapshot(); updated.workflow.revision = 2; f.state(updated); await f.click('refresh'); }
    if (change === 'context') f.context({ native: { ...NATIVE, threadId: 'other-thread' } });
    assert.equal(f.doc.field('evidence').value, '', change); assert.equal(f.doc.native.value, 'Existing native draft');
    await f.click('decision'); assert.equal(previews(f.calls).length, 0, change); assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
  }
});

test('manual JSON requires deliberate replacement after another workflow, step or revision; it never auto-carries', async () => {
  const f = fixture(helperSnapshot()); await f.panel.start(); choose(f.doc, 'action', 'handoff');
  f.doc.field('evidence').value = JSON.stringify(SUBMISSION); f.doc.field('evidence').emit('input');
  const second = helperSnapshot(); second.workflow.id = 'flow_two'; f.state(second);
  choose(f.doc, 'stored', 'flow_two'); await f.click('inspect');
  assert.equal(f.doc.field('evidence').value, ''); await f.click('decision'); assert.equal(previews(f.calls).length, 0);
  f.doc.field('evidence').value = JSON.stringify(SUBMISSION); f.doc.field('evidence').emit('input'); await f.click('decision');
  assert.equal(previews(f.calls).length, 1); assert.equal(previews(f.calls)[0]!.body!.workflowId, 'flow_two');
  await f.click('discard'); choose(f.doc, 'step', 'requirements'); assert.equal(f.doc.field('evidence').value, '');
  const third = clone(second); third.workflow.revision = 2; f.doc.field('evidence').value = 'Keep manual text only within the inspected revision';
  f.state(third); await f.click('refresh'); assert.equal(f.doc.field('evidence').value, ''); f.panel.cleanup();
});

test('changing generated evidence paths or serialized value refuses stale handoff; explicit manual editing remains usable', async () => {
  for (const change of ['path-event', 'path-silent', 'blank-path-silent', 'json-silent'] as const) {
    const f = fixture(helperSnapshot()); await f.panel.start(); choose(f.doc, 'action', 'handoff');
    f.doc.field('files-brief').value = 'src/brief.txt'; await f.click('evidence-files');
    if (change === 'json-silent') f.doc.field('evidence').value = JSON.stringify({ ...SUBMISSION, artifacts: [{ ...SUBMISSION.artifacts[0]!, path: 'src/another.txt' }] });
    else { f.doc.field('files-brief').value = change === 'blank-path-silent' ? '' : 'src/another.txt'; if (change === 'path-event') f.doc.field('files-brief').emit('input'); }
    await f.click('decision'); assert.equal(previews(f.calls).length, 0, change); assert.equal(f.doc.field('evidence').value, '', change);
    f.doc.field('evidence').value = JSON.stringify(SUBMISSION); f.doc.field('evidence').emit('input');
    await f.click('decision'); assert.equal(previews(f.calls).length, 1, change); assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
  }
});

test('refreshing the same workflow revision preserves its prepared evidence and requested files', async () => {
  const f = fixture(helperSnapshot()); await f.panel.start(); choose(f.doc, 'action', 'handoff');
  f.doc.field('files-brief').value = 'src/brief.txt'; await f.click('evidence-files');
  const value = f.doc.field('evidence').value; await f.click('refresh');
  assert.equal(f.doc.field('evidence').value, value); assert.equal(f.doc.field('files-brief').value, 'src/brief.txt');
  await f.click('decision'); assert.equal(previews(f.calls).length, 1); f.panel.cleanup();
});

test('late evidence response cannot overwrite changed paths, manual JSON, or a newly selected workflow', async () => {
  for (const change of ['silent-path', 'silent-manual', 'workflow'] as const) {
    const f = fixture(helperSnapshot()); const base = f.defaultHandler(); let release!: (value: Response) => void;
    f.handler(call => call.path.endsWith('/evidence') ? new Promise<Response>(resolve => { release = resolve; }) : base(call));
    await f.panel.start(); choose(f.doc, 'action', 'handoff'); f.doc.field('files-brief').value = 'src/brief.txt';
    f.doc.button('evidence-files').emit('click', true); await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(release);
    if (change === 'silent-path') f.doc.field('files-brief').value = 'src/changed.txt';
    if (change === 'silent-manual') f.doc.field('evidence').value = 'Preserve newly entered manual evidence';
    if (change === 'workflow') choose(f.doc, 'stored', 'flow_two');
    release(Response.json(evidencePayload())); await new Promise(resolve => setTimeout(resolve, 4));
    assert.equal(f.doc.field('evidence').value, change === 'silent-manual' ? 'Preserve newly entered manual evidence' : '');
    assert.equal(previews(f.calls).length, 0); assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
  }
});

test('planned evidence preflight teaches narrow scope and blocks out-of-scope paths without adding permissions or request fields', async () => {
  const f = fixture(null); await f.panel.start();
  const narrow = { ...REQUEST, scope: ['src/movement.luau'] }; fill(f.doc, narrow);
  assert.match(f.doc.mount.textContent, /Before creating.*brief, requirements, plan, review/);
  f.doc.field('evidence-paths').value = 'src/brief.txt\nsrc/requirements.txt\nsrc/plan.txt\nsrc/review.txt'; await f.click('recipe');
  assert.equal(previews(f.calls).length, 0); assert.equal(f.doc.field('scope').value, 'src/movement.luau');
  assert.match(f.doc.mount.textContent, /outside the exact file scope.*Scope was not expanded/);
  choose(f.doc, 'scope', 'src/movement.luau\nevidence');
  choose(f.doc, 'evidence-paths', 'evidence/brief.txt\nevidence/requirements.txt\nevidence/plan.txt\nevidence/review.txt');
  await f.click('recipe'); assert.equal(previews(f.calls).length, 1);
  const request = previews(f.calls)[0]!.body!.request as WorkflowRecipeRequest;
  assert.deepEqual(request.scope, ['evidence', 'src/movement.luau']);
  assert.deepEqual(Object.keys(request).sort(), ['deliverable', 'engine', 'model', 'prompt', 'scope', 'title']);
  assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
});

test('file-helper and explicit manual fallback both preflight actual paths against exact step scope before HTTP', async () => {
  const f = fixture(helperSnapshot({ ...REQUEST, scope: ['src/movement.luau'] })); await f.panel.start(); choose(f.doc, 'action', 'handoff');
  f.doc.field('files-brief').value = 'src/brief.txt'; await f.click('evidence-files');
  assert.equal(f.calls.length, 2); assert.equal(f.doc.field('evidence').value, '');
  f.doc.field('evidence').value = JSON.stringify(SUBMISSION); f.doc.field('evidence').emit('input'); await f.click('decision');
  assert.equal(previews(f.calls).length, 0); assert.equal(f.calls.length, 2);
  assert.match(f.doc.mount.textContent, /Include every brief, requirements, plan, review/); f.panel.cleanup();
});

test('draft callback receives exact detached deeply frozen provenance from validated server data and live context only', async () => {
  let received: WorkflowDraftProvenance | undefined; let receivedText = '';
  const f = fixture(helperSnapshot(), true, (text, provenance) => { receivedText = text; received = provenance; return true; });
  f.context({ model: MODEL }); const payload = draftPayload(); const base = f.defaultHandler();
  f.handler(call => call.path.endsWith('/draft') ? Promise.resolve(Response.json(payload)) : base(call));
  await f.panel.start(); choose(f.doc, 'step', 'requirements'); await f.click('draft');
  assert.ok(received); const pin = received;
  assert.equal(receivedText, payload.text);
  assert.deepEqual(pin, { projectPath: PATH, projectId: PROJECT, workflowId: 'flow_one', workflowRevision: 1, stepKey: 'requirements', conversation: serverConversation(), model: MODEL });
  assert.deepEqual(Object.keys(pin).sort(), ['conversation', 'model', 'projectId', 'projectPath', 'stepKey', 'workflowId', 'workflowRevision']);
  assert.ok(Object.isFrozen(pin) && Object.isFrozen(pin.conversation) && Object.isFrozen(pin.model));
  assert.equal(Reflect.set(pin, 'workflowId', 'forged'), false); assert.equal(Reflect.set(pin.conversation, 'threadId', 'forged'), false); assert.equal(Reflect.set(pin.model, 'effort', 'low'), false);
  (payload.conversation as NativeWorkflowConversation).threadId = 'mutated-response'; (payload.model as RequestedModel).model = 'mutated-response';
  f.context({ model: { ...MODEL, effort: 'low' }, native: { ...NATIVE, threadId: 'changed-live-thread' } });
  assert.equal(pin.conversation.threadId, NATIVE.threadId); assert.equal(pin.model.model, MODEL.model);
  assert.equal(pin.workflowId, 'flow_one'); assert.equal(previews(f.calls).length, 0); assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
});

test('draft provenance is never dispatched across late context, form, workflow or revision races', async () => {
  for (const change of ['silent-context', 'form', 'workflow', 'stale-revision'] as const) {
    let appends = 0; const f = fixture(helperSnapshot(), true, (_text, _pin) => { appends++; return true; }); f.context({ model: MODEL });
    const base = f.defaultHandler(); let release!: (value: Response) => void;
    f.handler(call => call.path.endsWith('/draft') ? new Promise<Response>(resolve => { release = resolve; }) : base(call));
    await f.panel.start(); choose(f.doc, 'step', 'requirements'); f.doc.button('draft').emit('click', true);
    await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(release);
    if (change === 'silent-context') f.context({ native: { ...NATIVE, threadId: 'other-thread' } }, false);
    if (change === 'form') { f.doc.field('evidence-paths').value = 'src/planned.txt'; f.doc.field('evidence-paths').emit('input'); }
    if (change === 'workflow') choose(f.doc, 'stored', 'flow_two');
    release(Response.json({ ...draftPayload(), ...(change === 'stale-revision' ? { workflowRevision: 2 } : {}) }));
    await new Promise(resolve => setTimeout(resolve, 4)); assert.equal(appends, 0, change);
    assert.equal(f.doc.native.value, 'Existing native draft'); assert.equal(f.calls.length, 3);
    assert.equal(previews(f.calls).length, 0); assert.equal(executions(f.calls).length, 0); f.panel.cleanup();
  }
});

test('an unchanged JSON input notification cannot detach generated provenance or preserve stale paths', async () => {
  const f = fixture(helperSnapshot()); await f.panel.start(); choose(f.doc, 'action', 'handoff');
  f.doc.field('files-brief').value = 'src/brief.txt'; await f.click('evidence-files');
  f.doc.field('evidence').emit('input'); f.doc.field('files-brief').value = 'src/changed.txt'; f.doc.field('files-brief').emit('input');
  assert.equal(f.doc.field('evidence').value, ''); await f.click('decision'); assert.equal(previews(f.calls).length, 0); f.panel.cleanup();
});
