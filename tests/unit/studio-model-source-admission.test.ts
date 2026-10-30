import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { READ_METHODS, WRITE_METHODS, ASSET_STAGE_METHODS, type InstanceRef } from '../../packages/protocol/src/studio.js';
import { recordReviewedOriginalRun } from '../helpers/asset-review-boundary-fixture.js';
import { makeFixtureDirectory } from './windows-fixture-paths.js';

// Real SQLite queue and receipt validation; the policy identities and plugin
// acknowledgements are controlled host fixtures, not native/Studio proof.
function fixture(t: TestContext) {
  const directory = makeFixtureDirectory('arcane-model-source-');
  let now = Date.now(), store = new StudioStore({ directory, now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1,
    identity: { clientSessionId: 'model-source-window', placeId: 12, universeId: 34, name: 'Source fixture', pluginVersion: '0.1.9' },
    capabilities: [...READ_METHODS, ...WRITE_METHODS, ...ASSET_STAGE_METHODS] });
  const root: InstanceRef = { sessionId: pair.sessionId, instanceId: 'fixture-workspace', root: 'Workspace', pathSegments: [], className: 'Workspace' };
  const template: InstanceRef = { ...root, instanceId: 'external-template', pathSegments: ['Existing model'], className: 'Model' };
  const proof = { sessionId: pair.sessionId, clientLifetimeId: 'model-source-window', pluginArtifactHash: 'b'.repeat(64),
    markerName: 'ArcaneTestProof_model_source', placeId: 12, universeId: 34, placeName: 'Source fixture',
    mode: 'Edit', playEpoch: 0, continuitySupported: true, connected: true };
  store.poll(pair.sessionId, proof);
  let manual = false;
  const active = new WeakSet<object>(), seen: (object | undefined)[] = [];
  const read = (sessionId: string, admission?: object): boolean => {
    assert.equal(sessionId, pair.sessionId); seen.push(admission);
    return admission === undefined ? manual : active.has(admission);
  };
  let release = store.bindModelSourcePolicy(read);
  return { directory, pair, root, template, proof, seen, read,
    get store() { return store; },
    manual(value: boolean) { manual = value; },
    mint() { const admission = Object.freeze({}); active.add(admission); return admission; },
    retire(admission: object) { active.delete(admission); },
    unbind() { release(); },
    rebind(next: typeof read) { release = store.bindModelSourcePolicy(next); },
    advance(ms: number) { now += ms; },
    reopen() { store.close(); store = new StudioStore({ directory, now: () => now }); },
  };
}
type Fixture = ReturnType<typeof fixture>;
const forest = (f: Fixture, requestId: string) => ({ sessionId: f.pair.sessionId, requestId, method: 'scene.build',
  args: { parent: f.root, container: { className: 'Model', name: 'Forest' }, prototypes: [], templates: [f.template],
    items: [{ kind: 'clone', template: 1, name: 'Tree', parent: 0, at: [0, 0, 0], yaw: 0, scale: 1 }] } });
const ack = (f: Fixture, commandId: string) => {
  const ref = { ...f.root, instanceId: 'placed-' + commandId, pathSegments: ['Forest'], className: 'Model' };
  const counts = { count: 2, classes: { Model: 2 } };
  return { sessionId: f.pair.sessionId, commandId, state: 'succeeded', result: { ref, created: counts,
    mutation: { kind: 'scene.build', ref, before: null, after: counts } } };
};

