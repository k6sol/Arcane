/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startWorkflowPanel, WorkflowPanelApi, WorkflowPanelError, readWorkflowSafeVerification,
  type NativeWorkflowConversation, type WorkflowSafeVerificationInput, type WorkflowSafeVerificationResult,
} from '../../apps/desktop/src/workflow-panel.js';
import { createWorkflowRecipe, type WorkflowRecipeRequest } from '../../packages/core/src/workflow-recipes.js';
import type { WorkflowSnapshot } from '../../apps/daemon/src/workflow-service.js';

const PROJECT = 'a'.repeat(64), OTHER = 'b'.repeat(64), HASH = 'c'.repeat(64), TOKEN = 'synthetic-safe-verifier-control';
const NATIVE: NativeWorkflowConversation = { provider: 'codex', threadId: 'synthetic-chat-A', sessionId: null };
const INPUT: WorkflowSafeVerificationInput = { workflowId: 'synthetic_flow', stepKey: 'verification', idempotencyKey: 'synthetic_key' };
const clone = <T>(value: T): T => structuredClone(value);
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
type AttestedSnapshot = WorkflowSnapshot & { conversation: NativeWorkflowConversation };
const REQUEST: WorkflowRecipeRequest = { deliverable: 'code-change', engine: 'roblox', title: 'Synthetic safe verifier UI fixture',
  prompt: 'Test explicit report creation controls only.', scope: ['src', 'reports'], model: null };
// Synthetic host observations and report data only; these tests run no provider or Studio.
function snapshot(native = NATIVE): AttestedSnapshot {
  const recipe = createWorkflowRecipe(REQUEST);
  return {
    conversation: clone(native),
    workflow: { id: INPUT.workflowId, projectId: PROJECT, recipe, creationReceiptHash: HASH, runId: 'synthetic_run',
      taskIds: Object.fromEntries(recipe.steps.map(s => [s.key, 'task_' + s.key])),
      taskStates: Object.fromEntries(recipe.steps.map(s => [s.key, s.key === 'verification' ? 'pending' as const : 'complete' as const])),
      state: 'active', submissions: [], decisions: [], attempts: [], operation: null, revision: 1 },
    tasks: [], assessment: { workflowId: recipe.id, steps: recipe.steps.map(s => ({ key: s.key,
      state: s.key === 'verification' ? 'pending' : 'complete', disposition: s.key === 'verification' ? 'verify' : 'complete', blockers: [] })),
      audit: [], learning: { mode: 'context learning not weights', authority: 'untrusted_supplemental_hints', references: [] } },
  };
}
function result(before: AttestedSnapshot, input = INPUT, status: WorkflowSafeVerificationResult['result'] = 'submitted'): AttestedSnapshot & WorkflowSafeVerificationResult {
  const value = { ...clone(before), result: status };
  value.workflow.revision++;
  value.workflow.attempts.push({ stepKey: input.stepKey, number: before.workflow.attempts.filter(a => a.stepKey === input.stepKey).length + 1,
    subjectDigest: HASH, state: status });
  if (status === 'submitted') {
    const step = value.workflow.recipe.steps.find(s => s.key === input.stepKey)!;
    value.workflow.taskStates[input.stepKey] = 'needs_review';
    value.workflow.submissions.push({ key: input.stepKey, subjectHashes: [],
      artifacts: [{ path: 'reports/synthetic-verification.json', role: 'report', bytes: 20, sha256: HASH }],
      checks: step.quality.checks.map((check, i) => ({ id: check.id, outcome: i === 0 ? 'pass' : 'unsupported', evidenceSha256: HASH, subjectDigest: HASH })) });
    const assessed = value.assessment!.steps.find(s => s.key === input.stepKey)!;
    assessed.disposition = 'pending'; assessed.blockers = [{ code: 'evidence', requirement: 'Synthetic partial unsupported checks' }];
  } else if (status === 'uncertain') {
    value.workflow.state = 'uncertain'; value.assessment = null;
    value.workflow.operation = { key: input.idempotencyKey, kind: 'verify', stepKey: input.stepKey, submission: null, approved: null };
  }
  return value;
}

