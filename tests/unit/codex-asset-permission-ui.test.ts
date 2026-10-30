/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTextOnlyChatSource } from './chat-source-contract.js';
import {createModelSourceConsent} from '../../apps/desktop/src/toolbox-policy.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import {
  CodexChat, CodexChatApi, CodexHttpError, prepareCodexAction, readCodexState,
  type ChatAction, type ChatActionRecord, type ChatState, type NativeAssetPermission,
} from '../../apps/desktop/src/codex-chat.js';

const TOKEN = 'a'.repeat(64), THREAD = 'opaque/native thread:asset.1';
const assets = (patch: Partial<NativeAssetPermission> = {}): NativeAssetPermission =>
  ({ available: true, sealed: true, granted: false, admissionOpen: false, ...patch });
function state(): ChatState {
  return {
    provider: 'codex', use: 'personal-local', projectPath: 'C:\\Fixture\\Asset UI',
    connecting: false, closing: false, busy: false, actions: [], lastSnapshot: null,
    nativeTools: { configured: true, verified: false }, nativeAssets: assets(),
    snapshot: {
      connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true,
      account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', efforts: ['low'], defaultEffort: 'low', entitlement: 'unverified' }],
      selection: { model: 'fixture', effort: 'low' },
      thread: { threadId: THREAD, sessionId: null, selection: { model: 'fixture', effort: 'low' }, configured: true,
        writeGranted: false, turnId: null, turnStatus: 'idle' },
      operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null,
    },
  };
}
function receipt(input: ChatAction, patch: Partial<ChatActionRecord> = {}): ChatActionRecord {
  return { requestId: input.requestId, connectionId: input.connectionId, action: input.action,
    threadId: 'threadId' in input ? input.threadId : null, turnId: null, model: null, effort: null,
    state: 'acknowledged', errorCode: null, createdAt: '2026-10-13T12:00:00.000Z',
    finishedAt: '2026-10-13T12:00:00.001Z', ...patch };
}
function response(input: ChatAction, observed: ChatState, patch: Partial<ChatActionRecord> = {}): Response {
  const record = receipt(input, patch);
  return Response.json({ record, replayed: false, state: observed },
    { status: record.state === 'acknowledged' ? 200 : record.state === 'rejected' ? 409 : 202 });
}
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await tick(); }
function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(done => { release = done; });
  return { promise, release };
}

/** Private DOM fixture: emit supplies trusted-shaped listener data, while
 * dispatchEvent keeps the real Event's untrusted flag. No native runtime runs. */
class ElementFixture {
  tagName = ''; children: ElementFixture[] = []; value = ''; checked = false; disabled = false;
  hidden = false; open = false; className = ''; type = ''; dataset: Record<string, string> = {};
  scrollHeight = 0; scrollTop = 0; clientHeight = 0;
  private content = ''; private attributes = new Map<string, string>();
  private listeners = new Map<string, ((event: Event) => void)[]>();
  get textContent(): string { return this.content + this.children.map(e => e.textContent).join(''); }
  set textContent(value: string) { this.content = value; this.children = []; }
  append(...children: ElementFixture[]): void { this.children.push(...children); }
  replaceChildren(...children: ElementFixture[]): void { this.content = ''; this.children = children; }
  after(..._children: ElementFixture[]): void {}
  remove(): void {}
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  querySelectorAll(): ElementFixture[] { return []; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  focus(): void {}
  addEventListener(type: string, fn: (event: Event) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]);
  }
  removeEventListener(type: string, fn: (event: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(listener => listener !== fn));
  }
  dispatchEvent(event: Event): void { for (const fn of this.listeners.get(event.type) ?? []) fn(event); }
  emit(type = 'click', patch: Record<string, unknown> = {}) {
    const event = { type, isTrusted: true, button: 0, detail: 1, target: this, currentTarget: this,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...patch };
    this.dispatchEvent(event as unknown as Event); return event;
  }
}
class DocumentFixture extends EventTarget {
  hidden = true; // Suppress scheduled polling in this owned document.
  private elements = new Map<string, ElementFixture>();
  getElementById(id: string): ElementFixture {
    let element = this.elements.get(id);
    if (!element) { element = new ElementFixture(); element.tagName = id === 'codex-composer' ? 'TEXTAREA' : 'BUTTON'; this.elements.set(id, element); }
    return element;
  }
  createElement(tag: string): ElementFixture { const element = new ElementFixture(); element.tagName = tag.toUpperCase(); return element; }
}
async function fixture(t: test.TestContext, initial = state()) {
  const doc = new DocumentFixture(), posts: ChatAction[] = [], reads: string[] = [];
  let observed = structuredClone(initial), failed = false;
  let handler: ((input: ChatAction) => Promise<Response>) | null = null;
  const api = new CodexChatApi(TOKEN, async (path, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + TOKEN);
    if (init?.method === 'GET') {
      assert.equal(path, '/v1/codex/state'); reads.push(String(path));
      if (failed) throw new Error('Fixture read unavailable');
      return Response.json({ state: observed });
    }
    assert.equal(path, '/v1/codex/action', 'Only native action envelopes may be posted');
    const input = JSON.parse(String(init?.body)) as ChatAction; posts.push(input);
    if (handler) return handler(input);
    assert.ok(input.action === 'grant-assets' || input.action === 'revoke-assets');
    observed.nativeAssets = assets({ granted: input.action === 'grant-assets', admissionOpen: input.action === 'grant-assets' });
    const record = receipt(input); observed.actions = [record, ...observed.actions];
    return response(input, observed);
  });
  const chat = new CodexChat(doc as unknown as Document, api);
  t.after(() => chat.stop());
  await chat.start();
  const el = (id: string) => doc.getElementById(id.startsWith('codex-') ? id : 'codex-assets-' + id);
  return {
    chat, doc, posts, reads, el,
    observed: () => structuredClone(observed),
    set(value: ChatState) { observed = structuredClone(value); },
    fail(value: boolean) { failed = value; },
    handler(value: typeof handler) { handler = value; },
    async click(id: string, patch: Record<string, unknown> = {}) {
      el(id).emit('pointerdown', patch); el(id).emit('click', patch); await flush();
    },
    async key(id: string, key: 'Enter' | ' ') {
      const event = el(id).emit('keydown', { key, repeat: false, detail: 0 });
      if (!event.defaultPrevented) el(id).emit('click', { detail: 0 });
      await flush();
    },
  };
}