test('model-source admission: manual session choice and exact agent command identity remain independent', async t => {
  const f = fixture(t), allowed = f.mint(), invalid = Object.freeze({});
  f.manual(true);
  for (const admission of [invalid, { ...allowed }, new Proxy(allowed, {})]) {
    assert.throws(() => f.store.enqueue({ ...forest(f, 'invalid-agent'), modelSourceAdmission: allowed }, false, undefined, admission), { code: 'TEMPLATE_SOURCE' });
  }
  assert.equal(f.store.commands().length, 0);
  const human = f.store.enqueue(forest(f, 'manual-source'));
  assert.equal(human.state, 'queued');
  f.manual(false);
  const agent = await f.store.enqueueVerified(forest(f, 'agent-source'), null, () => {}, false, allowed);
  assert.equal(agent.state, 'queued');
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof).map(command => command.id), [agent.id]);
  assert.equal(f.store.command(human.id).state, 'cancelled');
  assert.equal(f.store.command(agent.id).state, 'dispatched');
  assert.ok(f.seen.includes(allowed)); assert.ok(f.seen.includes(undefined));
});

test('model-source admission: exact-request replay cannot replace a retired original queued admission', async t => {
  const f = fixture(t), original = f.mint(), later = f.mint(), input = forest(f, 'retained-source');
  const command = await f.store.enqueueVerified(input, null, () => {}, false, original);
  f.retire(original);
  assert.equal((await f.store.enqueueVerified(input, null, () => {}, false, later)).id, command.id);
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
  assert.equal(f.store.command(command.id).state, 'cancelled');
  assert.match(f.store.command(command.id).error!, /This operation was not sent/);
  assert.equal(f.seen.includes(later), false);
  assert.equal(f.store.enqueue(input, false, undefined, later).state, 'cancelled');
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
});

test('model-source admission: queued commands retain distinct original task admissions in FIFO order', t => {
  const f = fixture(t), first = f.mint(), next = f.mint();
  const old = f.store.enqueue(forest(f, 'first-task-source'), false, undefined, first);
  const current = f.store.enqueue(forest(f, 'next-task-source'), false, undefined, next);
  f.retire(first);
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof).map(command => command.id), [current.id]);
  assert.equal(f.store.command(old.id).state, 'cancelled');
  assert.equal(f.store.command(current.id).state, 'dispatched');
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
});

test('model-source admission: a replacement policy binding cannot authorize an earlier queued command', t => {
  const f = fixture(t), original = f.mint();
  const command = f.store.enqueue(forest(f, 'bound-policy-source'), false, undefined, original);
  f.unbind();
  let replacementReads = 0;
  f.rebind(() => { replacementReads++; return true; });
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
  assert.equal(f.store.command(command.id).state, 'cancelled');
  assert.equal(replacementReads, 0);
});

test('model-source admission: rebinding the same callback still cannot revive its earlier command admission', t => {
  const f = fixture(t), original = f.mint();
  const command = f.store.enqueue(forest(f, 'same-policy-source'), false, undefined, original);
  const reads = f.seen.length;
  f.unbind(); f.rebind(f.read);
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
  assert.equal(f.store.command(command.id).state, 'cancelled');
  assert.equal(f.seen.length, reads);
});

test('model-source admission: retirement during a held request tail refuses enqueue without allocating a receipt', async t => {
  const f = fixture(t), original = f.mint();
  f.manual(true); // A stale agent cannot fall back to the independent manual choice.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // The route captures this exact host object before awaiting its body. Its
  // actual HTTP boundary is covered by the native route integration fixture.
  const incoming = (async () => { await held; return f.store.enqueueVerified(forest(f, 'held-source-body'), null, () => {}, false, original); })();
  f.retire(original); release();
  await assert.rejects(incoming, { code: 'TEMPLATE_SOURCE' });
  assert.equal(f.store.commands().length, 0);
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
});

test('model-source admission: primitive builds do not acquire an external-model permission', async t => {
  const f = fixture(t), invalid = Object.freeze({});
  const input = { sessionId: f.pair.sessionId, requestId: 'explicit-blockout', method: 'scene.build',
    args: { parent: f.root, container: { className: 'Model', name: 'Blockout' }, prototypes: [],
      items: [{ kind: 'group', className: 'Folder', name: 'Explicit group', parent: 0 }] } };
  const command = await f.store.enqueueVerified(input, null, () => {}, false, invalid);
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof).map(value => value.id), [command.id]);
  assert.deepEqual(f.seen, []);
});

