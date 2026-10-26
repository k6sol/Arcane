/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,mkdir,realpath,writeFile,readFile,readdir,rm,lstat,link,symlink,unlink,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,resolve,sep,basename} from 'node:path';
import {createAssetService,type AssetService} from '../../apps/daemon/src/asset-service.js';
import {createAssetConversationHost} from '../../apps/daemon/src/asset-conversation-host.js';
import {createNativeAssetRegistry,type NativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';
import {nativeAssetRoutes} from '../../apps/daemon/src/native-asset-routes.js';
import {assetRoutes} from '../../apps/daemon/src/asset-routes.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {parseAdoptGlbInput,parseAdoptedGlbManifest,isAdoptedGlbManifest,validateAdoptedGlbManifest} from '../../packages/asset-pipeline/src/adopted-glb.js';
import {sha256} from '../../packages/asset-pipeline/src/validation.js';
import {GLB_PREFLIGHT_LIMITS,validateGlb} from '../../apps/desktop/src/glb-preflight.js';
import {AssetViewerPanel} from '../../apps/desktop/src/asset-viewer.js';
import {AutomaticAssetPreviews} from '../../apps/desktop/src/automatic-asset-previews.js';
import {readAssetConversationPage} from '../../apps/desktop/src/studio.js';
import {DaemonClient} from '../../apps/mcp/src/daemon-client.js';
import {assetManifest as manifestSchema,nativeAdoptGlbInput} from '../../apps/mcp/src/asset-schemas.js';
import {createMcpServer} from '../../apps/mcp/src/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
type Options = NonNullable<ConstructorParameters<typeof AssetViewerPanel>[2]>;
type Renderer = Awaited<ReturnType<Awaited<ReturnType<NonNullable<Options['loadRuntime']>>>['createAssetViewer']>>;
// Actual ordinary files + Node SQLite + native registry + HTTP/MCP client.
// Synthetic GLBs and recording DOM/renderer only; no Blender/Studio/provider.

type Doc = Record<string, any>;
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
function glb(doc: Doc | string, bin: Uint8Array, jsonPad = 0x20): Uint8Array {
  const text = new TextEncoder().encode(typeof doc === 'string' ? doc : JSON.stringify(doc));
  const jsonLength = (text.length + 3) & ~3, binLength = (bin.length + 3) & ~3;
  const bytes = new Uint8Array(28 + jsonLength + binLength), v = new DataView(bytes.buffer);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, bytes.length, true);
  v.setUint32(12, jsonLength, true); v.setUint32(16, 0x4e4f534a, true);
  bytes.fill(jsonPad, 20, 20 + jsonLength); bytes.set(text, 20);
  v.setUint32(20 + jsonLength, binLength, true); v.setUint32(24 + jsonLength, 0x004e4942, true); bytes.set(bin, 28 + jsonLength);
  return bytes;
}
function builder() {
  const doc: Doc = { asset: { version: '2.0', generator: 'Arcane data-only test' }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [], meshes: [], nodes: [], scenes: [{ nodes: [0] }], scene: 0 };
  const chunks: number[] = [];
  function view(bytes: Uint8Array, options: Doc = {}): number {
    while (chunks.length % 4) chunks.push(0);
    const index = doc.bufferViews.length;
    doc.bufferViews.push({ buffer: 0, byteOffset: chunks.length, byteLength: bytes.length, ...options });
    chunks.push(...bytes); return index;
  }
  function accessor(values: number[], type: string, componentType = 5126, extra: Doc = {}): number {
    const widths: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    const bytes = new Uint8Array(values.length * widths[componentType]!), v = new DataView(bytes.buffer);
    values.forEach((n, i) => {
      const at = i * widths[componentType]!;
      if (componentType === 5126) v.setFloat32(at, n, true);
      else if (componentType === 5125) v.setUint32(at, n, true);
      else if (componentType === 5123) v.setUint16(at, n, true);
      else if (componentType === 5122) v.setInt16(at, n, true);
      else if (componentType === 5120) v.setInt8(at, n);
      else v.setUint8(at, n);
    });
    const index = doc.accessors.length;
    doc.accessors.push({ bufferView: view(bytes), componentType, count: values.length / components[type]!, type, ...extra });
    return index;
  }
  function finish(): { doc: Doc; bin: Uint8Array; bytes: Uint8Array } {
    const bin = new Uint8Array(chunks); doc.buffers[0].byteLength = bin.length;
    return { doc, bin, bytes: glb(doc, bin) };
  }
  return { doc, accessor, view, finish };
}
function ownedGlb(rich = false) {
  const b = builder(), d = b.doc;
  const position = b.accessor([0, 0, 0, 1, 0, 0, 0, 1, 0], 'VEC3', 5126, { min: [0, 0, 0], max: [1, 1, 0] });
  const normal = b.accessor([0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3');
  const indices = b.accessor([0, 1, 2], 'SCALAR', 5123);
  d.meshes = [{ primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices }] }];
  d.nodes = [{ mesh: 0 }];
  if (rich) {
    const primitive = d.meshes[0].primitives[0];
    primitive.attributes.TEXCOORD_0 = b.accessor([0, 0, 1, 0, 0, 1], 'VEC2');
    primitive.attributes.COLOR_0 = b.accessor([255, 128, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255], 'VEC4', 5121, { normalized: true });
    primitive.attributes.JOINTS_0 = b.accessor([0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0], 'VEC4', 5121);
    primitive.attributes.WEIGHTS_0 = b.accessor([0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0], 'VEC4');
    const morph = b.accessor([0, 0, 0, 0, 0, 0, 0, 0, 0.5], 'VEC3', 5126, { min: [0, 0, 0], max: [0, 0, 0.5] });
    primitive.targets = [{ POSITION: morph }]; d.meshes[0].weights = [0];
    const ibm = b.accessor([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1], 'MAT4');
    d.nodes = [{ children: [1, 2] }, { mesh: 0, skin: 0, weights: [0] }, { children: [3] }, { translation: [0, 1, 0] }];
    d.skins = [{ joints: [2, 3], skeleton: 2, inverseBindMatrices: ibm }];
    const times = b.accessor([0, 1], 'SCALAR', 5126, { min: [0], max: [1] });
    const translation = b.accessor([0, 1, 0, 0, 2, 0], 'VEC3');
    const rotation = b.accessor([0, 0, 0, 1, 0, 0, 1, 0], 'VEC4');
    const weights = b.accessor([0, 1], 'SCALAR');
    d.animations = [{ samplers: [{ input: times, output: translation }, { input: times, output: rotation, interpolation: 'STEP' }, { input: times, output: weights }], channels: [{ sampler: 0, target: { node: 3, path: 'translation' } }, { sampler: 1, target: { node: 2, path: 'rotation' } }, { sampler: 2, target: { node: 1, path: 'weights' } }] }];
    d.images = [{ bufferView: b.view(PNG), mimeType: 'image/png' }];
    d.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    d.textures = [{ source: 0, sampler: 0 }];
    d.materials = [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.5, 0.2, 1], metallicFactor: 0.25, roughnessFactor: 0.6, baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0, 0], scale: [1, 1], rotation: 0, texCoord: 0 } } } }, normalTexture: { index: 0, scale: 1 }, occlusionTexture: { index: 0, strength: 1 }, emissiveFactor: [0.1, 0.2, 0.3], emissiveTexture: { index: 0 }, extensions: { KHR_materials_emissive_strength: { emissiveStrength: 2 }, KHR_materials_ior: { ior: 1.5 }, KHR_materials_specular: { specularFactor: 0.5, specularColorFactor: [1, 1, 1], specularTexture: { index: 0 } } } }];
    primitive.material = 0;
    d.extensionsUsed = ['KHR_texture_transform', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_specular'];
    d.extras = { name: 'embedded model', tags: ['PBR', 'skin', 'morph'], nested: { harmless: true } };
  }
  return b.finish();
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