// Private DOM harness follows workflow-panel.test.ts. Trusted-shaped clicks invoke
// captured listeners; ordinary Event objects retain their genuine isTrusted=false.
class ElementFixture {
  children: ElementFixture[] = []; parentElement: ElementFixture | null = null;
  value = ''; id = ''; type = ''; className = ''; disabled = false; hidden = false; required = false; maxLength = 0; open = false;
  private content = ''; private attrs = new Map<string, string>(); private listeners = new Map<string, EventListener[]>();
  constructor(readonly tagName: string) {}
  get textContent(): string { return this.content + this.children.map(c => c.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.content = value; }
  get innerHTML(): never { throw new Error('Forbidden HTML sink'); }
  set innerHTML(_value: string) { throw new Error('Forbidden HTML sink'); }
  append(...children: ElementFixture[]): void { for (const c of children) { c.parentElement = this; this.children.push(c); } }
  replaceChildren(...children: ElementFixture[]): void { this.children.forEach(c => { c.parentElement = null; }); this.children = []; this.content = ''; this.append(...children); }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null; }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  addEventListener(type: string, handler: EventListener): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], handler]); }
  removeEventListener(type: string, handler: EventListener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(h => h !== handler)); }
  all(): ElementFixture[] { return this.children.flatMap(c => [c, ...c.all()]); }
  emit(type: string, trusted = false): void {
    const event = { type, target: this, isTrusted: trusted, preventDefault() {} };
    for (let node: ElementFixture | null = this; node; node = node.parentElement) for (const h of node.listeners.get(type) ?? []) h(event as unknown as Event);
  }
  dispatchEvent(event: Event): void {
    Object.defineProperty(event, 'target', { value: this });
    for (let node: ElementFixture | null = this; node; node = node.parentElement) for (const h of node.listeners.get(event.type) ?? []) h(event);
  }
}
interface Call { path: string; init: RequestInit; body: Record<string, unknown> | undefined }
function fixture(t: test.TestContext, initial = snapshot()) {
  const mount = new ElementFixture('DIV'); mount.id = 'workflow-panel';
  const calls: Call[] = [];
  let state = clone(initial), native = clone(NATIVE), path = 'C:/synthetic/project-A', notify = () => {};
  const base = async (call: Call): Promise<Response> => {
    if (call.path === '/v1/workflows') return Response.json({ projectId: state.workflow.projectId,
      workflows: [{ id: state.workflow.id, recipeId: state.workflow.recipe.id, state: state.workflow.state }] });
    if (call.init.method === 'GET') return Response.json(state);
    if (call.path.endsWith('/verify-safe')) { state = result(state, call.body as unknown as WorkflowSafeVerificationInput); return Response.json(state); }
    assert.fail('Unexpected endpoint: ' + call.path);
  };
  let handler = base;
  const transport: typeof fetch = async (input, init) => {
    const call = { path: String(input), init: init!, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
    calls.push(call); return handler(call);
  };
  const doc = {
    defaultView: { fetch: transport, crypto: globalThis.crypto },
    createElement: (tag: string) => new ElementFixture(tag.toUpperCase()),
    getElementById: (id: string) => [mount, ...mount.all()].find(e => e.id === id) ?? null,
  };
  const button = (action: string): ElementFixture => { const el = mount.all().find(e => e.getAttribute('data-workflow-action') === action); assert.ok(el); return el; };
  const field = (name: string): ElementFixture => { const el = doc.getElementById('workflow-' + name); assert.ok(el); return el; };
  const panel = startWorkflowPanel(doc as unknown as Document, {
    getToken: () => TOKEN, getProjectPath: () => path, getNativeConversation: () => native,
    subscribeContextChange: listener => { notify = listener; return () => {}; }, timeoutMs: 500,
  });
  t.after(() => { panel.cleanup(); });
  const idle = async () => { for (let i = 0; i < 250; i++) { await tick(); if (!button('refresh').disabled) return; } assert.fail('Panel did not become idle'); };
  return { panel, calls, mount, button, field, idle, base,
    async click(action: string) { button(action).emit('click', true); await idle(); },
    select(step = 'verification') { field('step').value = step; field('step').emit('change'); },
    handler(fn: typeof base) { handler = fn; }, state(value: AttestedSnapshot) { state = clone(value); },
    context(value: NativeWorkflowConversation, projectPath = path, announce = true) { native = clone(value); path = projectPath; if (announce) notify(); },
  };
}
const verifications = (calls: Call[]) => calls.filter(c => c.path.endsWith('/verify-safe'));
const unknownError = (error: unknown) => error instanceof WorkflowPanelError && error.unknownOutcome;

test('verifySafe sends exactly validated identifiers and the existing human bearer transport settings', async () => {
  const calls: Call[] = [];
  const api = new WorkflowPanelApi(TOKEN, async (path, init) => {
    calls.push({ path: String(path), init: init!, body: JSON.parse(String(init!.body)) as Record<string, unknown> }); return Response.json({});
  });
  await api.verifySafe(INPUT);
  assert.equal(calls[0]!.path, '/v1/workflows/verify-safe'); assert.deepEqual(calls[0]!.body, INPUT);
  assert.equal(calls[0]!.init.method, 'POST'); assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer ' + TOKEN);
  assert.equal(calls[0]!.init.credentials, 'same-origin'); assert.equal(calls[0]!.init.redirect, 'error');
  for (const invalid of [{ ...INPUT, command: 'arbitrary' }, { ...INPUT, receiptHash: HASH }, { ...INPUT, stepKey: '../bad' },
    { ...INPUT, workflowId: 'x'.repeat(65) }, { ...INPUT, idempotencyKey: 1 }, { workflowId: INPUT.workflowId, stepKey: INPUT.stepKey }, null]) {
    assert.throws(() => api.verifySafe(invalid as WorkflowSafeVerificationInput), WorkflowPanelError);
  }
  assert.equal(calls.length, 1);
});

test('lost acknowledgement, 202, 5xx, malformed/oversized response, timeout and cancellation are unknown and never retried', async t => {
  const transports: Array<[string, typeof fetch, number]> = [
    ['lost ack', async () => { throw new Error('Synthetic acknowledgement loss'); }, 100],
    ['202', async () => Response.json(result(snapshot(), INPUT, 'uncertain'), { status: 202 }), 100],
    ['503', async () => new Response('', { status: 503 }), 100],
    ['malformed', async () => new Response('{', { headers: { 'Content-Type': 'application/json' } }), 100],
    ['oversized', async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(4 * 1024 * 1024 + 1) } }), 100],
    ['timeout', () => new Promise<Response>(() => {}), 5],
  ];
  for (const [label, transport, timeout] of transports) await t.test(label, async () => {
    let calls = 0;
    const api = new WorkflowPanelApi(TOKEN, (...args) => { calls++; return transport(...args); }, timeout);
    await assert.rejects(api.verifySafe(INPUT), unknownError); assert.equal(calls, 1);
  });
  const controller = new AbortController(); let calls = 0;
  const api = new WorkflowPanelApi(TOKEN, () => { calls++; return new Promise<Response>(() => {}); });
  const pending = api.verifySafe(INPUT, controller.signal); controller.abort();
  await assert.rejects(pending, unknownError); assert.equal(calls, 1);
  const refused = new WorkflowPanelApi(TOKEN, async () => new Response('', { status: 403 }));
  await assert.rejects(refused.verifySafe(INPUT), error => error instanceof WorkflowPanelError && !error.unknownOutcome);
});