test('optional nativeAssets is exact JSON data and validates every capability combination', () => {
  const old = state(); delete old.nativeAssets;
  assert.equal(readCodexState(old).nativeAssets, undefined);
  assert.equal(readCodexState({ ...old, nativeAssets: null }).nativeAssets, undefined);
  for (const available of [false, true]) for (const sealed of [false, true])
    for (const granted of [false, true]) for (const admissionOpen of [false, true]) {
      const value = { available, sealed, granted, admissionOpen };
      if (!available && sealed || (granted || admissionOpen) && (!available || !sealed) || admissionOpen && !granted) assert.throws(() => readCodexState({ ...old, nativeAssets: value }), /asset permission/);
      else assert.deepEqual(readCodexState({ ...old, nativeAssets: value }).nativeAssets, value);
    }
  for (const value of [undefined, false, [], {}, { ...assets(), granted: 'true' }, { ...assets(), admissionOpen: 1 },
    { available: true, sealed: true, granted: false }]) assert.throws(() => readCodexState({ ...old, nativeAssets: value }));
  for (const key of ['token', 'credential', 'accessToken', 'actor', 'humanId', 'authority', 'grant', '__proto__']) {
    const value = { ...assets() }; Object.defineProperty(value, key, { value: 'injected', enumerable: true });
    assert.throws(() => readCodexState({ ...old, nativeAssets: value }));
  }
  let invoked = 0;
  const getter = { ...assets() }; Object.defineProperty(getter, 'granted', { enumerable: true, get() { invoked++; return true; } });
  assert.throws(() => readCodexState({ ...old, nativeAssets: getter }));
  const top = { ...old }; Object.defineProperty(top, 'nativeAssets', { enumerable: true, get() { invoked++; return assets(); } });
  assert.throws(() => readCodexState(top)); assert.equal(invoked, 0);
  const inherited = Object.create(assets()); assert.throws(() => readCodexState({ ...old, nativeAssets: inherited }));
  const hidden = { ...assets() }; Object.defineProperty(hidden, 'credential', { value: 'hidden' });
  assert.throws(() => readCodexState({ ...old, nativeAssets: hidden }));
  assert.throws(() => readCodexState({ ...old, nativeAssets: { ...assets(), [Symbol('authority')]: true } }));
});

test('asset envelopes use only UUIDs, action and the exact configured live opaque thread', () => {
  const st = state(), requestId = randomUUID();
  for (const action of ['grant-assets', 'revoke-assets']) {
    assert.deepEqual(prepareCodexAction(st, action, { threadId: THREAD }, requestId),
      { requestId, connectionId: st.snapshot!.connectionId, action, threadId: THREAD });
    for (const key of ['connectionId', 'requestId', 'token', 'credential', 'actor', 'humanId', 'authority', 'projectPath', 'sessionId', 'jobId', 'writeGranted'])
      assert.throws(() => prepareCodexAction(st, action, { threadId: THREAD, [key]: 'injected' }), /exact browser envelope/);
    assert.throws(() => prepareCodexAction(st, action, { threadId: 'stale-thread' }));
    assert.throws(() => prepareCodexAction(st, action, { threadId: THREAD }, 'invalid'));
    let invoked = 0;
    const fields = {}; Object.defineProperty(fields, 'threadId', { enumerable: true, get() { invoked++; return THREAD; } });
    assert.throws(() => prepareCodexAction(st, action, fields)); assert.equal(invoked, 0);
    for (const change of [(s: ChatState) => { delete s.nativeAssets; }, (s: ChatState) => { delete s.nativeAssets; },
      (s: ChatState) => { s.nativeAssets = assets({ available: false }); }, (s: ChatState) => { s.nativeAssets = assets({ sealed: false }); },
      (s: ChatState) => { s.snapshot = null; }, (s: ChatState) => { s.snapshot!.connected = false; },
      (s: ChatState) => { s.snapshot!.ready = false; }, (s: ChatState) => { s.snapshot!.thread!.configured = false; },
      (s: ChatState) => { s.connecting = true; }, (s: ChatState) => { s.closing = true; }]) {
      const bad = structuredClone(st); change(bad); assert.throws(() => prepareCodexAction(bad, action, { threadId: THREAD }));
    }
  }
  const busy = structuredClone(st); busy.busy = true; busy.snapshot!.thread!.turnStatus = 'unknown';
  assert.throws(() => prepareCodexAction(busy, 'grant-assets', { threadId: THREAD }));
  assert.equal(prepareCodexAction(busy, 'revoke-assets', { threadId: THREAD }).action, 'revoke-assets');
});

test('Send allowAssets is a closed optional boolean, never model metadata or a persistent grant action',()=>{
  const st=state(),fields={threadId:THREAD,text:'Human modeling request'};
  const ordinary=prepareCodexAction(st,'turn-start',fields);assert.ok(ordinary.action==='turn-start');assert.equal(ordinary.allowAssets,undefined);
  for(const allowAssets of [false,true]){const input=prepareCodexAction(st,'turn-start',{...fields,allowAssets});assert.ok(input.action==='turn-start');assert.equal(input.allowAssets,allowAssets);}
  for(const allowAssets of [undefined,null,1,'true',{},()=>true])assert.throws(()=>prepareCodexAction(st,'turn-start',{...fields,allowAssets}));
  for(const action of ['connect','select','thread-start','grant-assets'])assert.throws(()=>prepareCodexAction(st,action,{...fields,allowAssets:true}));
  const unavailable=state();delete unavailable.nativeAssets;assert.throws(()=>prepareCodexAction(unavailable,'turn-start',{...fields,allowAssets:true}));
});

test('Send workspace editing is a closed optional boolean confined to the turn-start envelope',()=>{
  const st=state(),fields={threadId:THREAD,text:'Human project request'};
  const ordinary=prepareCodexAction(st,'turn-start',fields);assert.ok(ordinary.action==='turn-start');assert.equal(ordinary.allowWorkspaceWrites,undefined);
  for(const allowWorkspaceWrites of [false,true]){
    const input=prepareCodexAction(st,'turn-start',{...fields,allowWorkspaceWrites});assert.ok(input.action==='turn-start');assert.equal(input.allowWorkspaceWrites,allowWorkspaceWrites);
  }
  for(const value of [undefined,null,1,'true',{},()=>true])assert.throws(()=>prepareCodexAction(st,'turn-start',{...fields,allowWorkspaceWrites:value}));
  for(const action of ['connect','select','thread-start','grant-writes','grant-assets'])assert.throws(()=>prepareCodexAction(st,action,{...fields,allowWorkspaceWrites:true}));
  const combined=prepareCodexAction(st,'turn-start',{...fields,allowWorkspaceWrites:true,allowAssets:true});
  assert.ok(combined.action==='turn-start');assert.equal(combined.allowWorkspaceWrites,true);assert.equal(combined.allowAssets,true);
});

