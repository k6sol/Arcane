/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  ASSET_CONVERSATION_BYTES, StudioApi, StudioWorkbench,
  type AssetConversation, type AssetConversationPage, type StudioWorkbenchOptions,
} from '../../apps/desktop/src/studio.js';
import type { AssetJobRecord } from '../../apps/daemon/src/asset-service.js';

// Synthetic matched HTTP metadata only. These controller tests record viewer
// admission; the accompanying Edge test verifies authenticated GLB bytes/GPU.
const TOKEN = 'a'.repeat(64), PATH = 'C:\\owned-fixture\\automatic-assets', PROJECT = 'b'.repeat(64);
const NATIVE: AssetConversation = { provider: 'codex', threadId: 'fixture-thread', sessionId: 'fixture-session' };
const OLD = '11111111-1111-4111-8111-111111111111', LIVE = '22222222-2222-4222-8222-222222222222', FRESH = '33333333-3333-4333-8333-333333333333';
function job(id = LIVE, state: AssetJobRecord['state'] = 'running', startedAt = '2026-10-14T10:01:00.000Z', manifestAvailable = state === 'succeeded'): AssetJobRecord {
  return { schemaVersion: 1, jobId: id, directory: PATH + '\\assets\\' + id, manifestPath: null,
    request: { schemaVersion: 1, template: 'hero-prop', name: 'fixture-' + id.slice(0, 8), seed: 1, sizeMeters: [1, .65, .7], color: [.12, .32, .27], triangleBudget: 5000, renderResolution: 384, renderSamples: 16 },
    state, stage: state === 'running' ? 'modeling' : 'complete', startedAt, updatedAt: startedAt, events: [], manifestAvailable, error: null };
}
const historical = () => job(OLD, 'succeeded', '2026-10-14T10:00:00.000Z');
function page(jobs: AssetJobRecord[], nextCursor: string | null = null): AssetConversationPage {
  return { projectId: PROJECT, projectPath: PATH, conversation: { ...NATIVE }, jobs, nextCursor, byteLimit: ASSET_CONVERSATION_BYTES };
}
function manifest(item: AssetJobRecord) { return { jobId: item.jobId, request: item.request, artifacts: [] }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let n = 0; n < 8; n++) await setImmediate(); }

