import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient, validateDaemonUrl } from '../../apps/mcp/src/daemon-client.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { assetRoutes } from '../../apps/daemon/src/asset-routes.js';
import { HISTORY_PAGE_BYTES, type AssetService, type AssetJobRecord, type AssetJobPage } from '../../apps/daemon/src/asset-service.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import type { AssetInput, AssetManifest, AssetProbe, AssemblyRecipe, AssemblyGeometry, MeshMetrics, Vec3 } from '../../packages/asset-pipeline/src/types.js';
import { normalizeRequest, validateAudit, sha256 } from '../../packages/asset-pipeline/src/validation.js';
import { preflightRecipe, preflightPart, expectedSockets, rotate, CUSTOM_REQUEST_BYTES } from '../../packages/asset-pipeline/src/recipe.js';
import { READ_METHODS, WRITE_METHODS } from '../../packages/protocol/src/studio.js';
import type { StudioCommand, StudioSession, InstanceRef, Json } from '../../packages/protocol/src/studio.js';

// These fixtures exercise actual SDK/HTTP/SQLite code, but simulate the plugin and never use native Studio.
const ROOT = resolve(process.cwd());
const TEMP = join(ROOT, 'apps/mcp/.tmp');
const TOKEN = 'fixture-control-bearer-1234567890';
const SESSION_ID = 'fixture-studio-session';
const REFERENCE: InstanceRef = { instanceId: 'opaque-1', sessionId: SESSION_ID, root: 'Workspace', pathSegments: ['Same', 'Same'], className: 'Part' };
const TOOL_ACCESS = {
  sessions: true, scene_children: true, scene_inspect: true, scene_search: true, selection_read: true, script_read: true,
  script_update: false, scene_create: false, scene_update: false, receipt_status: true, receipt_restore: false,
  skills_list: true, skills_get: true, work_runs: true, work_ready: true, work_create: false, work_claim: false,
  work_progress: false, work_submit: false, assets_probe: true, assets_jobs: true, assets_start: false, assets_cancel: false, assets_manifest: true,
};
const EDITOR_SOURCE = '--!strict\nreturn "café 🧩"\n';
type Behavior = 'normal' | 'timeout' | 'lost-ack' | 'redirect' | 'invalid' | 'oversize' | 'wrong-session' | 'failed' | 'reconciliation' | 'forbidden' | 'poll-failure' | 'hang-enqueue' | 'server-error';