test('actual composer Human Send requests automatic assets without Advanced and terminal state permits tabs',async t=>{
  const f=await fixture(t);f.el('codex-composer').value='Build an owned synthetic asset';assert.equal(f.posts.length,0);
  assert.equal(f.observed().nativeAssets?.granted,false);
  f.handler(async input=>{
    assert.ok(input.action==='turn-start');assert.equal(input.allowAssets,true);assert.equal(input.allowWorkspaceWrites,true);
    const next=f.observed();next.snapshot!.thread!.turnId='sent-turn';next.snapshot!.thread!.turnStatus='inProgress';next.nativeAssets=assets({granted:true,admissionOpen:true});f.set(next);
    return response(input,next,{turnId:'sent-turn'});
  });
  f.el('codex-compose').emit('submit');await flush();
  assert.equal(f.posts.length,1);assert.deepEqual(f.posts.map(p=>p.action),['turn-start']);
  assert.ok(f.posts[0]!.action==='turn-start');assert.equal(f.posts[0]!.allowAssets,true);assert.equal(f.observed().snapshot!.thread!.writeGranted,false);
  const ended=f.observed();ended.snapshot!.thread!.turnStatus='completed';ended.nativeAssets=assets();f.set(ended);await f.chat.refresh();
  assert.equal((f.chat as unknown as {tabBlockReason():string|null}).tabBlockReason(),null,'No manual revoke is required after the exact automatic intent ends.');
});

test('composer Send omits automatic assets when the host has no managed capability',async t=>{
  const initial=state();delete initial.nativeAssets;const f=await fixture(t,initial);f.el('codex-composer').value='Ordinary human message';
  f.handler(async input=>{assert.ok(input.action==='turn-start');assert.equal(Object.hasOwn(input,'allowAssets'),false);assert.equal(input.allowWorkspaceWrites,true);return response(input,f.observed());});
  f.el('codex-compose').emit('submit');await flush();assert.equal(f.posts.length,1);
});

test('actual Codex composer binds Models consent to one typed Send and later Sends remain original-only',async t=>{
  const initial=state(),threadId='models.thread:original';initial.snapshot!.thread!.threadId=threadId;
  initial.nativeThreads=[{provider:'codex',projectPath:initial.projectPath,threadId,sessionId:null,selection:{model:'fixture',effort:'low'}}];assert.doesNotThrow(()=>readCodexState(initial));
  const f=await fixture(t,initial),storage=new Map<string,string>();f.doc.getElementById('workspace-chat-tabs').setAttribute('role','tablist');
  await f.chat.enableChatTabs({storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);}}});
  f.el('codex-composer').value='Use a reviewed external model for this synthetic brief';f.el('codex-composer').emit('input');
  const consent=createModelSourceConsent({context:()=>f.chat.modelSourceContext(),session:()=>'studio-original'});f.chat.setModelSourceConsent(consent.port);
  assert.equal(consent.arm(true),true);consent.confirm(true);
  f.handler(async input=>{assert.equal(input.action,'turn-start');return response(input,f.observed());});
  f.el('codex-compose').emit('submit');await flush();assert.equal(f.posts.length,1);
  assert.ok(f.posts[0]!.action==='turn-start');assert.deepEqual(f.posts[0]!.modelSource,{sessionId:'studio-original'});assert.equal(consent.pending(),false);
  f.el('codex-composer').value='A separate unrelated brief';f.el('codex-composer').emit('input');f.el('codex-compose').emit('submit');await flush();
  assert.equal(f.posts.length,2);assert.equal(Object.hasOwn(f.posts[1]!,'modelSource'),false);
});

test('actual Codex held context preparation refuses Models draft ABA without HTTP or losing the original text',async t=>{
  const initial=state(),threadId='models.thread:original';initial.snapshot!.thread!.threadId=threadId;
  initial.nativeThreads=[{provider:'codex',projectPath:initial.projectPath,threadId,sessionId:null,selection:{model:'fixture',effort:'low'}}];assert.doesNotThrow(()=>readCodexState(initial));
  const f=await fixture(t,initial),storage=new Map<string,string>();f.doc.getElementById('workspace-chat-tabs').setAttribute('role','tablist');
  await f.chat.enableChatTabs({storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);}}});
  const draft='Original Models brief';f.el('codex-composer').value=draft;f.el('codex-composer').emit('input');
  const consent=createModelSourceConsent({context:()=>f.chat.modelSourceContext(),session:()=>'studio-original'});f.chat.setModelSourceConsent(consent.port);
  assert.equal(consent.arm(true),true);consent.confirm(true);const gate=deferred<string>();f.chat.setBeforeMessageSubmit(()=>gate.promise);
  f.el('codex-compose').emit('submit');await flush();f.el('codex-composer').value='Replacement brief';f.el('codex-composer').emit('input');
  f.el('codex-composer').value=draft;f.el('codex-composer').emit('input');gate.release(draft);await flush();
  assert.equal(f.posts.length,0);assert.equal(f.el('codex-composer').value,draft);assert.match(f.el('codex-notice').textContent,/Models message context changed/);
  assert.equal(consent.port.capture(),null);
});