test('safe verification results require exact project/native/workflow/recipe and the new last attempt; reports cannot claim completion', () => {
  const before = snapshot();
  for (const status of ['submitted', 'busy', 'unsupported', 'uncertain'] as const) assert.equal(readWorkflowSafeVerification(result(before, INPUT, status), before, INPUT, NATIVE).result, status);
  const mutations: Array<(value: ReturnType<typeof result>) => void> = [
    v => { v.workflow.projectId = OTHER; }, v => { v.workflow.id = 'other_flow'; },
    v => { v.workflow.recipe.id = 'other_recipe'; }, v => { v.workflow.recipe.title = 'Changed same-id recipe'; },
    v => { v.conversation.threadId = 'other_chat'; }, v => { v.conversation.sessionId = 'other_session'; },
    v => { v.workflow.attempts.at(-1)!.stepKey = 'implementation'; }, v => { v.workflow.attempts.at(-1)!.state = 'busy'; },
    v => { v.workflow.attempts.at(-1)!.number = 2; }, v => { v.workflow.attempts.at(-1)!.subjectDigest = 'bad'; },
    v => { v.workflow.revision = before.workflow.revision; }, v => { v.workflow.taskStates.verification = 'complete'; },
    v => { v.assessment!.steps.find(s => s.key === 'verification')!.disposition = 'complete'; },
    v => { v.workflow.submissions[0]!.artifacts[0]!.path = 'outside/report.json'; },
    v => { v.workflow.submissions[0]!.artifacts[0]!.role = 'patch'; }, v => { v.result = 'unsupported'; },
  ];
  for (const mutate of mutations) { const value = result(before); mutate(value); assert.throws(() => readWorkflowSafeVerification(value, before, INPUT, NATIVE), WorkflowPanelError); }
  assert.throws(() => readWorkflowSafeVerification({ ...result(before), conversation: undefined }, before, INPUT, NATIVE), WorkflowPanelError);
  assert.throws(() => readWorkflowSafeVerification({ ...result(before), extra: true }, before, INPUT, NATIVE), WorkflowPanelError);
});