type AppProvider='claude-code'|'arcane';
function appIncarnation(registry:ReturnType<typeof createNativeAssetRegistry>,provider:AppProvider,conversationId:string=randomUUID()) {
 const incarnation=registry.issue(),connectionId=randomUUID(),threadId='app:'+conversationId,operationId=randomUUID();
 if(provider==='claude-code')incarnation.bindAppConversation({kind:'app-conversation',connectionId,provider,conversationId,
  transport:{kind:'claude-code-process',incarnationId:randomUUID(),nativeSessionId:null}});
 else incarnation.bindAppConversation({kind:'app-conversation',connectionId,provider,conversationId,
  transport:{kind:'arcane-gateway-loop',incarnationId:randomUUID()}});
 const identity={connectionId,provider,threadId,sessionId:null},bound={connectionId,threadId};
 incarnation.grantNextIntent({...bound,sessionId:null});incarnation.dispatched({...bound,operationId});
 const credential=incarnation.credential();
 return {incarnation,credential,identity,conversationId,operationId,actor:()=>registry.capture(credential,'mutate')};
}

async function nativeFixture(t:test.TestContext,provider:'codex'|AppProvider='codex') {
 const boundary=await realpath(tmpdir()),directory=await mkdtemp(join(boundary,'arcane-adopt-files-')),project=join(directory,'project');
 await mkdir(project);await mkdir(join(project,'exports'));
 const canonical=await realpath(project);let store=new ConversationWorkStore({directory:join(directory,'bindings'),projectPath:canonical});
 const registry=createNativeAssetRegistry({projectPath:canonical}),app=provider==='codex'?null:appIncarnation(registry,provider);
 const incarnation=app?.incarnation??registry.issue(),credential=app?.credential??incarnation.credential();
 const codexIdentity={connectionId:'owned-connection',provider:'codex' as const,threadId:'owned-thread',sessionId:null},identity=app?.identity??codexIdentity;
 if(!app){incarnation.seal(codexIdentity);const bound={connectionId:identity.connectionId,threadId:identity.threadId};incarnation.grant(bound);incarnation.dispatched({...bound,operationId:'owned-operation'});}
 const conversation=()=>({provider:identity.provider,threadId:identity.threadId,sessionId:identity.sessionId});
 const actor=()=>registry.capture(credential,'mutate');
 let selectedTargetCalls=0;
 const options={cwd:directory,projectPath:canonical,outputRoot:join(directory,'managed'),studioImport:{workAssociations:store,
  selectTarget(){selectedTargetCalls++;throw Error('No native engine/context call permitted for adopted GLB');}}};
 let service=await createAssetService(options);
 const human='a'.repeat(64),generic='b'.repeat(64);
 const createHost=()=>createAssetConversationHost({projectPath:canonical,workAssociations:store,conversation,
  start:async()=>{throw Error('No Blender generation allowed');},
  adoptNative:async(input,captured,admission)=>(await service.adoptProjectGlb(input,captured,admission)).jobId});
 let host=createHost();
 let origin='';let native=nativeAssetRoutes(service,host,registry),assets=assetRoutes(service,host);
 const server=createServer(async(request,response)=>{try{const url=new URL(request.url??'/',origin);
  if(await native(request,response,url,origin))return;if(await assets(request,response,url,human,origin,generic))return;
  response.writeHead(404);response.end();}catch{response.writeHead(500);response.end();}});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const call=async(route:string,token=credential,input?:unknown)=>fetch(origin+route,{method:input===undefined?'GET':'POST',
  headers:{Authorization:'Bearer '+token,...(input===undefined?{}:{'Content-Type':'application/json'})},
  ...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(5000)});
 const path=join(project,'exports','owned.glb');await writeFile(path,ownedGlb(true).bytes);
 const sdkFor=(assetToken:string)=>new DaemonClient({url:origin,token:'c'.repeat(43),assetAudience:'native-session',assetToken});
 const sdk=()=>app?sdkFor(credential):new DaemonClient({url:origin,token:credential,assetAudience:'native-session'});
 t.after(async()=>{registry.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await service.close();store.close();
  const absolute=resolve(directory),part=relative(boundary,absolute);assert.ok(part&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep));assert.equal((await lstat(absolute)).isSymbolicLink(),false);
  await rm(absolute,{recursive:true,force:true});});
 return {directory,project:canonical,get store(){return store;},registry,incarnation,credential,identity,conversation,conversationId:app?.conversationId??null,actor,get host(){return host;},call,sdk,sdkFor,path,human,generic,origin,
   appContext:(nextProvider:AppProvider,conversationId?:string)=>appIncarnation(registry,nextProvider,conversationId),
  get service(){return service;},get selectedTargetCalls(){return selectedTargetCalls;},
  async adopt(){return host.adoptNative(actor(),{name:'owned-creation',path:'exports/owned.glb'});},
   async restart(reopenBindings=false){await service.close();if(reopenBindings){store.close();store=new ConversationWorkStore({directory:join(directory,'bindings'),projectPath:canonical});options.studioImport.workAssociations=store;}
    service=await createAssetService(options);host=createHost();native=nativeAssetRoutes(service,host,registry);assets=assetRoutes(service,host);return service;}};
}