test('actual Codex first-Send draft setup retains exact Models ownership through acknowledged native binding',async t=>{
  const initial=state(),threadId='models.first-send:original';initial.snapshot!.thread=null;initial.nativeThreads=[];initial.nativeAssets=assets({sealed:false});assert.doesNotThrow(()=>readCodexState(initial));
  const f=await fixture(t,initial),storage=new Map<string,string>();f.doc.getElementById('workspace-chat-tabs').setAttribute('role','tablist');
  await f.chat.enableChatTabs({storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);}}});
  f.el('codex-model').value='fixture';f.el('codex-effort').value='low';f.el('codex-composer').value='First typed Models brief';f.el('codex-composer').emit('input');
  const original=f.chat.conversationSource()!;const consent=createModelSourceConsent({context:()=>f.chat.modelSourceContext(),session:()=>'studio-original'});f.chat.setModelSourceConsent(consent.port);
  assert.equal(consent.arm(true),true);consent.confirm(true);
  f.handler(async input=>{
    const next=f.observed();
    if(input.action==='select'){assert.equal(Object.hasOwn(input,'modelSource'),false);return response(input,next);}
    if(input.action==='thread-start'){
      assert.equal(Object.hasOwn(input,'modelSource'),false);next.snapshot!.thread={...state().snapshot!.thread!,threadId};next.nativeAssets=assets();
      next.nativeThreads=[{provider:'codex',projectPath:next.projectPath,threadId,sessionId:null,selection:{model:'fixture',effort:'low'}}];assert.doesNotThrow(()=>readCodexState(next));f.set(next);return response(input,next,{threadId});
    }
    assert.ok(input.action==='turn-start');assert.deepEqual(input.modelSource,{sessionId:'studio-original'});return response(input,next);
  });
  f.el('codex-compose').emit('submit');await flush();
  assert.deepEqual(f.posts.map(input=>input.action),['select','thread-start','turn-start'],f.el('codex-notice').textContent);
  assert.deepEqual(f.chat.conversationSource(),original);assert.equal(f.chat.currentStateView().nativeBoundToActiveChat,true);
});

test('Models is a closed initial-Send field and its final pre-dispatch check cannot send after cancellation',async()=>{
  const st=state(),fields={threadId:THREAD,text:'Synthetic Models message',modelSource:{sessionId:'studio-original'}};
  const input=prepareCodexAction(st,'turn-start',fields);assert.ok(input.action==='turn-start');assert.deepEqual(input.modelSource,fields.modelSource);
  for(const value of [true,null,{}, {sessionId:'studio-original',actor:'human'}, {sessionId:'studio-original\n'}])assert.throws(()=>prepareCodexAction(st,'turn-start',{...fields,modelSource:value}));
  for(const action of ['select','turn-steer','thread-start','grant-assets'])assert.throws(()=>prepareCodexAction(st,action,fields));
  let posts=0;const api=new CodexChatApi(TOKEN,async()=>{posts++;throw Error('No HTTP expected');});
  await assert.rejects(api.action(input,undefined,()=>false),error=>error instanceof CodexHttpError&&!error.unknown);assert.equal(posts,0);
});

test('Human Send opens its exact new chat before requesting one-shot assets on that Send only',async t=>{
  const initial=state();initial.snapshot!.thread=null;initial.nativeAssets=assets({sealed:false});
  const f=await fixture(t,initial);f.el('codex-model').value='fixture';f.el('codex-effort').value='low';f.el('codex-composer').value='Human new-chat build';
  f.handler(async input=>{
    const next=f.observed();
    if(input.action==='thread-start'){
      assert.equal(Object.hasOwn(input,'allowAssets'),false);assert.equal(Object.hasOwn(input,'allowWorkspaceWrites'),false);next.snapshot!.thread=state().snapshot!.thread!;next.nativeAssets=assets();f.set(next);
      return response(input,next,{threadId:THREAD});
    }
    assert.ok(input.action==='turn-start');assert.equal(input.allowAssets,true);assert.equal(input.allowWorkspaceWrites,true);assert.equal(input.threadId,THREAD);
    return response(input,next,{threadId:THREAD});
  });
  assert.equal(f.posts.length,0);f.el('codex-compose').emit('submit');await flush();
  assert.deepEqual(f.posts.map(p=>p.action),['thread-start','turn-start']);
});

test('conversation tasks are closed metadata and Stop carries only the exact human task identity',()=>{
  const initial=state(),taskId=randomUUID();initial.chatTasks=[{taskId,threadId:THREAD,sessionId:null,connectionId:initial.snapshot!.connectionId,state:'awaiting_verification',round:0,reason:null,reportDigest:null}];
  assert.equal(readCodexState(initial).chatTasks![0]!.taskId,taskId);
  const requestId=randomUUID();assert.deepEqual(prepareCodexAction(initial,'task-stop',{threadId:THREAD,taskId},requestId),{requestId,connectionId:initial.snapshot!.connectionId,action:'task-stop',threadId:THREAD,taskId});
});

test('task state and Stop reject foreign identities, getters and model-supplied continuation authority',()=>{
  const initial=state(),taskId=randomUUID();initial.chatTasks=[{taskId,threadId:THREAD,sessionId:null,connectionId:initial.snapshot!.connectionId,state:'awaiting_verification',round:0,reason:null,reportDigest:null}];
  for(const patch of [{taskId:randomUUID()},{threadId:'foreign'},{taskId},{taskId,threadId:THREAD,continuation:{}},{taskId,threadId:THREAD,initiatedBy:'human'}]){
    if(Object.keys(patch).length===1&&patch.taskId===taskId)continue;
    assert.throws(()=>prepareCodexAction(initial,'task-stop',patch));
  }
  for(const patch of [{state:'complete'},{round:2},{reportDigest:'a'.repeat(64)+'\n'},{origin:{}},{sessionId:undefined}])assert.throws(()=>readCodexState({...initial,chatTasks:[{...initial.chatTasks![0],...patch}]}));
  let called=0;const row={...initial.chatTasks[0]};Object.defineProperty(row,'state',{get(){called++;return'working';},enumerable:true});assert.throws(()=>readCodexState({...initial,chatTasks:[row]}));assert.equal(called,0);
});

test('fresh-task ACK lineage preserves the exact conversation and composer message across internal client rotation',async t=>{
  const initial=state(),threadId='rotation.thread:exact',old=initial.snapshot!.connectionId,nextId=randomUUID();initial.snapshot!.thread!.threadId=threadId;
  initial.nativeThreads=[{provider:'codex',projectPath:initial.projectPath,threadId,sessionId:null,selection:{model:'fixture',effort:'low'}}];
  const f=await fixture(t,initial);f.el('codex-composer').value='Keep this original human message';
  f.handler(async input=>{assert.equal(input.action,'turn-start');const next=f.observed();next.snapshot!.connectionId=nextId;next.snapshot!.thread!.turnStatus='inProgress';next.snapshot!.thread!.turnId='new-task-turn';
    const record=receipt(input,{nextConnectionId:nextId,turnId:'new-task-turn'});next.actions=[record];f.set(next);return response(input,next,{nextConnectionId:nextId,turnId:'new-task-turn'});});
  f.el('codex-compose').emit('submit');await flush();assert.equal(f.posts.length,1);assert.equal(f.posts[0]!.connectionId,old);
  assert.equal(f.chat.currentStateView().state!.snapshot!.connectionId,nextId);assert.ok(f.el('codex-messages').textContent.includes('Keep this original human message'));assert.ok(f.el('codex-messages').textContent.includes('Accepted'));
});

