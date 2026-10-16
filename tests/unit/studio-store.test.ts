import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { canonical } from '../../packages/core/src/studio-policy.js';
import { READ_METHODS, WRITE_METHODS, type InstanceRef } from '../../packages/protocol/src/studio.js';

function fixture(t: test.TestContext, writable = false) {
  const directory = mkdtempSync(join(tmpdir(), 'arcane-studio-store-')); let now = Date.now();
  const store = new StudioStore({ directory, now: () => now });
  t.after(() => { store.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/')); rmSync(directory, { recursive: true, force: true }); });
  const grant = store.createGrant({ allowedRoots: ['Workspace'], allowWrites: writable });
  const input = { code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'native-window-A', placeId: 0, universeId: 0, name: 'Disposable fixture', pluginVersion: '0.1.0' }, capabilities: [...READ_METHODS, ...WRITE_METHODS] };
  const pair = store.pair(input);
  const ref: InstanceRef = { instanceId: 'opaque-A', sessionId: pair.sessionId, root: 'Workspace', pathSegments: ['Part'], className: 'Part' };
  return { directory, store, grant, input, pair, ref, advance: (ms: number) => { now += ms; } };
}
test('pairing code is one-use; identity and token are exact session scoped', t => {
  const f = fixture(t); assert.throws(() => f.store.pair(f.input), /expired or already used/);
  assert.equal(f.store.authenticate(f.pair.sessionId, f.pair.token).name, 'Disposable fixture');
  assert.throws(() => f.store.authenticate(f.pair.sessionId, 'wrong'), /bearer/);
  assert.throws(() => f.store.authenticate('another-session', f.pair.token), /bearer/);
});
test('pairing grants expire, protocol mismatch refused and roots are explicit', t => {
  const f = fixture(t); const g = f.store.createGrant({ allowedRoots: ['Workspace'], allowWrites: false }); f.advance(120001);
  assert.throws(() => f.store.pair({ ...f.input, code: g.code }), /expired/);
  assert.throws(() => f.store.pair({ ...f.input, protocolVersion: 2 }), /protocol/);
  assert.throws(() => f.store.createGrant({ allowedRoots: [], allowWrites: true }), /explicit/);
  assert.throws(() => f.store.createGrant({ allowedRoots: ['DataStoreService'], allowWrites: true }), /explicit/);
});
test('only hashed plugin bearers and codes are persisted', t => {
  const f = fixture(t);
  const content = readdirSync(f.directory).filter(n => n.startsWith('studio.sqlite')).map(n => readFileSync(join(f.directory, n))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
  assert.equal(content.includes(f.pair.token), false); assert.equal(content.includes(f.grant.code), false);
});
test('same request ID returns exact prior receipt; different payload conflicts', t => {
  const f = fixture(t); const input = { sessionId: f.pair.sessionId, requestId: 'request-0001', method: 'scene.children', args: { root: 'Workspace' } };
  const a = f.store.enqueue(input); const b = f.store.enqueue(input); assert.equal(a.id, b.id);
  assert.throws(() => f.store.enqueue({ ...input, args: { root: 'Workspace', limit: 5 } }), /different input/);
  assert.equal(f.store.commands().length, 1);
});
test('readonly pairing denies mutation and raw eval method is never accepted', t => {
  const f = fixture(t);
  assert.throws(() => f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'readonly-01', method: 'scene.update', args: { ref: f.ref, expected: { Name: 'Part' }, properties: { Name: 'New' } } }), /read-only/);
  assert.throws(() => f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'unsafe-0001', method: 'execute_luau', args: {} }), /Raw Luau/);
});
test('references cannot escape granted root or exact Studio session', t => {
  const f = fixture(t, true);
  for (const bad of [{ ...f.ref, root: 'ServerStorage' }, { ...f.ref, sessionId: 'other-window' }]) assert.throws(() => f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'scope-00001', method: 'scene.inspect', args: { ref: bad } }), /scope/);
  assert.throws(() => f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'scope-00002', method: 'scene.children', args: { root: 'ServerStorage' } }), /grant/);
});
test('safe properties reject arbitrary source, services, invalid ranges and incomplete baselines', t => {
  const f = fixture(t, true); const submit = (args: unknown) => f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'property-01', method: 'scene.update', args });
  assert.throws(() => submit({ ref: f.ref, expected: { Source: '' }, properties: { Source: 'print(1)' } }), /not writable/);
  assert.throws(() => submit({ ref: f.ref, expected: {}, properties: { Name: 'New' } }), /every changed/);
  assert.throws(() => submit({ ref: f.ref, expected: { Transparency: 0 }, properties: { Transparency: 2 } }), /0..1/);
  assert.throws(() => submit({ ref: { ...f.ref, pathSegments: [], className: 'Workspace' }, expected: { Name: 'Workspace' }, properties: { Name: 'Destroyed' } }), /not writable/);
  assert.throws(() => submit({ ref: f.ref, expected: { Size: { type: 'Vector3', value: [1, 1, 1] } }, properties: { Size: { type: 'Vector3', value: [-1, 0, 1] } } }), /dimensions/);
});
test('FIFO single-flight delivery fences later commands until receipt', t => {
  const f = fixture(t);
  const a = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'queue-00001', method: 'scene.children', args: { root: 'Workspace' } });
  const b = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'queue-00002', method: 'selection.read', args: {} });
  assert.deepEqual(f.store.poll(f.pair.sessionId).map(c => c.id), [a.id]); assert.deepEqual(f.store.poll(f.pair.sessionId), []);
  assert.equal(f.store.command(a.id).state, 'dispatched');
  f.store.result({ sessionId: f.pair.sessionId, commandId: a.id, state: 'succeeded', result: { items: [] } });
  assert.deepEqual(f.store.poll(f.pair.sessionId).map(c => c.id), [b.id]); assert.ok(b.leaseEpoch > a.leaseEpoch);
});
test('receipt retries are immutable; cross-session and undelivered results refused', t => {
  const f = fixture(t); const c = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'receipt-001', method: 'selection.read', args: {} });
  const r = { sessionId: f.pair.sessionId, commandId: c.id, state: 'succeeded', result: { items: [] } };
  assert.throws(() => f.store.result(r), /not delivered/); f.store.poll(f.pair.sessionId); f.store.result(r); f.store.result(r);
  assert.throws(() => f.store.result({ ...r, result: { items: ['different'] } }), /immutable/);
  assert.throws(() => f.store.result({ ...r, sessionId: 'other-window' }), /another Studio/);
});
test('mutation receipts must match requested baseline and intended result; restore is daemon-built', t => {
  const f = fixture(t, true); const ref = { ...f.ref, className: 'ModuleScript' };
  const c = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'source-0001', method: 'script.update', args: { ref, expectedSource: 'return 1', source: 'return 2' } });
  f.store.poll(f.pair.sessionId);
  const mutation = { kind: 'script.update', ref, before: { source: 'return 1' }, after: { source: 'return 2' } };
  assert.throws(() => f.store.result({ sessionId: f.pair.sessionId, commandId: c.id, state: 'succeeded', result: { mutation: { ...mutation, after: { source: 'return 3' } } } }), /intended/);
  f.store.result({ sessionId: f.pair.sessionId, commandId: c.id, state: 'succeeded', result: { ref, mutation } });
  const restore = f.store.restore({ commandId: c.id, requestId: 'restore-001' }); assert.equal(restore.method, 'scene.restore');
  assert.equal(canonical(restore.args.mutation), canonical(mutation));
  assert.throws(() => f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'inverse-001', method: 'scene.restore', args: restore.args }), /arbitrary inverse/);
});
test('dispatched expiry produces unknown outcome and blocks all new work; queued expiry cancels', t => {
  const f = fixture(t); const c = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'expire-0001', method: 'selection.read', args: {} });
  f.store.poll(f.pair.sessionId); f.advance(180001); f.store.poll(f.pair.sessionId);
  assert.equal(f.store.command(c.id).state, 'needs_reconciliation');
  assert.throws(() => f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'expire-0002', method: 'selection.read', args: {} }), /Unknown previous/);
  // A late known receipt may resolve ambiguity while session remains authenticated.
  f.store.result({ sessionId: f.pair.sessionId, commandId: c.id, state: 'succeeded', result: { items: [] } });
  const queued = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'expire-0003', method: 'selection.read', args: {} });
  f.advance(180001); assert.deepEqual(f.store.poll(f.pair.sessionId), []); assert.equal(f.store.command(queued.id).state, 'cancelled');
});
test('partial engine failure blocks queue instead of falsely advertising rollback', t => {
  const f = fixture(t, true); const c = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'partial-001', method: 'scene.update', args: { ref: f.ref, expected: { Name: 'Part' }, properties: { Name: 'New' } } });
  f.store.poll(f.pair.sessionId); f.store.result({ sessionId: f.pair.sessionId, commandId: c.id, state: 'failed', error: 'Restoration could not be verified', result: { partial: true } });
  assert.equal(f.store.command(c.id).state, 'needs_reconciliation');
  assert.throws(() => f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'partial-002', method: 'selection.read', args: {} }), /Unknown previous/);
});
test('revoke invalidates bearer, cancels undelivered work and preserves ambiguous delivered receipt', t => {
  const f = fixture(t); const a = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'revoke-0001', method: 'selection.read', args: {} });
  const b = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'revoke-0002', method: 'selection.read', args: {} });
  f.store.poll(f.pair.sessionId); f.store.revoke(f.pair.sessionId);
  assert.throws(() => f.store.authenticate(f.pair.sessionId, f.pair.token), /revoked/); assert.equal(f.store.command(a.id).state, 'needs_reconciliation'); assert.equal(f.store.command(b.id).state, 'cancelled');
});
test('workspace lock prevents second daemon and restart never replays unknown commands', t => {
  const f = fixture(t); assert.throws(() => new StudioStore({ directory: f.directory }), /already running/);
  const c = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'restart-001', method: 'selection.read', args: {} }); f.store.poll(f.pair.sessionId); f.store.close();
  const reopened = new StudioStore({ directory: f.directory }); t.after(() => reopened.close());
  assert.equal(reopened.command(c.id).state, 'needs_reconciliation'); assert.throws(() => reopened.authenticate(f.pair.sessionId, f.pair.token), /revoked/);
  assert.ok(reopened.events().some(e => e && typeof e === 'object' && !Array.isArray(e) && e.kind === 'daemon_started'));
  reopened.close();
});
test('a Studio reload leaves the old pairing listed as not live; commands to it are refused, never silently queued', t => {
  const f = fixture(t, true);
  // Reopening Studio is a new plugin lifetime: a new clientSessionId pairs while the old row stays unrevoked (stop() sends no disconnect).
  const grant = f.store.createGrant({ allowedRoots: ['Workspace'], allowWrites: true });
  const reopened = f.store.pair({ ...f.input, code: grant.code, identity: { ...f.input.identity, clientSessionId: 'native-window-A-reloaded' } });
  f.advance(61_000); f.store.poll(reopened.sessionId);
  const listed = f.store.sessions() as (ReturnType<StudioStore['sessions']>[number] & { live?: unknown })[];
  assert.equal(listed.find(s => s.id === f.pair.sessionId)?.revokedAt, null, 'the dead lifetime is still unrevoked');
  assert.equal(listed.find(s => s.id === f.pair.sessionId)?.live, false);
  assert.equal(listed.find(s => s.id === reopened.sessionId)?.live, true);
  assert.throws(() => f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'dead-000001', method: 'selection.read', args: {} }),
    (error: Error & { code?: string }) => error.code === 'SESSION_OFFLINE');
  assert.equal(f.store.commands().length, 0, 'no queued command is left behind for a dead session');
  assert.equal(f.store.enqueue({ sessionId: reopened.sessionId, requestId: 'live-000001', method: 'selection.read', args: {} }).state, 'queued');
});
test('a session executing a dispatched command stays live while it is not polling', t => {
  const f = fixture(t);
  f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'busy-000001', method: 'selection.read', args: {} }); f.store.poll(f.pair.sessionId);
  f.advance(90_000);
  assert.equal((f.store.sessions()[0] as { live?: unknown }).live, true);
  assert.equal(f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'busy-000002', method: 'selection.read', args: {} }).state, 'queued');
});
test('queued and dispatched commands of a session that stopped polling expire when read, not only on its next poll', t => {
  const f = fixture(t);
  const dispatched = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'stop-000001', method: 'selection.read', args: {} }); f.store.poll(f.pair.sessionId);
  const queued = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'stop-000002', method: 'selection.read', args: {} });
  f.advance(180_001); // The plugin was unloaded; poll() is never called again for this session.
  assert.equal(f.store.command(queued.id).state, 'cancelled');
  assert.equal(f.store.command(dispatched.id).state, 'needs_reconciliation');
  assert.deepEqual(f.store.commands(f.pair.sessionId).map(c => c.state).sort(), ['cancelled', 'needs_reconciliation']);
});
