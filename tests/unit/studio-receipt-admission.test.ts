import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixtureTempDirectory, makeFixtureDirectory } from './windows-fixture-paths.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { canonical, validateCommandArgs } from '../../packages/core/src/studio-policy.js';
import { READ_METHODS, WRITE_METHODS, type InstanceRef, type StudioCommand, type StudioMethod, type StudioSession } from '../../packages/protocol/src/studio.js';

const RESULT_BYTES = 512 * 1024;
const ARGUMENT_BYTES = 256 * 1024;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const REF: InstanceRef = { instanceId: 'opaque-script', sessionId: 'paired-session', root: 'Workspace', pathSegments: ['OriginalName'], className: 'Script' };
const RENAMED_REF: InstanceRef = { ...REF, pathSegments: ['RenamedFolder', 'RenamedScript'] };
const SOURCE = 'print("verified")';

// The real constructor owns the lock, schema and private admission/queue state.
// A second SQLite connection seeds only synthetic sessions and previously admitted
// commands, so receipt tests need no compiler, Studio, provider or HTTP listener.
// All on-disk data is confined to a freshly owned native-canonical TEMP directory.
class SyntheticReceiptStore {
  readonly db: DatabaseSync;
  readonly store: StudioStore;
  readonly session: StudioSession = {
    id: REF.sessionId, clientSessionId: 'synthetic-window', placeId: 0, universeId: 0,
    name: 'Synthetic receipt fixture', pluginVersion: 'fixture', protocolVersion: 1,
    allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true,
    capabilities: [...READ_METHODS, ...WRITE_METHODS], connectedAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString(), revokedAt: null,
  };
  private serial = 0;

  constructor(directory: string) {
    this.store = new StudioStore({ directory, now: () => 0 });
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(directory, 'studio.sqlite'), { allowExtension: false });
      db.prepare('INSERT INTO sessions(id,payload,token_hash) VALUES(?,?,?)').run(
        this.session.id, JSON.stringify(this.session), createHash('sha256').update('synthetic-receipt-session-only').digest('hex'));
      this.db = db;
    } catch (error) {
      try { db?.close(); } finally { this.store.close(); }
      throw error;
    }
  }

  dispatch(method: StudioMethod, args: unknown): StudioCommand {
    const validated = validateCommandArgs(method, args, this.session);
    const requestId = 'synthetic-receipt-' + ++this.serial;
    const epoch = this.db.prepare('UPDATE sessions SET epoch=epoch+1 WHERE id=? RETURNING epoch').get(this.session.id) as { epoch: number };
    const command: StudioCommand = {
      protocolVersion: 1, id: requestId, requestId, sessionId: this.session.id,
      clientSessionId: this.session.clientSessionId, method, args: validated,
      allowedRoots: [...this.session.allowedRoots], allowWrites: true, leaseEpoch: epoch.epoch,
      expiresAt: new Date(180000).toISOString(), state: 'queued', createdAt: new Date(0).toISOString(),
      finishedAt: null, result: null, error: null,
    };
    const fingerprint = createHash('sha256').update(canonical({ sessionId: command.sessionId, method, args })).digest('hex');
    this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?,?,?)').run(command.id, requestId, command.sessionId, fingerprint, command.state, JSON.stringify(command), 0);
    assert.deepEqual(this.store.poll(this.session.id).map(item => item.id), [command.id]);
    return this.store.command(command.id);
  }

  ack(command: StudioCommand, result: unknown): void {
    this.store.result({ sessionId: command.sessionId, commandId: command.id, state: 'succeeded', result });
  }

  close(): void { try { this.db.close(); } finally { this.store.close(); } }
}

function fixture(t: TestContext): SyntheticReceiptStore {
  const boundary = fixtureTempDirectory(), directory = makeFixtureDirectory('arcane-receipt-admission-');
  let receipt: SyntheticReceiptStore | undefined;
  t.after(() => {
    try { receipt?.close(); } finally {
      const child = relative(boundary, directory);
      assert.ok(child.startsWith('arcane-receipt-admission-') && !isAbsolute(child) && !child.includes(sep));
      assert.equal(lstatSync(directory).isSymbolicLink(), false);
      assert.equal(realpathSync.native(directory), directory);
      rmSync(directory, { recursive: true, force: true });
    }
  });
  receipt = new SyntheticReceiptStore(directory);
  return receipt;
}

