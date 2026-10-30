// Actual loopback HTTP, SQLite, account authorization and encryption; identity provider is an explicit local double.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {testConfig} from './helpers.ts';
import {openDatabase} from '../src/db.ts';
import {AccountStore} from '../src/account-store.ts';
import {createAccountAccess} from '../src/account-access.ts';
import {keyedHash} from '../src/auth.ts';
import {createGatewayServer} from '../src/server.ts';
import {readDiagnosticsConfig} from '../src/diagnostics-config.ts';

const OWNER = '11111111-2222-4333-8444-555555555555', MEMBER = '22222222-2222-4333-8444-555555555555';
async function fixture(t: import('node:test').TestContext, env: Record<string, string> = {}) {
  const config = testConfig({SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'p'.repeat(24),
    ACCOUNTS_SESSION_KEY: randomBytes(32).toString('base64url'), ADMIN_BOOTSTRAP_EMAIL: 'owner@example.com', DIAGNOSTICS_ENABLED: '1', ...env});
  const db = openDatabase(':memory:'), store = new AccountStore(db, config.accounts!), access = createAccountAccess(db, config.accounts!, store);
  let time = 1792500000000; const logs: string[] = [];
  const identity = (subject: string, aal: 'aal1' | 'aal2' = 'aal2') => ({subject, aal, email: subject === OWNER ? 'owner@example.com' : 'member@example.com',
    expiresAt: time + 3600000, factors: [{id: OWNER, type: 'totp', status: 'verified', name: 'Authenticator'}]});
  const owner = access.resolve(identity(OWNER), time); access.claimOwner(owner, time, time);
  const member = access.resolve(identity(MEMBER), time);
  const token = 'arc_' + randomBytes(32).toString('base64url'), hash = keyedHash(config, 'token', token);
  db.prepare('INSERT INTO tokens(hash,account_id,created_at) VALUES(?,?,?)').run(hash, member.account.id, time);
  db.prepare('INSERT INTO account_token_access(hash,subject,aal,expires_at) VALUES(?,?,?,?)').run(hash, MEMBER, 'aal2', time + 86400000);
  const accountFetch = (async (_url: unknown, init?: RequestInit) => {
    const bearer = (init?.headers as Record<string, string>).Authorization;
    const claims = JSON.parse(Buffer.from(bearer.slice(7).split('.')[1]!, 'base64url').toString());
    return Response.json({id: claims.sub, email: claims.sub === OWNER ? 'owner@example.com' : 'member@example.com',
      email_confirmed_at: '2026-10-20T00:00:00Z', factors: [{id: OWNER, factor_type: 'totp', status: 'verified'}]});
  }) as typeof fetch;
  const instance = createGatewayServer({config, db, accountFetch, now: () => time, log: line => logs.push(line),
    sendMail: async () => assert.fail('No email operation expected'), upstream: async function* () {assert.fail('No inference expected');}});
  await new Promise<void>(done => instance.server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + (instance.server.address() as AddressInfo).port; config.publicOrigin = base; config.publicUrl = base;
  t.after(async () => {instance.close(); instance.server.closeAllConnections(); await new Promise<void>(done => instance.server.close(() => done())); db.close();});
  function cookie(subject = OWNER, aal: 'aal1' | 'aal2' = 'aal2', mfaAt = time) {
    const claims = {sub: subject, aal, iss: config.accounts!.providerUrl + '/auth/v1', aud: 'authenticated', exp: Math.floor(time / 1000) + 3600};
    const accessToken = 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
    const created = store.create(time, {csrf: randomBytes(32).toString('base64url'), createdAt: time, accessToken, refreshToken: 'fixture-refresh', mfaAt}, subject);
    return 'arcane-session=' + created.cookie;
  }
  async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
    return fetch(base + path, {headers: {...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)})});
  }
  const event = (id = randomUUID()) => ({schemaVersion: 1, eventId: id, occurredAt: time, component: 'blender', stage: 'mesh-validation', code: 'MESH_AUDIT', context: {renderTriangles: 17000, triangleBudget: 16000}});
  return {db, store, config, time: () => time, advance: (ms: number) => {time += ms;}, logs, event, request, cookie, token, hash, accountId: member.account.id};
}
test('diagnostics configuration is explicit, bounded and requires managed accounts', () => {
  assert.equal(readDiagnosticsConfig({}, false), null);
  assert.throws(() => readDiagnosticsConfig({DIAGNOSTICS_ENABLED: '1'}, false));
  for (const env of [{DIAGNOSTICS_RETENTION_DAYS: '31'}, {DIAGNOSTICS_ACCOUNT_EVENTS: '10001'}, {DIAGNOSTICS_MAX_EVENTS: '0'}, {DIAGNOSTICS_PER_MINUTE: '121'}])
    assert.throws(() => readDiagnosticsConfig({DIAGNOSTICS_ENABLED: '1', ...env}, true));
});
test('approved-device ingress stores an encrypted useful event, deduplicates retries and refuses conflicts/private data', async t => {
  const h = await fixture(t), headers = {Authorization: 'Bearer ' + h.token}, report = h.event();
  assert.equal((await h.request('/v1/diagnostics/events', report)).status, 401);
  assert.equal((await h.request('/v1/diagnostics/events', report, headers)).status, 200);
  assert.deepEqual(await (await h.request('/v1/diagnostics/events', report, headers)).json(), {accepted: true, eventId: report.eventId});
  assert.equal((await h.request('/v1/diagnostics/events', {...report, code: 'MEMORY_LIMIT'}, headers)).status, 409);
  const secret = 'Bearer should-not-appear user@example.com C:\\Users\\private\\worker.py';
  assert.equal((await h.request('/v1/diagnostics/events', {...h.event(), message: secret}, headers)).status, 400);
  assert.equal((await h.request('/v1/diagnostics/events', {...h.event(), context: {path: secret}}, headers)).status, 400);
  assert.equal((await h.request('/v1/diagnostics/events', {...h.event(), reason: secret}, headers)).status, 400);
  const raw = JSON.stringify(h.db.prepare('SELECT * FROM diagnostic_events').all());
  assert.ok(!raw.includes(secret)); assert.ok(!raw.includes('MESH_AUDIT')); assert.ok(!h.logs.join('\n').includes(secret));
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM diagnostic_events').get()!.n, 1);
  const admin = await h.request('/v1/admin/diagnostics', undefined, {Cookie: h.cookie()}); assert.equal(admin.status, 200);
  const view = await admin.json() as {events: {event: {stage: string; code: string; reason: string; context: {renderTriangles: number}}}[]};
  assert.equal(view.events[0]!.event.stage, 'mesh-validation'); assert.equal(view.events[0]!.event.code, 'MESH_AUDIT');
  assert.match(view.events[0]!.event.reason, /Structural mesh validation/); assert.equal(view.events[0]!.event.context.renderTriangles, 17000);
  assert.equal(admin.headers.get('cache-control'), 'no-store');
});
test('admin reads reject anonymous, device-only, member, stale MFA and lower assurance sessions', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('/v1/admin/diagnostics')).status, 401);
  assert.equal((await h.request('/v1/admin/diagnostics', undefined, {Authorization: 'Bearer ' + h.token})).status, 401);
  assert.equal((await h.request('/v1/admin/diagnostics', undefined, {Cookie: h.cookie(MEMBER)})).status, 403);
  assert.equal((await h.request('/v1/admin/diagnostics', undefined, {Cookie: h.cookie(OWNER, 'aal2', h.time() - 16 * 60000)})).status, 403);
  assert.equal((await h.request('/v1/admin/diagnostics', undefined, {Cookie: h.cookie(OWNER, 'aal1')})).status, 403);
  assert.equal((await h.request('/v1/admin/diagnostics', undefined, {Cookie: h.cookie()})).status, 200);
});
test('ingress refuses revoked, expired and suspended device credentials and oversized JSON', async t => {
  const h = await fixture(t), headers = {Authorization: 'Bearer ' + h.token};
  assert.deepEqual(await (await h.request('/v1/diagnostics/identity', undefined, headers)).json(), {accountId: h.accountId});
  assert.equal((await h.request('/v1/diagnostics/events', {padding: 'x'.repeat(8192)}, headers)).status, 413);
  h.db.prepare('UPDATE account_token_access SET expires_at=?').run(h.time() - 1);
  assert.equal((await h.request('/v1/diagnostics/events', h.event(), headers)).status, 401);
  h.db.prepare('UPDATE account_token_access SET expires_at=?').run(h.time() + 100000);
  h.db.prepare('UPDATE account_identities SET disabled=1 WHERE account_id=?').run(h.accountId);
  assert.equal((await h.request('/v1/diagnostics/events', h.event(), headers)).status, 401);
  h.db.prepare('UPDATE account_identities SET disabled=0 WHERE account_id=?').run(h.accountId);
  h.db.prepare('UPDATE tokens SET revoked_at=? WHERE hash=?').run(h.time(), h.hash);
  assert.equal((await h.request('/v1/diagnostics/events', h.event(), headers)).status, 401);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM diagnostic_events').get()!.n, 0);
});
test('capacity, account rate and retention keep bounded evidence without overwriting earlier reports', async t => {
  const h = await fixture(t, {DIAGNOSTICS_ACCOUNT_EVENTS: '1', DIAGNOSTICS_MAX_EVENTS: '1', DIAGNOSTICS_PER_MINUTE: '3', DIAGNOSTICS_RETENTION_DAYS: '1'});
  const headers = {Authorization: 'Bearer ' + h.token}, first = h.event();
  assert.equal((await h.request('/v1/diagnostics/events', first, headers)).status, 200);
  assert.equal((await h.request('/v1/diagnostics/events', h.event(), headers)).status, 503);
  assert.equal((await h.request('/v1/diagnostics/events', first, headers)).status, 200);
  const limited = await h.request('/v1/diagnostics/events', h.event(), headers); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  h.advance(86400001);
  // Issue a new valid device lifetime in this fixture; the old token's access expiry is still enforced.
  h.db.prepare('UPDATE account_token_access SET expires_at=?').run(h.time() + 86400000);
  assert.equal((await h.request('/v1/diagnostics/events', first, headers)).status, 410);
  assert.equal((await h.request('/v1/diagnostics/events', h.event(), headers)).status, 200);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM diagnostic_events').get()!.n, 1);
});
test('authorized pagination is bounded, exact event lookup works and invalid cursors fail', async t => {
  const h = await fixture(t), headers = {Authorization: 'Bearer ' + h.token}; const ids: string[] = [];
  for (let i = 0; i < 51; i++) {const report = h.event(); ids.push(report.eventId); assert.equal((await h.request('/v1/diagnostics/events', report, headers)).status, 200);}
  const admin = {Cookie: h.cookie()};
  const first = await (await h.request('/v1/admin/diagnostics', undefined, admin)).json() as {events: unknown[]; next: string};
  assert.equal(first.events.length, 50); assert.ok(first.next);
  const second = await (await h.request('/v1/admin/diagnostics?before=' + first.next, undefined, admin)).json() as {events: unknown[]; next: null};
  assert.equal(second.events.length, 1); assert.equal(second.next, null);
  const lookup = await (await h.request('/v1/admin/diagnostics?accountId=' + h.accountId + '&eventId=' + ids[0], undefined, admin)).json() as {events: {event: {eventId: string}}[]};
  assert.equal(lookup.events.length, 1); assert.equal(lookup.events[0]!.event.eventId, ids[0]);
  assert.equal((await h.request('/v1/admin/diagnostics?before=invalid', undefined, admin)).status, 400);
});
test('disabled service exposes no reports and does not create its event table', async t => {
  const h = await fixture(t, {DIAGNOSTICS_ENABLED: '0'});
  assert.equal((await h.request('/v1/diagnostics/events', h.event(), {Authorization: 'Bearer ' + h.token})).status, 503);
  assert.equal((await h.request('/v1/admin/diagnostics', undefined, {Cookie: h.cookie()})).status, 503);
  assert.equal(h.db.prepare("SELECT name FROM sqlite_master WHERE name='diagnostic_events'").get(), undefined);
});