const cleanups = new WeakMap<test.TestContext, (() => unknown | Promise<unknown>)[]>();
function after(t: test.TestContext, cleanup: () => unknown | Promise<unknown>) {
  let hooks = cleanups.get(t);
  if (!hooks) {
    hooks = []; cleanups.set(t, hooks);
    t.after(async () => {
      const failures = [];
      for (const release of hooks!.toReversed()) {
        try { await release(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed.');
    });
  }
  hooks.push(cleanup);
}

async function directory(t: test.TestContext) {
  await mkdir(TEMP, { recursive: true });
  const value = await mkdtemp(join(TEMP, 'mcp-'));
  after(t,async () => {
    const difference = relative(TEMP, value);
    assert.ok(difference.startsWith('mcp-') && !difference.includes(sep));
    await rm(value, { recursive: true, force: true });
  });
  return value;
}
async function jsonBody(request: IncomingMessage): Promise<Record<string, Json>> {
  const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, Json>;
}
function send(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
}
async function fixture(t: test.TestContext, behavior: Behavior = 'normal') {
  const commands = new Map<string, StudioCommand>();
  const requests: { method: string; path: string; body: Record<string, Json> | null; auth: string | undefined; origin: string | undefined }[] = [];
  const state = { behavior, posts: 0, polls: 0, redirects: 0 };
  const session: StudioSession = { id: SESSION_ID, protocolVersion: 1, clientSessionId: 'fixture-plugin-lifetime', placeId: 0, universeId: 0,
    name: 'Unsaved fixture', pluginVersion: 'fixture-v1', allowedRoots: ['Workspace'], allowWrites: true,
    capabilities: [...READ_METHODS, ...WRITE_METHODS], connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null };
  const server = createServer((request, response) => { void (async () => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const body = request.method === 'POST' ? await jsonBody(request) : null;
    requests.push({ method: request.method ?? '', path: pathname, body, auth: request.headers.authorization, origin: request.headers.origin });
    if (pathname === '/redirect-target') { state.redirects++; send(response, 200, { sessions: [] }); return; }
    if (state.behavior === 'redirect') { response.writeHead(302, { Location: '/redirect-target' }); response.end(); return; }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { send(response, 401, { error: 'AUTH', message: 'Invalid local fixture bearer.' }); return; }
    if (pathname === '/v1/studio/sessions') {
      if (state.behavior === 'oversize') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('x'.repeat(1024 * 1024 + 1)); return; }
      if (state.behavior === 'invalid') { send(response, 200, { sessions: [{ token: TOKEN }] }); return; }
      send(response, 200, { sessions: [session] }); return;
    }
    if (request.method === 'POST' && ['/v1/studio/commands', '/v1/studio/restore'].includes(pathname) && body) {
      state.posts++;
      if (state.behavior === 'forbidden') { send(response, 403, { error: 'READ_ONLY', message: `Write grant required. ${TOKEN}` }); return; }
      const restoring = pathname === '/v1/studio/restore';
      const previous = restoring ? commands.get(String(body.commandId)) : null;
      const command: StudioCommand = { protocolVersion: 1, id: randomUUID(), requestId: String(body.requestId), sessionId: SESSION_ID,
        clientSessionId: session.clientSessionId, method: restoring ? 'scene.restore' : body.method as StudioCommand['method'],
        args: restoring ? { receiptCommandId: String(body.commandId), mutation: (previous?.result as Record<string, Json> | null)?.mutation ?? null } : body.args as Record<string, Json>,
        allowedRoots: ['Workspace'], allowWrites: true, leaseEpoch: state.posts, expiresAt: new Date(Date.now()+60000).toISOString(),
        state: 'queued', createdAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
      commands.set(command.id, command);
      if (state.behavior === 'lost-ack') { request.socket.destroy(); return; }
      if (state.behavior === 'hang-enqueue') return;
      if (state.behavior === 'server-error') { send(response, 500, { error: 'INTERNAL', message: 'Outcome unavailable.' }); return; }
      send(response, 200, { command: state.behavior === 'wrong-session' ? { ...command, sessionId: 'other-window' } : command }); return;
    }
    if (request.method === 'GET' && pathname.startsWith('/v1/studio/commands/')) {
      const item = commands.get(decodeURIComponent(pathname.slice('/v1/studio/commands/'.length)));
      if (!item) { send(response,404,{error:'COMMAND',message:'Unknown command.'}); return; }
      state.polls++;
      if (state.behavior === 'poll-failure') { send(response,503,{error:'INTERNAL',message:'Read interrupted.'}); return; }
      if (state.behavior === 'timeout') item.state = 'dispatched';
      else if (state.behavior === 'failed' || state.behavior === 'reconciliation') {
        item.state = state.behavior === 'failed' ? 'failed' : 'needs_reconciliation'; item.error = `Conflict ${TOKEN}`; item.finishedAt = new Date().toISOString();
      } else if (item.state === 'queued') {
        item.state = 'succeeded'; item.finishedAt = new Date().toISOString();
        const mutationRef = (item.args.ref ?? REFERENCE) as unknown as InstanceRef;
        if (item.method === 'script.read') item.result = { ref: mutationRef as unknown as Json, source: EDITOR_SOURCE };
        else if (item.method === 'scene.inspect') item.result = { ref: REFERENCE as unknown as Json, name: 'Same', className: 'Part', childCount: 0, properties: { Anchored: true } };
        else if (item.method === 'script.update') item.result = { ref: mutationRef as unknown as Json, mutation: { kind: item.method, ref: mutationRef as unknown as Json, before: { source: item.args.expectedSource! }, after: { source: item.args.source! } } };
        else if (item.method === 'scene.update') item.result = { ref: mutationRef as unknown as Json, mutation: { kind: item.method, ref: mutationRef as unknown as Json, before: { properties: item.args.expected! }, after: { properties: item.args.properties! } } };
        else if (item.method === 'scene.create') item.result = { ref: REFERENCE as unknown as Json, mutation: { kind: item.method, ref: REFERENCE as unknown as Json, before: null, after: { properties: { Name: item.args.name! } } } };
        else if (item.method === 'scene.restore') item.result = { restored: true, ref: REFERENCE as unknown as Json };
        else item.result = { items: [{ ref: REFERENCE as unknown as Json, name: 'Same', className: 'Part', childCount: 0 }], ...(item.method !== 'selection.read' ? { truncated: false } : {}) };
      }
      send(response,200,{command:item}); return;
    }
    send(response,404,{error:'NOT_FOUND',message:'Unknown fixture endpoint.'});
  })().catch(() => send(response,500,{error:'FIXTURE',message:'Fixture failed.'})); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  after(t,async () => { server.closeAllConnections(); await new Promise<void>((accept,reject) => server.close(error => error ? reject(error) : accept())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { ...state, state, commands, requests, session, url: `http://127.0.0.1:${address.port}` };
}
async function recordFixture(t: test.TestContext, handle: (url: URL, body: Record<string, Json> | null, response: ServerResponse, request: IncomingMessage) => unknown | Promise<unknown>) {
  const requests: { method: string; url: string; body: Record<string, Json> | null; auth: string | undefined; origin: string | undefined }[] = [];
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = request.method === 'POST' ? await jsonBody(request) : null;
    requests.push({ method: request.method ?? '', url: url.pathname + url.search, body, auth: request.headers.authorization, origin: request.headers.origin });
    if (request.headers.authorization !== 'Bearer ' + TOKEN) { send(response, 401, { error: 'AUTH', message: 'Fixture bearer required.' }); return; }
    await handle(url, body, response, request);
  })().catch(() => { if (!response.destroyed && !response.headersSent) send(response, 500, { error: 'FIXTURE', message: 'Fixture handler failed.' }); }); });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  after(t, async () => { server.closeAllConnections(); await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: 'http://127.0.0.1:' + address.port, requests };
}

async function linked(t: test.TestContext, daemon: { url: string }, projectRoot = ROOT, token = TOKEN) {
  const server = createMcpServer({ client: new DaemonClient({ url: daemon.url, token, pollIntervalMs: 10 }), projectRoot });
  const client = new Client({ name: 'arcane-sdk-fixture', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  after(t,async () => { await client.close(); await server.close(); });
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const text = result.content.find(item => item.type === 'text');
  assert.ok(text && text.type === 'text');
  let data: Record<string, any>;
  try { data=JSON.parse(text.text) as Record<string, any>; } catch { data={sdkError:text.text}; }
  return { result, data };
}

test('MCP: exact literal loopback URL and environment bearer validation', () => {
  assert.equal(validateDaemonUrl('http://127.0.0.1:65535'), 'http://127.0.0.1:65535');
  for (const url of [undefined, '', 'http://localhost:80', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:01', 'http://127.0.0.1:65536',
    'http://127.0.0.1:80/', 'http://127.0.0.1:80/path', 'http://127.0.0.1:80?x=1', 'http://127.0.0.1:80#token', 'https://127.0.0.1:80',
    'http://user:pass@127.0.0.1:80', 'http://127.1:80', 'http://2130706433:80', 'http://[::1]:80', 'http://example.test:80', ' http://127.0.0.1:80']) {
    assert.throws(() => validateDaemonUrl(url), { code: 'CONFIG_URL' });
  }
  for (const token of ['', 'with space', 'token\nheader', '${ARCANE_LOCAL_TOKEN}']) {
    assert.throws(() => new DaemonClient({ url:'http://127.0.0.1:80',token }), {code:'CONFIG_TOKEN'});
  }
  assert.throws(() => DaemonClient.fromEnvironment({ ARCANE_DAEMON_URL: 'http://127.0.0.1:80' }), { code:'CONFIG_TOKEN' });
});

test('fixture SDK: advertised tools are strict bounded operations with read/write annotations', async t => {
  const f = await fixture(t), client = await linked(t,f);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(TOOL_ACCESS).sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.annotations?.openWorldHint, false, tool.name);
    assert.equal(tool.annotations?.readOnlyHint, TOOL_ACCESS[tool.name as keyof typeof TOOL_ACCESS], tool.name);
    if (!TOOL_ACCESS[tool.name as keyof typeof TOOL_ACCESS]) assert.equal(tool.annotations?.idempotentHint, false, tool.name);
  }
  assert.equal(tools.find(tool=>tool.name==='script_update')?.annotations?.readOnlyHint,false);
  assert.equal(tools.find(tool=>tool.name==='scene_inspect')?.annotations?.readOnlyHint,true);
  assert.equal(tools.find(tool=>tool.name==='receipt_restore')?.annotations?.idempotentHint,false);
});

test('fixture SDK: every scene/selection/script read uses exact shared endpoints, UUIDs and current source', async t => {
  const f = await fixture(t), client = await linked(t,f);
  const sessions=await call(client,'sessions'); assert.notEqual(sessions.result.isError,true,JSON.stringify(sessions.data));
  assert.equal(sessions.data.sessions[0].id,SESSION_ID);
  for (const [name, args] of [
    ['scene_children',{root:'Workspace',ref:REFERENCE,limit:7}], ['scene_inspect',{ref:REFERENCE}],
    ['scene_search',{root:'Workspace',query:'Same',limit:5}], ['selection_read',{}], ['script_read',{ref:{...REFERENCE,className:'ModuleScript'}}],
  ] as const) {
    const { result, data } = await call(client,name,{sessionId:SESSION_ID,...args});
    assert.notEqual(result.isError,true); assert.equal(data.state,'succeeded'); assert.equal(data.terminal,true); assert.equal(data.ambiguous,false);
    assert.match(data.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    if(name==='script_read') assert.equal(data.command.result.source,EDITOR_SOURCE);
  }
  assert.deepEqual([...f.commands.values()].map(command=>command.method),READ_METHODS);
  assert.equal(f.state.posts,5);
  assert.ok(f.requests.every(request=>request.auth===`Bearer ${TOKEN}` && request.origin===undefined));
  assert.equal((f.requests.find(request=>request.body?.method==='scene.children')!.body!.args as any).limit,7);
});

test('fixture SDK: guarded writes and daemon-built restore use separate receipt endpoint', async t => {
  const f = await fixture(t), client = await linked(t,f);
  const update = await call(client,'script_update',{sessionId:SESSION_ID,ref:{...REFERENCE,className:'ModuleScript'},expectedSource:EDITOR_SOURCE,source:'return 2'});
  assert.equal(update.data.command.result.mutation.before.source,EDITOR_SOURCE);
  const property = await call(client,'scene_update',{sessionId:SESSION_ID,ref:REFERENCE,expected:{Anchored:false},properties:{Anchored:true}});
  assert.equal(property.data.state,'succeeded');
  const created = await call(client,'scene_create',{sessionId:SESSION_ID,parent:REFERENCE,className:'Script',name:'DisabledScript'});
  assert.equal(created.data.command.result.mutation.before,null);
  const status = await call(client,'receipt_status',{commandId:update.data.commandId});
  assert.equal(status.data.command.id,update.data.commandId);
  const restored = await call(client,'receipt_restore',{commandId:update.data.commandId});
  assert.equal(restored.data.command.method,'scene.restore'); assert.equal(restored.data.command.result.restored,true);
  const restoreRequest = f.requests.find(request=>request.path==='/v1/studio/restore')!;
  assert.deepEqual(Object.keys(restoreRequest.body!).sort(),['commandId','requestId']); assert.equal(f.state.posts,4);
});

test('fixture SDK: unsafe or unbounded inputs are rejected before HTTP enqueue', async t => {
  const f = await fixture(t), client = await linked(t,f);
  const common = {sessionId:SESSION_ID,ref:REFERENCE};
  for (const [name,args] of [
    ['scene_inspect',{...common,method:'execute_luau'}], ['scene_children',{sessionId:SESSION_ID,root:'Workspace',limit:201}],
    ['scene_search',{sessionId:SESSION_ID,root:'Workspace',query:'  '}], ['selection_read',{sessionId:SESSION_ID,timeoutMs:60001}],
    ['scene_create',{sessionId:SESSION_ID,parent:REFERENCE,className:'MeshPart',name:'X'}],
    ['scene_create',{sessionId:SESSION_ID,parent:REFERENCE,className:'Script',name:'X',properties:{Source:'print(1)'}}],
    ['scene_create',{sessionId:SESSION_ID,parent:REFERENCE,className:'Folder',name:'X',properties:{Anchored:true}}],
    ['scene_update',{...common,expected:{},properties:{Name:'X'}}],
    ['scene_update',{...common,expected:{Name:'Same',Anchored:false},properties:{Name:'X'}}],
    ['scene_update',{...common,expected:{Transparency:0},properties:{Transparency:2}}],
    ['scene_update',{...common,expected:{Material:'Plastic'},properties:{Material:'Water'}}],
    ['scene_update',{...common,expected:{Parent:'Workspace'},properties:{Parent:'ServerStorage'}}],
    ['script_update',{...common,expectedSource:'',source:'🧩'.repeat(26000)}],
    ['script_update',{...common,expectedSource:'',source:'nul\0byte'}],
    ['receipt_restore',{commandId:'known',mutation:{kind:'script.update'}}], ['execute_luau',{code:'print(1)'}],
  ] as const) { assert.equal((await call(client,name,args)).result.isError,true,name); }
  assert.equal(f.state.posts,0);
});

test('fixture SDK: references cannot target another Studio session or root', async t => {
  const f=await fixture(t),client=await linked(t,f);
  assert.equal((await call(client,'scene_inspect',{sessionId:SESSION_ID,ref:{...REFERENCE,sessionId:'other-window'}})).data.error.code,'REFERENCE_SESSION');
  assert.equal((await call(client,'scene_children',{sessionId:SESSION_ID,root:'ServerStorage',ref:REFERENCE})).data.error.code,'REFERENCE_SESSION');
  assert.equal(f.state.posts,0);
});

test('fixture SDK: definitive write rejection is an error and control bearer is redacted', async t => {
  const f=await fixture(t,'forbidden'),client=await linked(t,f);
  const response=await call(client,'scene_update',{sessionId:SESSION_ID,ref:REFERENCE,expected:{Name:'Same'},properties:{Name:'X'}});
  assert.equal(response.result.isError,true); assert.equal(response.data.error.code,'READ_ONLY'); assert.ok(!JSON.stringify(response.result).includes(TOKEN)); assert.equal(f.state.posts,1);
});

for (const behavior of ['failed','reconciliation'] as const) test(`fixture SDK: terminal ${behavior} is preserved without automatic replay`, async t => {
  const f=await fixture(t,behavior),client=await linked(t,f);
  const response=await call(client,'selection_read',{sessionId:SESSION_ID});
  assert.equal(response.result.isError,true); assert.equal(response.data.terminal,true);
  assert.equal(response.data.state,behavior==='failed'?'failed':'needs_reconciliation'); assert.equal(f.state.posts,1);
  assert.ok(!JSON.stringify(response.result).includes(TOKEN));
});

test('fixture SDK: bounded timeout returns command ID and last known state; status does not replay', async t => {
  const f=await fixture(t,'timeout'),client=await linked(t,f);
  const started=Date.now(); const response=await call(client,'selection_read',{sessionId:SESSION_ID,timeoutMs:120});
  assert.ok(Date.now()-started<2000); assert.notEqual(response.result.isError,true);
  assert.equal(response.data.wait,'timeout'); assert.equal(response.data.state,'dispatched'); assert.equal(response.data.terminal,false); assert.equal(response.data.ambiguous,true);
  assert.equal(f.state.posts,1); assert.ok(f.state.polls>0 && f.state.polls<30);
  f.state.behavior='normal';
  const status=await call(client,'receipt_status',{commandId:response.data.commandId}); assert.equal(status.data.command.id,response.data.commandId); assert.equal(f.state.posts,1);
});

for (const behavior of ['lost-ack','hang-enqueue','server-error','wrong-session'] as const) test(`fixture SDK: ${behavior} keeps request UUID without claiming enqueue failure or retrying`, async t => {
  const f=await fixture(t,behavior),client=await linked(t,f);
  const response=await call(client,'selection_read',{sessionId:SESSION_ID,timeoutMs:120});
  assert.equal(response.data.commandId,null); assert.equal(response.data.state,'unknown'); assert.equal(response.data.ambiguous,true); assert.equal(response.data.terminal,false);
  assert.equal(f.state.posts,1); assert.equal([...f.commands.values()][0]!.requestId,response.data.requestId);
});

test('fixture SDK: interrupted polling preserves accepted command identity and state', async t => {
  const f=await fixture(t,'poll-failure'),client=await linked(t,f);
  const response=await call(client,'selection_read',{sessionId:SESSION_ID});
  assert.equal(response.data.wait,'interrupted'); assert.equal(response.data.state,'queued'); assert.equal(response.data.ambiguous,true); assert.ok(response.data.commandId); assert.equal(f.state.posts,1);
});

test('fixture HTTP: AbortSignal ends waits and never cancels/replays daemon commands', async t => {
  const f=await fixture(t,'timeout'),bridge=new DaemonClient({url:f.url,token:TOKEN,pollIntervalMs:10});
  const abort=new AbortController(); const operation=bridge.execute(SESSION_ID,'selection.read',{}, {timeoutMs:1000,signal:abort.signal});
  const until=Date.now()+1500; while(f.state.polls<2 && Date.now()<until) await sleep(5);
  assert.ok(f.state.polls>=2,'A second poll proves the first dispatched response was observed before cancellation.'); abort.abort();
  const result=await operation; assert.equal(result.wait,'aborted'); assert.equal(result.state,'dispatched'); assert.equal(result.ambiguous,true); assert.equal(f.state.posts,1);
  const preAborted=new AbortController(); preAborted.abort();
  await assert.rejects(()=>bridge.execute(SESSION_ID,'selection.read',{}, {signal:preAborted.signal}),{code:'ABORTED'}); assert.equal(f.state.posts,1);
});

test('fixture SDK: redirect targets receive no bearer; malformed and oversized responses fail closed', async t => {
  const f=await fixture(t,'redirect'),client=await linked(t,f);
  assert.equal((await call(client,'sessions')).result.isError,true); assert.equal(f.state.redirects,0);
  f.state.behavior='invalid'; assert.equal((await call(client,'sessions')).data.error.code,'PROTOCOL');
  f.state.behavior='oversize'; assert.equal((await call(client,'sessions')).data.error.code,'RESPONSE_LIMIT');
});

test('fixture SDK: spawned official stdio transport initializes and actually exercises tools', async t => {
  const f=await fixture(t);
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../apps/mcp/src/main.js',import.meta.url)),'--project',ROOT],
    env:{ARCANE_DAEMON_URL:f.url,ARCANE_LOCAL_TOKEN:TOKEN},cwd:ROOT,stderr:'pipe'});
  let diagnostics=''; transport.stderr?.on('data',chunk=>{diagnostics+=String(chunk);});
  const client=new Client({name:'arcane-spawn-fixture',version:'1.0.0'});
  after(t,()=>client.close()); await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), Object.keys(TOOL_ACCESS).sort());
  assert.equal((await call(client,'sessions')).data.sessions[0].id,SESSION_ID);
  assert.equal((await call(client,'scene_search',{sessionId:SESSION_ID,root:'Workspace',query:'Same'})).data.state,'succeeded');
  assert.equal(f.state.posts,1); assert.equal(diagnostics,'');
});

test('fixture SDK: skill registry defaults to approved only, explicit experimental opt-in and checksum enforcement', async t => {
  const f=await fixture(t),project=await directory(t);
  await cp(join(ROOT,'scripts'),join(project,'scripts'),{recursive:true}); await cp(join(ROOT,'skills'),join(project,'skills'),{recursive:true});
  const client=await linked(t,f,project);
  assert.deepEqual((await call(client,'skills_list')).data.items,[]);
  const rejected=await call(client,'skills_get',{ids:['arcane-studio-context']}); assert.equal(rejected.result.isError,true); assert.equal(rejected.data.error.code,'UNAPPROVED');
  assert.ok((await call(client,'skills_list',{allowExperimental:true,query:'studio'})).data.items.length>0);
  const packed=await call(client,'skills_get',{ids:['arcane-studio-context'],allowExperimental:true}); assert.match(packed.data.context,/Experimental content/); assert.equal(packed.data.approvalChanged,false);
  assert.equal((await call(client,'skills_get',{ids:['arcane-studio-context'],allowExperimental:true,byteBudget:256})).data.error.code,'BUDGET_EXCEEDED');
  const path=join(project,'skills/arcane/arcane-studio-context/SKILL.md'); await writeFile(path,(await readFile(path,'utf8'))+'\nchanged\n');
  assert.equal((await call(client,'skills_get',{ids:['arcane-studio-context'],allowExperimental:true})).data.error.code,'INTEGRITY');
  assert.equal(f.state.posts,0);
});

test('fixture SDK: approved skill loading still excludes quarantined/deprecated content', async t => {
  const f=await fixture(t),project=await directory(t);
  await cp(join(ROOT,'scripts'),join(project,'scripts'),{recursive:true}); await cp(join(ROOT,'skills'),join(project,'skills'),{recursive:true});
  const registryPath=join(project,'skills/registry.json'),registry=JSON.parse(await readFile(registryPath,'utf8'));
  registry.skills[0].status='approved'; registry.skills[0].approved=true; registry.skills[0].evaluationRuns=[{outcome:'passed',evidence:'non-native-test-fixture-only'}];
  registry.skills[1].status='quarantined'; registry.skills[2].status='deprecated'; await writeFile(registryPath,JSON.stringify(registry));
  const client=await linked(t,f,project);
  assert.deepEqual((await call(client,'skills_list')).data.items.map((item:any)=>item.id),['arcane-studio-context']);
  assert.notEqual((await call(client,'skills_get',{ids:['arcane-studio-context']})).result.isError,true);
  for(const skill of registry.skills.slice(1,3)) assert.equal((await call(client,'skills_get',{ids:[skill.id],allowExperimental:true})).data.error.code,'UNAPPROVED');
});

test('project config generator: env references, bounded output, no home writes or overwriting existing settings', async t => {
  const project=await directory(t);
  await mkdir(join(project,'scripts')); await mkdir(join(project,'skills'));
  await writeFile(join(project,'skills/registry.json'),'{}'); await writeFile(join(project,'scripts/skill-pack.mjs'),'// fixture');
  const moduleUrl=pathToFileURL(join(ROOT,'apps/mcp/scripts/generate-config.mjs')).href;
  const module=await import(moduleUrl) as {generateConfig(options: {projectRoot:string;outputDirectory?:string}):Promise<{files:string[];tokenWritten:boolean;installed:boolean}>};
  const result=await module.generateConfig({projectRoot:project}); assert.equal(result.tokenWritten,false); assert.equal(result.installed,false);
  const claude=JSON.parse(await readFile(result.files[0]!,'utf8')),codex=await readFile(result.files[1]!,'utf8');
  assert.equal(claude.mcpServers.arcane.env.ARCANE_LOCAL_TOKEN,'${ARCANE_LOCAL_TOKEN}'); assert.match(codex,/env_vars = \["ARCANE_DAEMON_URL", "ARCANE_LOCAL_TOKEN"\]/);
  assert.ok(!JSON.stringify(claude).includes(TOKEN)); assert.ok(!codex.includes(TOKEN));
  const original=await readFile(result.files[0]!,'utf8'); await assert.rejects(()=>module.generateConfig({projectRoot:project}),{code:'EEXIST'}); assert.equal(await readFile(result.files[0]!,'utf8'),original);
  await assert.rejects(()=>module.generateConfig({projectRoot:project,outputDirectory:'../outside'}),/inside this project/);
  const marker='fixture-token-that-must-not-be-written';
  const cli=spawnSync(process.execPath,[join(ROOT,'apps/mcp/scripts/generate-config.mjs'),'--project',project,'--output','second'],{env:{ARCANE_LOCAL_TOKEN:marker,...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {})},encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr); const generated=JSON.parse(cli.stdout); for(const file of generated.files) assert.ok(!(await readFile(file,'utf8')).includes(marker));
});

test('real daemon HTTP + SQLite + SDK: non-native mock plugin pairing, source update, immutable receipt, restore, readonly grant', async t => {
  const stateDirectory=await directory(t),store=new StudioStore({directory:join(stateDirectory,'sqlite')});
  const lab=await createConnectionLab({cwd:ROOT,stateDirectory:join(stateDirectory,'lab'),studioStore:store});
  after(t,async()=>{try { await lab.close(); } finally { store.close(); }});
  const http=async(path:string,body:unknown,bearer?:string)=>{
    const response=await fetch(lab.origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(bearer?{Authorization:`Bearer ${bearer}`}:{})},body:JSON.stringify(body)});
    const result=await response.json() as any; assert.equal(response.status,200,JSON.stringify(result)); return result;
  };
  const grant=await http('/v1/studio/pairing',{allowedRoots:['Workspace'],allowWrites:true},lab.token);
  const paired=await http('/v1/plugin/pair',{code:grant.code,protocolVersion:1,identity:{clientSessionId:randomUUID(),placeId:0,universeId:0,name:'Non-native MCP fixture',pluginVersion:'fixture'},capabilities:[...READ_METHODS,...WRITE_METHODS]});
  const client=await linked(t,{url:lab.origin},ROOT,lab.agentToken),scriptRef={...REFERENCE,sessionId:paired.sessionId,className:'ModuleScript'};
  assert.equal((await call(client,'sessions')).data.sessions[0].id,paired.sessionId);
  async function completePluginWork(pending: Promise<Awaited<ReturnType<typeof call>>>, expectedMethod:string, result:(command:StudioCommand)=>Json) {
    let delivered: StudioCommand | undefined;
    const until=Date.now()+2000;
    while(!delivered && Date.now()<until) {
      delivered=(await http('/v1/plugin/poll',{sessionId:paired.sessionId},paired.token)).commands[0];
      if(!delivered) await sleep(10);
    }
    assert.ok(delivered,'Mock plugin received a real SQLite queued command.'); assert.equal(delivered.method,expectedMethod);
    await http('/v1/plugin/result',{sessionId:paired.sessionId,commandId:delivered.id,state:'succeeded',result:result(delivered)},paired.token);
    const outcome=await pending; assert.equal(outcome.data.state,'succeeded'); return outcome;
  }
  const read=await completePluginWork(call(client,'script_read',{sessionId:paired.sessionId,ref:scriptRef}),'script.read',()=>({ref:scriptRef as unknown as Json,source:EDITOR_SOURCE}));
  assert.equal(read.data.command.result.source,EDITOR_SOURCE);
  const updated=await completePluginWork(call(client,'script_update',{sessionId:paired.sessionId,ref:scriptRef,expectedSource:EDITOR_SOURCE,source:'return 2'}),'script.update',command=>({ref:scriptRef as unknown as Json,mutation:{kind:'script.update',ref:scriptRef as unknown as Json,before:{source:command.args.expectedSource!},after:{source:command.args.source!}}}));
  const status=await call(client,'receipt_status',{commandId:updated.data.commandId}); assert.equal(status.data.command.result.mutation.after.source,'return 2');
  const exact = { sessionId: paired.sessionId, requestId: updated.data.requestId, method: 'script.update', args: updated.data.command.args };
  assert.equal((await http('/v1/studio/commands', exact, lab.token)).command.id, updated.data.commandId);
  const conflict = await fetch(lab.origin + '/v1/studio/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lab.token },
    body: JSON.stringify({ ...exact, args: { ...exact.args, source: 'return 999' } }) });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json() as any).error, 'IDEMPOTENCY');
  assert.equal(store.commands(paired.sessionId).length, 2);
  const restored=await completePluginWork(call(client,'receipt_restore',{commandId:updated.data.commandId}),'scene.restore',command=>{
    assert.equal(command.args.receiptCommandId,updated.data.commandId); assert.equal((command.args.mutation as any).after.source,'return 2');
    return {restored:true,ref:scriptRef as unknown as Json};
  });
  assert.equal(restored.data.command.result.restored,true); assert.equal(store.commands(paired.sessionId).length,3);
  const readonlyGrant=await http('/v1/studio/pairing',{allowedRoots:['Workspace'],allowWrites:false},lab.token);
  const readonly=await http('/v1/plugin/pair',{code:readonlyGrant.code,protocolVersion:1,identity:{clientSessionId:randomUUID(),placeId:0,universeId:0,name:'Readonly fixture',pluginVersion:'fixture'},capabilities:[...READ_METHODS,...WRITE_METHODS]});
  const refused=await call(client,'script_update',{sessionId:readonly.sessionId,ref:{...scriptRef,sessionId:readonly.sessionId},expectedSource:'',source:'return 3'});
  assert.equal(refused.result.isError,true,JSON.stringify(refused.data)); assert.equal(refused.data.error.code,'READ_ONLY',JSON.stringify(refused.data)); assert.equal(store.commands(readonly.sessionId).length,0);
  assert.notEqual(paired.token,lab.token); assert.notEqual(lab.agentToken,lab.token); assert.notEqual(paired.token,lab.agentToken);
  for (const [path, body] of [['/v1/studio/pairing', {allowedRoots:['Workspace'],allowWrites:true}], ['/v1/studio/revoke', {sessionId:paired.sessionId}], ['/v1/product/mcp-token', {}]] as const) {
    const denied = await fetch(lab.origin + path, {method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ' + lab.agentToken},body:JSON.stringify(body)});
    assert.equal(denied.status,403); assert.equal((await denied.json() as any).error,'SCOPE');
  }
});