function mutationCase(method: 'script.set_enabled' | 'script.update' | 'scene.update') {
  if (method === 'script.set_enabled') return {
    args: { ref: REF, expectedSource: SOURCE, expectedEnabled: false, enabled: true },
    mutation: { kind: method, ref: RENAMED_REF, before: { source: SOURCE, enabled: false }, after: { source: SOURCE, enabled: true } },
  };
  if (method === 'script.update') return {
    args: { ref: REF, expectedSource: SOURCE, source: 'print("updated")' },
    mutation: { kind: method, ref: RENAMED_REF, before: { source: SOURCE }, after: { source: 'print("updated")' } },
  };
  const ref: InstanceRef = { ...REF, className: 'Part' };
  return {
    args: { ref, expected: { Name: 'OriginalName' }, properties: { Name: 'RenamedScript' } },
    mutation: { kind: method, ref: { ...RENAMED_REF, className: 'Part' }, before: { properties: { Name: 'OriginalName' } }, after: { properties: { Name: 'RenamedScript' } } },
  };
}

for (const method of ['script.set_enabled', 'script.update', 'scene.update'] as const) {
  test(`${method}: renamed display path ACK is accepted and its receipt remains restorable`, t => {
    const f = fixture(t), sample = mutationCase(method), command = f.dispatch(method, sample.args);
    const result = { ref: sample.mutation.ref, mutation: sample.mutation };
    // Engine Registry:resolve binds the opaque ID to an Instance and checks its
    // session/root/class. pathSegments are intentionally display metadata, never
    // a lookup path or additional authority; a rename within the root is legal.
    assert.notDeepEqual(sample.mutation.ref.pathSegments, sample.args.ref.pathSegments);
    f.ack(command, result);
    f.ack(command, structuredClone(result));
    assert.equal(f.store.command(command.id).state, 'succeeded');
    assert.deepEqual(f.store.command(command.id).result, result);

    const restore = f.store.restore({ commandId: command.id, requestId: 'restore-renamed-receipt' });
    assert.equal(restore.method, 'scene.restore');
    assert.deepEqual(restore.args, { receiptCommandId: command.id, mutation: sample.mutation });
    assert.deepEqual(f.store.poll(f.session.id).map(item => item.id), [restore.id]);
    f.ack(restore, { restored: true, ref: sample.mutation.ref });
    assert.equal(f.store.command(restore.id).state, 'succeeded');
    assert.deepEqual(f.store.poll(f.session.id), []);
  });

  test(`${method}: a rename does not authorize a different class, opaque ID, session or granted root`, t => {
    const f = fixture(t), sample = mutationCase(method), command = f.dispatch(method, sample.args);
    const changes: Partial<InstanceRef>[] = [
      { className: sample.mutation.ref.className === 'Script' ? 'LocalScript' : 'Model' },
      { instanceId: 'different-instance' }, { sessionId: 'different-session' }, { root: 'ServerStorage' },
    ];
    for (const change of changes) {
      const ref = { ...sample.mutation.ref, ...change };
      assert.throws(() => f.ack(command, { ref, mutation: { ...sample.mutation, ref } }), { code: 'RECEIPT' });
      assert.equal(f.store.command(command.id).state, 'dispatched');
      assert.equal(f.store.command(command.id).result, null);
      assert.equal(f.store.command(command.id).finishedAt, null);
    }
    f.ack(command, { ref: sample.mutation.ref, mutation: sample.mutation });
    assert.equal(f.store.command(command.id).state, 'succeeded');
  });

  test(`${method}: display metadata must still be a bounded string path`, t => {
    const f = fixture(t), sample = mutationCase(method), command = f.dispatch(method, sample.args);
    for (const pathSegments of ['not-an-array', [42], ['x'.repeat(257)], Array<string>(65).fill('name')]) {
      const ref = { ...sample.mutation.ref, pathSegments };
      assert.throws(() => f.ack(command, { ref, mutation: { ...sample.mutation, ref } }), { code: 'INPUT' });
      assert.equal(f.store.command(command.id).state, 'dispatched');
      assert.equal(f.store.command(command.id).result, null);
    }
  });
}