test('model-source admission: original reviewed reconstruction remains exempt with an invalid external admission', async t => {
  const f = fixture(t), transfer = 'a'.repeat(64);
  recordReviewedOriginalRun(f.store, f.pair.sessionId, transfer, f.root.instanceId, f.proof);
  const placement = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'original-source-place', method: 'scene.place_asset',
    args: { watch: 'editable-' + transfer, parent: f.root, name: 'Original model', position: [0, 0, 0], yaw: 0, ground: true, anchor: true, allowScripts: false } });
  assert.equal(f.store.poll(f.pair.sessionId, f.proof)[0]?.id, placement.id);
  f.store.result({ sessionId: f.pair.sessionId, commandId: placement.id, state: 'succeeded', result: {
    ref: f.template, removedScripts: { count: 0, classes: {}, names: [] },
    mutation: { kind: 'scene.place_asset', ref: f.template, before: null, after: { descendants: 3, removedScripts: 0, keptScripts: 0, scale: 1 } } } });
  const command = await f.store.enqueueVerified(forest(f, 'original-source-clone'), null, () => {}, false, Object.freeze({}));
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof).map(value => value.id), [command.id]);
  assert.deepEqual(f.seen, []);
});

test('model-source admission: permission loss after dispatch preserves an authenticated original success receipt', t => {
  const f = fixture(t), original = f.mint(), input = forest(f, 'delivered-source');
  const command = f.store.enqueue(input, false, undefined, original);
  assert.equal(f.store.poll(f.pair.sessionId, f.proof)[0]?.id, command.id);
  const reads = f.seen.length;
  f.retire(original); f.unbind();
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
  assert.equal(f.store.command(command.id).state, 'dispatched');
  const receipt = ack(f, command.id);
  f.store.result(receipt); f.store.result(receipt);
  assert.equal(f.store.command(command.id).state, 'succeeded');
  assert.equal(f.store.enqueue(input, false, undefined, Object.freeze({})).state, 'succeeded');
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
  assert.equal(f.seen.length, reads);
  assert.equal(f.store.commands().length, 1);
});

test('model-source admission: lost dispatched acknowledgement stays unknown without replay after permission loss', t => {
  const f = fixture(t), original = f.mint(), input = forest(f, 'unknown-source');
  const command = f.store.enqueue(input, false, undefined, original);
  assert.equal(f.store.poll(f.pair.sessionId, f.proof)[0]?.id, command.id);
  f.retire(original); f.advance(180001);
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
  assert.equal(f.store.command(command.id).state, 'needs_reconciliation');
  assert.equal(f.store.enqueue(input, false, undefined, f.mint()).state, 'needs_reconciliation');
  assert.throws(() => f.store.enqueue(forest(f, 'new-after-unknown'), false, undefined, f.mint()), { code: 'RECONCILIATION' });
  f.store.result(ack(f, command.id));
  assert.equal(f.store.command(command.id).state, 'succeeded');
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
});

test('model-source admission: reopen retains the original cancelled receipt without restoring an opaque task permit', t => {
  const f = fixture(t), original = f.mint(), input = forest(f, 'reopened-source');
  const command = f.store.enqueue(input, false, undefined, original);
  f.reopen();
  assert.equal(f.store.command(command.id).state, 'cancelled');
  assert.throws(() => f.store.authenticate(f.pair.sessionId, f.pair.token), /revoked/);
  f.store.bindModelSourcePolicy(() => true);
  assert.equal(f.store.enqueue(input, false, undefined, original).id, command.id);
  assert.equal(f.store.command(command.id).state, 'cancelled');
  assert.throws(() => f.store.poll(f.pair.sessionId), { code: 'REVOKED' });
});

const externalPlacement = (f: Fixture, requestId: string) => ({ sessionId: f.pair.sessionId, requestId, method: 'scene.place_asset',
  args: { watch: 'original-external-watch', parent: f.root, name: 'External model', position: [0, 0, 0], yaw: 0, ground: true, anchor: true, allowScripts: false } });