test('native HTTP/SDK adopts actual embedded-texture GLB, binds actual SQLite CWS, and drives chat automatic preview + existing viewer',async t=>{
 const f=await nativeFixture(t),original=await readFile(f.path),automatic=new AutomaticAssetPreviews();automatic.observe([]);
 const adopted=await f.sdk().assetsAdoptGlb({name:'owned-creation',path:'exports/owned.glb'});
 assert.ok('jobId' in adopted&&adopted.jobId);const id=adopted.jobId as string;
 assert.equal((adopted as {association:string}).association,'bound');assert.equal((adopted as {creation:string}).creation,'created');
 assert.equal(f.store.binding('asset-job',id)?.conversation.threadId,f.identity.threadId);
 const pageResponse=await f.call('/v1/assets/conversation-jobs',f.human),page=readAssetConversationPage(await pageResponse.json());
 automatic.observe(page.jobs);assert.equal(automatic.ready(),id);automatic.markReady(id);
 const response=await f.call('/v1/assets/manifest?jobId='+id,f.human),manifest=manifestSchema.parse((await response.json() as {manifest:unknown}).manifest);
 assert.ok(isAdoptedGlbManifest(manifest));assert.equal(manifest.provenance.kind,'native-project-glb');
 assert.equal(manifest.validation.metadata.imagePixels,1);assert.equal(manifest.validation.metadata.animations,1);
 assert.equal(manifest.engineImport.status,'unavailable');assert.equal('runtime' in manifest,false);assert.equal('templateSha256' in manifest,false);
 const doc=new DocumentFixture();let renders=0;let received:ArrayBuffer|undefined;
 const panel=new AssetViewerPanel(doc as unknown as Document,f.human,{transport:async(url,init)=>fetch(f.origin+String(url),init),
  loadRuntime:async()=>({createAssetViewer:async input=>{renders++;received=input.bytes;const r=recordingRenderer(doc,input.host);r.renderer.hasAnimations=false;return r.renderer;}})});
 t.after(()=>panel.clear());await panel.show(manifest,id,()=>true);
 assert.equal(renders,1);assert.deepEqual(Buffer.from(received!),original);assert.equal(doc.host.querySelectorAll('canvas').length,1);
 assert.equal(f.selectedTargetCalls,0);assert.deepEqual(await readFile(f.path),original,'Source is borrowed and never modified');
});