test('renamed activation receipts still require the exact before/after source and boolean state', t => {
  const f = fixture(t), sample = mutationCase('script.set_enabled'), command = f.dispatch('script.set_enabled', sample.args);
  const original = sample.mutation;
  for (const change of [
    { before: { source: SOURCE + ' ', enabled: false } }, { after: { source: SOURCE + ' ', enabled: true } },
    { before: { source: SOURCE, enabled: true } }, { after: { source: SOURCE, enabled: false } },
    { before: { source: SOURCE, enabled: 'false' } }, { after: { source: SOURCE, enabled: 1 } },
  ]) {
    assert.throws(() => f.ack(command, { ref: original.ref, mutation: { ...original, ...change } }), { code: 'RECEIPT' });
    assert.equal(f.store.command(command.id).state, 'dispatched');
    assert.equal(f.store.command(command.id).result, null);
  }
  f.ack(command, { ref: original.ref, mutation: original });
  assert.equal(f.store.command(command.id).state, 'succeeded');
});

test('read result ACK accepts exactly 512 KiB, rejects one extra byte and unblocks the queue', t => {
  const f = fixture(t), command = f.dispatch('selection.read', {});
  // This synthetic read payload tests the daemon JSON budget, not engine output.
  const result = { fixture: 'x'.repeat(RESULT_BYTES - bytes({ fixture: '' })) };
  const oversized = { fixture: result.fixture + 'x' };
  assert.equal(bytes(result), RESULT_BYTES);
  assert.equal(bytes({ value: result }), RESULT_BYTES + 10);
  assert.equal(bytes(oversized), RESULT_BYTES + 1);
  assert.throws(() => f.ack(command, oversized), { code: 'BODY_LIMIT' });
  assert.equal(f.store.command(command.id).state, 'dispatched');
  assert.equal(f.store.command(command.id).result, null);
  f.ack(command, result);
  f.ack(command, structuredClone(result));
  assert.equal(f.store.command(command.id).state, 'succeeded');
  assert.deepEqual(f.store.command(command.id).result, result);
  const next = f.store.enqueue({ sessionId: f.session.id, requestId: 'read-after-boundary', method: 'selection.read', args: {} });
  assert.deepEqual(f.store.poll(f.session.id).map(item => item.id), [next.id]);
});

test('JSON-expanded disable ACK fits the actual result budget despite crossing the old wrapper budget', t => {
  const f = fixture(t);
  // Control bytes in a long comment expand to six JSON bytes each. Disabling
  // requires no compiler; this fixture claims neither compilation nor execution.
  const prefix = '--[[' + '\u0001'.repeat(43600), suffix = ']]';
  const args = { ref: REF, expectedSource: prefix + suffix, expectedEnabled: true, enabled: false };
  args.expectedSource = prefix + 'x'.repeat(ARGUMENT_BYTES - bytes(args)) + suffix;
  assert.equal(Buffer.byteLength(args.expectedSource, 'utf8'), 43946);
  assert.equal(bytes(args), ARGUMENT_BYTES);
  assert.ok(Buffer.byteLength(args.expectedSource, 'utf8') < 100 * 1024);
  // Exercise real command admission as well as result admission for this disable.
  const command = f.store.enqueue({ sessionId: f.session.id, requestId: 'expanded-disable-boundary', method: 'script.set_enabled', args });
  assert.deepEqual(f.store.poll(f.session.id).map(item => item.id), [command.id]);
  const result = { ref: REF, mutation: { kind: 'script.set_enabled', ref: REF,
    before: { source: args.expectedSource, enabled: true }, after: { source: args.expectedSource, enabled: false } } };
  assert.equal(bytes(result), 524286);
  assert.equal(bytes({ value: result }), 524296);
  assert.ok(bytes(result) <= RESULT_BYTES && bytes({ value: result }) > RESULT_BYTES);
  f.ack(command, result);
  assert.equal(f.store.command(command.id).state, 'succeeded');
  assert.deepEqual(f.store.command(command.id).result, result);
  assert.deepEqual(f.store.poll(f.session.id), []);
});
