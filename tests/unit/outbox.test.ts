import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID, createCipheriv, createDecipheriv} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {DiagnosticOutbox, diagnosticScope, type DiagnosticCodec, type DiagnosticCredential} from '../../packages/diagnostics/src/outbox.js';

const base = 'https://diagnostics.example', scope = diagnosticScope(base, 'acct_' + 'a'.repeat(32));
const credential: DiagnosticCredential = {scope, base, token: 'arc_' + 't'.repeat(43)};
const now = 1792500000000;
const event = (id = randomUUID()) => ({schemaVersion: 1, eventId: id, occurredAt: now, component: 'studio', stage: 'studio-import', code: 'IMPORT_FAILED', context: {httpStatus: 500}});
function codec(): DiagnosticCodec {
  const key = randomBytes(32);
  return {seal(id, value) {const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(id)); const text = Buffer.concat([c.update(value), c.final()]); return Buffer.concat([iv, c.getAuthTag(), text]).toString('base64url');},
    open(id, value) {const b = Buffer.from(value, 'base64url'), c = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); c.setAAD(Buffer.from(id)); c.setAuthTag(b.subarray(12, 28)); return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString();}};
}
const accepted = (body: string) => Response.json({accepted: true, eventId: JSON.parse(body).eventId});
test('encrypted queue survives a disk reopen, preserves retry time and removes only a matching acknowledgement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-diagnostics-')), file = join(directory, 'outbox.sqlite'), encryption = codec();
  let db = new DatabaseSync(file), clock = now, calls = 0;
  t.after(() => {db.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, {recursive: true});});
  const options = () => ({db, codec: encryption, allowedOrigins: [base], credential: async () => credential, now: () => clock,
    fetch: (async (_url: unknown, init?: RequestInit) => {calls++; assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
      return calls === 1 ? new Response('', {status: 503}) : accepted(String(init?.body));}) as typeof fetch});
  let queue = new DiagnosticOutbox(options()); const input = event();
  assert.equal(queue.enqueue(scope, input), input.eventId); queue.enqueue(scope, input);
  assert.equal(queue.pending(), 1); assert.equal((await queue.flush()).state, 'retry');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM diagnostic_outbox').all()).includes('IMPORT_FAILED'));
  db.close(); assert.ok(!readFileSync(file).includes(Buffer.from('IMPORT_FAILED')));
  db = new DatabaseSync(file); queue = new DiagnosticOutbox(options());
  assert.equal((await queue.flush()).state, 'idle'); assert.equal(calls, 1);
  clock += 1001; assert.deepEqual(await queue.flush(), {state: 'sent', sent: 1, pending: 0}); assert.equal(calls, 2);
});
test('unconfigured, signed-out and switched accounts cannot transmit another scope', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let calls = 0, current: DiagnosticCredential | null = credential;
  const options = {db, codec: codec(), allowedOrigins: [base], credential: async () => current, now: () => now,
    fetch: (async () => {calls++; throw Error('must not send');}) as typeof fetch};
  const queue = new DiagnosticOutbox(options); queue.enqueue(scope, event());
  current = null; assert.equal((await queue.flush()).state, 'signed-out');
  current = {...credential, scope: diagnosticScope(base, 'acct_' + 'b'.repeat(32))}; assert.equal((await queue.flush()).state, 'idle');
  current = {...credential, base: 'https://untrusted.example'}; assert.equal((await queue.flush()).state, 'disabled');
  assert.equal((await new DiagnosticOutbox({...options, allowedOrigins: []}).flush()).state, 'disabled');
  assert.equal(calls, 0); assert.equal(queue.pending(), 1);
  assert.throws(() => new DiagnosticOutbox({...options, allowedOrigins: ['http://diagnostics.example']}));
});
test('lost or oversized acknowledgements retain evidence; retries keep the original event id', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let clock = now, calls = 0; const ids: string[] = [];
  const queue = new DiagnosticOutbox({db, codec: codec(), allowedOrigins: [base], credential: async () => credential, now: () => clock,
    fetch: (async (_url: unknown, init?: RequestInit) => {calls++; ids.push(JSON.parse(String(init?.body)).eventId);
      return calls === 1 ? Response.json({accepted: true, eventId: randomUUID()}) : calls === 2 ? new Response('x'.repeat(1025)) : accepted(String(init?.body));}) as typeof fetch});
  const input = event(); queue.enqueue(scope, input);
  for (const advance of [0, 1001]) {clock += advance; assert.equal((await queue.flush()).state, 'retry'); assert.equal(queue.pending(), 1);}
  clock += 2001; assert.equal((await queue.flush()).state, 'sent'); assert.deepEqual(ids, [input.eventId, input.eventId, input.eventId]);
});
test('an account change during credential acquisition cancels delivery; auth and rate failures retry after recovery', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let clock = now, reads = 0, calls = 0, changed = true;
  const queue = new DiagnosticOutbox({db, codec: codec(), allowedOrigins: [base], now: () => clock,
    credential: async () => {reads++; return changed && reads > 1 ? {...credential, scope: diagnosticScope(base, 'acct_' + 'b'.repeat(32))} : credential;},
    fetch: (async (_url: unknown, init?: RequestInit) => {calls++; return calls <= 2 ? new Response('private server detail', {status: calls === 1 ? 401 : 429}) : accepted(String(init?.body));}) as typeof fetch});
  queue.enqueue(scope, event()); assert.equal((await queue.flush()).state, 'signed-out'); assert.equal(calls, 0); assert.equal(queue.pending(), 1);
  changed = false;
  for (const advance of [1001, 2001]) {clock += advance; assert.equal((await queue.flush()).state, 'retry'); assert.equal(queue.pending(), 1);}
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM diagnostic_outbox').all()).includes('private server detail'));
  clock += 4001; assert.equal((await queue.flush()).state, 'sent'); assert.equal(calls, 3);
});
test('an abandoned lease recovers, conflicting events fail, and permanent refusal stays blocked', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let clock = now, calls = 0;
  const options = {db, codec: codec(), allowedOrigins: [base], credential: async () => credential, now: () => clock,
    fetch: (async () => {calls++; return new Response('', {status: 409});}) as typeof fetch};
  const queue = new DiagnosticOutbox(options), input = event(); queue.enqueue(scope, input);
  assert.throws(() => queue.enqueue(scope, {...input, code: 'FILE_MISSING'}));
  db.prepare('UPDATE diagnostic_outbox SET lease_owner=?,lease_until=?').run('abandoned-fixture-owner', now + 30000);
  const recovered = new DiagnosticOutbox(options); assert.equal((await recovered.flush()).state, 'idle'); assert.equal(calls, 0);
  clock += 30001; assert.equal((await recovered.flush()).state, 'blocked'); assert.equal(recovered.pending(), 1);
  clock += 3600001; assert.equal((await recovered.flush()).state, 'idle'); assert.equal(calls, 1);
});
test('encryption failure refuses enqueue, tampering never transmits, queue capacity and retention stay bounded', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let clock = now, calls = 0;
  const options = {db, codec: codec(), allowedOrigins: [base], credential: async () => credential, now: () => clock,
    fetch: (async () => {calls++; throw Error();}) as typeof fetch};
  const bad = new DiagnosticOutbox({...options, codec: {seal() {throw Error('private input');}, open() {throw Error();}}});
  assert.throws(() => bad.enqueue(scope, event()), /local diagnostic queue is unavailable/); assert.equal(bad.pending(), 0);
  const queue = new DiagnosticOutbox(options); const input = event(); queue.enqueue(scope, input);
  db.prepare('UPDATE diagnostic_outbox SET payload=?').run('tampered'); assert.equal((await queue.flush()).state, 'retry'); assert.equal(calls, 0);
  for (let i = 1; i < 1000; i++) queue.enqueue(scope, event()); assert.equal(queue.pending(), 1000);
  assert.throws(() => queue.enqueue(scope, event())); assert.equal(queue.pending(), 1000);
  clock += 30 * 86400000 + 1; queue.enqueue(scope, {...event(), occurredAt: clock}); assert.equal(queue.pending(), 1);
});
test('idle queues enforce fixed retention even without an endpoint or signed-in account',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let clock=now;
  const options={db,codec:codec(),allowedOrigins:[] as string[],credential:async()=>null,now:()=>clock};
  const offline=new DiagnosticOutbox(options);offline.enqueue(scope,event());clock+=30*86400000+1;
  assert.deepEqual(await offline.flush(),{state:'disabled',sent:0,pending:0});
  const signedOut=new DiagnosticOutbox({...options,allowedOrigins:[base]});signedOut.enqueue(scope,{...event(),occurredAt:clock});clock+=30*86400000+1;
  assert.deepEqual(await signedOut.flush(),{state:'signed-out',sent:0,pending:0});
});