test('real daemon HTTP + SQLite + SDK: durable work graph, leases, hashed submission and human-only review', async t => {
  const project = await directory(t);
  await mkdir(join(project, 'worker'));
  await writeFile(join(project, 'worker/evidence.txt'), 'actual local fixture evidence\n');
  const studio = new StudioStore({ directory: join(project, 'studio-db') });
  const work = new WorkStore({ directory: join(project, 'work-db'), projectPath: project });
  const lab = await createConnectionLab({ cwd: ROOT, stateDirectory: join(project, 'lab'), studioStore: studio, workStore: work, projectPath: project });
  after(t, async () => { try { await lab.close(); } finally { work.close(); studio.close(); } });
  const client = await linked(t, { url: lab.origin }, ROOT, lab.agentToken);
  const created = await call(client, 'work_create', { title: 'SDK task graph', objective: 'Verify durable evidence gating '.repeat(100), tasks: [
    { key: 'build', title: 'Build fixture', instructions: 'Write the scoped fixture '.repeat(300), acceptance: 'Review file evidence '.repeat(100), dependencies: [], scope: ['worker/evidence.txt'] },
    { key: 'next', title: 'Dependent task', instructions: 'Continue after review', acceptance: 'Inspect predecessor', dependencies: ['build'], scope: ['worker/next.txt'] },
  ] });
  assert.notEqual(created.result.isError, true, JSON.stringify(created.data));
  const run = created.data.run, taskId = run.tasks[0].id;
  assert.deepEqual((await call(client, 'work_ready', { runId: run.id })).data.tasks.map((task: any) => task.id), [taskId]);
  const blocked = await call(client, 'work_claim', { taskId: run.tasks[1].id, worker: 'dependent-worker' });
  assert.equal(blocked.data.error.code, 'TASK_STATE');
  const claimed = await call(client, 'work_claim', { taskId, worker: 'sdk-worker' });
  assert.equal(claimed.data.task.id, taskId); assert.equal(claimed.data.task.state, 'in_progress');
  assert.match(claimed.data.leaseToken, /^[a-f0-9]{64}$/);
  assert.equal(created.data.run.objective, 'Verify durable evidence gating '.repeat(100));
  assert.equal(created.data.run.tasks[0].instructions, 'Write the scoped fixture '.repeat(300));
  const longProgress = 'Fixture written and inspected '.repeat(50);
  const progressed = await call(client, 'work_progress', { taskId, leaseToken: claimed.data.leaseToken, progress: longProgress });
  assert.equal(progressed.data.task.progress, longProgress);
  const submitted = await call(client, 'work_submit', { taskId, leaseToken: claimed.data.leaseToken, evidence: [{ path: 'worker/evidence.txt', note: 'Local fixture result '.repeat(50) }] });
  assert.equal(submitted.data.task.state, 'needs_review'); assert.equal(submitted.data.task.leaseUntil, null);
  assert.equal(submitted.data.task.evidence[0].path, 'worker/evidence.txt'); assert.equal(submitted.data.task.evidence[0].note, 'Local fixture result '.repeat(50));
  assert.match(submitted.data.task.evidence[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(submitted.data.task.evidence[0].bytes, Buffer.byteLength('actual local fixture evidence\n'));
  assert.deepEqual((await call(client, 'work_ready', { runId: run.id })).data.tasks, []);
  const snapshot = (await call(client, 'work_runs')).data;
  assert.equal(snapshot.runs[0].tasks[0].state, 'needs_review'); assert.ok(!JSON.stringify(snapshot).includes(claimed.data.leaseToken));
  for (const name of ['work_review', 'work_approve']) assert.equal((await call(client, name, { taskId, approved: true, note: 'Agent approval forbidden' })).result.isError, true);
  const agentReview = await fetch(lab.origin + '/v1/work/review', {method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ' + lab.agentToken},body:JSON.stringify({taskId,approved:true,note:'Agent cannot review'})});
  assert.equal(agentReview.status,403); assert.equal((await agentReview.json() as any).error,'SCOPE');
  assert.equal(work.task(taskId).state, 'needs_review');
  // Simulate a separate human panel decision; MCP has no corresponding tool.
  work.review({ taskId, approved: true, note: 'Human fixture reviewer accepted hashed evidence' });
  assert.equal((await call(client, 'work_runs')).data.runs[0].tasks[0].state, 'complete');
  assert.deepEqual((await call(client, 'work_ready', { runId: run.id })).data.tasks.map((task: any) => task.id), [run.tasks[1].id]);
});

test('fixture SDK: unsafe work scopes, oversized graphs and forged review fields never reach HTTP', async t => {
  const f = await recordFixture(t, (_url, _body, response) => send(response, 500, { error: 'UNEXPECTED', message: 'Input should be rejected before HTTP.' }));
  const client = await linked(t, f);
  const task = { key: 'one', title: 'Task', instructions: 'Do scoped work', acceptance: 'Inspect evidence', dependencies: [], scope: ['worker/file.txt'] };
  for (const scope of ['../outside', '/absolute', 'C:/outside', '.env', 'worker/.env.secret', '.codex/config.toml', 'node_modules/package/file', 'worker/./file']) {
    assert.equal((await call(client, 'work_create', { title: 'Run', objective: 'Test scope', tasks: [{ ...task, scope: [scope] }] })).result.isError, true, scope);
  }
  for (const [name, args] of [
    ['work_create', { title: 'Run', objective: 'Test bounds', tasks: Array.from({ length: 65 }, () => task) }],
    ['work_create', { title: 'Run', objective: 'x'.repeat(8001), tasks: [task] }],
    ['work_create', { title: 'Run', objective: 'Bounded', tasks: [{ ...task, instructions: 'x'.repeat(16001) }] }],
    ['work_claim', { taskId: 'one', worker: 'worker', approved: true }],
    ['work_progress', { taskId: 'one', leaseToken: 'valid-token', progress: 'x'.repeat(4001) }],
    ['work_submit', { taskId: 'one', leaseToken: 'valid-token', evidence: [], approved: true }],
    ['work_submit', { taskId: 'one', leaseToken: 'valid-token', evidence: [{ path: '../secret', note: 'Unsafe' }] }],
  ] as const) assert.equal((await call(client, name, args)).result.isError, true, name);
  assert.equal(f.requests.length, 0);
});

for (const behavior of ['lost-ack', 'hang', 'server-error', 'wrong-task'] as const) test('fixture SDK: work claim ' + behavior + ' preserves ambiguity and never retries', async t => {
  const project = await directory(t), work = new WorkStore({ directory: join(project, 'db'), projectPath: project });
  after(t, () => work.close());
  const run = work.create({ title: 'Ambiguous claim', objective: 'Preserve durable lease state', tasks: [
    { key: 'one', title: 'Task', instructions: 'Inspect evidence', acceptance: 'Human review', dependencies: [], scope: ['worker/file.txt'] },
  ] });
  const taskId = run.tasks[0]!.id;
  const f = await recordFixture(t, (url, body, response, request) => {
    if (url.pathname === '/v1/work/runs') { send(response, 200, { runs: work.runs() }); return; }
    assert.equal(url.pathname, '/v1/work/claim');
    const claimed = work.claim(body);
    if (behavior === 'lost-ack') request.socket.destroy();
    else if (behavior === 'hang') return;
    else if (behavior === 'server-error') send(response, 500, { error: 'INTERNAL', message: 'Acknowledgement unavailable' });
    else send(response, 200, { ...claimed, task: { ...claimed.task, id: 'another-task' } });
  });
  const client = await linked(t, f);
  const outcome = await call(client, 'work_claim', { taskId, worker: 'fixture-worker', timeoutMs: 120 });
  assert.notEqual(outcome.result.isError, true); assert.equal(outcome.data.taskId, taskId);
  assert.equal(outcome.data.state, 'unknown'); assert.equal(outcome.data.ambiguous, true); assert.equal(outcome.data.terminal, false);
  assert.match(outcome.data.operationId, /^[a-f0-9-]{36}$/); assert.equal(outcome.data.leaseToken, undefined);
  assert.equal(outcome.data.wait, behavior === 'hang' ? 'timeout' : 'interrupted');
  assert.equal((await call(client, 'work_runs')).data.runs[0].tasks[0].state, 'in_progress');
  const posts = f.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 1); assert.deepEqual(posts[0]!.body, { taskId, worker: 'fixture-worker' });
});

test('fixture SDK: work read responses must preserve run/task identity', async t => {
  const project = await directory(t), work = new WorkStore({ directory: join(project, 'db'), projectPath: project });
  after(t, () => work.close());
  const run = work.create({ title: 'Identity fixture', objective: 'Reject mixed run records', tasks: [
    { key: 'one', title: 'Task', instructions: 'Do scoped work', acceptance: 'Review evidence', dependencies: [], scope: ['worker/file'] },
  ] });
  const f = await recordFixture(t, (url, _body, response) => {
    if (url.pathname === '/v1/work/ready') send(response, 200, { tasks: run.tasks });
    else send(response, 200, { runs: [{ ...run, tasks: [{ ...run.tasks[0]!, runId: 'wrong-run' }] }] });
  });
  const client = await linked(t, f);
  assert.equal((await call(client, 'work_runs')).data.error.code, 'PROTOCOL');
  assert.equal((await call(client, 'work_ready', { runId: 'requested/run?&' })).data.error.code, 'PROTOCOL');
  assert.equal(f.requests[1]!.url, '/v1/work/ready?runId=requested%2Frun%3F%26');
});

const ASSET_JOB_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ASSET_JOB_ID = '22222222-2222-4222-8222-222222222222';
const ASSET_REQUEST = normalizeRequest({ template: 'hero-prop', name: 'fixture-crate' });
const ASSET_PROBE: AssetProbe = { observedAt: '2026-10-11T00:00:00Z', available: false, blender: null, python: null, attempts: [] };
function manifestFixture(jobId: string): AssetManifest {
  return { schemaVersion: 1, jobId, createdAt: '2026-10-11T00:00:00Z', request: ASSET_REQUEST,
    runtime: { executable: 'C:/fixture/blender.exe', version: 'fixture-version', pythonVersion: 'fixture-python', background: true,
      capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } }, templateSha256: 'a'.repeat(64),
    coordinateSystem: { units: 'meters', sceneUp: 'Z', glbUp: 'Y', fbxUp: 'Y', pivot: 'floor', robloxScaleVerified: false },
    validation: { schemaVersion: 1, template: 'hero-prop', meshes: [{ name: 'SM_fixture', role: 'render', vertices: 8, edges: 12, faces: 6, triangles: 12,
      nonManifoldEdges: 0, looseVertices: 0, looseEdges: 0, duplicateVertices: 0, duplicateFaces: 0, degenerateFaces: 0, inconsistentNormals: 0,
      invertedComponents: 0, finitePositions: true, uvLayers: 1, uvLoops: 24, invalidUVs: 0, degenerateUVFaces: 0, dimensions: [1, 1, 1],
      scale: [1, 1, 1], rotation: [0, 0, 0], materials: ['MAT_fixture'], errors: [] }],
      totals: { renderTriangles: 12, lod1Triangles: 0, collisionTriangles: 0, materials: 1 }, renders: [], exports: [], savedSceneReopened: true, errors: [], warnings: [] },
    artifacts: [{ path: 'audit.json', role: 'audit', bytes: 100, sha256: 'b'.repeat(64) }], limitations: ['Typed HTTP fixture only; no native Blender or production asset validation.'] };
}
function jobFixture(jobId = ASSET_JOB_ID, state: 'running' | 'cancelled' = 'running') {
  return { schemaVersion:1 as const, jobId, directory:'C:/fixture/assets/' + jobId, state, manifestPath:null, error:null, request:ASSET_REQUEST,
    stage:state === 'running' ? 'generate' : 'complete', startedAt:'2026-10-11T00:00:00Z', updatedAt:'2026-10-11T00:00:01Z', manifestAvailable:false,
    events:[{jobId,at:'2026-10-11T00:00:01Z',stage:'generate',state:'running' as const}] };
}

function historyFixture(all: AssetJobRecord[], options: { limit?: number; after?: string } = {}): AssetJobPage {
  const start = options.after === undefined ? 0 : all.findIndex(job => job.jobId === options.after) + 1;
  const jobs = structuredClone(all.slice(start, start + (options.limit ?? 32)));
  return { schemaVersion:1, jobs, total:all.length, nextCursor:start + jobs.length < all.length ? jobs.at(-1)!.jobId : null, byteLimit:HISTORY_PAGE_BYTES };
}

test('fixture SDK: fixed asset tools use exact GET/POST endpoints and preserve typed evidence', async t => {
  const job = { ...jobFixture(), directory: 'C:/fixture/' + 'segment/'.repeat(40) + ASSET_JOB_ID };
  const f = await recordFixture(t, (url, body, response) => {
    if (url.pathname === '/v1/assets/probe') { assert.deepEqual(body, {}); send(response, 200, { probe: ASSET_PROBE }); }
    else if (url.pathname === '/v1/assets/jobs') send(response, 200, historyFixture([job]));
    else if (url.pathname === '/v1/assets/start') { assert.deepEqual(body, { template: 'hero-prop', name: 'fixture-crate', seed: 7, color: [0.1, 0.2, 0.3] }); send(response, 200, { job }); }
    else if (url.pathname === '/v1/assets/cancel') { assert.deepEqual(body, { jobId: job.jobId }); send(response, 200, { job: jobFixture(job.jobId, 'cancelled') }); }
    else if (url.pathname === '/v1/assets/manifest') { assert.equal(url.searchParams.get('jobId'), job.jobId); send(response, 200, { manifest: manifestFixture(job.jobId) }); }
    else throw new Error('Unexpected asset endpoint');
  });
  const client = await linked(t, f);
  assert.equal((await call(client, 'assets_probe')).data.probe.available, false);
  assert.equal((await call(client, 'assets_jobs')).data.jobs[0].state, 'running');
  const started = await call(client, 'assets_start', { template: 'hero-prop', name: 'fixture-crate', seed: 7, color: [0.1, 0.2, 0.3] });
  assert.notEqual(started.result.isError, true); assert.equal(started.data.job.jobId, job.jobId); assert.equal(started.data.job.state, 'running'); assert.equal(started.data.job.directory, job.directory);
  assert.equal((await call(client, 'assets_cancel', { jobId: job.jobId })).data.job.state, 'cancelled');
  const manifest = await call(client, 'assets_manifest', { jobId: job.jobId });
  assert.equal(manifest.data.manifest.artifacts[0].sha256, 'b'.repeat(64)); assert.equal(manifest.data.manifest.coordinateSystem.robloxScaleVerified, false);
  assert.deepEqual(f.requests.map(request => [request.method, request.url]), [
    ['POST', '/v1/assets/probe'], ['GET', '/v1/assets/jobs'], ['POST', '/v1/assets/start'], ['POST', '/v1/assets/cancel'], ['GET', '/v1/assets/manifest?jobId=' + ASSET_JOB_ID],
  ]);
  assert.ok(f.requests.every(request => request.auth === 'Bearer ' + TOKEN && request.origin === undefined));
});

test('fixture SDK: asset tools reject arbitrary code, host paths, publication and out-of-range settings before HTTP', async t => {
  const f = await recordFixture(t, (_url, _body, response) => send(response, 500, { error: 'UNEXPECTED', message: 'Input must not reach daemon.' }));
  const client = await linked(t, f), input = { template: 'hero-prop', name: 'fixture-crate' };
  for (const extra of [{ script: 'print(1)' }, { python: 'print(1)' }, { executable: 'C:/outside.exe' }, { outputRoot: 'C:/outside' },
    { importPath: 'C:/asset.blend' }, { publish: true }, { template: 'arbitrary-script' }, { name: '../outside' }, { name: 'con' },
    { schemaVersion: 1 }, { seed: -1 }, { sizeMeters: [1, 1, 21] }, { color: [0, 0, 2] }, { triangleBudget: 50001 }, { renderResolution: 1025 }, { renderSamples: 65 }]) {
    assert.equal((await call(client, 'assets_start', { ...input, ...extra })).result.isError, true, JSON.stringify(extra));
  }
  assert.equal((await call(client, 'assets_manifest', { jobId: 'known', path: 'C:/manifest.json' })).result.isError, true);
  assert.equal(f.requests.length, 0);
});

for (const behavior of ['lost-ack', 'hang', 'server-error', 'invalid-record'] as const) test('fixture SDK: asset start ' + behavior + ' returns ambiguity with exactly one POST', async t => {
  let starts = 0;
  const f = await recordFixture(t, (url, _body, response, request) => {
    if (url.pathname === '/v1/assets/jobs') { send(response, 200, historyFixture(starts ? [jobFixture()] : [])); return; }
    assert.equal(url.pathname, '/v1/assets/start'); starts++;
    if (behavior === 'lost-ack') request.socket.destroy();
    else if (behavior === 'hang') return;
    else if (behavior === 'server-error') send(response, 500, { error: 'INTERNAL', message: 'Acknowledgement unavailable' });
    else send(response, 200, { job: { jobId: 'invalid-without-state' } });
  });
  const client = await linked(t, f);
  const outcome = await call(client, 'assets_start', { template: 'hero-prop', name: 'fixture-crate', timeoutMs: 120 });
  assert.notEqual(outcome.result.isError, true); assert.equal(outcome.data.jobId, null); assert.equal(outcome.data.name, 'fixture-crate');
  assert.equal(outcome.data.state, 'unknown'); assert.equal(outcome.data.ambiguous, true); assert.equal(outcome.data.terminal, false);
  assert.match(outcome.data.nextStep, /assets_jobs/); assert.equal(outcome.data.wait, behavior === 'hang' ? 'timeout' : 'interrupted');
  assert.equal((await call(client, 'assets_jobs')).data.jobs.length, 1); assert.equal(starts, 1);
  assert.deepEqual(f.requests.filter(request => request.method === 'POST')[0]!.body, { template: 'hero-prop', name: 'fixture-crate' });
});

test('fixture SDK: exact asset identity, encoded queries, definitive errors and ambiguous cancel', async t => {
  let behavior: 'wrong-id' | 'forbidden' = 'wrong-id';
  const f = await recordFixture(t, (url, _body, response) => {
    if (behavior === 'forbidden') { send(response, 403, { error: 'ASSET_SCOPE', message: 'Denied ' + TOKEN }); return; }
    if (url.pathname === '/v1/assets/manifest') send(response, 200, { manifest: manifestFixture(OTHER_ASSET_JOB_ID) });
    else send(response, 200, { job: jobFixture(OTHER_ASSET_JOB_ID, 'cancelled') });
  });
  const client = await linked(t, f), jobId = ASSET_JOB_ID;
  assert.equal((await call(client, 'assets_manifest', {jobId:'job/?&'})).result.isError,true); assert.equal(f.requests.length,0);
  assert.equal((await call(client, 'assets_manifest', { jobId })).data.error.code, 'PROTOCOL');
  assert.equal(f.requests[0]!.url, '/v1/assets/manifest?jobId=' + ASSET_JOB_ID);
  const cancelled = await call(client, 'assets_cancel', { jobId });
  assert.equal(cancelled.data.jobId, jobId); assert.equal(cancelled.data.ambiguous, true);
  behavior = 'forbidden';
  const denied = await call(client, 'assets_start', { template: 'hero-prop', name: 'fixture-crate' });
  assert.equal(denied.result.isError, true); assert.equal(denied.data.error.code, 'ASSET_SCOPE'); assert.ok(!JSON.stringify(denied.result).includes(TOKEN));
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 2);
});

test('actual daemon asset routes + SDK: native agent bearer, fixed tools and 202 job acknowledgement with non-native service fixture', async t => {
  let started = 0, current = jobFixture();
  const service: AssetService = {
    outputRoot: 'C:/fixture/assets', projectPath: ROOT,
    async probe() { return ASSET_PROBE; }, jobs() { return started ? [current] : []; },
    jobPage(options = {}) { return historyFixture(started ? [current] : [], options); },
    async start(input) { started++; current = { ...jobFixture(), request: normalizeRequest(input) }; return current; },
    async cancel(jobId) { assert.equal(jobId, ASSET_JOB_ID); current = { ...current, state: 'cancelled', stage: 'complete' }; return current; },
    async manifest(jobId) { assert.equal(jobId, ASSET_JOB_ID); return manifestFixture(ASSET_JOB_ID); },
    async artifact() { throw new Error('MCP exposes no asset download endpoint.'); },
    async preview() { throw new Error('MCP exposes no asset preview path endpoint.'); }, async close() {},
  };
  const route = assetRoutes(service);
  let origin = '';
  const requests: {method:string;path:string;origin:string|undefined}[] = [];
  const server = createServer((request,response) => { void (async () => {
    requests.push({method:request.method ?? '',path:request.url ?? '',origin:request.headers.origin});
    if (!await route(request,response,new URL(request.url ?? '/',origin),'fixture-human-control',origin,TOKEN)) send(response,404,{error:'NOT_FOUND',message:'Unknown route'});
  })().catch(() => { if (!response.headersSent) send(response,500,{error:'FIXTURE',message:'Route fixture failed'}); }); });
  await new Promise<void>((accept,reject) => { server.once('error',reject);server.listen(0,'127.0.0.1',accept); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
  after(t,async () => {server.closeAllConnections();await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()));});
  const client = await linked(t,{url:origin});
  assert.equal((await call(client,'assets_probe')).data.probe.available,false);
  assert.deepEqual((await call(client,'assets_jobs')).data.jobs,[]);
  const acknowledgement = await call(client,'assets_start',{template:'environment-kit',name:'sdk-kit'});
  assert.notEqual(acknowledgement.result.isError,true,JSON.stringify(acknowledgement.data));
  assert.equal(acknowledgement.data.job.jobId,ASSET_JOB_ID); assert.equal(acknowledgement.data.job.state,'running');
  assert.equal(acknowledgement.data.job.stage,'generate'); assert.equal(acknowledgement.data.job.events.length,1);
  assert.equal((await call(client,'assets_jobs')).data.jobs[0].request.template,'environment-kit');
  assert.equal((await call(client,'assets_manifest',{jobId:ASSET_JOB_ID})).data.manifest.jobId,ASSET_JOB_ID);
  assert.equal((await call(client,'assets_cancel',{jobId:ASSET_JOB_ID})).data.job.state,'cancelled');
  assert.equal(started,1); assert.ok(requests.every(request=>request.origin===undefined));
  const csrf = await fetch(origin + '/v1/assets/start',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ' + TOKEN,Origin:'https://untrusted.invalid'},body:JSON.stringify({template:'hero-prop',name:'csrf'})});
  assert.equal(csrf.status,403); assert.equal((await csrf.json() as any).error,'ORIGIN'); assert.equal(started,1);
});

function customRecipeFixture(): AssemblyRecipe {
  return { schemaVersion:1,
    materials:[{id:'alloy',color:[0.2,0.3,0.4],metallic:0.6,roughness:0.25,emission:{color:[0.05,0.1,0.2],strength:0.5}}],
    parts:[
      {name:'body',role:'render',geometry:{kind:'box'},dimensions:[1,1,1],position:[0,0,0.5],rotationDegrees:[0,0,45],material:'alloy',bevel:{width:0.02,segments:2}},
      {name:'detail',role:'render',geometry:{kind:'mesh',vertices:[[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[-0.5,0.5,-0.5],[-0.5,-0.5,0.5]],indices:[0,2,1,0,1,3,1,2,3,2,0,3]},dimensions:[1,1,1],position:[2,0,0.5],material:'alloy'},
      {name:'collision',role:'collision',geometry:{kind:'box'},dimensions:[3.5,1.5,1],position:[1,0,0.5]},
      {name:'lod',role:'lod1',geometry:{kind:'box'},dimensions:[1,1,1],position:[0,0,0.5],material:'alloy'},
    ],
    sockets:[{name:'grip',kind:'socket',part:'body',position:[0,0,0.5],rotationDegrees:[0,30,0]},
      {name:'light',kind:'attachment',part:'detail',position:[0.1,0.1,0],rotationDegrees:[10,0,0]}],
    collisionTriangleBudget:128,lodTriangleBudget:1000,
  };
}
function customInputFixture(): AssetInput { return {template:'custom-assembly',name:'sdk-assembly',recipe:customRecipeFixture()}; }
function customManifestFixture(input: AssetInput, jobId = ASSET_JOB_ID): AssetManifest {
  const request = normalizeRequest(input), recipe = request.recipe!;
  const preflight = preflightRecipe(recipe,request.triangleBudget), sockets = expectedSockets(recipe);
  const assembly = {recipeSha256:sha256(Buffer.from(JSON.stringify(recipe))),...preflight,sockets,artisticFidelity:'unverified' as const,robloxImport:'unverified' as const};
  const meshes: MeshMetrics[] = recipe.parts.map(part => {
    const base = manifestFixture(jobId).validation.meshes[0]!;
    let points: Vec3[];
    if (part.geometry.kind === 'mesh') points = part.geometry.vertices;
    else { points = []; for (const x of [-0.5,0.5]) for (const y of [-0.5,0.5]) for (const z of [-0.5,0.5]) points.push([x,y,z]); }
    const positions = points.map(point => rotate(point.map((n,k)=>n * part.dimensions[k]!) as Vec3,part.rotationDegrees ?? [0,0,0]).map((n,k)=>n + part.position[k]!) as Vec3);
    const minimum = [0,1,2].map(k=>Math.min(...positions.map(p=>p[k]!))) as Vec3, maximum = [0,1,2].map(k=>Math.max(...positions.map(p=>p[k]!))) as Vec3;
    const triangles = part.geometry.kind === 'mesh' ? part.geometry.indices.length / 3 : part.bevel ? 12 : preflightPart(part).triangles;
    const material = recipe.materials.find(material=>material.id === part.material);
    return {...base,name:(part.role === 'collision' ? 'COL_' : 'SM_') + part.name,role:part.role,triangles,
      vertices:points.length,faces:triangles,uvLoops:part.role === 'collision' ? 0 : triangles * 3,uvLayers:part.role === 'collision' ? 0 : 1,
      materials:part.material ? ['MAT_' + part.material] : [],dimensions:maximum.map((n,k)=>n - minimum[k]!),
      geometrySha256:sha256(Buffer.from('synthetic fixture geometry: ' + part.name)),bounds:preflightPart(part).bounds,position:[0,0,0],
      materialProperties:material ? [{name:'MAT_' + material.id,color:material.color,metallic:material.metallic!,roughness:material.roughness!,emission:material.emission ?? {color:[1,1,1],strength:0}}] : []};
  });
  const triangles = (role: MeshMetrics['role']) => meshes.filter(mesh=>mesh.role === role).reduce((n,mesh)=>n + mesh.triangles,0);
  const manifest = manifestFixture(jobId);
  const exports = [
    {path:'asset.glb',objects:meshes.filter(mesh=>mesh.role === 'render').length,triangles:triangles('render'),materials:recipe.materials.length,finitePositions:true,sockets},
    {path:'asset.fbx',objects:meshes.filter(mesh=>mesh.role === 'render').length,triangles:triangles('render'),materials:recipe.materials.length,finitePositions:true,sockets},
    {path:'collision.glb',objects:meshes.filter(mesh=>mesh.role === 'collision').length,triangles:triangles('collision'),materials:0,finitePositions:true},
    ...(triangles('lod1') ? [{path:'asset-lod1.glb',objects:meshes.filter(mesh=>mesh.role === 'lod1').length,triangles:triangles('lod1'),materials:recipe.materials.length,finitePositions:true}] : []),
  ];
  const sourceRequestSha256 = sha256(Buffer.from(JSON.stringify(input) + '\n'));
  const result: AssetManifest = {...manifest,request,assembly,sourceRequestSha256,
    validation:{...manifest.validation,template:'custom-assembly',meshes,assembly,exports,
      totals:{renderTriangles:triangles('render'),collisionTriangles:triangles('collision'),lod1Triangles:triangles('lod1'),materials:recipe.materials.length},
      renders:['preview-hero.png','preview-side.png'].map(path=>({path,width:request.renderResolution,height:request.renderResolution,finitePixels:true,minLuminance:0,maxLuminance:1,meanLuminance:0.5,standardDeviation:0.2})),
      warnings:['Synthetic metrics only; no native worker or Blender invoked.']},
    artifacts:[...manifest.artifacts,{path:'input.json',role:'request',bytes:Buffer.byteLength(JSON.stringify(input) + '\n'),sha256:sourceRequestSha256},
      {path:'assembly.json',role:'audit',bytes:200,sha256:'c'.repeat(64)},{path:'assembly.py',role:'worker',bytes:100,sha256:'d'.repeat(64)}],
  };
  // This tests the real shared evidence contract, not byte/native-artifact validation.
  validateAudit(result.validation,result.request);
  return result;
}
async function customAssetLabFixture(t: test.TestContext) {
  const directoryPath = await directory(t), inputs: AssetInput[] = [], jobs: AssetJobRecord[] = [];
  let deliveredManifest: AssetManifest | null = null;
  const state = {starts:0,statuses:[] as {method:string;path:string;status:number}[]};
  const service: AssetService = {
    outputRoot:join(directoryPath,'not-generated'),projectPath:ROOT,
    async probe() { return ASSET_PROBE; }, jobs() { return structuredClone(jobs); },
    jobPage(options = {}) { return historyFixture(jobs,options); },
    async start(input) {
      inputs.push(structuredClone(input));state.starts++;
      const job = {...jobFixture(state.starts === 1 ? ASSET_JOB_ID : OTHER_ASSET_JOB_ID),request:normalizeRequest(input)};
      jobs.push(job);return structuredClone(job);
    },
    async cancel(jobId) { const job = jobs.find(job=>job.jobId === jobId)!;job.state = 'cancelled';return structuredClone(job); },
    async manifest(jobId) { return deliveredManifest ?? customManifestFixture(inputs[jobs.findIndex(job=>job.jobId === jobId)]!,String(jobId)); },
    async artifact() { throw new Error('MCP exposes no asset download endpoint.'); },
    async preview() { throw new Error('No native preview bytes in this fixture.'); }, async close() {},
  };
  const lab = await createConnectionLab({cwd:ROOT,stateDirectory:join(directoryPath,'lab'),assetService:service});
  lab.server.on('request',(request,response)=>response.once('finish',()=>state.statuses.push({method:request.method ?? '',path:request.url ?? '',status:response.statusCode})));
  after(t,()=>lab.close());
  return {lab,inputs,jobs,state,setManifest(value: AssetManifest) { deliveredManifest = value; }};
}
function closedMeshGrid(copies = 1000): Extract<AssemblyGeometry,{kind:'mesh'}> {
  const vertices: Vec3[] = [],indices: number[] = [];
  for (let i = 0;i < copies;i++) {
    const origin = [-0.5 + (i % 10) * 0.09,-0.5 + (Math.floor(i / 10) % 10) * 0.09,-0.5 + Math.floor(i / 100) * 0.09] as Vec3;
    const first = vertices.length;
    for (const offset of [[0,0,0],[0.04,0,0],[0,0.04,0],[0,0,0.04]]) vertices.push(origin.map((n,k)=>Math.round((n + offset[k]!) * 10000) / 10000) as Vec3);
    indices.push(...[0,2,1,0,1,3,1,2,3,2,0,3].map(index=>index + first));
  }
  return {kind:'mesh',vertices,indices};
}

test('custom assembly SDK: advertised strict recipe schema exposes every safe geometry and bound', async t => {
  const f = await fixture(t),client = await linked(t,f);
  const schema = (await client.listTools()).tools.find(tool=>tool.name === 'assets_start')!.inputSchema as any;
  assert.deepEqual(schema.properties.template.enum,['hero-prop','environment-kit','custom-assembly']);
  const recipe = schema.properties.recipe;
  assert.equal(recipe.additionalProperties,false);assert.equal(recipe.properties.parts.maxItems,96);assert.equal(recipe.properties.materials.maxItems,8);assert.equal(recipe.properties.sockets.maxItems,64);
  assert.equal(recipe.properties.parts.items.additionalProperties,false);assert.equal(recipe.properties.materials.items.additionalProperties,false);assert.equal(recipe.properties.sockets.items.additionalProperties,false);
  const geometry = recipe.properties.parts.items.properties.geometry;
  const kinds = (geometry.oneOf ?? geometry.anyOf).map((variant:any)=>{assert.equal(variant.additionalProperties,false);return variant.properties.kind.const;});
  assert.deepEqual(kinds.sort(),['box','cone','cylinder','mesh','sphere']);
  assert.equal(f.requests.length,0);
});

test('custom assembly SDK + real daemon: 202 preserves raw recipe and normalized assembly/provenance/geometry/socket evidence', async t => {
  const f = await customAssetLabFixture(t),client = await linked(t,{url:f.lab.origin},ROOT,f.lab.agentToken),input = customInputFixture();
  const started = await call(client,'assets_start',input as unknown as Record<string,unknown>);
  assert.notEqual(started.result.isError,true,JSON.stringify(started.data));assert.equal(started.data.job.state,'running');assert.equal(f.state.starts,1);
  assert.deepEqual(f.inputs[0],input);assert.deepEqual(started.data.job.request,normalizeRequest(input));
  assert.equal(started.data.job.request.triangleBudget,15000);assert.deepEqual(started.data.job.request.color,input.recipe!.materials[0]!.color);
  assert.equal(f.inputs[0]!.triangleBudget,undefined);assert.equal(f.inputs[0]!.recipe!.materials[0]!.roughness,0.25);
  assert.equal(f.state.statuses.find(response=>response.path === '/v1/assets/start')!.status,202);
  const page = await call(client,'assets_jobs');
  assert.deepEqual(page.data.jobs[0].request.recipe,normalizeRequest(input).recipe);assert.equal(page.data.total,1);assert.equal(page.data.nextCursor,null);assert.equal(page.data.byteLimit,HISTORY_PAGE_BYTES);
  const expected = customManifestFixture(input),manifest = await call(client,'assets_manifest',{jobId:ASSET_JOB_ID});
  assert.notEqual(manifest.result.isError,true,JSON.stringify(manifest.data));assert.deepEqual(manifest.data.manifest,expected);
  assert.deepEqual(manifest.result.structuredContent?.manifest,expected);
  const observed = manifest.data.manifest,assembly = observed.assembly,mesh = observed.validation.meshes[0],attachment = assembly?.sockets[1],exportSocket = observed.validation.exports[0]?.sockets?.[0];
  assert.ok(assembly && mesh && attachment && exportSocket);
  assert.equal(assembly.artisticFidelity,'unverified');assert.equal(assembly.robloxImport,'unverified');
  assert.equal(attachment.nodeName,'ATT_light');assert.equal(exportSocket.matrix.length,16);
  assert.equal(mesh.geometrySha256,expected.validation.meshes[0]!.geometrySha256);
  assert.deepEqual(mesh.bounds,expected.validation.meshes[0]!.bounds);
});

test('custom assembly SDK + real daemon: all primitive kinds and maximum part/material/socket counts pass shared preflight', async t => {
  const f = await customAssetLabFixture(t),client = await linked(t,{url:f.lab.origin},ROOT,f.lab.agentToken);
  const input = customInputFixture(),recipe = input.recipe!;
  for (const [index,geometry] of [{kind:'cylinder',segments:16},{kind:'cone',segments:12},{kind:'sphere',segments:8,rings:4}].entries()) {
    recipe.parts.push({name:'shape-' + index,role:'render',geometry:geometry as AssemblyGeometry,dimensions:[1,1,1],position:[4 + index * 2,0,0.5],material:'alloy'});
  }
  assert.notEqual((await call(client,'assets_start',input as unknown as Record<string,unknown>)).result.isError,true);
  const maximum: AssetInput = {template:'custom-assembly',name:'bounded-assembly',recipe:{schemaVersion:1,
    materials:Array.from({length:8},(_,index)=>({id:'mat-' + index,color:[0.2,0.3,0.4] as Vec3})),
    parts:[...Array.from({length:95},(_,index)=>({name:'part-' + index,role:'render' as const,geometry:{kind:'box' as const},dimensions:[1,1,1] as Vec3,position:[0,0,0.5] as Vec3,material:'mat-' + index % 8})),
      {name:'collision',role:'collision',geometry:{kind:'box'},dimensions:[1,1,1],position:[0,0,0.5]}],
    sockets:Array.from({length:64},(_,index)=>({name:'socket-' + index,kind:'socket' as const,part:'part-0',position:[0,0,0] as Vec3})),
  }};
  const outcome = await call(client,'assets_start',maximum as unknown as Record<string,unknown>);
  assert.notEqual(outcome.result.isError,true,JSON.stringify(outcome.data));assert.equal(outcome.data.job.request.recipe.parts.length,96);
  assert.equal(outcome.data.job.request.recipe.materials.length,8);assert.equal(outcome.data.job.request.recipe.sockets.length,64);assert.deepEqual(f.inputs[1],maximum);
});

test('custom assembly SDK + real daemon: large closed mesh exceeds the old SDK/16-KiB bounds and is accepted without code execution', async t => {
  const f = await customAssetLabFixture(t),client = await linked(t,{url:f.lab.origin},ROOT,f.lab.agentToken);
  const recipe = customRecipeFixture();recipe.parts = [
    {name:'grid',role:'render',geometry:closedMeshGrid(),dimensions:[1,1,1],position:[0,0,0.5],material:'alloy'},
    {name:'collision',role:'collision',geometry:{kind:'box'},dimensions:[1,1,1],position:[0,0,0.5]},
  ];recipe.sockets = [];
  const input: AssetInput = {template:'custom-assembly',name:'closed-grid',recipe};
  const bytes = Buffer.byteLength(JSON.stringify(input));assert.ok(bytes > 16384 && bytes < CUSTOM_REQUEST_BYTES);
  const outcome = await call(client,'assets_start',input as unknown as Record<string,unknown>);
  assert.notEqual(outcome.result.isError,true,JSON.stringify(outcome.data));assert.equal(f.state.starts,1);
  assert.equal(outcome.data.job.request.recipe.parts[0].geometry.vertices.length,4000);assert.deepEqual(f.inputs[0],input);
  assert.equal(f.state.statuses[0]!.status,202);
});

test('custom assembly SDK: invalid topology, budgets, references, bounds and nested executable fields fail before any HTTP', async t => {
  const f = await recordFixture(t,(_url,_body,response)=>send(response,500,{error:'UNEXPECTED',message:'Invalid input must never reach HTTP.'})),client = await linked(t,f);
  const cases: [string,(input:any)=>void][] = [
    ['missing recipe',input=>{delete input.recipe;}],['fixed template recipe',input=>{input.template = 'hero-prop';}],
    ['size override',input=>{input.sizeMeters = [1,1,1];}],['color override',input=>{input.color = [0,0,0];}],
    ['97 parts',input=>{input.recipe.parts = Array.from({length:97},(_,index)=>({...input.recipe.parts[0],name:'part-' + index}));}],
    ['9 materials',input=>{input.recipe.materials = Array.from({length:9},(_,index)=>({...input.recipe.materials[0],id:'mat-' + index}));}],
    ['65 sockets',input=>{input.recipe.sockets = Array.from({length:65},(_,index)=>({...input.recipe.sockets[0],name:'socket-' + index}));}],
    ['duplicate part IDs',input=>{input.recipe.parts[1].name = 'body';}],['unknown material',input=>{input.recipe.parts[0].material = 'undeclared';}],
    ['collision material',input=>{input.recipe.parts[2].material = 'alloy';}],['collision bevel',input=>{input.recipe.parts[2].bevel = {width:0.01};}],
    ['oversized bevel',input=>{input.recipe.parts[0].bevel.width = 0.2;}],['segments divisibility',input=>{input.recipe.parts[0].geometry = {kind:'cylinder',segments:10};}],
    ['open mesh',input=>{input.recipe.parts[1].geometry = {kind:'mesh',vertices:[[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5],[0,0,0.5]],indices:[0,1,4,1,2,4,2,3,4,3,0,4]};}],
    ['inconsistent winding',input=>{input.recipe.parts[1].geometry.indices.splice(0,3,0,1,2);}],
    ['duplicate face',input=>{input.recipe.parts[1].geometry.indices.splice(3,3,0,2,1);}],
    ['loose vertex',input=>{input.recipe.parts[1].geometry.vertices.push([0.5,0.5,0.5]);}],
    ['duplicate vertex',input=>{input.recipe.parts[1].geometry.vertices[1] = input.recipe.parts[1].geometry.vertices[0];}],
    ['index outside vertices',input=>{input.recipe.parts[1].geometry.indices[0] = 7;}],['vertex bound',input=>{input.recipe.parts[1].geometry.vertices[0][0] = 1;}],
    ['preflight render budget',input=>{input.triangleBudget = 100;}],['preflight collision budget',input=>{input.recipe.parts[2].geometry = {kind:'sphere',segments:64,rings:32};}],
    ['LOD budget/reduction',input=>{input.recipe.parts[3].geometry = {kind:'sphere',segments:64,rings:32};}],
    ['floor placement',input=>{for (const part of input.recipe.parts) part.position[2] = 2;}],
    ['40m assembly extent',input=>{input.recipe.parts[0].position[0] = -30;input.recipe.parts[1].position[0] = 30;}],
    ['socket part',input=>{input.recipe.sockets[0].part = 'collision';}],['socket world bounds',input=>{input.recipe.parts[0].position[0] = 40;input.recipe.parts[1].position[0] = 38;input.recipe.sockets[0].position = [20,-20,0];}],
    ['top-level script',input=>{input.python = 'print(1)';}],['recipe URL',input=>{input.recipe.url = 'https://untrusted.invalid/model';}],
    ['part output path',input=>{input.recipe.parts[0].path = 'C:/outside';}],['geometry code',input=>{input.recipe.parts[1].geometry.script = 'print(1)';}],
    ['material node code',input=>{input.recipe.materials[0].nodes = 'exec(code)';}],['socket executable',input=>{input.recipe.sockets[0].executable = 'C:/outside.exe';}],
  ];
  for (const [label,mutate] of cases) {const input = structuredClone(customInputFixture());mutate(input);assert.equal((await call(client,'assets_start',input as unknown as Record<string,unknown>)).result.isError,true,label);}
  const oversized = customInputFixture();const geometry = closedMeshGrid();
  geometry.vertices = geometry.vertices.map(vertex=>vertex.map(n=>n * 0.999999987654321) as Vec3);
  oversized.recipe!.parts[1]!.geometry = geometry;
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > CUSTOM_REQUEST_BYTES,'Fixture really exceeds the shared byte budget.');
  assert.equal((await call(client,'assets_start',oversized as unknown as Record<string,unknown>)).result.isError,true);
  assert.equal(f.requests.length,0);
});

for (const behavior of ['lost-ack','hang'] as const) test('custom assembly SDK + real daemon: ' + behavior + ' keeps accepted job ambiguous and never replays', async t => {
  const f = await customAssetLabFixture(t),input = customInputFixture();
  const proxy = await recordFixture(t,async (url,body,response,request)=>{
    const upstream = await fetch(f.lab.origin + url.pathname + url.search,{method:request.method ?? 'GET',headers:{Authorization:'Bearer ' + f.lab.agentToken,...(body ? {'Content-Type':'application/json'} : {})},...(body ? {body:JSON.stringify(body)} : {})});
    const payload = await upstream.json();
    if (url.pathname === '/v1/assets/start') {assert.equal(upstream.status,202);if (behavior === 'lost-ack') request.socket.destroy();return;}
    send(response,upstream.status,payload);
  });
  const client = await linked(t,proxy),outcome = await call(client,'assets_start',{...input,timeoutMs:120});
  assert.notEqual(outcome.result.isError,true);assert.equal(outcome.data.ambiguous,true);assert.equal(outcome.data.jobId,null);assert.equal(outcome.data.terminal,false);
  assert.equal(outcome.data.wait,behavior === 'hang' ? 'timeout' : 'interrupted');assert.deepEqual(f.inputs[0],input);assert.equal(f.state.starts,1);
  const recovered = await call(client,'assets_jobs');assert.deepEqual(recovered.data.jobs[0].request,normalizeRequest(input));
  assert.equal(proxy.requests.filter(request=>request.method === 'POST').length,1);assert.equal(f.state.starts,1);
});

test('custom assembly SDK: malformed or incomplete current manifest evidence is refused instead of stripped', async t => {
  const f = await customAssetLabFixture(t),client = await linked(t,{url:f.lab.origin},ROOT,f.lab.agentToken),input = customInputFixture();
  await call(client,'assets_start',input as unknown as Record<string,unknown>);
  const cases: [string,(manifest:any)=>void][] = [
    ['missing source digest',manifest=>{delete manifest.sourceRequestSha256;}],['missing assembly',manifest=>{delete manifest.assembly;}],
    ['missing audit assembly',manifest=>{delete manifest.validation.assembly;}],['mismatched assembly',manifest=>{manifest.assembly.bounds.max[0] += 1;}],
    ['missing geometry hash',manifest=>{delete manifest.validation.meshes[0].geometrySha256;}],['invalid geometry hash',manifest=>{manifest.validation.meshes[0].geometrySha256 = 'invalid';}],
    ['missing part origin',manifest=>{delete manifest.validation.meshes[0].position;}],['non-floor origin',manifest=>{manifest.validation.meshes[0].position = [0,0,1];}],
    ['missing PBR evidence',manifest=>{delete manifest.validation.meshes[0].materialProperties;}],['different PBR roughness',manifest=>{manifest.validation.meshes[0].materialProperties[0].roughness = 0.99;}],
    ['missing geometry bounds',manifest=>{delete manifest.validation.meshes[0].bounds;}],['negative extent',manifest=>{manifest.validation.meshes[0].bounds.max[0] = -60;}],
    ['wrong socket matrix length',manifest=>{manifest.assembly.sockets[0].matrix = [1,2];}],['wrong export socket pose',manifest=>{manifest.validation.exports[0].sockets[0].matrix[3] += 1;}],
    ['missing export sockets',manifest=>{delete manifest.validation.exports[0].sockets;}],['changed source digest',manifest=>{manifest.sourceRequestSha256 = 'e'.repeat(64);}],
    ['incorrect normalized size',manifest=>{manifest.request.sizeMeters = [1,1,1];}],['recipe omitted',manifest=>{delete manifest.request.recipe;}],
    ['false import verification',manifest=>{manifest.assembly.robloxImport = 'verified';}],
  ];
  for (const [label,mutate] of cases) {const manifest = structuredClone(customManifestFixture(input));mutate(manifest);f.setManifest(manifest);const result = await call(client,'assets_manifest',{jobId:ASSET_JOB_ID});assert.equal(result.result.isError,true,label);assert.equal(result.data.error.code,'PROTOCOL',label);}
  assert.equal(f.state.starts,1);
});

test('custom assembly SDK + real daemon: explicit history pagination preserves recipes and bounded page metadata without auto-fetching', async t => {
  const f = await customAssetLabFixture(t),client = await linked(t,{url:f.lab.origin},ROOT,f.lab.agentToken);
  const firstInput = customInputFixture(),secondInput = {...customInputFixture(),name:'second-assembly'};
  await call(client,'assets_start',firstInput as unknown as Record<string,unknown>);await call(client,'assets_start',secondInput as unknown as Record<string,unknown>);
  const first = await call(client,'assets_jobs',{limit:1});assert.equal(first.data.jobs.length,1);assert.equal(first.data.total,2);assert.equal(first.data.nextCursor,ASSET_JOB_ID);assert.equal(first.data.byteLimit,HISTORY_PAGE_BYTES);
  assert.deepEqual(first.data.jobs[0].request.recipe,normalizeRequest(firstInput).recipe);
  assert.equal(f.state.statuses.filter(request=>request.path.startsWith('/v1/assets/jobs')).length,1);
  const second = await call(client,'assets_jobs',{limit:1,after:first.data.nextCursor});assert.equal(second.data.jobs[0].jobId,OTHER_ASSET_JOB_ID);assert.equal(second.data.nextCursor,null);assert.equal(second.data.total,2);
  assert.deepEqual(second.data.jobs[0].request.recipe,normalizeRequest(secondInput).recipe);
  assert.equal(f.state.statuses.at(-1)!.path,'/v1/assets/jobs?limit=1&after=' + ASSET_JOB_ID);
  const before = f.state.statuses.length;
  for (const input of [{limit:0},{limit:65},{after:'../outside'},{cursor:ASSET_JOB_ID}]) assert.equal((await call(client,'assets_jobs',input)).result.isError,true);
  assert.equal(f.state.statuses.length,before);
});
