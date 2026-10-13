import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  ASSET_CONVERSATION_BYTES, AssetConversationController, StudioApi, StudioRequestError, StudioWorkbench,
  readAssetConversationPage, readAssetConversationStart,
  type AssetConversation, type AssetConversationPage, type AssetConversationStart, type StudioWorkbenchOptions,
} from '../../apps/desktop/src/studio.js';
import type { AssetJobRecord } from '../../apps/daemon/src/asset-service.js';
import type { AssetManifest } from '../../packages/asset-pipeline/src/types.js';

const TOKEN = 'a'.repeat(64), PATH = 'C:\\projects\\arcane', PROJECT = 'b'.repeat(64);
const NATIVE: AssetConversation = { provider: 'codex', threadId: 'thread-one', sessionId: 'session-one' };
const ID = '12345678-1234-1234-1234-123456789abc';
function job(id = ID): AssetJobRecord {
  return { schemaVersion: 1, jobId: id, directory: PATH + '\\assets\\' + id, manifestPath: null,
    request: { schemaVersion: 1, template: 'hero-prop', name: 'crate', seed: 1, sizeMeters: [1, 0.65, 0.7], color: [0.12, 0.32, 0.27], triangleBudget: 5000, renderResolution: 384, renderSamples: 16 },
    state: 'running', stage: 'starting', startedAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:00.000Z', events: [], manifestAvailable: false, error: null };
}
function page(jobs: AssetJobRecord[] = [], conversation = NATIVE, nextCursor: string | null = null): AssetConversationPage {
  return { projectId: PROJECT, projectPath: PATH, conversation: { ...conversation }, jobs, nextCursor, byteLimit: ASSET_CONVERSATION_BYTES };
}
function receipt(association: 'bound' | 'unknown' = 'bound', item = job()): AssetConversationStart {
  return { projectId: PROJECT, projectPath: PATH, conversation: { ...NATIVE }, jobId: item.jobId, association, retry: false, job: item };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function context(options: Partial<StudioWorkbenchOptions> = {}) {
  let path: string | null = PATH, native: (AssetConversation & { projectPath: string }) | null = { ...NATIVE, projectPath: PATH };
  const listeners = new Set<() => void>();
  return {
    options: { getProjectPath: () => path, getNativeConversation: () => native, subscribeContextChange: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, ...options } satisfies StudioWorkbenchOptions,
    change(next: (AssetConversation & { projectPath?: string }) | null, nextPath: string | null = path) {
      path = nextPath; native = next ? { ...next, projectPath: next.projectPath ?? nextPath ?? '' } : null;
      for (const listener of listeners) listener();
    },
  };
}

test('conversation pages and start receipts decode only the exact bounded contract', () => {
  assert.deepEqual(readAssetConversationPage(page([job()])), page([job()]));
  assert.deepEqual(readAssetConversationStart(receipt('unknown')), receipt('unknown'));
  for (const bad of [
    { ...page(), extra: true }, { ...page(), projectId: '' }, { ...page(), projectPath: PATH + '\0' },
    { ...page(), conversation: { ...NATIVE, projectPath: PATH } }, { ...page(), conversation: { ...NATIVE, provider: 'inferred' } },
    { ...page(), byteLimit: 1048576 }, { ...page(), nextCursor: '' }, { ...page(), jobs: [job(), job()] },
    { ...page(), jobs: [{ ...job(), manifestAvailable: 'true' }] }, { ...page(), jobs: [{ ...job(), request: { ...job().request, threadId: 'client' } }] },
  ]) assert.throws(() => readAssetConversationPage(bad));
  assert.throws(() => readAssetConversationPage(page([job()]), 0));
  assert.throws(() => readAssetConversationPage(page([job(), job('other')]), 1));
  for (const bad of [
    { ...receipt(), association: 'unscoped' }, { ...receipt(), retry: true }, { ...receipt(), conversation: null },
    { ...receipt(), jobId: 'different' }, { ...receipt(), job: { ...job(), jobId: ID + '\n' } },
    { ...receipt(), unexpected: true },
  ]) assert.throws(() => readAssetConversationStart(bad));
  assert.throws(() => readAssetConversationPage({ ...page(), projectPath: 'x'.repeat(ASSET_CONVERSATION_BYTES) }));
});

test('trusted project, provider, thread and session epochs reject stale reads including A → B → A', () => {
  const c = context(), controller = new AssetConversationController(c.options), original = controller.capture();
  assert.equal(controller.matches(original, page()), true);
  assert.equal(controller.matches(original, { ...page(), projectId: 'c'.repeat(64) }), false);
  assert.equal(controller.matches(original, { ...page(), projectPath: PATH.toLowerCase() }), false);
  for (const next of [{ ...NATIVE, provider: 'claude-code' as const }, { ...NATIVE, threadId: 'thread-two' }, { ...NATIVE, sessionId: null }]) {
    const ticket = controller.capture(); c.change(next); assert.equal(controller.current(ticket), false);
    assert.equal(controller.matches(controller.capture(), page()), false); c.change(NATIVE); controller.sync();
  }
  assert.equal(controller.current(original), false);
  const ticket = controller.capture(); c.change({ ...NATIVE, projectPath: PATH + '-other' });
  assert.equal(controller.current(ticket), false); assert.equal(controller.ready(), false);
  c.change({ ...NATIVE, projectPath: PATH }, PATH + '-other'); assert.equal(controller.ready(), false);
  c.change(null); assert.equal(controller.ready(), false);
});

test('default requires exact trusted chat; explicit standalone and global inspection never infer a chat', () => {
  const c = context(), controller = new AssetConversationController(c.options);
  assert.equal(new AssetConversationController().ready(), false);
  assert.equal(controller.canStart(), true);
  const ticket = controller.capture(); controller.setGlobal(true);
  assert.equal(controller.current(ticket), false); assert.equal(controller.ready(), true); assert.equal(controller.canStart(), false);
  assert.equal(controller.matches(controller.capture(), page()), false);
  assert.equal(new AssetConversationController({ assetMode: 'standalone' }).canStart(), true);
  const enabled = new AssetConversationController({ ...c.options, allowUnscopedAssetStart: true }); enabled.setGlobal(true); assert.equal(enabled.canStart(), true);
});

test('unknown pre-start IDs and details survive chat switches only as ambiguous global inspection', () => {
  const c = context(), controller = new AssetConversationController(c.options), before = controller.capture();
  c.change({ ...NATIVE, threadId: 'thread-two' }); controller.sync();
  controller.retainUnknown(before, receipt('unknown'), 'Binding persistence was not confirmed.');
  assert.deepEqual(controller.unknownDetails(), []);
  controller.setGlobal(true);
  assert.equal(controller.unknownDetails()[0]?.jobId, ID); assert.deepEqual(controller.unknownDetails()[0]?.job, job());
  assert.equal(controller.canStart(), false);
  controller.retainUnknown(before, receipt('unknown'), 'Duplicate response.'); assert.equal(controller.unknownDetails().length, 1);
  c.change(NATIVE, PATH + '-other'); assert.deepEqual(controller.unknownDetails(), []);
  c.change(NATIVE, PATH); assert.equal(controller.unknownDetails()[0]?.jobId, ID);
  controller.retainUnknown(before, { jobId: 'safe-id', job: 'invalid' }, 'Invalid receipt.'); assert.equal(controller.unknownDetails()[1]?.jobId, 'safe-id');
  controller.retainUnknown(before, { ...receipt('unknown', job('foreign')), projectPath: PATH + '-other' }, 'Foreign project.');
  assert.equal(controller.unknownDetails().at(-1)?.job, null);
});

test('new API routes use human bearer, opaque pagination and fixed template bodies without conversation metadata', async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const api = new StudioApi(TOKEN, async function (this: unknown, path, init) {
    assert.equal(this, undefined); calls.push({ path: String(path), init });
    return Response.json(init?.method === 'POST' ? receipt() : page());
  });
  await api.assetConversationJobs(64, 'opaque:page+one/part?x'); await api.assetConversationStart({ template: 'hero-prop', name: 'crate' });
  assert.equal(calls[0]?.path, '/v1/assets/conversation-jobs?limit=64&after=opaque%3Apage%2Bone%2Fpart%3Fx');
  assert.equal(calls[1]?.path, '/v1/assets/conversation-start');
  assert.deepEqual(JSON.parse(calls[1]!.init!.body as string), { template: 'hero-prop', name: 'crate' });
  for (const call of calls) { assert.equal(new Headers(call.init?.headers).get('Authorization'), 'Bearer ' + TOKEN); assert.equal(call.init?.redirect, 'error'); assert.equal(call.init?.credentials, 'omit'); }
  assert.equal(calls[0]?.init?.method, 'GET'); assert.equal(calls[1]?.init?.method, 'POST');
  for (const limit of [0, 65, 1.5]) await assert.rejects(api.assetConversationJobs(limit));
  await assert.rejects(api.assetConversationJobs(1, ''));
  const prior = calls.length;
  for (const [path, input] of [
    ['/v1/assets/conversation-start?threadId=forged', {}], ['/v1/assets/conversation-jobs?provider=codex', undefined],
    ['/v1/assets/conversation-jobs?limit=32&limit=1', undefined], ['/v1/assets/conversation-jobs?limit=65', undefined],
    ['/v1/assets/conversation-jobs?after=%00', undefined], ['/v1/assets/conversation-jobs?limit=01', undefined],
    ['/v1/assets/conversation-jobs', {}], ['/v1/assets/conversation-start', undefined],
    ['/v1/assets/conversation-start', { template: 'hero-prop', name: 'crate', conversation: NATIVE }],
    ['/v1/assets/conversation-jobs/other', undefined], ['/v1/assets/conversation-bind', {}],
  ] as const) await assert.rejects(api.request(path, input));
  assert.equal(calls.length, prior);
});

test('legacy standalone API calls retain their exact unscoped paths and request shapes', async () => {
  const paths: string[] = [], api = new StudioApi(TOKEN, async (path, init) => { paths.push(String(path)); return Response.json(init?.method === 'POST' ? { job: job() } : { jobs: [] }); });
  await api.assetJobs(); await api.assetStart({ template: 'hero-prop', name: 'crate' });
  assert.deepEqual(paths, ['/v1/assets/jobs', '/v1/assets/start']);
});

test('conversation transport bounds bytes and UTF-8 and never retries uncertain writes', async () => {
  for (const response of [new Response('x'.repeat(ASSET_CONVERSATION_BYTES + 1)), new Response(new Uint8Array([0xff])), new Response('not JSON')]) {
    let calls = 0; const api = new StudioApi(TOKEN, async () => { calls++; return response; });
    await assert.rejects(api.assetConversationStart({ template: 'hero-prop', name: 'crate' }), (error: unknown) => error instanceof StudioRequestError && error.outcome === 'unknown'); assert.equal(calls, 1);
  }
  let calls = 0; const lost = new StudioApi(TOKEN, async () => { calls++; throw new Error('fixture lost response'); });
  await assert.rejects(lost.assetConversationStart({ template: 'hero-prop', name: 'crate' }), (error: unknown) => error instanceof StudioRequestError && error.outcome === 'unknown'); assert.equal(calls, 1);
  const invalid = new StudioApi(TOKEN, async () => Response.json({ ...receipt(), retry: true }));
  await assert.rejects(invalid.assetConversationStart({ template: 'hero-prop', name: 'crate' }), (error: unknown) => error instanceof StudioRequestError && error.outcome === 'unknown' && (error.details?.payload as AssetConversationStart).jobId === ID);
  const denied = new StudioApi(TOKEN, async () => Response.json({ error: 'AUTH', message: 'Human control required.' }, { status: 403 }));
  await assert.rejects(denied.assetConversationStart({ template: 'hero-prop', name: 'crate' }), (error: unknown) => error instanceof StudioRequestError && error.outcome === 'rejected');
  await assert.rejects(new StudioApi(TOKEN, async () => new Response('x'.repeat(ASSET_CONVERSATION_BYTES + 1))).assetConversationJobs(), /512 KiB/);
});

// Tiny DOM surface for deterministic controller tests. No browser, daemon, CLI or Studio runs.
class ElementFixture extends EventTarget {
  textContent = ''; value = ''; hidden = false; disabled = false; className = ''; type = ''; checked = false;
  children: ElementFixture[] = []; attributes = new Map<string, string>();
  replaceChildren(...children: ElementFixture[]) { this.children = children; }
  append(...children: ElementFixture[]) { this.children.push(...children); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  querySelectorAll() { return this.children.filter(child => child.type === 'button'); }
}
class DocumentFixture {
  elements = new Map<string, ElementFixture>();
  getElementById(id: string) { let item = this.elements.get(id); if (!item) { item = new ElementFixture(); this.elements.set(id, item); } return item; }
  createElement(_tag: string) { return new ElementFixture(); }
}
interface WorkbenchFixture {
  assetJobs: AssetJobRecord[]; assetJobId: string; assetAvailable: boolean; assetProbed: boolean; assetBusy: boolean;
  assetUnknown: string; assetNextCursor: string | null; assetContext: AssetConversationController;
  refreshAssets(more?: boolean): Promise<void>; startAsset(): Promise<void>; cancelAsset(): Promise<void>; probeAsset(): Promise<void>;
  loadAssetManifest(): Promise<void>; renderAssetControls(): void; renderAssetJob(): void; subscribeAssetContext(): void;
}
function workbench(api: StudioApi, options: StudioWorkbenchOptions) {
  const doc = new DocumentFixture();
  for (const [id, value] of Object.entries({ 'asset-template': 'hero-prop', 'asset-name': 'crate', 'asset-size': '1, 0.65, 0.7', 'asset-color': '0.12, 0.32, 0.27', 'asset-seed': '1', 'asset-budget': '5000', 'asset-resolution': '384', 'asset-samples': '16' })) doc.getElementById(id).value = value;
  const view = new StudioWorkbench(doc as unknown as Document, api, 'http://127.0.0.1:45871', TOKEN, options) as unknown as WorkbenchFixture;
  view.subscribeAssetContext(); return { doc, view };
}

test('chat changes synchronously clear selected job, history, previews, manifest and downloads', async () => {
  const c = context(), { doc, view } = workbench(new StudioApi(TOKEN, async () => Response.json(page([job()]))), c.options);
  await view.refreshAssets(); view.assetJobId = ID; view.renderAssetJob();
  doc.getElementById('asset-previews').append(new ElementFixture()); doc.getElementById('artifact-files').append(new ElementFixture()); doc.getElementById('asset-manifest').textContent = 'old manifest';
  view.assetProbed = true; view.assetBusy = true; c.change(null);
  assert.equal(view.assetJobId, ''); assert.deepEqual(view.assetJobs, []); assert.equal(view.assetProbed, false); assert.equal(view.assetBusy, false);
  assert.equal(doc.getElementById('asset-previews').children.length, 0); assert.equal(doc.getElementById('artifact-files').children.length, 0);
  assert.equal(doc.getElementById('artifact-files').hidden, true); assert.equal(doc.getElementById('asset-job-picker').children.length, 1);
  assert.doesNotMatch(doc.getElementById('asset-manifest').textContent, /old manifest/);
  assert.equal(doc.getElementById('asset-start').disabled, true);
});

test('late and out-of-order history reads cannot populate the new chat or replace newer history', async () => {
  const c = context(), pending = deferred<Response>(); let calls = 0;
  const { view } = workbench(new StudioApi(TOKEN, async () => { calls++; return calls === 1 ? pending.promise : Response.json(page([job('newer')])); }), c.options);
  const old = view.refreshAssets(); await view.refreshAssets(); pending.resolve(Response.json(page([job('older')]))); await old;
  assert.deepEqual(view.assetJobs.map(item => item.jobId), ['newer']);
  const held = deferred<Response>(), next = workbench(new StudioApi(TOKEN, async () => held.promise), c.options);
  const reading = next.view.refreshAssets(); c.change(null); held.resolve(Response.json(page([job()]))); await reading;
  assert.deepEqual(next.view.assetJobs, []); assert.equal(next.view.assetAvailable, false);
});

test('foreign host project/chat and inconsistent project ID are refused without global fallback', async () => {
  for (const foreign of [{ ...page([job()]), projectPath: PATH.toLowerCase() }, page([job()], { ...NATIVE, sessionId: 'other-session' })]) {
    const c = context(), calls: string[] = [], { view } = workbench(new StudioApi(TOKEN, async path => { calls.push(String(path)); return Response.json(foreign); }), c.options);
    await view.refreshAssets(); assert.deepEqual(view.assetJobs, []); assert.equal(view.assetAvailable, false); assert.deepEqual(calls, ['/v1/assets/conversation-jobs?limit=32']);
  }
  const c = context(); let count = 0;
  const { view } = workbench(new StudioApi(TOKEN, async () => Response.json(count++ === 0 ? page([job()]) : { ...page([job()]), projectId: 'c'.repeat(64) })), c.options);
  await view.refreshAssets(); view.assetJobId = ID; await view.refreshAssets(); assert.equal(view.assetJobId, ''); assert.deepEqual(view.assetJobs, []);
});

test('history advances only on an explicit bounded page read and resets its opaque cursor on chat change', async () => {
  const c = context(), calls: string[] = [];
  const { doc, view } = workbench(new StudioApi(TOKEN, async path => { calls.push(String(path)); return Response.json(calls.length === 1 ? page([job()], NATIVE, 'opaque:next') : page([job('second')])); }), c.options);
  await view.refreshAssets(); assert.equal(calls.length, 1); assert.equal(doc.getElementById('asset-history-more').hidden, false);
  await view.refreshAssets(true); assert.deepEqual(view.assetJobs.map(item => item.jobId), [ID, 'second']); assert.equal(calls[1], '/v1/assets/conversation-jobs?limit=32&after=opaque%3Anext');
  c.change(null); assert.equal(view.assetNextCursor, null); assert.equal(doc.getElementById('asset-history-more').hidden, true);
});

test('late bound start cannot select a job in a changed chat, including return to the original chat', async () => {
  for (const returnToOriginal of [false, true]) {
    const c = context(), pending = deferred<Response>(), calls: string[] = [];
    const { view } = workbench(new StudioApi(TOKEN, async (path, init) => { calls.push(String(path)); return init?.method === 'POST' ? pending.promise : Response.json(page()); }), c.options);
    view.assetAvailable = true; view.assetProbed = true; const starting = view.startAsset(); c.change(null);
    if (returnToOriginal) { c.change(NATIVE); await setImmediate(); }
    pending.resolve(Response.json(receipt())); await starting;
    assert.equal(view.assetJobId, ''); assert.deepEqual(view.assetJobs, []); assert.equal(view.assetBusy, false);
    assert.equal(calls.filter(path => path === '/v1/assets/conversation-start').length, 1); assert.equal(calls.includes('/v1/assets/start'), false);
  }
});

test('unknown start after a chat switch preserves known ID/details in explicit global history, without retry or attribution', async () => {
  const c = context(), pending = deferred<Response>(), paths: string[] = [];
  const { doc, view } = workbench(new StudioApi(TOKEN, async (path, init) => {
    paths.push(String(path)); if (init?.method === 'POST') return pending.promise;
    return Response.json(String(path).startsWith('/v1/assets/jobs?') ? { schemaVersion: 1, jobs: [], total: 0, nextCursor: null, byteLimit: ASSET_CONVERSATION_BYTES } : page());
  }), c.options);
  view.assetAvailable = true; view.assetProbed = true; const starting = view.startAsset(); c.change({ ...NATIVE, threadId: 'thread-two' }); await setImmediate();
  pending.resolve(Response.json(receipt('unknown'))); await starting;
  assert.equal(view.assetJobId, ''); assert.equal(view.assetJobs.length, 0); assert.deepEqual(view.assetContext.unknownDetails(), []);
  assert.equal(paths.some(path => path.startsWith('/v1/assets/jobs')), false);
  view.assetContext.setGlobal(true); await view.refreshAssets(); view.renderAssetControls();
  assert.equal(view.assetJobId, ''); assert.equal(view.assetJobs[0]?.jobId, ID); assert.equal(doc.getElementById('asset-ambiguous').hidden, false);
  assert.match(doc.getElementById('asset-ambiguous-records').textContent, /association.*unknown/); assert.match(doc.getElementById('asset-ambiguous-records').textContent, /12345678/);
  assert.equal(doc.getElementById('asset-start').disabled, true); assert.equal(doc.getElementById('asset-start').textContent, 'Start unscoped template job');
  assert.equal(paths.filter(path => path === '/v1/assets/conversation-start').length, 1);
});

test('same-chat ambiguous and malformed successful starts retain IDs without selecting or repeating a job', async () => {
  for (const data of [receipt('unknown'), { ...receipt(), retry: true }, { ...receipt(), projectId: 'c'.repeat(64) }]) {
    const c = context(); let posts = 0;
    const { view } = workbench(new StudioApi(TOKEN, async (_path, init) => { if (init?.method === 'POST') { posts++; return Response.json(data); } return Response.json(page()); }), c.options);
    await view.refreshAssets(); view.assetProbed = true; await view.startAsset(); await view.startAsset();
    assert.equal(view.assetJobId, ''); assert.equal(posts, 1); assert.equal(view.assetContext.unknownDetails()[0]?.jobId, ID); assert.match(view.assetUnknown, /unknown/);
  }
});

test('late manifest, probe and cancellation success/failure never restore cleared state', async () => {
  for (const action of ['loadAssetManifest', 'probeAsset', 'cancelAsset'] as const) for (const fail of [false, true]) {
    const c = context(), pending = deferred<Response>(), { doc, view } = workbench(new StudioApi(TOKEN, async () => pending.promise), c.options);
    view.assetJobs = [{ ...job(), ...(action === 'loadAssetManifest' ? { state: 'succeeded' as const, manifestAvailable: true } : {}) }]; view.assetJobId = ID; view.assetAvailable = true;
    const running = view[action](); c.change(null);
    const cleared = doc.getElementById('asset-notice').textContent;
    if (fail) pending.reject(new Error('late failure'));
    else pending.resolve(Response.json(action === 'loadAssetManifest' ? { manifest: { jobId: ID, request: job().request, artifacts: [] } } : action === 'probeAsset' ? { probe: { available: true, blender: { capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } } } } : { job: { ...job(), state: 'cancelled' } }));
    await running;
    assert.equal(view.assetJobId, ''); assert.deepEqual(view.assetJobs, []); assert.equal(view.assetBusy, false); assert.equal(view.assetProbed, false);
    assert.equal(doc.getElementById('asset-notice').textContent, cleared); assert.equal(doc.getElementById('artifact-files').children.length, 0); assert.equal(doc.getElementById('asset-previews').children.length, 0);
  }
});

test('authenticated download UI appears only for the selected completed manifest and clears synchronously', async () => {
  const c = context(), item = { ...job(), state: 'succeeded' as const, manifestAvailable: true };
  const manifest = { jobId: ID, request: item.request, artifacts: [{ role: 'export', path: 'asset.glb', bytes: 8, sha256: 'd'.repeat(64) }] } as unknown as AssetManifest;
  const { doc, view } = workbench(new StudioApi(TOKEN, async () => Response.json({ manifest })), c.options);
  view.assetJobs = [item]; view.assetJobId = ID; view.assetAvailable = true; await view.loadAssetManifest();
  assert.equal(doc.getElementById('artifact-files').hidden, false); assert.equal(doc.getElementById('artifact-files').children.length, 3);
  assert.equal(doc.getElementById('preview-files-tab').attributes.get('data-workspace-target'), 'artifact-files');
  c.change(null); assert.equal(doc.getElementById('artifact-files').hidden, true); assert.equal(doc.getElementById('artifact-files').children.length, 0);
  assert.equal(doc.getElementById('preview-files-tab').attributes.get('data-workspace-target'), 'asset-heading');
});

test('late preview bytes cannot decode or restore previews/downloads after a chat change', async () => {
  const c = context(), pending = deferred<Response>(), bytes = new Uint8Array([1, 2, 3, 4]);
  const item = { ...job(), state: 'succeeded' as const, manifestAvailable: true };
  const manifest = { jobId: ID, request: item.request, artifacts: [
    { role: 'preview', path: 'preview-hero.png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    { role: 'export', path: 'asset.glb', bytes: 8, sha256: 'd'.repeat(64) },
  ] };
  let decodes = 0;
  const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { decodes++; throw new Error('No native bitmap decoding in this fixture.'); } });
  try {
    const { doc, view } = workbench(new StudioApi(TOKEN, async path => String(path).includes('/manifest?') ? Response.json({ manifest }) : pending.promise), c.options);
    view.assetJobs = [item]; view.assetJobId = ID; view.assetAvailable = true;
    const loading = view.loadAssetManifest(); await setImmediate(); assert.equal(doc.getElementById('artifact-files').hidden, false);
    c.change(null); const cleared = doc.getElementById('asset-notice').textContent;
    pending.resolve(new Response(bytes, { headers: { 'Content-Type': 'image/png' } })); await loading;
    assert.equal(decodes, 0); assert.equal(doc.getElementById('asset-previews').children.length, 0);
    assert.equal(doc.getElementById('artifact-files').children.length, 0); assert.equal(doc.getElementById('asset-notice').textContent, cleared);
  } finally {
    if (bitmapDescriptor) Object.defineProperty(globalThis, 'createImageBitmap', bitmapDescriptor);
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  }
});

test('production boot uses existing chat callbacks; static UI names global scope and adds no decorative badges', async () => {
  const source = await readFile('apps/desktop/src/studio.ts', 'utf8'), html = await readFile('apps/desktop/public/studio.html', 'utf8');
  assert.match(source, /assetMode: 'conversation', getNativeConversation: \(\) => codexChat.workflowConversation\(\)/);
  assert.match(source, /subscribeContextChange: listener => codexChat.subscribeWorkflowContextChange\(listener\)/);
  assert.match(source, /getProjectPath: options.getProjectPath \?\? \(\(\) => this.historyProjectPath\(\) \|\| null\)/);
  assert.match(html, /id="asset-history-scope"/); assert.match(html, /Global asset history · all chats and unscoped jobs/);
  assert.match(html, /id="asset-ambiguous-records"/); assert.match(html, /Start template job in this chat/);
  const assetSection = html.slice(html.indexOf('id="asset-heading"'), html.indexOf('id="work-heading"', html.indexOf('id="asset-heading"')));
  assert.doesNotMatch(assetSection, /class="badge/);
});