test('configured collector accepts only the finite staging event and keeps original auth, privacy and disabled boundaries',async t=>{
  const h=await fixture(t),headers={Authorization:'Bearer '+h.token};
  const event=()=>({...h.event(),component:'studio',stage:'studio-import',code:'STUDIO_STAGE_CONTINUITY',context:{stagingPhase:'packet-receipt',stagingReason:'proof-expired',packetOrdinal:511}});
  const report=event();assert.equal((await h.request('/v1/diagnostics/events',report)).status,401);
  assert.deepEqual(await (await h.request('/v1/diagnostics/events',report,headers)).json(),{accepted:true,eventId:report.eventId});
  const secret='private source C:\\Users\\fixture\\model.glb token';
  for(const value of [
    {...event(),context:{...report.context,packetOrdinal:512}}, {...event(),context:{...report.context,stagingReason:secret}},
    {...event(),context:{...report.context,jobId:OWNER}}, {...event(),context:{...report.context,operationId:MEMBER}},
    {...event(),context:{...report.context,stagingPhase:'target-check'}}, {...event(),component:'blender'},
    {...event(),message:secret}, {...event(),context:{stagingPhase:'packet-enqueue',stagingReason:'disconnected'}},
  ])assert.equal((await h.request('/v1/diagnostics/events',value,headers)).status,400);
  const response=await h.request('/v1/admin/diagnostics',undefined,{Cookie:h.cookie()});assert.equal(response.status,200);
  const view=await response.json() as {events:{event:{code:string;context:unknown}}[]};assert.equal(view.events.length,1);assert.equal(view.events[0]!.event.code,'STUDIO_STAGE_CONTINUITY');assert.deepEqual(view.events[0]!.event.context,report.context);
  const raw=JSON.stringify(h.db.prepare('SELECT * FROM diagnostic_events').all());assert.doesNotMatch(raw,/STUDIO_STAGE_CONTINUITY|proof-expired/);assert.ok(!raw.includes(secret));assert.ok(!h.logs.join('\n').includes(secret));
  const disabled=await fixture(t,{DIAGNOSTICS_ENABLED:'0'});assert.equal((await disabled.request('/v1/diagnostics/events',event(),{Authorization:'Bearer '+disabled.token})).status,503);
  assert.equal(disabled.db.prepare("SELECT name FROM sqlite_master WHERE name='diagnostic_events'").get(),undefined);
});


