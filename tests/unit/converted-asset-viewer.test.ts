/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AssetViewerPanel, type ViewerModule, type ViewerRuntime } from '../../apps/desktop/src/asset-viewer.js';

// Owned GLB bytes and a recording runtime exercise only the existing browser viewer.
// This fixture does not establish conversion validity, native execution or import authority.
const JOB = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64), ORIGIN = 'http://127.0.0.1:7780';
function glb(): Uint8Array<ArrayBuffer> {
  const binary = new Uint8Array(new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0]).buffer);
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteLength: binary.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
  const json = new TextEncoder().encode(JSON.stringify(doc)), size = Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(28 + size + binary.length), header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.length, true);
  header.setUint32(12, size, true); header.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + size); bytes.set(json, 20);
  header.setUint32(20 + size, binary.length, true); header.setUint32(24 + size, 0x004e4942, true);
  bytes.set(binary, 28 + size); return bytes;
}
class ElementFixture extends EventTarget {
  children: ElementFixture[] = []; parentElement: ElementFixture | null = null;
  id = ''; className = ''; type = ''; hidden = false; disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private text = ''; private readonly attributes = new Map<string, string>();
  constructor(readonly ownerDocument: DocumentFixture, readonly tagName: string) { super(); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(' '); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  set innerHTML(_value: string) { assert.fail('Viewer must use DOM nodes, never an HTML sink'); }
  get childElementCount(): number { return this.children.length; }
  append(...nodes: ElementFixture[]): void { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes: ElementFixture[]): void { for (const child of this.children) child.parentElement = null; this.children = []; this.text = ''; this.append(...nodes); }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  all(): ElementFixture[] { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelectorAll(selector: string): ElementFixture[] {
    return this.all().filter(child => selector.split(',').some(part => {
      const s = part.trim();
      return s.startsWith('.') ? child.className.split(' ').includes(s.slice(1)) : child.tagName.toLowerCase() === s;
    }));
  }
  querySelector(selector: string): ElementFixture | null { return this.querySelectorAll(selector)[0] ?? null; }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
class DocumentFixture {
  readonly defaultView = { setTimeout, clearTimeout, location: { origin: ORIGIN } };
  readonly host = this.createElement('section');
  constructor() { this.host.id = 'asset-viewer'; }
  createElement(tag: string): ElementFixture { return new ElementFixture(this, tag.toUpperCase()); }
  getElementById(id: string): ElementFixture | null { return [this.host, ...this.host.all()].find(element => element.id === id) ?? null; }
}
function fixture() {
  const bytes = glb(), sha256 = createHash('sha256').update(bytes).digest('hex'), doc = new DocumentFixture();
  const requests: string[] = [], inputs: Parameters<ViewerModule['createAssetViewer']>[0][] = [];
  const calls: { method: string; value?: unknown }[] = [];
  let disposed = 0;
  const transport: typeof fetch = async input => {
    const path = String(input); requests.push(path);
    if (path === '/v1/assets/artifact?jobId=' + JOB + '&path=asset.glb') return new Response(new Uint8Array(bytes).buffer, { headers: {
      'Content-Type': 'model/gltf-binary', 'Content-Length': String(bytes.length),
      'Content-Disposition': 'attachment; filename="fixture-asset-asset.glb"',
    } });
    return new Response(null, { status: 403 });
  };
  const loadRuntime = async (): Promise<ViewerModule> => ({ createAssetViewer: async input => {
    inputs.push(input); const canvas = doc.createElement('canvas'); (input.host as unknown as ElementFixture).append(canvas);
    const runtime: ViewerRuntime = {
      reset: () => { calls.push({ method: 'reset' }); }, setView: value => { calls.push({ method: 'setView', value }); },
      setMode: value => { calls.push({ method: 'setMode', value }); }, setLighting: value => { calls.push({ method: 'setLighting', value }); },
      setAnimationPlaying: () => {}, animations: () => [], hasAnimations: false,
      animationState: () => ({ index: 0, time: 0, duration: 0, playing: false, speed: 1, loop: false }),
      selectAnimation: () => {}, seekAnimation: () => {}, setAnimationSpeed: () => {}, setAnimationLoop: () => {},
      stats: () => ({ triangles: 1, materials: 1, dimensions: { x: 2, y: 1, z: 0 } }),
      dispose: () => { disposed++; canvas.remove(); },
    };
    return runtime;
  } });
  const panel = new AssetViewerPanel(doc as unknown as Document, TOKEN, { transport, loadRuntime, tokenOrigin: ORIGIN, deadlineMs: 500 });
  const artifact = { path: 'asset.glb', role: 'export', bytes: bytes.length, sha256 };
  const generated = { schemaVersion: 1, jobId: JOB, request: { name: 'fixture-asset', template: 'hero-prop' }, artifacts: [artifact] };
  const converted = { schemaVersion: 2, origin: 'converted-glb', jobId: JOB, request: {
    schemaVersion: 2, fidelityPolicy: 'arcane-static-fidelity-v1', kind: 'converted-glb', jobId: JOB, parentJobId: PARENT,
    parentManifestSha256: 'b'.repeat(64), name: 'fixture-asset', sourceSha256: sha256, sourceBytes: bytes.length,
    importSha256: sha256, importBytes: bytes.length, sourceMapSha256: 'c'.repeat(64), collision: 'none', renderResolution: 128, renderSamples: 1,
  }, artifacts: [artifact] };
  return { panel, doc, bytes, requests, inputs, calls, generated, converted, disposed: () => disposed };
}

test('converted GLB keeps the verified interactive viewer without requesting review or import', async t => {
  const f = fixture(); t.after(() => f.panel.clear());
  await f.panel.show(f.converted, JOB, () => true);
  assert.equal(f.inputs.length, 1); assert.deepEqual(new Uint8Array(f.inputs[0]!.bytes), f.bytes);
  assert.equal(f.inputs[0]!.signal.aborted, false); assert.equal(f.doc.host.hidden, false);
  assert.equal(f.doc.host.querySelectorAll('canvas').length, 1); assert.equal(f.doc.host.querySelector('.vw')?.dataset.phase, 'ready');
  assert.equal(f.doc.host.querySelector('.vw-pill')?.textContent.trim(), 'Preview only');
  assert.equal(f.doc.host.querySelector('.vw-pill')?.dataset.state, 'preview-only');
  assert.match(f.doc.host.querySelector('.vw-inspector-foot')!.textContent, /Studio import is unavailable/);
  assert.equal(f.doc.host.querySelector('.viewer-review'), null);
  assert.match(f.doc.host.querySelector('.vw-hints')!.textContent, /Orbit.*Pan.*Zoom/);
  const controls = f.doc.host.querySelectorAll('button');
  controls.find(button => button.getAttribute('aria-label') === 'Front view')!.click();
  controls.find(button => button.getAttribute('aria-label') === 'Reset view')!.click();
  assert.deepEqual(f.calls, [{ method: 'setView', value: 'front' }, { method: 'reset' }]);
  assert.deepEqual(f.requests, ['/v1/assets/artifact?jobId=' + JOB + '&path=asset.glb']);
  assert.equal(controls.some(button => /Approve model|Reject model|Refresh review|Import/.test(button.textContent)), false);
  f.panel.clear(); assert.equal(f.disposed(), 1); assert.equal(f.inputs[0]!.signal.aborted, true);
});

test('generated GLB still loads the runtime and requests its existing review card', async t => {
  const f = fixture(); t.after(() => f.panel.clear());
  await f.panel.show(f.generated, JOB, () => true);
  assert.equal(f.inputs.length, 1); assert.deepEqual(new Uint8Array(f.inputs[0]!.bytes), f.bytes);
  assert.deepEqual(f.requests, ['/v1/assets/artifact?jobId=' + JOB + '&path=asset.glb', '/v1/assets/review/prepare']);
  assert.ok(f.doc.host.querySelector('.viewer-review'));
  assert.notEqual(f.doc.host.querySelector('.vw-pill')?.dataset.state, 'preview-only');
  assert.doesNotMatch(f.doc.host.querySelector('.vw-inspector-foot')!.textContent, /Studio import is unavailable/);
});