test('native-only MCP tool registration and call reach actual HTTP/service rather than an unused helper',async t=>{
 const f=await nativeFixture(t),server=createMcpServer({client:f.sdk(),projectRoot:f.project});
 const client=new Client({name:'owned-adoption-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
 const tools=await client.listTools();const tool=tools.tools.find(row=>row.name==='assets_adopt_glb');assert.ok(tool);
 assert.equal(tool.annotations?.readOnlyHint,false);assert.equal(tool.annotations?.idempotentHint,false);
 const result=await client.callTool({name:'assets_adopt_glb',arguments:{name:'owned-mcp',path:'exports/owned.glb'}});
 assert.notEqual(result.isError,true);const data=result.structuredContent as {jobId:string;association:string};assert.ok(data.jobId);assert.equal(data.association,'bound');
 assert.equal(f.service.jobs().find(row=>row.jobId===data.jobId)?.request.template,'adopted-glb');
 const generic=createMcpServer({client:new DaemonClient({url:f.origin,token:f.generic}),projectRoot:f.project});
 const genericClient=new Client({name:'generic-adoption-test',version:'1'}),[c,d]=InMemoryTransport.createLinkedPair();
 await Promise.all([generic.connect(c),genericClient.connect(d)]);t.after(async()=>{await genericClient.close();await generic.close();});
 assert.equal((await genericClient.listTools()).tools.some(row=>row.name==='assets_adopt_glb'),false);
});

test('managed immutable snapshot survives original edits/deletion and restart, without rebinding or inventing worker provenance',async t=>{
 const f=await nativeFixture(t),ack=await f.adopt();assert.ok(ack.jobId);
 const original=await f.service.artifact(ack.jobId,'asset.glb'),bindings=f.store.list({provider:'codex',threadId:f.identity.threadId,sessionId:null},'asset-job').items.length;
 await writeFile(f.path,Buffer.from('changed source'));assert.deepEqual((await f.service.artifact(ack.jobId,'asset.glb')).bytes,original.bytes);
 await unlink(f.path);await f.restart();
 assert.equal(f.service.jobs()[0]?.state,'succeeded');assert.deepEqual((await f.service.artifact(ack.jobId,'asset.glb')).bytes,original.bytes);
 assert.equal(f.store.list({provider:'codex',threadId:f.identity.threadId,sessionId:null},'asset-job').items.length,bindings);
});

test('adopted preview explicitly refuses engine preparation before any target/native-context call',async t=>{
 const f=await nativeFixture(t),ack=await f.adopt();assert.ok(ack.jobId);
 await assert.rejects(f.service.prepareStudioImport(ack.jobId,f.actor()),{code:'STUDIO_IMPORT_UNSUPPORTED'});
 const response=await f.call('/v1/assets/native/prepare-studio-import',f.credential,{jobId:ack.jobId});assert.equal(response.status,503);
 assert.equal(f.selectedTargetCalls,0);
});

for(const provider of ['claude-code','arcane'] as const){
 test(provider+' native MCP adopts under its real app anchor and previews exact bytes without generated-model approval or engine import',async t=>{
  const f=await nativeFixture(t,provider),original=await readFile(f.path),server=createMcpServer({client:f.sdk(),projectRoot:f.project});
  const client=new Client({name:'app-adoption-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
  const tool=(await client.listTools()).tools.find(row=>row.name==='assets_adopt_glb');assert.ok(tool);
  const result=await client.callTool({name:'assets_adopt_glb',arguments:{name:'app-creation',path:'exports/owned.glb'}});
  assert.notEqual(result.isError,true);const data=result.structuredContent;assert.ok(data&&typeof data==='object'&&'jobId'in data&&typeof data.jobId==='string');
  const jobId=data.jobId;assert.ok('association'in data&&'creation'in data&&'retry'in data);
  assert.equal(data.association,'bound');assert.equal(data.creation,'created');assert.equal(data.retry,false);
  assert.match(f.identity.threadId,/^app:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(f.identity.threadId,'app:'+f.conversationId);
  const expected={provider,threadId:f.identity.threadId,sessionId:null};
  assert.deepEqual(f.store.binding('asset-job',jobId)?.conversation,expected);
  const pageResponse=await f.call('/v1/assets/conversation-jobs',f.human);assert.equal(pageResponse.status,200);
  const page=readAssetConversationPage(await pageResponse.json());assert.deepEqual(page.conversation,expected);assert.equal(page.jobs[0]?.jobId,jobId);
  const response=await f.call('/v1/assets/native/manifest?jobId='+jobId);assert.equal(response.status,200);
  const manifest=manifestSchema.parse((await response.json() as {manifest:unknown}).manifest);assert.ok(isAdoptedGlbManifest(manifest));
  assert.deepEqual(manifest.provenance.conversation,expected);assert.equal(manifest.provenance.projectId,f.store.projectId);
  assert.equal(manifest.provenance.kind,'native-project-glb');assert.equal(manifest.provenance.sourceSha256,sha256(original));
  assert.deepEqual(manifest.engineImport,{status:'unavailable',reason:'adopted-origin-requires-safe-conversion'});
  assert.equal('runtime' in manifest,false);assert.equal('templateSha256' in manifest,false);
  const doc=new DocumentFixture();let received:ArrayBuffer|undefined,renders=0;
  const panel=new AssetViewerPanel(doc as unknown as Document,f.human,{transport:async(url,init)=>fetch(f.origin+String(url),init),
   loadRuntime:async()=>({createAssetViewer:async input=>{renders++;received=input.bytes;const r=recordingRenderer(doc,input.host);r.renderer.hasAnimations=false;return r.renderer;}})});
  t.after(()=>panel.clear());await panel.show(manifest,jobId,()=>true);
  assert.equal(renders,1);assert.deepEqual(Buffer.from(received!),original);assert.equal(doc.host.querySelectorAll('canvas').length,1);
  // This is the actual producer of human-review subjects; refusal creates no
  // approvable generated subject, even though preview admission succeeded.
  await assert.rejects(f.service.modelReviewSubject(jobId,{projectId:f.store.projectId,conversation:expected}),{code:'ASSET_REVIEW_JOB_STATE'});
  await assert.rejects(f.service.prepareStudioImport(jobId,f.actor()),{code:'STUDIO_IMPORT_UNSUPPORTED'});
  assert.equal((await f.call('/v1/assets/native/prepare-studio-import',f.credential,{jobId})).status,503);
  assert.equal(f.selectedTargetCalls,0);assert.deepEqual(await readFile(f.path),original,'Borrowed project GLB is unchanged');
 });

 test(provider+' adopted app ownership and immutable bytes survive service hydration and an actual SQLite reopen',async t=>{
  const f=await nativeFixture(t,provider),ack=await f.adopt();assert.ok(ack.jobId);
  const original=await f.service.artifact(ack.jobId,'asset.glb'),binding=f.store.binding('asset-job',ack.jobId),oldStore=f.store;
  assert.deepEqual(binding?.conversation,f.conversation());
  await writeFile(f.path,Buffer.from('changed original source'));assert.deepEqual((await f.service.artifact(ack.jobId,'asset.glb')).bytes,original.bytes);
  await unlink(f.path);await f.restart(true);assert.notEqual(f.store,oldStore);
  assert.equal(f.service.jobs()[0]?.state,'succeeded');assert.deepEqual(f.store.binding('asset-job',ack.jobId),binding);
  assert.deepEqual(f.host.listNative(f.actor()).items.map(item=>item.id),[ack.jobId]);
  const response=await f.call('/v1/assets/native/manifest?jobId='+ack.jobId);assert.equal(response.status,200);
  const manifest=manifestSchema.parse((await response.json() as {manifest:unknown}).manifest);assert.ok(isAdoptedGlbManifest(manifest));
  assert.deepEqual(manifest.provenance.conversation,f.conversation());assert.equal(manifest.validation.engineVerification,'pending');
  assert.equal(manifest.engineImport.status,'unavailable');assert.deepEqual((await f.service.artifact(ack.jobId,'asset.glb')).bytes,original.bytes);
  assert.equal(f.selectedTargetCalls,0);
 });

 test(provider+' fresh incarnation can read its same app job while foreign chats, other providers and retired actors cannot',async t=>{
  const f=await nativeFixture(t,provider),ack=await f.adopt();assert.ok(ack.jobId);assert.ok(f.conversationId);
  const original=await readFile(f.path),old=f.actor();f.incarnation.retire();
  assert.throws(()=>f.registry.capture(f.credential,'read'));assert.throws(()=>f.host.listNative(old));
  await assert.rejects(f.host.adoptNative(old,{name:'retired-copy',path:'exports/owned.glb'}));
  await assert.rejects(f.sdk().assetsManifest(ack.jobId));
  const next=f.appContext(provider,f.conversationId);assert.notEqual(next.credential,f.credential);assert.notEqual(next.identity.connectionId,f.identity.connectionId);
  assert.deepEqual(next.identity.threadId,f.identity.threadId);assert.equal(next.identity.sessionId,null);
  assert.deepEqual(f.host.listNative(next.actor()).items.map(item=>item.id),[ack.jobId]);
  const reread=await f.sdkFor(next.credential).assetsManifest(ack.jobId);assert.ok(isAdoptedGlbManifest(reread.manifest));
  assert.deepEqual(reread.manifest.provenance.conversation,f.conversation());
  const foreignChat=f.appContext(provider),foreignProvider=f.appContext(provider==='claude-code'?'arcane':'claude-code',f.conversationId);
  for(const foreign of [foreignChat,foreignProvider]){
   assert.deepEqual(f.host.listNative(foreign.actor()).items,[]);assert.equal(f.host.bindingNative(foreign.actor(),ack.jobId),null);
   const response=await f.call('/v1/assets/native/manifest?jobId='+ack.jobId,foreign.credential);assert.equal(response.status,404);
   await assert.rejects(f.sdkFor(foreign.credential).assetsManifest(ack.jobId));
  }
  assert.deepEqual(f.store.binding('asset-job',ack.jobId)?.conversation,f.conversation());
  assert.equal(f.service.jobs().length,1);assert.equal(f.selectedTargetCalls,0);assert.deepEqual(await readFile(f.path),original);
 });

 test(provider+' malformed retained app anchors and runtime sessions fail parsing and hydration without rebinding',async t=>{
  const f=await nativeFixture(t,provider),ack=await f.adopt();assert.ok(ack.jobId);assert.ok(f.conversationId);
  const manifest=await f.service.manifest(ack.jobId);assert.ok(isAdoptedGlbManifest(manifest));
  const job=f.service.jobs().find(row=>row.jobId===ack.jobId);assert.ok(job);
  const binding=f.store.binding('asset-job',ack.jobId);
  const invalidScopes=[
   {provider,threadId:'runtime-session-instead-of-app-anchor',sessionId:null},
   {provider,threadId:'app:'+f.conversationId,sessionId:'observed-provider-session'},
   {provider,threadId:'app:ABCDEFAB-1234-4234-9234-ABCDEFABCDEF',sessionId:null},
   {provider,threadId:'app:00000000-0000-0000-0000-000000000000',sessionId:null},
   {provider,threadId:'app:'+f.conversationId+'\n',sessionId:null},
   {provider:'unsupported-app',threadId:'app:'+f.conversationId,sessionId:null},
   {provider,threadId:'app:'+f.conversationId,sessionId:null,connectionId:'not-provenance'},
  ];
  for(const conversation of invalidScopes){
   const changed:Record<string,unknown>={...manifest,provenance:{...manifest.provenance,conversation}};
   assert.throws(()=>parseAdoptedGlbManifest(changed));assert.equal(manifestSchema.safeParse(changed).success,false);
   await assert.rejects(validateAdoptedGlbManifest(job.directory,changed));
  }
  const changed={...manifest,provenance:{...manifest.provenance,conversation:{...f.conversation(),sessionId:'provider-runtime-session'}}};
  await writeFile(join(job.directory,'manifest.json'),JSON.stringify(changed));
  await assert.rejects(f.service.manifest(ack.jobId),{code:'ASSET_ADOPT_MANIFEST'});await f.restart(true);
  const retained=f.service.jobs().find(row=>row.jobId===ack.jobId);assert.ok(retained);
  assert.equal(retained.state,'failed');assert.equal(retained.manifestAvailable,false);assert.equal(retained.error?.code,'HISTORY_INTEGRITY');
  assert.deepEqual(f.store.binding('asset-job',ack.jobId),binding);assert.deepEqual(f.host.listNative(f.actor()).items.map(item=>item.id),[ack.jobId]);
  await assert.rejects(f.service.manifest(ack.jobId),{code:'JOB_STATE'});assert.equal(f.selectedTargetCalls,0);
 });
}

test('native-only ingress rejects human/global bearers, authority fields and URLs with zero managed jobs',async t=>{
 const f=await nativeFixture(t);
 for(const token of [f.human,f.generic,'0'.repeat(64)])assert.equal((await f.call('/v1/assets/native/adopt-glb',token,{name:'owned',path:'exports/owned.glb'})).status,403);
 for(const input of [{name:'owned',path:'exports/owned.glb',actor:{kind:'native-asset-actor'}},{name:'owned',path:'exports/owned.glb',projectId:'f'.repeat(64)},
  {name:'owned',path:'https://example.invalid/a.glb'},{name:'owned',path:'../outside.glb'},{name:'owned',path:'C:/outside.glb'}]){
  const response=await f.call('/v1/assets/native/adopt-glb',f.credential,input);assert.equal(response.status,400);
 }
 assert.equal((await f.call('/v1/assets/adopt-glb',f.human,{name:'owned',path:'exports/owned.glb'})).status,404);
 assert.equal(f.service.jobs().length,0);assert.deepEqual(await readdir(f.service.outputRoot),['index.json']);
});

test('forged/proxied actors and retired original native captures cannot copy or bind',async t=>{
 const f=await nativeFixture(t);let effects=0,reads=0;const admission={beforeCreate(){effects++;},created(){effects++;}};
 const getter=Object.defineProperty({},'kind',{get(){reads++;throw Error('must not read');}});
 for(const actor of [{kind:'native-asset-actor'},getter,new Proxy(f.actor(),{get(){reads++;throw Error('must not read');}})])
  await assert.rejects(async()=>f.service.adoptProjectGlb({name:'owned',path:'exports/owned.glb'},actor as NativeAssetActor,admission));
 const original=f.actor(),pending=f.service.adoptProjectGlb({name:'owned',path:'exports/owned.glb'},original,admission);f.incarnation.retire();
 await assert.rejects(pending);assert.equal(effects,0);assert.equal(reads,0);assert.equal(f.service.jobs().length,0);
});

test('non-GLB, external URI and byte/node/image budget violations reject before managed allocation',async t=>{
 const f=await nativeFixture(t);
 const invalid=[Buffer.from('not a GLB'),ownedGlb(true).bytes];
 const d=ownedGlb().doc;d.buffers[0].uri='https://example.invalid/buffer';invalid.push(glb(d,ownedGlb().bin));
 const many=ownedGlb().doc;many.nodes=Array.from({length:GLB_PREFLIGHT_LIMITS.nodes+1},()=>({mesh:0}));invalid.push(glb(many,ownedGlb().bin));
 // Damage embedded PNG dimensions; admission must reject encoded image data,
 // never defer malformed/over-budget resources until renderer allocation.
 const image=ownedGlb(true);const imageView=image.doc.bufferViews[image.doc.images[0].bufferView];
 new DataView(image.bin.buffer,image.bin.byteOffset).setUint32(imageView.byteOffset+16,GLB_PREFLIGHT_LIMITS.imageDimension+1,false);
 invalid[1]=glb(image.doc,image.bin);
 for(const bytes of invalid){await writeFile(f.path,bytes);await assert.rejects(f.adopt());assert.equal(f.service.jobs().length,0);}
 await truncate(f.path,GLB_PREFLIGHT_LIMITS.bytes+1);await assert.rejects(f.adopt());assert.equal(f.service.jobs().length,0);
});

test('hardlinks and junction/symlink ancestors reject, source outside project is never adopted',async t=>{
 const f=await nativeFixture(t),outside=join(f.directory,'outside');await mkdir(outside);await writeFile(join(outside,'foreign.glb'),ownedGlb().bytes);
 const hard=join(f.project,'exports','hard.glb');await link(f.path,hard);
 await assert.rejects(f.host.adoptNative(f.actor(),{name:'hard',path:'exports/hard.glb'}));await unlink(hard);
 const junction=join(f.project,'linked');await symlink(outside,junction,process.platform==='win32'?'junction':'dir');
 try{await assert.rejects(f.host.adoptNative(f.actor(),{name:'linked',path:'linked/foreign.glb'}));}finally{await unlink(junction);}
 assert.equal(f.service.jobs().length,0);
});

test('managed byte tampering, including a rewritten self-consistent manifest, cannot replace original in-memory request pin',async t=>{
 const f=await nativeFixture(t),ack=await f.adopt();assert.ok(ack.jobId);const job=f.service.jobs()[0]!;
 const manifest=await f.service.manifest(ack.jobId);assert.ok(isAdoptedGlbManifest(manifest));
 const replacement=ownedGlb().bytes;await writeFile(join(job.directory,'asset.glb'),replacement);await assert.rejects(f.service.artifact(ack.jobId,'asset.glb'));
 manifest.request.sourceSha256=sha256(replacement);manifest.request.sourceBytes=replacement.length;
 manifest.provenance.sourceSha256=sha256(replacement);manifest.provenance.sourceBytes=replacement.length;
 manifest.validation.metadata=validateGlb(Uint8Array.from(replacement).buffer);
 const requestBytes=Buffer.from(JSON.stringify(manifest.request)+'\n');await writeFile(join(job.directory,'request.json'),requestBytes);
 for(const a of manifest.artifacts){const bytes=a.path==='asset.glb'?replacement:requestBytes;a.bytes=bytes.length;a.sha256=sha256(bytes);}
 await writeFile(join(job.directory,'manifest.json'),JSON.stringify(manifest));
 await validateAdoptedGlbManifest(job.directory,manifest);await assert.rejects(f.service.manifest(ack.jobId),{code:'MANIFEST'});
 // An attacker cannot use the adoption endpoint to amend/re-adopt an existing
 // managed job or use its private snapshot as a new project source.
 await assert.rejects(f.host.adoptNative(f.actor(),{name:'replay',path:relative(f.project,join(job.directory,'asset.glb')).replaceAll('\\','/')}));
 assert.equal(f.service.jobs().length,1);
});

test('binding COMMIT acknowledgement failure preserves original known job but stops before GLB copy; no automatic rebind',async t=>{
 const f=await nativeFixture(t),actual=f.store.bind.bind(f.store);let calls=0;
 f.store.bind=input=>{calls++;actual(input);throw Error('owned lost CWS commit ACK');};
 const ack=await f.adopt();assert.ok(ack.jobId);assert.equal(ack.association,'unknown');assert.equal(ack.creation,'unknown');assert.equal(ack.retry,false);assert.equal(calls,1);
 const job=f.service.jobs().find(row=>row.jobId===ack.jobId)!;assert.equal(job.state,'failed');
 assert.equal((await readdir(job.directory)).includes('asset.glb'),false);assert.equal(f.store.binding('asset-job',ack.jobId)?.conversation.threadId,f.identity.threadId);
});

for(const published of [false,true])test('interrupted adoption publication retains a journal and does not block restart: '+published,{concurrency:false},async t=>{
 const f=await nativeFixture(t),actual=fs.rename;let staging='',destination='';
 const mock=t.mock.method(fs,'rename',async(from:Parameters<typeof fs.rename>[0],to:Parameters<typeof fs.rename>[1])=>{
  if(typeof from==='string'&&basename(from).startsWith('.adopting-')){
   assert.equal(typeof to,'string');staging=from;destination=String(to);
   const journal=JSON.parse(await readFile(join(staging,'job.json'),'utf8')) as {directory:string;request:{template:string};state:string};
   assert.equal(journal.directory,destination);assert.equal(journal.request.template,'adopted-glb');assert.equal(journal.state,'running');
   if(published)await actual(from,to);
   throw Object.assign(Error('Synthetic publication interruption'),{code:'EIO'});
  }
  return actual(from,to);
 });
 syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
 const result=await f.adopt();assert.equal(result.creation,'unknown');assert.equal(result.jobId,null);assert.equal(result.retry,false);
 assert.ok(staging&&destination);assert.equal(f.service.jobs().length,0);
 assert.equal(f.store.list({provider:'codex',threadId:f.identity.threadId,sessionId:null},'asset-job').items.length,0);
 mock.mock.restore();syncBuiltinESMExports();
 await f.restart();assert.equal(f.service.jobs().length,published?1:0);
 if(published){const job=f.service.jobs()[0]!;assert.equal(job.state,'interrupted');assert.equal(job.manifestAvailable,false);assert.equal(f.store.binding('asset-job',job.jobId),null);
  // This path launched no worker. Unrelated generation still reaches its normal
  // input preflight rather than inheriting a false lost-worker fence.
  await assert.rejects(f.service.start({} as never),{code:'INPUT'});
 }
 else assert.ok((await readdir(f.service.outputRoot)).includes(basename(staging)));
});

test('accessors/proxies/executable fields are rejected without invoking caller code',()=>{
 let reads=0;const getter=Object.defineProperty({name:'owned'},'path',{enumerable:true,get(){reads++;return 'exports/owned.glb';}});
 for(const value of [getter,new Proxy({name:'owned',path:'exports/owned.glb'},{ownKeys(){reads++;throw Error('never');}}),
  {name:'owned',path:'exports/owned.glb',python:'print(1)'},{name:'owned',path:'exports/owned.glb',url:'https://example.invalid'}])assert.throws(()=>parseAdoptGlbInput(value));
 assert.equal(reads,0);assert.equal(nativeAdoptGlbInput.safeParse({name:'owned',path:'exports/owned.glb',actor:{}}).success,false);
});
