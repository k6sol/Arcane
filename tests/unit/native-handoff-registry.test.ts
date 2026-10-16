import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { NATIVE_HANDOFF_LIMITS, NativeHandoffError, NativeHandoffRegistry, type NativeHandoffLease } from '../../apps/daemon/src/native-handoff-registry.js';

const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });
// In-memory registry only: no route, Electron, CLI, inference, Studio or filesystem mutation by the registry.
const code = (name: NativeHandoffError['code']) => (error: unknown) => error instanceof NativeHandoffError && error.code === name;
async function fixture(t: test.TestContext, lifetimeMs?: number) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-handoff-registry-')));
  const project = join(root, 'project'), other = join(root, 'other'); await mkdir(project); await mkdir(other);
  const clock = { now: 1_800_000_000_000 };
  const registry = new NativeHandoffRegistry({ projectPath: project, now: () => clock.now, ...(lifetimeMs ? { lifetimeMs } : {}) });
  t.after(async () => { registry.close(); const part = relative(base, root); assert.ok(part.startsWith('arcane-handoff-registry-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true }); });
  return { registry, project, other, clock };
}
const tokenFree = (value: unknown, credential: string) => {
  for (const text of [JSON.stringify(value) ?? '', inspect(value, { depth: 8, showHidden: false }), String(value)]) assert.ok(!text.includes(credential), 'credential leaked: ' + text.slice(0, 80));
};

test('pending credentials never authenticate; one host seal admits exactly the external-handoff audience and scopes', async t => {
  const { registry } = await fixture(t), receipt = registry.begin();
  assert.match(receipt.credential, /^[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(receipt.credential, 'base64url').length, 32);
  assert.equal(receipt.state, 'pending'); assert.equal(registry.recognize(receipt.credential), null, 'pending cannot authenticate');
  assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.createdAt), NATIVE_HANDOFF_LIMITS.lifetimeMs, 'default 30 minutes');
  const sealed = registry.seal(receipt.lease); assert.equal(sealed.state, 'sealed'); assert.ok(sealed.sealedAt);
  const auth = registry.recognize(receipt.credential)!;
  assert.deepEqual({ ...auth, scopes: [...auth.scopes] }, { handoffId: receipt.handoffId, audience: 'external-handoff', scopes: ['work-coordination', 'studio-granted-commands'],
    projectId: receipt.projectId, expiresAt: receipt.expiresAt });
  assert.ok(Object.isFrozen(auth) && Object.isFrozen(auth.scopes));
  assert.throws(() => registry.seal(receipt.lease), code('STATE'), 'duplicate seal');
  const second = registry.begin(); assert.notEqual(second.handoffId, receipt.handoffId); assert.notEqual(second.credential, receipt.credential);
  assert.equal(registry.recognize(second.credential), null);
  for (const bad of [undefined, null, '', 'x', receipt.credential + 'A', receipt.credential.slice(1), ' ' + receipt.credential, 42, { toString: () => receipt.credential }])
    assert.equal(registry.recognize(bad), null);
});

test('wrong-registry, JSON-forged and copied leases are refused; revoke is terminal, idempotent and never revives', async t => {
  const a = await fixture(t), b = await fixture(t), receipt = a.registry.begin();
  const forged = JSON.parse(JSON.stringify({ ...receipt, lease: {} })).lease as NativeHandoffLease;
  for (const lease of [forged, Object.freeze(Object.create(null)), b.registry.begin().lease, { ...receipt.lease }, null, undefined, 'lease'])
    assert.throws(() => a.registry.seal(lease as NativeHandoffLease), code('LEASE'));
  assert.throws(() => b.registry.seal(receipt.lease), code('LEASE'), 'a lease only works in its issuing registry');
  const revoked = a.registry.revoke(receipt.lease); assert.deepEqual([revoked.state, revoked.endedAt !== null], ['revoked', true]);
  assert.throws(() => a.registry.seal(receipt.lease), code('STATE'), 'a revoked pending lease cannot be sealed');
  assert.equal(a.registry.revoke(receipt.lease).state, 'revoked', 'duplicate revoke is idempotent');
  const live = a.registry.begin(); a.registry.seal(live.lease); assert.ok(a.registry.recognize(live.credential));
  a.registry.revoke(live.lease); assert.equal(a.registry.recognize(live.credential), null, 'revocation is immediate');
  assert.throws(() => a.registry.seal(live.lease), code('STATE'));
});

test('expiry is fixed (no renewal) and a backward clock never revives an expired credential', async t => {
  const { registry, clock } = await fixture(t, 60_000), receipt = registry.begin(); registry.seal(receipt.lease);
  clock.now += 59_999; assert.ok(registry.recognize(receipt.credential), 'live until its bound');
  assert.equal(registry.status(receipt.lease).expiresAt, receipt.expiresAt, 'use never renews');
  clock.now += 1; assert.equal(registry.recognize(receipt.credential), null); assert.equal(registry.status(receipt.lease).state, 'expired');
  clock.now -= 3_600_000; assert.equal(registry.recognize(receipt.credential), null, 'rollback does not revive'); assert.equal(registry.status(receipt.lease).state, 'expired');
  const pending = registry.begin(); assert.equal(Date.parse(pending.createdAt), clock.now + 3_600_000, 'observed time stays monotonic');
  clock.now += 3_600_000 + 60_000; assert.throws(() => registry.seal(pending.lease), code('STATE'), 'an expired pending lease cannot be sealed');
  const bad = await fixture(t), broken = { value: 'later' as unknown };
  assert.throws(() => new NativeHandoffRegistry({ projectPath: bad.project, now: () => broken.value as number }), code('CLOCK'));
  for (const lifetimeMs of [0, 999, NATIVE_HANDOFF_LIMITS.lifetimeMs + 1, 1.5, '60000'])
    assert.throws(() => new NativeHandoffRegistry({ projectPath: bad.project, lifetimeMs }), code('INPUT'), 'lifetime ' + String(lifetimeMs));
});

test('a project identity transition and close end every credential immediately; same-project transition is a no-op', async t => {
  const { registry, project, other } = await fixture(t), sealed = registry.begin(), pending = registry.begin(); registry.seal(sealed.lease);
  registry.transitionProject(project + sep); assert.ok(registry.recognize(sealed.credential), 'the same canonical identity keeps credentials');
  registry.transitionProject(other);
  assert.equal(registry.recognize(sealed.credential), null); assert.deepEqual([registry.status(sealed.lease).state, registry.status(pending.lease).state], ['project_changed', 'project_changed']);
  assert.throws(() => registry.seal(pending.lease), code('STATE'));
  registry.transitionProject(project); assert.equal(registry.recognize(sealed.credential), null, 'returning to the old project does not revive');
  assert.throws(() => registry.transitionProject(join(other, 'missing')), code('PROJECT'));
  const fresh = registry.begin(); registry.seal(fresh.lease); assert.equal(fresh.projectId, sealed.projectId, 'a new handoff binds the current (original) identity');
  registry.close(); registry.close();
  assert.equal(registry.recognize(fresh.credential), null); assert.equal(registry.status(fresh.lease).state, 'closed');
  for (const action of [() => registry.begin(), () => registry.seal(fresh.lease), () => registry.revoke(fresh.lease), () => registry.transitionProject(project)]) assert.throws(action, code('CLOSED'));
});

test('bounded capacity refuses before minting; retention never silently evicts', async t => {
  const { registry } = await fixture(t), receipts = Array.from({ length: NATIVE_HANDOFF_LIMITS.active }, () => registry.begin());
  assert.throws(() => registry.begin(), code('CAPACITY')); assert.equal(registry.list().length, NATIVE_HANDOFF_LIMITS.active, 'nothing minted on refusal');
  registry.revoke(receipts[0]!.lease); const replacement = registry.begin(); assert.equal(replacement.state, 'pending');
  for (const receipt of [...receipts.slice(1), replacement]) registry.revoke(receipt.lease);
  while (registry.list().length < NATIVE_HANDOFF_LIMITS.retained) registry.revoke(registry.begin().lease);
  const before = registry.list();
  assert.throws(() => registry.begin(), code('RETENTION')); assert.deepEqual(registry.list(), before, 'no record was evicted or minted');
  assert.ok(before.every(entry => entry.state === 'revoked'));
});

test('status, list, errors and serialization are detached and token-free', async t => {
  const { registry } = await fixture(t), receipt = registry.begin(); registry.seal(receipt.lease);
  const status = registry.status(receipt.lease), list = registry.list();
  assert.deepEqual(Object.keys(status).sort(), ['createdAt', 'endedAt', 'expiresAt', 'handoffId', 'projectId', 'sealedAt', 'state']);
  assert.throws(() => { (status as { state: string }).state = 'pending'; }); assert.equal(registry.status(receipt.lease).state, 'sealed', 'detached immutable metadata');
  assert.deepEqual(Object.keys(receipt).sort(), Object.keys(status).sort(), 'the credential and lease are not enumerable on the receipt');
  for (const value of [receipt, status, list, registry, registry.recognize(receipt.credential), registry.toJSON()]) tokenFree(value, receipt.credential);
  for (const action of [() => registry.seal(receipt.lease), () => registry.begin.call({} as never), () => new NativeHandoffRegistry({ projectPath: receipt.credential })]) {
    try { action(); assert.fail('expected refusal'); } catch (error) { tokenFree(error, receipt.credential); tokenFree(String((error as Error).stack), receipt.credential); }
  }
  assert.deepEqual(registry.toJSON(), { closed: false, records: 1 });
});

test('invalid, proxy and accessor envelopes are refused without traps; recognition infers no other authority', async t => {
  const { registry, project } = await fixture(t); let traps = 0, getters = 0;
  const proxy = new Proxy({ projectPath: project }, { get() { traps++; return project; }, ownKeys() { traps++; return ['projectPath']; }, getOwnPropertyDescriptor() { traps++; return { value: project, enumerable: true, configurable: true }; } });
  const accessor = Object.defineProperty({}, 'projectPath', { get() { getters++; return project; }, enumerable: true });
  class Options { projectPath = project; }
  for (const options of [proxy, accessor, new Options(), null, undefined, project, [project], { projectPath: project, extra: 1 }, { projectPath: 1 }, { [Symbol('x')]: 1, projectPath: project },
    { projectPath: project, now: new Proxy(() => 1, {}) }, { projectPath: project, now: 1 }, {}])
    assert.throws(() => new NativeHandoffRegistry(options), code('INPUT'));
  assert.equal(traps, 0); assert.equal(getters, 0);
  assert.throws(() => registry.transitionProject(42), code('INPUT'));
  const receipt = registry.begin(); registry.seal(receipt.lease); const auth = registry.recognize(receipt.credential)! as unknown as Record<string, unknown>;
  assert.deepEqual([...(auth.scopes as string[])], ['work-coordination', 'studio-granted-commands']);
  for (const key of ['asset', 'assets', 'review', 'grant', 'revoke', 'login', 'taskId', 'runId', 'credential', 'token', 'lease']) assert.ok(!(key in auth), 'no ' + key + ' authority');
  assert.notStrictEqual(registry.recognize(receipt.credential), registry.recognize(receipt.credential), 'each recognition is a fresh detached read of the live registry');
});

const MAX_DATE_MS = 8_640_000_000_000_000;
test('out-of-range constructor time and near-maximum time plus lifetime are refused before any mint; the registry stays usable', async t => {
  const { registry, project, clock } = await fixture(t, 60_000);
  for (const value of [MAX_DATE_MS + 1, Number.MAX_SAFE_INTEGER, MAX_DATE_MS, MAX_DATE_MS - 59_999])
    assert.throws(() => new NativeHandoffRegistry({ projectPath: project, now: () => value, lifetimeMs: 60_000 }), code('CLOCK'), 'constructor time ' + value);
  const edge = new NativeHandoffRegistry({ projectPath: project, now: () => MAX_DATE_MS - 60_000, lifetimeMs: 60_000 });
  assert.equal(edge.begin().expiresAt, new Date(MAX_DATE_MS).toISOString(), 'the exact maximum expiry is representable'); edge.close();
  const sealed = registry.begin(); registry.seal(sealed.lease); const before = registry.list(), saved = clock.now;
  for (const value of [MAX_DATE_MS - 59_999, MAX_DATE_MS, Number.MAX_SAFE_INTEGER, 1.5, -1, Number.NaN]) {
    clock.now = value;
    assert.throws(() => registry.begin(), code('CLOCK'), 'begin at ' + value);
    assert.equal(registry.recognize(sealed.credential), null, 'an invalid clock fails closed');
    clock.now = saved;
    assert.deepEqual(registry.list(), before, 'record inventory unchanged after refusal at ' + value);
  }
  assert.ok(registry.recognize(sealed.credential), 'a valid clock again: nothing advanced, expired or minted');
  const after = registry.begin(); assert.equal(after.state, 'pending'); assert.equal(registry.list().length, before.length + 1, 'still usable');
});

test('a clock returning a rejected (cross-realm) promise or a thenable is CLOCK with no unhandled rejection; thenables are never invoked', async t => {
  const { project } = await fixture(t); let thenCalls = 0, mode = 0;
  const returns: (() => unknown)[] = [() => 1_800_000_000_000, () => Promise.reject(new Error('clock')), () => runInNewContext('Promise.reject(new Error("cross-realm clock"))'),
    () => ({ then() { thenCalls++; } })];
  const registry = new NativeHandoffRegistry({ projectPath: project, now: (() => returns[mode]!()) as () => number });
  t.after(() => registry.close());
  const live = registry.begin(); registry.seal(live.lease); const before = registry.list();
  for (mode = 1; mode < returns.length; mode++) {
    assert.throws(() => registry.begin(), code('CLOCK'), 'begin mode ' + mode);
    assert.equal(registry.recognize(live.credential), null, 'recognize fails closed in mode ' + mode);
  }
  for (mode = 1; mode < returns.length; mode++) assert.throws(() => new NativeHandoffRegistry({ projectPath: project, now: (() => returns[mode]!()) as () => number }), code('CLOCK'));
  mode = 0; assert.deepEqual(registry.list(), before); assert.ok(registry.recognize(live.credential));
  await delay(30);
  assert.equal(thenCalls, 0, 'an arbitrary thenable is never inspected or invoked');
  assert.deepEqual(unhandled, [], 'real rejected promises were observed before refusal');
});