test('automatic client rotation cannot launder a foreign thread/session or another action receipt',async()=>{
  const initial=state(),threadId='rotation.thread:exact';initial.snapshot!.thread!.threadId=threadId;initial.nativeThreads=[{provider:'codex',projectPath:initial.projectPath,threadId,sessionId:null,selection:{model:'fixture',effort:'low'}}];
  const input=prepareCodexAction(initial,'turn-start',{threadId,text:'Human Send'}),next=structuredClone(initial),nextId=randomUUID();next.snapshot!.connectionId=nextId;
  for(const patch of [{threadId:'foreign'},{nextConnectionId:initial.snapshot!.connectionId},{action:'task-stop'}] satisfies Partial<ChatActionRecord>[]){
    const api=new CodexChatApi(TOKEN,async()=>response(input,next,{nextConnectionId:nextId,...patch}));await assert.rejects(api.action(input));}
  const foreign=structuredClone(next);foreign.snapshot!.thread!.sessionId='changed-session';const api=new CodexChatApi(TOKEN,async()=>response(input,foreign,{nextConnectionId:nextId}));await assert.rejects(api.action(input),/conversation/);
});

test('Stop remains available for owned verification after the native reply completed',async t=>{
  const initial=state(),taskId=randomUUID();initial.snapshot!.thread!.turnStatus='completed';initial.snapshot!.thread!.turnId='completed-parent';initial.chatTasks=[{taskId,threadId:THREAD,sessionId:null,connectionId:initial.snapshot!.connectionId,state:'awaiting_verification',round:0,reason:null,reportDigest:null}];
  const f=await fixture(t,initial);assert.equal(f.el('codex-interrupt').disabled,false);assert.equal(f.el('codex-interrupt').textContent,'Stop task');
  f.handler(async input=>{assert.equal(input.action,'task-stop');assert.ok('taskId'in input);assert.equal(input.taskId,taskId);const next=f.observed();next.chatTasks![0]!.state='cancelled';f.set(next);return response(input,next);});
  await f.click('codex-interrupt');assert.deepEqual(f.posts.map(input=>input.action),['task-stop']);assert.equal(f.el('codex-interrupt').disabled,true);
});

test('opening an exact retained task focuses its original approval UI without select, resume or a new model turn',async t=>{
  const initial=state(),threadId='retained.thread:exact',taskId=randomUUID(),owned=state().snapshot!,originalId=owned.connectionId;
  initial.snapshot!.thread=null;initial.nativeAssets=assets({sealed:false});initial.nativeThreads=[{provider:'codex',projectPath:initial.projectPath,threadId,sessionId:null,selection:{model:'fixture',effort:'low'}}];
  initial.chatTasks=[{taskId,threadId,sessionId:null,connectionId:originalId,state:'repairing',round:1,reason:null,reportDigest:null,retained:true}];
  owned.thread!.threadId=threadId;owned.thread!.turnId='original.repair';owned.thread!.turnStatus='inProgress';owned.thread!.writeGranted=true;
  owned.approvals=[{handle:'original-approval',connectionId:originalId,serverRequestId:'approval:1',method:'item/commandExecution/requestApproval',threadId,turnId:'original.repair',itemId:'command:1',reason:null,command:'original-repair-command',cwd:initial.projectPath,changes:null,canAccept:true,expiresAt:Date.now()+60000}];
  const f=await fixture(t,initial);f.handler(async input=>{assert.equal(input.action,'task-focus');assert.ok('taskId'in input);assert.equal(input.taskId,taskId);
    const next=f.observed();next.snapshot=owned;next.nativeAssets=assets({granted:true,admissionOpen:true});const record=receipt(input,{nextConnectionId:originalId});next.actions=[record];f.set(next);return response(input,next,{nextConnectionId:originalId});});
  f.doc.getElementById('workspace-chat-tabs').setAttribute('role','tablist');
  const saved=new Map<string,string>();
  await f.chat.enableChatTabs({storage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>{saved.set(key,value);}}});
  const opened=await f.chat.openSavedChat(threadId);
  assert.equal(opened,true);assert.deepEqual(f.posts.map(input=>input.action),['task-focus']);assert.ok(f.el('codex-approvals').textContent.includes('original-repair-command'));
  assert.equal(f.chat.currentStateView().nativeBoundToActiveChat,true);
  assert.equal(f.chat.currentStateView().conversation!.threadId,threadId);
  const control=prepareCodexAction(f.chat.currentStateView().state!,'approval',{threadId,turnId:'original.repair',handle:'original-approval',decision:'accept'});assert.equal(control.connectionId,originalId);
});

test('asset receipts accept both enum values and reject wrong scope, authority and getters', async () => {
  const st = state();
  for (const action of ['grant-assets', 'revoke-assets']) {
    const input = prepareCodexAction(st, action, { threadId: THREAD }), record = receipt(input);
    assert.equal(readCodexState({ ...st, actions: [record] }).actions[0]!.action, action);
    for (const patch of [{ action: 'assets-start' }, { connectionId: null }, { threadId: null }, { actor: 'human' }, { authority: true }, { credential: 'secret' }])
      assert.throws(() => readCodexState({ ...st, actions: [{ ...record, ...patch }] }));
    let invoked = 0;
    const getter = { ...record }; Object.defineProperty(getter, 'action', { enumerable: true, get() { invoked++; return action; } });
    assert.throws(() => readCodexState({ ...st, actions: [getter] })); assert.equal(invoked, 0);
    for (const patch of [{ threadId: 'other-thread' }, { connectionId: randomUUID() }, { requestId: randomUUID() }]) {
      const api = new CodexChatApi(TOKEN, async () => response(input, st, patch));
      await assert.rejects(api.action(input), (error: unknown) => error instanceof CodexHttpError && error.unknown);
    }
  }
});