test('Node gateway admits only the finite chat-frame boundary and preserves encrypted auth and byte limits',async t=>{
 const h=await fixture(t),headers={Authorization:'Bearer '+h.token};
 const context={operationId:randomUUID(),nativeFrameDirection:'inbound',nativeFramePhase:'discovery-inventory',
  nativeFrameByteKind:'at-least',nativeFrameBytes:1048577,nativeFrameLimit:1048576,nativeFramePendingMask:512,nativeFramePendingCount:1};
 const event={...h.event(),component:'chat',stage:'authenticate',code:'NATIVE_FRAME_LIMIT',context};
 assert.equal((await h.request('/v1/diagnostics/events',event)).status,401);
 assert.deepEqual(await (await h.request('/v1/diagnostics/events',event,headers)).json(),{accepted:true,eventId:event.eventId});
 const secret='private prompt source token';
 for(const bad of [{...event,component:'studio'},{...event,stage:'request-submit'},
  {...event,context:{...context,nativeFramePendingMask:1024}},{...event,context:{...context,nativeFramePendingCount:0}},
  {...event,context:{...context,nativeFramePhase:'not-connect'}},{...event,context:{...context,nativeFrameByteKind:'exact'}},
  {...event,context:{...context,method:secret}},{...event,message:secret}])
  assert.equal((await h.request('/v1/diagnostics/events',{...bad,eventId:randomUUID()},headers)).status,400);
 assert.equal((await h.request('/v1/diagnostics/events',{...event,eventId:randomUUID(),padding:'x'.repeat(8192)},headers)).status,413);
 const response=await h.request('/v1/admin/diagnostics',undefined,{Cookie:h.cookie()});assert.equal(response.status,200);
 const view=await response.json() as {events:{event:{code:string;context:unknown}}[]};
 assert.equal(view.events.length,1);assert.equal(view.events[0]!.event.code,'NATIVE_FRAME_LIMIT');assert.deepEqual(view.events[0]!.event.context,context);
 const raw=JSON.stringify(h.db.prepare('SELECT * FROM diagnostic_events').all());
 assert.doesNotMatch(raw,/NATIVE_FRAME_LIMIT|discovery-inventory/);assert.ok(!raw.includes(context.operationId));assert.ok(!h.logs.join('\n').includes(secret));
});