const placementAck = (f: Fixture, commandId: string) => {
  const ref = { ...f.template, instanceId: 'adopted-' + commandId };
  return { sessionId: f.pair.sessionId, commandId, state: 'succeeded', result: { ref, removedScripts: { count: 0, classes: {}, names: [] },
    mutation: { kind: 'scene.place_asset', ref, before: null, after: { descendants: 2, removedScripts: 0, keptScripts: 0, scale: 1 } } } };
};

test('external adoption: exact task permit enables the watch while human manual preference remains a separate path', async t => {
  const f = fixture(t), original = f.mint(), invalid = Object.freeze({});
  assert.throws(() => f.store.enqueue(externalPlacement(f, 'default-adoption')), { code: 'TEMPLATE_SOURCE' });
  f.manual(true);
  assert.throws(() => f.store.enqueue(externalPlacement(f, 'invalid-adoption'), false, undefined, invalid), { code: 'TEMPLATE_SOURCE' });
  assert.equal(f.store.commands().length, 0);
  const human = f.store.enqueue(externalPlacement(f, 'human-adoption'));
  f.manual(false);
  const task = await f.store.enqueueVerified(externalPlacement(f, 'task-adoption'), null, () => {}, false, original);
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof).map(command => command.id), [task.id]);
  assert.equal(f.store.command(human.id).state, 'cancelled');
  f.store.result(placementAck(f, task.id));
  f.manual(true);
  const manual = f.store.enqueue(externalPlacement(f, 'manual-adoption'));
  assert.equal(f.store.poll(f.pair.sessionId, f.proof)[0]?.id, manual.id);
  f.store.result(placementAck(f, manual.id));
  assert.equal(f.store.command(task.id).state, 'succeeded');
  assert.equal(f.store.command(manual.id).state, 'succeeded');
});

test('external adoption: a revoked queued operation cannot borrow a later permit through exact-request replay', async t => {
  const f = fixture(t), original = f.mint(), later = f.mint(), input = externalPlacement(f, 'held-adoption');
  const command = await f.store.enqueueVerified(input, null, () => {}, false, original);
  f.retire(original);
  assert.equal((await f.store.enqueueVerified(input, null, () => {}, false, later)).id, command.id);
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
  assert.equal(f.store.command(command.id).state, 'cancelled');
  assert.match(f.store.command(command.id).error!, /This operation was not sent/);
  assert.equal(f.seen.includes(later), false);
  const fresh = f.store.enqueue(externalPlacement(f, 'fresh-adoption'), false, undefined, later);
  assert.equal(f.store.poll(f.pair.sessionId, f.proof)[0]?.id, fresh.id);
});

for (const lost of [false, true]) test('external adoption: offered ' + (lost ? 'unknown' : 'successful') + ' outcome keeps its actual original receipt after source permission ends', t => {
  const f = fixture(t), original = f.mint(), input = externalPlacement(f, lost ? 'unknown-adoption' : 'offered-adoption');
  const command = f.store.enqueue(input, false, undefined, original);
  assert.equal(f.store.poll(f.pair.sessionId, f.proof)[0]?.id, command.id);
  const reads = f.seen.length; f.retire(original); f.unbind();
  if (lost) f.advance(180001);
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
  assert.equal(f.store.command(command.id).state, lost ? 'needs_reconciliation' : 'dispatched');
  const receipt = placementAck(f, command.id);
  f.store.result(receipt); f.store.result(receipt);
  assert.equal(f.store.command(command.id).state, 'succeeded');
  assert.equal(f.store.enqueue(input, false, undefined, Object.freeze({})).state, 'succeeded');
  assert.equal(f.seen.length, reads);
  assert.deepEqual(f.store.poll(f.pair.sessionId, f.proof), []);
  assert.equal(f.store.commands().length, 1);
});