test('read-only -> explicit grant -> explicit revoke preserves draft and native file permissions', async t => {
  const f = await fixture(t), draft = 'Unsent 🧩 draft\nKeep trailing spaces.  ';
  f.el('codex-composer').value = draft; f.el('codex-confirm-check').checked = true;
  assert.equal(f.posts.length, 0); assert.equal(f.el('grant').disabled, false);
  assert.match(f.el('status').textContent, /not granted.*admission is closed/);
  await f.click('grant');
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.action, 'grant-assets');
  assert.equal(f.observed().snapshot!.thread!.writeGranted, false);
  assert.match(f.el('status').textContent, /granted.*admission is open/); assert.equal(f.el('grant').disabled, true);
  assert.equal(f.el('codex-confirm').open, false); assert.equal(f.el('codex-confirm-check').checked, true);
  assert.equal(f.el('codex-composer').value, draft);
  await f.key('revoke', 'Enter');
  assert.deepEqual(f.posts.map(p => p.action), ['grant-assets', 'revoke-assets']);
  assert.equal(f.observed().snapshot!.thread!.writeGranted, false); assert.equal(f.el('codex-composer').value, draft);
  const writes = f.observed(); writes.snapshot!.thread!.writeGranted = true; f.set(writes); await f.chat.refresh();
  assert.match(f.el('status').textContent, /not granted.*closed/);
  await f.key('grant', ' '); await f.click('revoke');
  assert.equal(f.observed().snapshot!.thread!.writeGranted, true, 'asset revoke cannot revoke file writes');
  assert.deepEqual(f.posts.map(p => p.action), ['grant-assets', 'revoke-assets', 'grant-assets', 'revoke-assets']);
  for (const post of f.posts) assert.deepEqual(Object.keys(post).sort(), ['action', 'connectionId', 'requestId', 'threadId']);
});

test('unsupported, disconnected, unsealed, uncertain and unknown states cannot grant even with DOM tampering', async t => {
  const f = await fixture(t);
  for (const change of [(s: ChatState) => { delete s.nativeAssets; }, (s: ChatState) => { delete s.nativeAssets; },
    (s: ChatState) => { s.nativeAssets = assets({ available: false }); }, (s: ChatState) => { s.nativeAssets = assets({ sealed: false }); },
    (s: ChatState) => { s.snapshot!.connected = false; }, (s: ChatState) => { s.snapshot!.ready = false; },
    (s: ChatState) => { s.snapshot!.thread = null; }, (s: ChatState) => { s.snapshot!.thread!.configured = false; },
    (s: ChatState) => { s.busy = true; }, (s: ChatState) => { s.connecting = true; },
    (s: ChatState) => { s.closing = true; }, (s: ChatState) => { s.displayLimited = true; },
    (s: ChatState) => { s.snapshot!.thread!.turnStatus = 'unknown'; }]) {
    const bad = state(); change(bad); f.set(bad); await f.chat.refresh(); assert.equal(f.el('grant').disabled, true);
    f.el('grant').disabled = false; await f.click('grant'); assert.equal(f.posts.length, 0);
  }
  f.set(state()); await f.chat.refresh(); f.fail(true); await f.chat.refresh();
  assert.match(f.el('status').textContent, /uncertain/); assert.equal(f.el('grant').disabled, true);
  f.el('grant').disabled = false; await f.click('grant'); assert.equal(f.posts.length, 0);
  f.fail(false); f.set({ ...state(), nativeAssets: { ...assets(), actor: 'injected' } } as ChatState);
  await f.chat.refresh(); assert.equal(f.el('grant').disabled, true); assert.equal(f.posts.length, 0);
});

