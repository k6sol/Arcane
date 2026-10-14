/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssetViewerPanel } from '../../apps/desktop/src/asset-viewer.js';
import { ARTIFACT_LIMIT } from '../../apps/desktop/src/asset-downloads.js';
import { validateGlb } from '../../apps/desktop/src/glb-preflight.js';

// Owned, data-only GLBs and recording renderers. No product build, daemon,
// provider, Studio, native bridge, credential file or user asset is involved.
const JOB = '11111111-1111-4111-8111-111111111111';
const NEXT_JOB = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64); // Synthetic fixture token, never read from disk.
type Options = NonNullable<ConstructorParameters<typeof AssetViewerPanel>[2]>;
type Module = Awaited<ReturnType<NonNullable<Options['loadRuntime']>>>;
type Renderer = Awaited<ReturnType<Module['createAssetViewer']>>;
type RenderInput = Parameters<Module['createAssetViewer']>[0];

function glb(change: (doc: Record<string, any>) => void = () => {}): Uint8Array<ArrayBuffer> {
  const binary = new Uint8Array(new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0]).buffer);
  const doc: Record<string, any> = {
    asset: { version: '2.0', generator: 'Arcane owned integration fixture' },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  change(doc);
  const json = new TextEncoder().encode(JSON.stringify(doc)), jsonLength = Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(28 + jsonLength + binary.length), header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.length, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength); bytes.set(json, 20);
  header.setUint32(20 + jsonLength, binary.length, true); header.setUint32(24 + jsonLength, 0x004e4942, true);
  bytes.set(binary, 28 + jsonLength); return bytes;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function manifest(bytes = glb(), jobId = JOB, artifacts?: unknown[]) {
  return { jobId, request: { name: 'fixture-asset' }, artifacts: artifacts ?? [
    { path: 'asset.glb', role: 'export', bytes: bytes.length, sha256: digest(bytes) },
  ] };
}
const headers = (bytes: Uint8Array): Record<string, string> => ({
  'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length),
  'Content-Disposition': 'attachment; filename="fixture-asset-asset.glb"',
});
function response(bytes = glb(), fields: Record<string, string> = headers(bytes)) {
  return new Response(new Uint8Array(bytes).buffer, { headers: fields });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(done => setTimeout(done, 2)); }
  assert.fail('Bounded fixture did not settle');
}