test('only an explicit trusted-shaped click runs one verifier and displays partial unsupported checks as report evidence', async t => {
  const f = fixture(t); await f.panel.start(); f.select();
  assert.equal(f.button('verify-safe').textContent, 'Run pinned verification'); assert.equal(f.button('verify-safe').disabled, false);
  assert.match(f.mount.textContent, /No model or Studio is called/);
  f.button('verify-safe').dispatchEvent(new Event('click', { cancelable: true })); await tick();
  assert.equal(verifications(f.calls).length, 0);
  await f.click('verify-safe');
  assert.equal(verifications(f.calls).length, 1);
  assert.deepEqual(Object.keys(verifications(f.calls)[0]!.body!).sort(), ['idempotencyKey', 'stepKey', 'workflowId']);
  assert.match(f.mount.textContent, /Verification report created/); assert.match(f.mount.textContent, /: unsupported/);
  assert.match(f.mount.textContent, /report creation is not step completion/); assert.match(f.mount.textContent, /Synthetic partial unsupported checks/);
  assert.equal(f.button('verify-safe').disabled, true);
  assert.ok(f.calls.every(c => c.path.startsWith('/v1/workflows')));
});

test('false host readiness, capability blockers, foreign chat, nonlocal steps and exhausted/nonbusy attempts disable verification', async t => {
  const cases: Array<[string, (value: AttestedSnapshot) => void]> = [
    ['pending readiness', v => { v.assessment!.steps.find(s => s.key === 'verification')!.disposition = 'pending'; }],
    ['capability false', v => { v.assessment!.steps.find(s => s.key === 'verification')!.blockers = [{ code: 'capability', requirement: 'local.code.verify' }]; }],
    ['foreign chat', v => { v.conversation.threadId = 'other_chat'; }],
    ['already submitted', v => { v.workflow.attempts = [{ stepKey: 'verification', number: 1, subjectDigest: HASH, state: 'submitted' }]; }],
    ['unsupported attempt', v => { v.workflow.attempts = [{ stepKey: 'verification', number: 1, subjectDigest: HASH, state: 'unsupported' }]; }],
    ['exhausted busy', v => { v.workflow.attempts = [1, 2].map(number => ({ stepKey: 'verification', number, subjectDigest: HASH, state: 'busy' })); }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async t => {
    const state = snapshot(); mutate(state); const f = fixture(t, state); await f.panel.start(); f.select();
    assert.equal(f.button('verify-safe').disabled, true); await f.click('verify-safe'); assert.equal(verifications(f.calls).length, 0);
  });
  const f = fixture(t); await f.panel.start(); f.select('implementation'); assert.equal(f.button('verify-safe').disabled, true);
});

test('one flight blocks duplicate trusted clicks, pending previews and context changes without notifications', async t => {
  const f = fixture(t); await f.panel.start(); f.select();
  let release!: (value: Response) => void;
  f.handler(call => call.path.endsWith('/verify-safe') ? new Promise<Response>(resolve => { release = resolve; }) : f.base(call));
  f.button('verify-safe').emit('click', true); f.button('verify-safe').emit('click', true); f.button('refresh').emit('click', true);
  assert.equal(verifications(f.calls).length, 1); assert.equal(f.button('verify-safe').disabled, true);
  release(Response.json(result(snapshot(), verifications(f.calls)[0]!.body as unknown as WorkflowSafeVerificationInput))); await f.idle();
  const g = fixture(t); await g.panel.start(); g.select();
  g.field('title').value = REQUEST.title; g.field('prompt').value = REQUEST.prompt; g.field('scope').value = REQUEST.scope.join('\n');
  let previewRelease!: (value: Response) => void;
  g.handler(call => call.path.endsWith('/preview') ? new Promise<Response>(resolve => { previewRelease = resolve; }) : g.base(call));
  g.button('recipe').emit('click', true); assert.equal(g.button('verify-safe').disabled, true);
  g.button('verify-safe').emit('click', true); assert.equal(verifications(g.calls).length, 0);
  previewRelease(new Response('', { status: 403 })); await g.idle();
  g.context({ ...NATIVE, threadId: 'changed_without_notice' }, undefined, false);
  await g.click('verify-safe'); assert.equal(verifications(g.calls).length, 0);
});

test('lost acknowledgement retains original workflow/key until explicit inspection sees a durable attempt, without replay', async t => {
  const f = fixture(t); await f.panel.start(); f.select();
  f.handler(async call => { if (call.path.endsWith('/verify-safe')) throw new Error('Synthetic lost acknowledgement'); return f.base(call); });
  await f.click('verify-safe');
  const original = verifications(f.calls)[0]!.body as unknown as WorkflowSafeVerificationInput;
  assert.match(f.mount.textContent, /Verification outcome remains unknown/); assert.match(f.mount.textContent, new RegExp(original.idempotencyKey));
  assert.match(f.mount.textContent, /Workflow: synthetic_flow/); assert.doesNotMatch(f.mount.textContent, /Human receipt:/);
  await f.click('verify-safe'); await f.click('refresh'); f.select(); assert.equal(f.button('verify-safe').disabled, true);
  assert.equal(verifications(f.calls).length, 1);
  f.state(result(snapshot(), original)); await f.click('inspect');
  assert.match(f.mount.textContent, /Pinned verification: observed \(submitted\)/); assert.equal(verifications(f.calls).length, 1);
});

test('a displayed human preview or unknown human receipt prevents safe verification', async t => {
  const f = fixture(t); await f.panel.start(); f.select();
  f.field('title').value = REQUEST.title; f.field('prompt').value = REQUEST.prompt; f.field('scope').value = REQUEST.scope.join('\n');
  f.handler(async call => {
    if (call.path.endsWith('/preview')) {
      const request = call.body!.request as WorkflowRecipeRequest;
      return Response.json({ prepared: { kind: 'create-recipe', projectId: PROJECT, workflowId: null, recipe: createWorkflowRecipe(request),
        stepKey: null, decision: 'approved', binding: HASH, subjectHashes: [], inputArtifacts: [], submission: null, recipeGate: null, operation: null },
        receiptHash: OTHER, request, conversation: NATIVE });
    }
    if (call.path.endsWith('/execute')) throw new Error('Synthetic human acknowledgement loss');
    return f.base(call);
  });
  await f.click('recipe'); assert.equal(f.button('verify-safe').disabled, true);
  await f.click('verify-safe'); assert.equal(verifications(f.calls).length, 0);
  await f.click('discard'); assert.equal(f.button('verify-safe').disabled, false);
  await f.click('recipe'); await f.click('confirm');
  assert.match(f.mount.textContent, /Receipt: unknown/); assert.equal(f.button('verify-safe').disabled, true);
  await f.click('verify-safe'); assert.equal(verifications(f.calls).length, 0);
});

test('invalid acknowledged snapshots retain unknown verification instead of claiming a report or permitting another run', async t => {
  const mutations: Array<[string, (value: ReturnType<typeof result>) => void]> = [
    ['foreign result', value => { value.workflow.projectId = OTHER; }],
    ['report outside scope', value => { value.workflow.submissions[0]!.artifacts[0]!.path = 'outside/report.json'; }],
    ['claimed completion', value => { value.workflow.taskStates.verification = 'complete'; }],
  ];
  for (const [label, mutate] of mutations) await t.test(label, async t => {
    const f = fixture(t); await f.panel.start(); f.select();
    f.handler(async call => {
      if (!call.path.endsWith('/verify-safe')) return f.base(call);
      const value = result(snapshot(), call.body as unknown as WorkflowSafeVerificationInput); mutate(value); return Response.json(value);
    });
    await f.click('verify-safe');
    assert.match(f.mount.textContent, /Pinned verification: unknown/); assert.doesNotMatch(f.mount.textContent, /Verification report created/);
    assert.equal(f.button('verify-safe').disabled, true); await f.click('verify-safe'); assert.equal(verifications(f.calls).length, 1);
  });
});

test('context A to B and back preserves unknown A request and ignores late A replies', async t => {
  const f = fixture(t); await f.panel.start(); f.select();
  let release!: (value: Response) => void;
  f.handler(call => call.path.endsWith('/verify-safe') ? new Promise<Response>(resolve => { release = resolve; }) : f.base(call));
  f.button('verify-safe').emit('click', true);
  const call = verifications(f.calls)[0]!, original = call.body as unknown as WorkflowSafeVerificationInput;
  const nativeB = { ...NATIVE, threadId: 'synthetic-chat-B' }, stateB = snapshot(nativeB);
  stateB.workflow.projectId = OTHER; stateB.workflow.id = 'synthetic_flow_B';
  f.state(stateB); f.context(nativeB, 'C:/synthetic/project-B'); await f.click('refresh');
  assert.equal(call.init.signal!.aborted, true); assert.match(f.mount.textContent, /synthetic_flow_B/);
  release(Response.json(result(snapshot(), original))); await tick(); await tick();
  assert.doesNotMatch(f.mount.textContent, /Verification report created/); assert.doesNotMatch(f.mount.textContent, /synthetic_flow\n/);
  f.state(snapshot()); f.context(NATIVE, 'C:/synthetic/project-A'); await f.click('refresh'); f.select();
  assert.match(f.mount.textContent, new RegExp(original.idempotencyKey)); assert.match(f.mount.textContent, /Pinned verification: unknown/);
  assert.equal(f.button('verify-safe').disabled, true); assert.equal(verifications(f.calls).length, 1);
});

test('explicit refresh resolves an uncertain operation without replay and a host-ready busy attempt needs another trusted click', async t => {
  const f = fixture(t); await f.panel.start(); f.select();
  f.handler(async call => { if (call.path.endsWith('/verify-safe')) { f.state(result(snapshot(), call.body as unknown as WorkflowSafeVerificationInput, 'uncertain')); return new Response('', { status: 202 }); } return f.base(call); });
  await f.click('verify-safe'); await f.click('refresh'); f.select();
  assert.match(f.mount.textContent, /Pinned verification: observed \(uncertain\)/); assert.equal(f.button('verify-safe').disabled, true);
  assert.equal(verifications(f.calls).length, 1);
  const busy = result(snapshot(), INPUT, 'busy'), g = fixture(t, busy); await g.panel.start(); g.select();
  assert.equal(g.button('verify-safe').disabled, false); assert.equal(verifications(g.calls).length, 0);
  await g.click('verify-safe'); assert.equal(verifications(g.calls).length, 1);
});