test('only trusted unmodified button activation is accepted; native keyboard does not double dispatch', async t => {
  const f = await fixture(t);
  f.el('grant').dispatchEvent(new Event('click', { cancelable: true })); await flush();
  for (const patch of [{ isTrusted: false }, { isTrusted: 1 }, { button: 1 }, { button: 2 },
    { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { defaultPrevented: true }]) await f.click('grant', patch);
  assert.equal(f.posts.length, 0);
  for (const patch of [{ isTrusted: false }, { repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
    const event = f.el('grant').emit('keydown', { key: 'Enter', ...patch }); assert.equal(event.defaultPrevented, true);
  }
  assert.equal(f.posts.length, 0);
  await f.key('grant', 'Enter'); assert.equal(f.posts.length, 1);
  f.el('revoke').dispatchEvent(new Event('click')); await flush(); assert.equal(f.posts.length, 1);
  await f.key('revoke', ' '); assert.equal(f.posts.length, 2);
});

test('pointer/keyboard scope becomes stale on project, thread, session, configuration and reconnect changes', async t => {
  const f = await fixture(t), draft = 'Keep across context changes'; f.el('codex-composer').value = draft;
  for (const change of [(s: ChatState) => { s.projectPath += '\\other'; }, (s: ChatState) => { s.snapshot!.thread!.threadId = 'other-opaque'; },
    (s: ChatState) => { s.snapshot!.thread!.sessionId = 'other-session'; }, (s: ChatState) => { s.snapshot!.connectionId = randomUUID(); }]) {
    f.set(state()); await f.chat.refresh(); f.el('grant').emit('pointerdown');
    const next = f.observed(); change(next); f.set(next); await f.chat.refresh();
    f.el('grant').emit('click'); await flush(); assert.equal(f.posts.length, 0);
    await f.click('grant'); assert.equal(f.posts.at(-1)!.connectionId, next.snapshot!.connectionId);
    assert.equal((f.posts.at(-1)! as { threadId: string }).threadId, next.snapshot!.thread!.threadId);
    f.posts.length = 0;
  }
  f.set(state()); await f.chat.refresh(); f.el('grant').emit('keydown', { key: 'Enter' });
  const offline = f.observed(); offline.snapshot!.connected = false; f.set(offline); await f.chat.refresh();
  offline.snapshot!.connected = true; f.set(offline); await f.chat.refresh();
  f.el('grant').emit('click', { detail: 0 }); await flush(); assert.equal(f.posts.length, 0);
  f.el('grant').emit('pointerdown'); offline.snapshot!.thread!.configured = false; f.set(offline); await f.chat.refresh();
  offline.snapshot!.thread!.configured = true; f.set(offline); await f.chat.refresh();
  f.el('grant').emit('click'); await flush(); assert.equal(f.posts.length, 0);
  f.el('grant').emit('pointerdown'); f.chat.stop(); f.chat.resume(); await flush();
  f.el('grant').emit('click'); await flush(); assert.equal(f.posts.length, 0);
  assert.equal(f.el('codex-composer').value, draft);
});

test('shared oneflight blocks grant during a turn request but keeps revoke available and deduplicated', async t => {
  const initial = state(); initial.nativeAssets = assets({ granted: true, admissionOpen: true });
  const f = await fixture(t, initial), turn = deferred<Response>(), revoke = deferred<Response>();
  let turnInput!: ChatAction, revokeInput!: ChatAction;
  f.handler(async input => {
    if (input.action === 'turn-start') { turnInput = input; return turn.promise; }
    assert.equal(input.action, 'revoke-assets'); revokeInput = input; return revoke.promise;
  });
  f.el('codex-composer').value = 'Explicit fixture turn'; f.el('codex-compose').emit('submit'); await flush();
  const busy = f.observed(); busy.busy = true; busy.snapshot!.thread!.turnStatus = 'inProgress';
  busy.snapshot!.thread!.turnId = 'fixture-turn'; f.set(busy); await f.chat.refresh();
  f.el('codex-composer').value = 'Unsent next draft';
  assert.equal(f.el('grant').disabled, true); assert.equal(f.el('revoke').disabled, false);
  await f.click('grant'); assert.equal(f.posts.length, 1);
  await f.click('revoke'); await f.click('revoke');
  assert.deepEqual(f.posts.map(p => p.action), ['turn-start', 'revoke-assets']); assert.equal(f.el('revoke').disabled, true);
  const revoked = structuredClone(busy); revoked.nativeAssets = assets(); f.set(revoked);
  revoke.release(response(revokeInput, revoked)); await flush();
  turn.release(response(turnInput, busy)); await flush();
  assert.match(f.el('status').textContent, /not granted.*closed/);
  assert.equal(f.el('codex-composer').value, 'Unsent next draft');
});

test('held asset grant is single-flight and cannot restore permission after revoke or context change', async t => {
  const f = await fixture(t), held = deferred<Response>(); let input!: ChatAction;
  const before = f.observed(); f.handler(async action => {
    if (action.action === 'grant-assets') { input = action; return held.promise; }
    assert.equal(action.action, 'revoke-assets'); return response(action, f.observed());
  });
  await f.click('grant'); await f.click('grant'); assert.equal(f.posts.length, 1);
  assert.equal(f.el('codex-submit').disabled, true); assert.equal(f.el('revoke').disabled, false);
  await f.click('revoke'); assert.deepEqual(f.posts.map(p => p.action), ['grant-assets', 'revoke-assets']);
  const oldGranted = structuredClone(before); oldGranted.nativeAssets = assets({ granted: true, admissionOpen: true });
  held.release(response(input, oldGranted)); await flush();
  assert.match(f.el('status').textContent, /not granted.*closed/);
  const heldAgain = deferred<Response>(); f.handler(async action => { input = action; return heldAgain.promise; });
  await f.click('grant'); const next = state(); next.snapshot!.thread!.threadId = 'new-thread'; f.set(next); await f.chat.refresh();
  heldAgain.release(response(input, oldGranted)); await flush();
  assert.match(f.el('codex-scope').textContent, /new-thread/); assert.match(f.el('status').textContent, /not granted.*closed/);
});

test('lost or unknown acknowledgement retains request ID, blocks grant and never retries or starts jobs', async t => {
  const f = await fixture(t), draft = 'Never consume on permission action'; f.el('codex-composer').value = draft;
  f.handler(async () => { throw new Error('Fixture lost acknowledgement'); });
  await f.click('grant');
  assert.equal(f.posts.length, 1); assert.equal(f.el('grant').disabled, true); assert.equal(f.el('revoke').disabled, false);
  assert.match(f.el('codex-unknown-requests').textContent, new RegExp(f.posts[0]!.requestId));
  await f.chat.refresh(); await f.click('grant'); assert.equal(f.posts.length, 1);
  f.handler(async input => response(input, f.observed(), { state: 'unknown', finishedAt: null }));
  await f.click('revoke'); assert.deepEqual(f.posts.map(p => p.action), ['grant-assets', 'revoke-assets']);
  assert.equal(f.el('codex-composer').value, draft); assert.match(f.el('status').textContent, /uncertain/);
});

test('settings markup is an accessible compact group and permission source exposes no asset-job actions', async () => {
  const [html, css, source] = await Promise.all([
    readFile(resolve('apps/desktop/public/studio.html'), 'utf8'),
    readFile(resolve('apps/desktop/public/studio.css'), 'utf8'),
    readFile(resolve('apps/desktop/src/codex-chat.ts'), 'utf8'),
  ]);
  const group = html.match(/<fieldset class="codex-asset-permission"[\s\S]*?<\/fieldset>/)?.[0]; assert.ok(group);
  assert.match(group, /<legend>Asset jobs<\/legend>/); assert.match(group, /role="status" aria-live="polite"/);
  assert.match(group, /aria-describedby="codex-assets-help"/);
  assert.match(group, /type="button" class="secondary" disabled>Allow asset jobs/);
  assert.match(group, /type="button" class="secondary" disabled>Revoke asset jobs/);
  assert.doesNotMatch(group, /checkbox|badge|eyebrow|<img/);
  assert.ok(html.indexOf(group) > html.indexOf('id="native-conversation-settings"'));
  assert.ok(html.indexOf(group) < html.indexOf('id="codex-profile"'));
  assert.match(css, /\.codex-asset-permission button\{[^}]*min-height:44px/);
  assertTextOnlyChatSource(source);
});

test('owned Edge fixture: real trusted click/keyboard, inert scripted click, draft and responsive group', {
  skip: !process.env.ARCANE_ASSET_UI_BROWSER_EXE, timeout: 30000,
}, async t => {
  const { chromium } = await import('playwright-core');
  const { createServer } = await import('node:http');
  const profile = process.env.ARCANE_ASSET_UI_PROFILE_DIR ?? await mkdtemp(join(tmpdir(), 'arcane-asset-permission-edge-'));
  const browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.ARCANE_ASSET_UI_BROWSER_EXE!,
    headless: true, args: ['--disable-gpu'], viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  t.after(() => browser.close());
  const build = process.env.ARCANE_UI_BUILD_DIR; assert.ok(build, 'Owned private build must be explicit');
  const html = (await readFile(resolve('apps/desktop/public/studio.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const css = await readFile(resolve('apps/desktop/public/studio.css'), 'utf8');
  const js = await readFile(resolve(build, 'apps/desktop/src/codex-chat.js'), 'utf8');
  const shellJs = await readFile(resolve(build, 'apps/desktop/src/workspace-shell.js'), 'utf8');
  const setupJs = await readFile(resolve(build, 'apps/desktop/src/provider-setup.js'), 'utf8');
  const server = createServer((request, reply) => {
    const path = request.url?.split('?')[0];
    const body = path === '/fixture' ? html : path === '/studio.css' ? css : path === '/codex-chat.js' ? js : path === '/workspace-shell.js' ? shellJs : path==='/provider-setup.js'?setupJs:null;
    reply.writeHead(body === null ? 404 : 200, { 'Content-Type': path === '/fixture' ? 'text/html' : path?.endsWith('.css') ? 'text/css' : 'text/javascript' });
    reply.end(body ?? '');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const page = await browser.newPage(), posts: ChatAction[] = [], errors: string[] = [];
  page.setDefaultTimeout(6000);
  t.diagnostic('Synthetic native state only; Edge ' + browser.browser()!.version() + '; owned profile ' + profile);
  let observed = state();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/v1/codex/**', async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      assert.ok(request.url().endsWith('/v1/codex/state'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: observed }) }); return;
    }
    assert.ok(request.url().endsWith('/v1/codex/action'));
    const input = request.postDataJSON() as ChatAction; posts.push(input);
    assert.ok(input.action === 'grant-assets' || input.action === 'revoke-assets' || input.action==='task-stop');
    if(input.action==='task-stop'){assert.equal(input.taskId,observed.chatTasks![0]!.taskId);assert.equal(input.threadId,observed.snapshot!.thread!.threadId);observed.chatTasks![0]!.state='cancelled';}
    else observed = { ...observed, nativeAssets: assets({ granted: input.action === 'grant-assets', admissionOpen: input.action === 'grant-assets' }) };
    const record = receipt(input); observed.actions = [record, ...observed.actions];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ record, replayed: false, state: observed }) });
  });
  await page.goto('http://127.0.0.1:' + address.port + '/fixture');
  await page.evaluate(async token => {
    const modulePath: string = '/codex-chat.js';
    const module = await import(modulePath);
    const shellPath: string = '/workspace-shell.js';
    const { startWorkspaceShell } = await import(shellPath);
    const setupPath:string='/provider-setup.js';const {startProviderSetup}=await import(setupPath);
    const shell = startWorkspaceShell(document);
    const chat = new module.CodexChat(document, new module.CodexChatApi(token));
    const setup=startProviderSetup(document,{chat});
    await chat.start();
    (window as unknown as { stopFixture: () => void;refreshFixture:()=>Promise<void> }).stopFixture = () => { chat.stop();setup.cleanup(); shell.cleanup(); };
    (window as unknown as {refreshFixture:()=>Promise<void>}).refreshFixture=()=>chat.refresh();
  }, TOKEN);
  assert.equal(await page.locator('#settings-drawer').isVisible(), false);
  await page.locator('#codex-composer').fill('Owned browser draft 🧩');
  await page.locator('#app-sidebar [data-workspace-target="workspace-settings"]').click();
  assert.equal(await page.locator('#settings-drawer').evaluate(dialog => dialog.matches(':modal')), true);
  await page.locator('[data-settings-section-target="settings-advanced"]').click();
  await page.locator('#settings-advanced > details').filter({ has: page.locator('#native-conversation-settings') }).locator(':scope > summary').click();
  assert.equal(await page.locator('#settings-advanced').isVisible(), true);
  assert.equal(await page.locator('#workspace-settings').isVisible(), false);
  const grant = page.locator('#codex-assets-grant'), revoke = page.locator('#codex-assets-revoke');
  await page.waitForFunction(() => !(document.getElementById('codex-assets-grant') as HTMLButtonElement).disabled);
  assert.equal(posts.length, 0);
  await grant.evaluate(button => (button as HTMLButtonElement).click());
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done()))); assert.equal(posts.length, 0);
  await grant.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('codex-assets-status')?.textContent?.includes('admission is open'));
  assert.deepEqual(posts.map(p => p.action), ['grant-assets']);
  assert.equal(await page.locator('#codex-composer').inputValue(), 'Owned browser draft 🧩');
  assert.equal(await page.locator('#codex-confirm').evaluate(dialog => (dialog as HTMLDialogElement).open), false);
  await revoke.focus(); await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('codex-assets-status')?.textContent?.includes('admission is closed'));
  assert.deepEqual(posts.map(p => p.action), ['grant-assets', 'revoke-assets']);
  await grant.click();
  await page.waitForFunction(() => document.getElementById('codex-assets-status')?.textContent?.includes('admission is open'));
  assert.deepEqual(posts.map(p => p.action), ['grant-assets', 'revoke-assets', 'grant-assets']);
  assert.equal(observed.snapshot!.thread!.writeGranted, false);
  if (process.env.ARCANE_ASSET_UI_SCREENSHOT) await page.locator('.codex-asset-permission').screenshot({ path: process.env.ARCANE_ASSET_UI_SCREENSHOT + '-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator('.codex-asset-permission').evaluate(group => {
    const box = group.getBoundingClientRect();
    return { left: box.left, right: box.right, viewport: innerWidth, buttons: [...group.querySelectorAll('button')].map(button => {
      const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right, height: rect.height };
    }) };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport);
  assert.ok(bounds.buttons.every(b => b.left >= bounds.left && b.right <= bounds.right && b.height >= 44));
  if (process.env.ARCANE_ASSET_UI_SCREENSHOT) await page.locator('.codex-asset-permission').screenshot({ path: process.env.ARCANE_ASSET_UI_SCREENSHOT + '-mobile.png' });
  assert.equal(await page.locator('#codex-composer').inputValue(), 'Owned browser draft 🧩');
  assert.deepEqual(errors, []);
  const taskId=randomUUID();observed.snapshot!.thread!.turnStatus='completed';observed.snapshot!.thread!.turnId='completed-parent';observed.nativeAssets=assets();
  observed.chatTasks=[{taskId,threadId:THREAD,sessionId:null,connectionId:observed.snapshot!.connectionId,state:'awaiting_verification',round:0,reason:null,reportDigest:null}];
  await page.evaluate(()=>(window as unknown as {refreshFixture:()=>Promise<void>}).refreshFixture());
  assert.equal(await page.locator('#codex-interrupt').textContent(),'Stop task');await page.locator('#codex-interrupt').click();
  await page.waitForFunction(()=>(document.getElementById('codex-interrupt')as HTMLButtonElement).disabled);assert.equal(posts.at(-1)!.action,'task-stop');assert.deepEqual(errors,[]);
  await page.evaluate(() => (window as unknown as { stopFixture: () => void }).stopFixture());
});