class ElementFixture extends EventTarget {
  readonly nodeType = 1;
  children: ElementFixture[] = [];
  parentElement: ElementFixture | null = null;
  id = ''; className = ''; type = ''; value = ''; hidden = false; disabled = false; checked = false;
  min = ''; max = ''; step = ''; title = ''; tabIndex = 0; selected = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private text = '';
  private readonly attributes = new Map<string, string>();
  constructor(readonly ownerDocument: DocumentFixture, readonly tagName: string) { super(); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(' '); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  set innerHTML(_value: string) { assert.fail('Viewer must use text/DOM nodes, never an HTML sink'); }
  get childElementCount() { return this.children.length; }
  get isConnected(): boolean { return this === this.ownerDocument.host || !!this.parentElement?.isConnected; }
  append(...nodes: ElementFixture[]): void {
    for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); }
  }
  appendChild(node: ElementFixture): ElementFixture { this.append(node); return node; }
  insertBefore(node: ElementFixture, before: ElementFixture): ElementFixture {
    node.remove(); node.parentElement = this; this.children.splice(this.children.indexOf(before), 0, node); return node;
  }
  replaceChildren(...nodes: ElementFixture[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children = []; this.text = ''; this.append(...nodes);
  }
  remove(): void {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  all(): ElementFixture[] { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelectorAll(selector: string): ElementFixture[] {
    return this.all().filter(child => selector.split(',').some(part => {
      const s = part.trim();
      if (s.startsWith('#')) return child.id === s.slice(1);
      if (s.startsWith('.')) return child.className.split(' ').includes(s.slice(1));
      return child.tagName.toLowerCase() === s;
    }));
  }
  querySelector(selector: string): ElementFixture | null { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): ElementFixture | null {
    assert.equal(selector, '[hidden]'); return this.hidden ? this : this.parentElement?.closest(selector) ?? null;
  }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
class DocumentFixture {
  readonly host = this.createElement('section');
  readonly defaultView = { setTimeout, clearTimeout };
  constructor(readonly mounted = true) { this.host.id = 'asset-viewer'; }
  createElement(tag: string): ElementFixture { return new ElementFixture(this, tag.toUpperCase()); }
  createTextNode(text: string): ElementFixture { const node = this.createElement('#text'); node.textContent = text; return node; }
  getElementById(id: string): ElementFixture | null {
    return this.mounted ? [this.host, ...this.host.all()].find(element => element.id === id) ?? null : null;
  }
}
function recordingRenderer(doc: DocumentFixture, host: HTMLElement) {
  const calls: { method: string; args: unknown[] }[] = [];
  const canvas = doc.createElement('canvas'); (host as unknown as ElementFixture).append(canvas);
  const call = (method: string, ...args: unknown[]) => { calls.push({ method, args }); };
  let disposed = 0;
  const state = { index: 0, time: 0, duration: 2, playing: false, speed: 1, loop: true };
  const renderer = {
    reset: () => call('reset'), setView: (value: string) => call('setView', value),
    setMode: (value: string) => call('setMode', value), setLighting: (value: string) => call('setLighting', value),
    animations: () => [{ index: 0, name: 'Fixture motion', duration: 2 }, { index: 1, name: 'Second clip', duration: 3 }],
    animationState: () => ({ ...state }),
    selectAnimation: (value: number) => { state.index = value; call('selectAnimation', value); },
    seekAnimation: (value: number) => { state.time = value; call('seekAnimation', value); },
    setAnimationSpeed: (value: number) => { state.speed = value; call('setAnimationSpeed', value); },
    setAnimationLoop: (value: boolean) => { state.loop = value; call('setAnimationLoop', value); },
    setAnimationPlaying: (value: boolean) => { state.playing = value; call('setAnimationPlaying', value); },
    hasAnimations: true,
    stats: () => ({ triangles: 1, materials: 1, drawCalls: 1, dimensions: { x: 2, y: 1, z: 0 } }),
    dispose: () => { disposed++; canvas.remove(); },
  } as unknown as Renderer;
  return { renderer, calls, canvas, disposed: () => disposed, finishAnimation: () => { state.playing = false; state.time = state.duration; } };
}
function fixture(options: Options = {}, mounted = true) {
  const doc = new DocumentFixture(mounted), downloads: { path: string; init: RequestInit | undefined }[] = [];
  const inputs: RenderInput[] = [], renderers: ReturnType<typeof recordingRenderer>[] = [];
  let loads = 0;
  const loadRuntime: NonNullable<Options['loadRuntime']> = async () => {
    loads++;
    return { createAssetViewer: async input => {
      inputs.push(input);
      const renderer = recordingRenderer(doc, input.host); renderers.push(renderer); return renderer.renderer;
    } };
  };
  const transport: typeof fetch = async (input, init) => { downloads.push({ path: String(input), init }); return response(); };
  const panel = new AssetViewerPanel(doc as unknown as Document, TOKEN, { transport, loadRuntime, deadlineMs: 500, ...options });
  return { doc, panel, downloads, inputs, renderers, loads: () => loads, loadRuntime };
}
const noRenderer = (f: ReturnType<typeof fixture>) => {
  assert.equal(f.loads(), 0); assert.equal(f.inputs.length, 0); assert.equal(f.doc.host.querySelectorAll('canvas').length, 0);
};

test('constructing/clearing the panel and an absent optional mount are inert', async () => {
  const f = fixture(); f.panel.clear(); f.panel.clear(); noRenderer(f); assert.equal(f.downloads.length, 0);
  const absent = fixture({}, false); await absent.panel.show(manifest(), JOB, () => true);
  absent.panel.clear(); noRenderer(absent); assert.equal(absent.downloads.length, 0);
});

test('wrong job, role, path, hash and unbounded descriptors never fetch or load the runtime', async t => {
  const bytes = glb(), row = manifest(bytes).artifacts[0] as Record<string, unknown>;
  const cases: [string, unknown][] = [
    ['wrong job', manifest(bytes, NEXT_JOB)], ['wrong role', manifest(bytes, JOB, [{ ...row, role: 'preview' }])],
    ['traversal', manifest(bytes, JOB, [{ ...row, path: '../asset.glb' }])],
    ['absolute path', manifest(bytes, JOB, [{ ...row, path: 'https://fixture.invalid/asset.glb' }])],
    ['malformed hash', manifest(bytes, JOB, [{ ...row, sha256: 'x'.repeat(64) }])],
    ['zero bytes', manifest(bytes, JOB, [{ ...row, bytes: 0 }])],
    ['oversized bytes', manifest(bytes, JOB, [{ ...row, bytes: ARTIFACT_LIMIT + 1 }])],
    ['duplicate asset', manifest(bytes, JOB, [row, row])], ['missing manifest', null],
  ];
  for (const [name, value] of cases) await t.test(name, async () => {
    const f = fixture(); t.after(() => f.panel.clear());
    await f.panel.show(value, JOB, () => true); noRenderer(f); assert.equal(f.downloads.length, 0);
  });
});

test('only asset.glb is selected from the exact manifest, never collision, LOD, FBX, scene or previews', async t => {
  const bytes = glb(), row = manifest(bytes).artifacts[0] as Record<string, unknown>, f = fixture();
  t.after(() => f.panel.clear());
  const others = ['collision.glb', 'asset-lod1.glb', 'asset.fbx', 'asset.blend', 'preview-hero.png'].map(path => ({
    ...row, path, role: path.endsWith('.png') ? 'preview' : path.endsWith('.blend') ? 'scene' : 'export',
  }));
  await f.panel.show(manifest(bytes, JOB, others), JOB, () => true); noRenderer(f); assert.equal(f.downloads.length, 0);
  await f.panel.show(manifest(bytes, JOB, [...others, row]), JOB, () => true);
  assert.equal(f.downloads.length, 1); assert.equal(f.downloads[0]!.path, '/v1/assets/artifact?jobId=' + JOB + '&path=asset.glb');
  assert.equal(f.inputs.length, 1); f.panel.clear();
});

test('stream completion, exact checksum and preflight precede runtime import and GPU allocation', async t => {
  const bytes = glb(); assert.equal(validateGlb(bytes).triangleEstimate, 1);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  const calls: { path: string; init?: RequestInit }[] = [];
  const f = fixture({ transport: async (input, init) => {
    calls.push({ path: String(input), ...(init ? { init } : {}) }); return new Response(body, { headers: headers(bytes) });
  } }); t.after(() => f.panel.clear());
  const pending = f.panel.show(manifest(bytes), JOB, () => true);
  await until(() => calls.length === 1); stream.enqueue(bytes.subarray(0, bytes.length - 4)); noRenderer(f);
  stream.enqueue(bytes.subarray(bytes.length - 4)); noRenderer(f); stream.close(); await pending;
  assert.equal(f.loads(), 1); assert.equal(f.inputs.length, 1);
  const init = calls[0]!.init!;
  assert.equal(calls[0]!.path, '/v1/assets/artifact?jobId=' + JOB + '&path=asset.glb');
  assert.equal(init.method, 'GET'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
  assert.deepEqual(init.headers, { Authorization: 'Bearer ' + TOKEN }); assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(new Uint8Array(f.inputs[0]!.bytes), bytes); assert.ok(f.inputs[0]!.signal instanceof AbortSignal);
  assert.equal(f.doc.host.querySelectorAll('canvas').length, 1);
});

test('a byte change with valid GLB structure fails checksum before runtime import', async () => {
  const original = glb(), tampered = original.slice();
  tampered[Buffer.from(original).indexOf('Arcane')] = 'B'.charCodeAt(0);
  assert.deepEqual(validateGlb(tampered), validateGlb(original));
  const f = fixture({ transport: async () => response(tampered, headers(original)) });
  await f.panel.show(manifest(original), JOB, () => true); noRenderer(f); f.panel.clear();
  assert.notEqual(digest(tampered), digest(original));
});

test('missing/mismatched bounded headers and short/oversized/refused deliveries never invoke runtime', async t => {
  const bytes = glb();
  const cases: [string, () => Response][] = [];
  for (const field of ['Content-Type', 'Content-Length', 'Content-Disposition']) {
    const fields = headers(bytes); delete fields[field]; cases.push(['missing ' + field, () => response(bytes, fields)]);
  }
  for (const [field, value] of [['Content-Type', 'text/html'], ['Content-Length', String(bytes.length + 1)], ['Content-Disposition', 'inline']]) {
    cases.push(['wrong ' + field, () => response(bytes, { ...headers(bytes), [field!]: value! })]);
  }
  cases.push(['short body', () => response(bytes.subarray(0, bytes.length - 1), headers(bytes))],
    ['oversized body', () => response(new Uint8Array(bytes.length + 1), headers(bytes))],
    ['refused', () => new Response('PRIVATE_RESPONSE_SENTINEL', { status: 401 })]);
  for (const [name, result] of cases) await t.test(name, async () => {
    let calls = 0; const f = fixture({ transport: async () => { calls++; return result(); } });
    await f.panel.show(manifest(bytes), JOB, () => true); noRenderer(f); assert.equal(calls, 1);
    assert.doesNotMatch(f.doc.host.textContent, /PRIVATE_RESPONSE_SENTINEL/); f.panel.clear();
  });
});

test('checksum-valid external buffer/image URIs and malformed GLB fail preflight without runtime import', async t => {
  const cases: [string, Uint8Array<ArrayBuffer>][] = [
    ['external buffer', glb(doc => { doc.buffers[0].uri = 'https://fixture.invalid/private.bin'; })],
    ['relative buffer', glb(doc => { doc.buffers[0].uri = 'outside.bin'; })],
    ['external image', glb(doc => { doc.images = [{ uri: 'https://fixture.invalid/image.png' }]; })],
    ['data image', glb(doc => { doc.images = [{ uri: 'data:image/png;base64,AAAA' }]; })],
    ['invalid accessor', glb(doc => { doc.meshes[0].primitives[0].attributes.POSITION = 99; })],
    ['truncated header', new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0])],
  ];
  for (const [name, bytes] of cases) await t.test(name, async () => {
    assert.throws(() => validateGlb(bytes), /GLB preflight/);
    const f = fixture({ transport: async () => response(bytes) });
    await f.panel.show(manifest(bytes), JOB, () => true); noRenderer(f); f.panel.clear();
  });
});

test('a delayed old-job download is aborted and cannot replace the current job renderer or status', async t => {
  const old = deferred<Response>(); let oldSignal: AbortSignal | null = null, calls = 0;
  const f = fixture({ transport: async (_input, init) => {
    calls++; if (calls === 1) { oldSignal = init!.signal!; return old.promise; } return response();
  } }); t.after(() => f.panel.clear());
  const pending = f.panel.show(manifest(), JOB, () => true); await until(() => calls === 1);
  await f.panel.show(manifest(glb(), NEXT_JOB), NEXT_JOB, () => true);
  assert.equal((oldSignal as unknown as AbortSignal).aborted, true);
  const status = f.doc.host.textContent; old.resolve(response()); await pending;
  assert.equal(f.loads(), 1); assert.equal(f.inputs.length, 1); assert.equal(f.doc.host.textContent, status);
  assert.equal(f.doc.host.querySelectorAll('canvas').length, 1); assert.equal(f.renderers[0]!.disposed(), 0);
});

test('callback false before show or after download prevents runtime import and canvas creation', async () => {
  const inactive = fixture(); await inactive.panel.show(manifest(), JOB, () => false);
  noRenderer(inactive); assert.equal(inactive.downloads.length, 0); inactive.panel.clear();
  const download = deferred<Response>(); let active = true, called = false;
  const f = fixture({ transport: async () => { called = true; return download.promise; } });
  const pending = f.panel.show(manifest(), JOB, () => active); await until(() => called);
  active = false; download.resolve(response()); await pending; noRenderer(f); f.panel.clear();
});

test('clear aborts an in-flight artifact fetch and leaves no renderer or canvas after its late response', async () => {
  const download = deferred<Response>(); let signal: AbortSignal | null = null;
  const f = fixture({ transport: async (_input, init) => { signal = init!.signal!; return download.promise; } });
  const pending = f.panel.show(manifest(), JOB, () => true); await until(() => signal !== null);
  f.panel.clear(); assert.equal((signal as unknown as AbortSignal).aborted, true);
  download.resolve(response()); await pending; noRenderer(f); assert.equal(f.doc.host.hidden, true);
});

for (const reason of ['clear', 'callback'] as const) test(`late runtime import after ${reason} cannot create a renderer`, async () => {
  const loaded = deferred<Module>(); let loading = false, creates = 0, active = true;
  const f = fixture({ loadRuntime: async () => { loading = true; return loaded.promise; } });
  const pending = f.panel.show(manifest(), JOB, () => active); await until(() => loading);
  if (reason === 'clear') f.panel.clear(); else active = false;
  loaded.resolve({ createAssetViewer: async () => { creates++; throw new Error('Late renderer must never be allocated'); } });
  await pending; assert.equal(creates, 0); assert.equal(f.doc.host.querySelectorAll('canvas').length, 0); f.panel.clear();
});

for (const reason of ['clear', 'callback', 'replacement'] as const) test(`renderer completing after ${reason} is disposed without touching the current renderer`, async t => {
  const completed = deferred<Renderer>(); let late: ReturnType<typeof recordingRenderer> | undefined, active = true, creates = 0;
  const f = fixture({ loadRuntime: async () => ({ createAssetViewer: async input => {
    creates++; if (creates === 1) { late = recordingRenderer(f.doc, input.host); return completed.promise; }
    const next = recordingRenderer(f.doc, input.host); f.renderers.push(next); return next.renderer;
  } }) }); t.after(() => f.panel.clear());
  const pending = f.panel.show(manifest(), JOB, () => active); await until(() => late !== undefined);
  if (reason === 'replacement') await f.panel.show(manifest(glb(), NEXT_JOB), NEXT_JOB, () => true);
  else if (reason === 'clear') f.panel.clear(); else active = false;
  completed.resolve(late!.renderer); await pending; await until(() => late!.disposed() === 1);
  assert.equal(f.doc.host.querySelectorAll('canvas').length, reason === 'replacement' ? 1 : 0);
  if (reason === 'replacement') assert.equal(f.renderers[0]!.disposed(), 0);
});

test('deadline aborts a pending transport, with no runtime or canvas and no retry', async () => {
  let aborted = false, calls = 0;
  const f = fixture({ deadlineMs: 15, transport: async (_input, init) => {
    calls++;
    return new Promise<Response>((_done, reject) => init!.signal!.addEventListener('abort', () => {
      aborted = true; reject(new DOMException('Fixture deadline', 'AbortError'));
    }, { once: true }));
  } });
  await f.panel.show(manifest(), JOB, () => true); assert.equal(aborted, true); assert.equal(calls, 1); noRenderer(f); f.panel.clear();
});

for (const stage of ['fetch', 'import', 'create'] as const) test(`clear promptly settles an uncooperative pending ${stage}`, async t => {
  const download = deferred<Response>(), module = deferred<Module>(), renderer = deferred<Renderer>();
  let reached = false, late: ReturnType<typeof recordingRenderer> | undefined;
  const f = fixture({
    transport: async () => { if (stage === 'fetch') { reached = true; return download.promise; } return response(); },
    loadRuntime: async () => {
      if (stage === 'import') { reached = true; return module.promise; }
      return { createAssetViewer: async input => { reached = true; late = recordingRenderer(f.doc, input.host); return renderer.promise; } };
    },
  }); t.after(() => f.panel.clear());
  let settled = false;
  const pending = f.panel.show(manifest(), JOB, () => true).then(() => { settled = true; });
  await until(() => reached); f.panel.clear(); await until(() => settled); await pending;
  assert.equal(f.doc.host.querySelectorAll('canvas').length, 0);
  // Resolve ignored operations after show has already settled; abandoned work
  // must never become a current renderer or leave an unhandled rejection.
  if (stage === 'fetch') download.resolve(response());
  else if (stage === 'import') module.resolve({ createAssetViewer: async () => { assert.fail('Late import created a renderer'); } });
  else { renderer.resolve(late!.renderer); await until(() => late!.disposed() === 1); }
});

test('deadline also settles an ignored abort instead of waiting indefinitely for transport', async () => {
  const held = deferred<Response>(); let settled = false;
  const f = fixture({ deadlineMs: 15, transport: async () => held.promise });
  const pending = f.panel.show(manifest(), JOB, () => true).then(() => { settled = true; });
  await until(() => settled); await pending; noRenderer(f); held.resolve(response()); f.panel.clear();
});

test('clear disposes the mounted renderer exactly once and removes its canvas', async t => {
  const f = fixture(); await f.panel.show(manifest(), JOB, () => true);
  t.after(() => f.panel.clear());
  assert.equal(f.renderers.length, 1); f.panel.clear(); f.panel.clear();
  assert.equal(f.renderers[0]!.disposed(), 1); assert.equal(f.doc.host.querySelectorAll('canvas').length, 0);
});

test('view/display/lighting and animation controls dispatch exact values only to the current renderer', async t => {
  const f = fixture(); t.after(() => f.panel.clear()); let active = true;
  await f.panel.show(manifest(), JOB, () => active);
  const controls = f.doc.host.all().filter(element => ['SELECT', 'INPUT', 'BUTTON'].includes(element.tagName));
  const control = (label: string) => {
    const node = controls.find(element => element.getAttribute('aria-label') === label || element.textContent === label);
    assert.ok(node, 'Named control: ' + label); return node;
  };
  const change = (label: string, value: string, event = 'change') => {
    const node = control(label); node.value = value; node.dispatchEvent(new Event(event));
  };
  const first = f.renderers[0]!;
  assert.match(f.doc.host.textContent, /2\.00 × 1\.00 × 0\.00 m/);
  for (const view of ['perspective', 'front', 'side', 'top']) change('View', view);
  for (const mode of ['rendered', 'wireframe', 'clay']) change('Display', mode);
  for (const lighting of ['studio', 'soft', 'dramatic']) change('Lighting', lighting);
  control('Reset view').click(); change('Animation clip', '1'); change('Animation time', '1.25', 'input');
  change('Animation speed', '1.5'); control('Loop animation').checked = false; control('Loop animation').dispatchEvent(new Event('change'));
  const play = control('Play animation'); play.click(); play.click();
  const expected = [
    ...['perspective', 'front', 'side', 'top'].map(value => ({ method: 'setView', args: [value] })),
    ...['rendered', 'wireframe', 'clay'].map(value => ({ method: 'setMode', args: [value] })),
    ...['studio', 'soft', 'dramatic'].map(value => ({ method: 'setLighting', args: [value] })),
    { method: 'reset', args: [] }, { method: 'selectAnimation', args: [1] }, { method: 'seekAnimation', args: [1.25] },
    { method: 'setAnimationSpeed', args: [1.5] }, { method: 'setAnimationLoop', args: [false] },
    { method: 'setAnimationPlaying', args: [true] }, { method: 'setAnimationPlaying', args: [false] },
  ];
  assert.deepEqual(first.calls, expected);
  active = false;
  for (const node of controls) for (const event of ['click', 'change', 'input']) node.dispatchEvent(new Event(event));
  assert.deepEqual(first.calls, expected, 'callback fences already-mounted controls');
  await f.panel.show(manifest(glb(), NEXT_JOB), NEXT_JOB, () => true);
  assert.equal(first.disposed(), 1);
  for (const node of controls) for (const event of ['click', 'change', 'input']) node.dispatchEvent(new Event(event));
  assert.deepEqual(first.calls, expected, 'detached controls have their listeners removed');
  const second = f.renderers[1]!, view = f.doc.host.all().find(node => node.getAttribute('aria-label') === 'View')!;
  view.value = 'top'; view.dispatchEvent(new Event('change'));
  assert.deepEqual(second.calls, [{ method: 'setView', args: ['top'] }]);
  assert.equal(f.downloads.length, 2, 'all controls are local, with no extra transport calls');
  assert.ok(f.downloads.every(call => /^\/v1\/assets\/artifact\?jobId=[a-f0-9-]+&path=asset\.glb$/.test(call.path)));
});

test('a naturally completed animation updates visible play/time controls without dispatching another action', async t => {
  const f = fixture(); t.after(() => f.panel.clear()); await f.panel.show(manifest(), JOB, () => true);
  const play = f.doc.host.all().find(node => node.getAttribute('aria-label') === 'Play animation')!;
  const seek = f.doc.host.all().find(node => node.getAttribute('aria-label') === 'Animation time')!;
  play.click(); assert.equal(play.textContent, 'Pause');
  f.renderers[0]!.finishAnimation(); await until(() => play.textContent === 'Play');
  assert.equal(seek.value, '2'); assert.equal(play.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(f.renderers[0]!.calls, [{ method: 'setAnimationPlaying', args: [true] }]);
});

test('production static routes enumerate the local viewer/preflight/runtime and exactly six vendor modules under self/blob CSP', async () => {
  const server = await readFile(resolve('apps/daemon/src/lab-server.ts'), 'utf8');
  for (const [path, source] of [
    ['/asset-viewer.js', 'dist/apps/desktop/src/asset-viewer.js'],
    ['/glb-preflight.js', 'dist/apps/desktop/src/glb-preflight.js'],
    ['/asset-viewer-runtime.mjs', 'apps/desktop/public/asset-viewer-runtime.mjs'],
  ]) {
    assert.ok(server.includes("['" + path + "', [join(options.cwd, '" + source + "'), 'text/javascript']]"), 'Exact static route: ' + path);
  }
  const vendor = /\.\.\.\[\s*('build\/three\.module\.js'[\s\S]*?)\]\.map\(path => \['\/vendor\/three\//.exec(server);
  assert.ok(vendor, 'An explicit local vendor list, never a wildcard filesystem route');
  assert.deepEqual([...vendor[1]!.matchAll(/'([^']+\.js)'/g)].map(match => match[1]).sort(), [
    'build/three.module.js', 'build/three.core.js', 'examples/jsm/loaders/GLTFLoader.js',
    'examples/jsm/controls/OrbitControls.js', 'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/SkeletonUtils.js',
  ].sort());
  assert.match(server, /publicRoutes\.get\(url\.pathname\)/);
  const policy = /setHeader\('Content-Security-Policy', "([^"]+)"\)/.exec(server)?.[1]; assert.ok(policy);
  assert.match(policy, /script-src 'self';/); assert.match(policy, /connect-src 'self' blob:;/); assert.match(policy, /img-src 'self' blob:;/);
  assert.doesNotMatch(policy, /\*|https?:|unsafe-eval|unsafe-inline/);
});

test('production source uses one fixed same-origin runtime and exact manifest-load ownership', async () => {
  const [panel, workbench, html] = await Promise.all([
    readFile(resolve('apps/desktop/src/asset-viewer.ts'), 'utf8'),
    readFile(resolve('apps/desktop/src/studio.ts'), 'utf8'),
    readFile(resolve('apps/desktop/public/studio.html'), 'utf8'),
  ]);
  assert.match(panel, /readDownloadArtifacts/); assert.match(panel, /fetchVerifiedArtifact/); assert.match(panel, /validateGlb/);
  assert.match(panel, /['"]\/asset-viewer-runtime\.mjs['"]/);
  assert.doesNotMatch(panel, /(?:https?:\/\/|eval\s*\(|new Function\s*\(|innerHTML\s*=|nativeBridge|execute_luau|\/v1\/(?:codex|studio|native|providers))/);
  assert.match(html, /id="asset-viewer"/);
  assert.match(workbench, /new AssetViewerPanel\(/);
  const loadStart = workbench.indexOf('private async loadAssetManifest(');
  assert.ok(loadStart >= 0);
  const load = workbench.slice(loadStart, workbench.indexOf('\n  private ', loadStart + 1) < 0 ? undefined : workbench.indexOf('\n  private ', loadStart + 1));
  assert.match(load, /assetManifest\(job\.jobId\)/); assert.match(load, /assetViewer\.show\(manifest, job\.jobId,/);
  assert.match(workbench, /assetViewer\.clear\(\)/);
});