class ElementFixture extends EventTarget {
  id = ''; value = ''; hidden = false; disabled = false; className = ''; type = ''; checked = false; open = false;
  parentElement: ElementFixture | null = null; children: ElementFixture[] = [];
  dataset: Record<string, string> = {}; attributes = new Map<string, string>(); private text = '';
  constructor(readonly tagName = 'DIV') { super(); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(' '); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  set innerHTML(_value: string) { assert.fail('Asset cards must use DOM/text sinks'); }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  get childElementCount() { return this.children.length; }
  append(...children: ElementFixture[]) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children: ElementFixture[]) { for (const child of this.children) child.parentElement = null; this.children = []; this.text = ''; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  all(): ElementFixture[] { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelectorAll(selector: string) { return this.all().filter(child => selector.split(',').some(s => child.tagName.toLowerCase() === s.trim() || s.startsWith('.') && child.className.split(' ').includes(s.slice(1)))); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
class DocumentFixture extends EventTarget {
  readonly defaultView = Object.assign(new EventTarget(), { CustomEvent, setTimeout, clearTimeout });
  readonly elements = new Map<string, ElementFixture>();
  getElementById(id: string) { let node = this.elements.get(id); if (!node) { node = new ElementFixture(id.endsWith('picker') || id === 'settings-key-select' ? 'SELECT' : 'DIV'); node.id = id; this.elements.set(id, node); } return node; }
  createElement(tag: string) { return new ElementFixture(tag.toUpperCase()); }
  createTextNode(text: string) { const node = new ElementFixture('#TEXT'); node.textContent = text; return node; }
}
interface WorkbenchAccess {
  assetJobs: AssetJobRecord[]; assetJobId: string; assetAvailable: boolean; assetBusy: boolean; assetNextCursor: string | null;
  assetViewer: { clear(): void; show(value: unknown, id: string, current: () => boolean): Promise<void> };
  refreshAssets(more?: boolean): Promise<void>; resetAssetContext(): void; stop(): void; resume(): void; start(): Promise<void>;
  refresh(): Promise<void>; schedule(): void;
  renderNativeForm(): void; addWorkTask(): void; renderKeyControls(): void; renderForm(): void; renderControls(): void;
}
type HttpCall = { path: string; method: string };
async function fixture(t: test.TestContext, signedIn?: boolean | 'throw' | 'truthy') {
  let reply: unknown = page([]), manifestReply: Response | Promise<Response> | null = null;
  let viewerGate: Promise<void> | null = null;
  let path: string | null = PATH, native: (AssetConversation & { projectPath: string }) | null = { ...NATIVE, projectPath: PATH };
  const listeners = new Set<() => void>(), signInListeners = new Set<() => void>(), calls: HttpCall[] = [], admissions: string[] = [], viewerStarts: string[] = [], activities: { jobId: string; state: string }[] = [];
  const options: StudioWorkbenchOptions = { getProjectPath: () => path, getNativeConversation: () => native,
    subscribeContextChange: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    ...(signedIn === undefined ? {} : { isSignedIn: () => {
      if (signedIn === 'throw') throw new Error('Synthetic unavailable sign-in metadata');
      return signedIn === 'truthy' ? 'true' as unknown as boolean : signedIn === true;
    },
      subscribeSignInChange: (fn: () => void) => { signInListeners.add(fn); return () => { signInListeners.delete(fn); }; } }),
  };
  const doc = new DocumentFixture();
  for (const [id, value] of Object.entries({ 'asset-template': 'hero-prop', 'asset-name': 'fixture', 'asset-size': '1,.65,.7', 'asset-color': '.12,.32,.27', 'asset-seed': '1', 'asset-budget': '5000', 'asset-resolution': '384', 'asset-samples': '16' })) doc.getElementById(id).value = value;
  doc.getElementById('codex-messages').textContent = 'Recorded public native text';
  doc.addEventListener('workspace:assetactivity', event => activities.push((event as CustomEvent<{ jobId: string; state: string }>).detail));
  const api = new StudioApi(TOKEN, async (input, init) => {
    const url = String(input); calls.push({ path: url, method: init?.method ?? 'GET' });
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + TOKEN);
    assert.equal(init?.method, 'GET', 'automatic previews cannot mutate host state');
    if (url.startsWith('/v1/assets/manifest?')) {
      if (manifestReply) return await manifestReply;
      const id = new URL(url, 'http://fixture.invalid').searchParams.get('jobId');
      const item = ((reply as AssetConversationPage).jobs ?? []).find(item => item.jobId === id);
      assert.ok(item, 'manifest must use an exact returned job'); return Response.json({ manifest: manifest(item) });
    }
    assert.match(url, /^\/v1\/assets\/(?:conversation-jobs|jobs)\?limit=32(?:&after=.+)?$/);
    return Response.json(reply);
  });
  const view = new StudioWorkbench(doc as unknown as Document, api, 'http://fixture.invalid', TOKEN, options) as unknown as WorkbenchAccess;
  view.assetViewer = { clear() {}, async show(_manifest, id, current) { viewerStarts.push(id); if (viewerGate) await viewerGate; if (current()) admissions.push(id); } };
  // Keep real start() asset event registration. Unrelated tool/controller
  // startup is outside this focused fixture and cannot make HTTP requests.
  view.refresh = async () => {}; view.schedule = () => {};
  for (const name of ['renderNativeForm', 'addWorkTask', 'renderKeyControls', 'renderForm', 'renderControls'] as const) view[name] = () => {};
  await view.start(); t.after(() => view.stop());
  return { doc, view, calls, admissions, viewerStarts, activities,
    async poll(value: unknown, more = false) { reply = value; await view.refreshAssets(more); await settle(); },
    holdManifest(value: Response | Promise<Response>) { manifestReply = value; },
    holdViewer(value: Promise<void>) { viewerGate = value; },
    signIn(value: boolean) { signedIn = value; for (const fn of signInListeners) fn(); },
    signInSubscriptions() { return signInListeners.size; },
    change(next: AssetConversation | null, nextPath: string | null = path, nativePath = nextPath) { path = nextPath; native = next ? { ...next, projectPath: nativePath ?? '' } : null; for (const fn of listeners) fn(); },
    manifestCalls() { return calls.filter(call => call.path.startsWith('/v1/assets/manifest?')); },
    cards() { return doc.getElementById('chat-assets'); },
  };
}

test('initial bound HEAD presents completed cards without selection, manifest read or viewer admission', async t => {
  const f = await fixture(t); await f.poll(page([historical()]));
  assert.ok(f.cards().all().some(node => node.getAttribute('data-job-id') === OLD)); assert.ok(f.cards().childElementCount > 0);
  assert.equal(f.view.assetJobId, ''); assert.deepEqual(f.manifestCalls(), []); assert.deepEqual(f.admissions, []); assert.deepEqual(f.activities, []);
  assert.equal(f.doc.getElementById('codex-messages').textContent, 'Recorded public native text');
});

test('observed running job automatically selects; successful availability admits its exact manifest once', async t => {
  const f = await fixture(t); await f.poll(page([historical(), job()]));
  assert.equal(f.view.assetJobId, LIVE); assert.ok(f.activities.some(event => event.jobId === LIVE && event.state === 'running'));
  assert.ok(f.cards().all().some(node => node.getAttribute('data-job-id') === LIVE)); assert.deepEqual(f.manifestCalls(), []);
  await f.poll(page([job(LIVE, 'succeeded', undefined, false), historical()])); assert.deepEqual(f.manifestCalls(), []);
  await f.poll(page([job(LIVE, 'succeeded'), historical()]));
  for (let n = 0; n < 3; n++) await f.poll(page([job(LIVE, 'succeeded'), historical()]));
  assert.deepEqual(f.manifestCalls(), [{ path: '/v1/assets/manifest?jobId=' + LIVE, method: 'GET' }]); assert.deepEqual(f.admissions, [LIVE]);
});

test('a fresh instant completion after baseline loads while historical backfill never does', async t => {
  const f = await fixture(t); await f.poll(page([historical()], 'opaque:older'));
  await f.poll(page([job('44444444-4444-4444-8444-444444444444', 'succeeded', '2026-10-14T09:00:00.000Z')]), true);
  assert.deepEqual(f.manifestCalls(), []);
  await f.poll(page([job(FRESH, 'succeeded', '2026-10-14T10:02:00.000Z'), historical()]));
  assert.deepEqual(f.admissions, [FRESH]); assert.equal(f.manifestCalls().length, 1);
});

test('pagination cannot auto-admit a running backfill or its later completion', async t => {
  const f = await fixture(t); await f.poll(page([historical()], 'older'));
  await f.poll(page([job(LIVE, 'running', '2026-10-14T09:00:00.000Z')]), true);
  await f.poll(page([job(LIVE, 'succeeded', '2026-10-14T09:00:00.000Z'), historical()]));
  assert.deepEqual(f.manifestCalls(), []); assert.deepEqual(f.admissions, []); assert.deepEqual(f.activities, []);
});

test('global history is inspection only, including running and fresh completed records', async t => {
  const f = await fixture(t);
  f.doc.getElementById('asset-history-scope').value = 'global';
  f.doc.getElementById('asset-history-scope').dispatchEvent(new Event('change'));
  await f.poll({ schemaVersion: 1, jobs: [job(), historical()], total: 2, nextCursor: null, byteLimit: ASSET_CONVERSATION_BYTES });
  await f.poll({ schemaVersion: 1, jobs: [job(LIVE, 'succeeded'), job(FRESH, 'succeeded')], total: 2, nextCursor: null, byteLimit: ASSET_CONVERSATION_BYTES });
  assert.deepEqual(f.manifestCalls(), []); assert.deepEqual(f.admissions, []); assert.deepEqual(f.activities, []);
  assert.equal(f.cards().childElementCount, 0);
});

test('foreign project/provider/thread/session pages cannot select or auto-load jobs', async t => {
  const changes = [
    { projectPath: PATH.toLowerCase() },
    { conversation: { ...NATIVE, provider: 'claude-code' } },
    { conversation: { ...NATIVE, threadId: 'another-thread' } },
    { conversation: { ...NATIVE, sessionId: 'another-session' } },
    { conversation: { ...NATIVE, sessionId: null } },
  ];
  for (const change of changes) {
    const f = await fixture(t); await f.poll({ ...page([job()]), ...change });
    assert.deepEqual(f.view.assetJobs, []); assert.equal(f.view.assetJobId, ''); assert.deepEqual(f.manifestCalls(), []); assert.equal(f.cards().childElementCount, 0);
  }
  const f = await fixture(t); await f.poll(page([historical()]));
  await f.poll({ ...page([job()]), projectId: 'c'.repeat(64) });
  assert.deepEqual(f.manifestCalls(), []); assert.equal(f.cards().childElementCount, 0);
});

test('manual picker selection mutes known pending jobs; genuinely new work still auto-loads', async t => {
  const f = await fixture(t); await f.poll(page([job(), historical()]));
  const picker = f.doc.getElementById('asset-job-picker'); picker.value = OLD; picker.dispatchEvent(new Event('change'));
  await f.poll(page([job(LIVE, 'succeeded'), historical()])); assert.equal(f.view.assetJobId, OLD); assert.deepEqual(f.manifestCalls(), []);
  await f.poll(page([job(FRESH, 'succeeded', '2026-10-14T10:02:00.000Z'), job(LIVE, 'succeeded'), historical()]));
  assert.deepEqual(f.admissions, [FRESH]);
});

test('card View uses the exact completed job and mutes the previously observed running job', async t => {
  const f = await fixture(t); await f.poll(page([job(), historical()]));
  const card = f.cards().all().find(node => node.getAttribute('data-job-id') === OLD), button = card?.querySelector('button');
  assert.ok(button); button.click(); await settle();
  assert.deepEqual(f.manifestCalls(), [{ path: '/v1/assets/manifest?jobId=' + OLD, method: 'GET' }]); assert.deepEqual(f.admissions, [OLD]);
  await f.poll(page([job(LIVE, 'succeeded'), historical()])); assert.deepEqual(f.admissions, [OLD]);
  assert.equal(f.view.assetJobId, OLD);
});

test('repeated polls during an in-flight automatic manifest read cannot duplicate the read or admission', async t => {
  const f = await fixture(t), held = deferred<Response>(); await f.poll(page([job(), historical()]));
  f.holdManifest(held.promise); await f.poll(page([job(LIVE, 'succeeded'), historical()]));
  for (let n = 0; n < 3; n++) await f.poll(page([job(LIVE, 'succeeded'), historical()]));
  assert.equal(f.manifestCalls().length, 1); assert.deepEqual(f.admissions, []);
  held.resolve(Response.json({ manifest: manifest(job(LIVE, 'succeeded')) })); await settle();
  assert.deepEqual(f.admissions, [LIVE]); assert.equal(f.manifestCalls().length, 1);
});

test('detached old card button cannot select or load after a context epoch changes', async t => {
  const f = await fixture(t); await f.poll(page([historical()]));
  const button = f.cards().all().find(node => node.getAttribute('data-job-id') === OLD)?.querySelector('button'); assert.ok(button);
  f.change({ ...NATIVE, threadId: 'other-thread' }); f.change(NATIVE); await f.poll(page([historical()]));
  button.click(); await settle(); assert.equal(f.view.assetJobId, ''); assert.deepEqual(f.manifestCalls(), []);
});

test('trusted native project mismatch or missing conversation disables the automatic flow', async t => {
  const f = await fixture(t); await f.poll(page([historical()]));
  f.change(NATIVE, PATH, PATH + '-other'); await f.poll(page([job()]));
  assert.deepEqual(f.manifestCalls(), []); assert.equal(f.cards().childElementCount, 0);
  f.change(null); await f.poll(page([job(LIVE, 'succeeded')]));
  assert.deepEqual(f.manifestCalls(), []); assert.deepEqual(f.admissions, []); assert.equal(f.view.assetJobId, '');
});

test('A to B to A clears cards and pending manifest results without stale viewer admission', async t => {
  const f = await fixture(t), held = deferred<Response>();
  await f.poll(page([job(), historical()])); f.holdManifest(held.promise);
  const completing = f.poll(page([job(LIVE, 'succeeded'), historical()]));
  await settle(); assert.equal(f.manifestCalls().length, 1);
  f.change({ ...NATIVE, threadId: 'other-thread' }); assert.equal(f.cards().childElementCount, 0); assert.equal(f.view.assetJobId, '');
  f.change(NATIVE); assert.equal(f.cards().childElementCount, 0);
  held.resolve(Response.json({ manifest: manifest(job(LIVE, 'succeeded')) })); await completing;
  await f.poll(page([job(LIVE, 'succeeded'), historical()]));
  assert.deepEqual(f.admissions, []); assert.equal(f.manifestCalls().length, 1); assert.equal(f.view.assetJobId, '');
});

test('failed manifest reads are single attempts and never create mutation or retry requests', async t => {
  const f = await fixture(t); await f.poll(page([job(), historical()]));
  f.holdManifest(Response.json({ error: 'FIXTURE_FAILURE', message: 'Synthetic read failure' }, { status: 503 }));
  await f.poll(page([job(LIVE, 'succeeded'), historical()]));
  for (let n = 0; n < 3; n++) await f.poll(page([job(LIVE, 'succeeded'), historical()]));
  assert.equal(f.manifestCalls().length, 1); assert.deepEqual(f.admissions, []); assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('supplied signed-out callback blocks cached native chat history and every asset read', async t => {
  const f = await fixture(t, false);
  await f.poll(page([job(), historical()])); await f.poll(page([job(LIVE, 'succeeded'), historical()]));
  assert.deepEqual(f.calls, []); assert.deepEqual(f.activities, []); assert.deepEqual(f.admissions, []);
  assert.equal(f.cards().childElementCount, 0); assert.equal(f.view.assetJobId, ''); assert.deepEqual(f.view.assetJobs, []);
});

test('supplied throwing or truthy nonboolean sign-in metadata cannot authorize automatic reads', async t => {
  for (const state of ['throw', 'truthy'] as const) {
    const f = await fixture(t, state); await f.poll(page([job(), historical()]));
    assert.deepEqual(f.calls, []); assert.deepEqual(f.activities, []); assert.deepEqual(f.admissions, []); assert.equal(f.cards().childElementCount, 0);
  }
});

test('sign-out clears pending jobs/cards despite unchanged cached conversation, and sign-in resets the baseline', async t => {
  const f = await fixture(t, true); await f.poll(page([job(), historical()]));
  f.signIn(false); assert.equal(f.cards().childElementCount, 0); assert.equal(f.view.assetJobId, ''); assert.deepEqual(f.view.assetJobs, []);
  const before = f.calls.length; await f.poll(page([job(LIVE, 'succeeded'), historical()])); assert.equal(f.calls.length, before);
  f.signIn(true); await f.poll(page([job(LIVE, 'succeeded'), historical()]));
  assert.deepEqual(f.manifestCalls(), []); assert.deepEqual(f.admissions, []); assert.equal(f.view.assetJobId, '');
});

test('auth loss fences a late automatic manifest without requiring native conversation invalidation', async t => {
  const f = await fixture(t, true), held = deferred<Response>(); await f.poll(page([job(), historical()]));
  f.holdManifest(held.promise); await f.poll(page([job(LIVE, 'succeeded'), historical()])); assert.equal(f.manifestCalls().length, 1);
  f.signIn(false); assert.equal(f.cards().childElementCount, 0); assert.equal(f.view.assetBusy, false);
  held.resolve(Response.json({ manifest: manifest(job(LIVE, 'succeeded')) })); await settle();
  assert.deepEqual(f.viewerStarts, []); assert.deepEqual(f.admissions, []); assert.equal(f.view.assetJobId, '');
  const before = f.calls.length; await f.poll(page([job(LIVE, 'succeeded')])); assert.equal(f.calls.length, before);
});

test('viewer completion after callback auth loss cannot admit or repopulate cleared asset UI', async t => {
  const f = await fixture(t, true), held = deferred<void>(); await f.poll(page([job(), historical()]));
  f.holdViewer(held.promise); await f.poll(page([job(LIVE, 'succeeded'), historical()])); assert.deepEqual(f.viewerStarts, [LIVE]);
  f.signIn(false); held.resolve(); await settle();
  assert.deepEqual(f.admissions, []); assert.equal(f.cards().childElementCount, 0); assert.equal(f.view.assetJobId, ''); assert.equal(f.view.assetBusy, false);
});

test('stop removes the sign-in callback; resume installs exactly one subscription again', async t => {
  const f = await fixture(t, true); await f.poll(page([historical()])); assert.equal(f.signInSubscriptions(), 1);
  f.view.stop(); assert.equal(f.signInSubscriptions(), 0);
  const before = f.calls.length; f.signIn(false); f.signIn(true); await settle(); assert.equal(f.calls.length, before);
  f.view.resume(); f.view.resume(); assert.equal(f.signInSubscriptions(), 1);
  f.view.stop(); assert.equal(f.signInSubscriptions(), 0);
});
