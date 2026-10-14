import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import type { ScriptSourceVerification, ScriptSourceVerifier } from '../../packages/core/src/script-source-verifier.js';
import { engineProperties } from '../../packages/core/src/studio-policy.js';
import { READ_METHODS, WRITE_METHODS, object, type InstanceRef, type Json, type StudioCommand } from '../../packages/protocol/src/studio.js';

const SOURCE = '--!strict\r\nprint("\u{1f680}")\r\n';
const sha256 = (source: string): string => createHash('sha256').update(source, 'utf8').digest('hex');
const COMPILER_SHA256 = sha256('SYNTHETIC TRUSTED HOST FACADE; NO COMPILER IS EXECUTED');
const proof = (source: string): ScriptSourceVerification => Object.freeze({
  sourceSha256: sha256(source), compilerSha256: COMPILER_SHA256, syntaxVerified: true, elapsedMs: 1.25,
});

function fixture(t: TestContext, options: { allowWrites?: boolean; capabilities?: string[] } = {}) {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'arcane-script-activation-')));
  const store = new StudioStore({ directory });
  t.after(() => {
    store.close();
    const inside = relative(temporaryRoot, directory);
    assert.ok(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep));
    assert.equal(realpathSync(directory), directory);
    rmSync(directory, { recursive: true, force: true });
  });
  const grant = store.createGrant({ allowedRoots: ['Workspace'], allowWrites: options.allowWrites ?? true });
  const pairing = {
    code: grant.code, protocolVersion: 1,
    identity: { clientSessionId: 'activation-window', placeId: 0, universeId: 0, name: 'Synthetic activation fixture', pluginVersion: '0.1.0' },
    capabilities: options.capabilities ?? [...READ_METHODS, ...WRITE_METHODS],
  };
  const pair = store.pair(pairing);
  const ref: InstanceRef = { instanceId: 'script-A', sessionId: pair.sessionId, root: 'Workspace', pathSegments: ['Activation'], className: 'Script' };
  return { store, pair, ref, pairing };
}
type Fixture = ReturnType<typeof fixture>;

function activation(f: Fixture, requestId = 'activate-0001', enabled = true, expectedSource = SOURCE, expectedEnabled = !enabled) {
  return {
    sessionId: f.pair.sessionId, requestId, method: 'script.set_enabled',
    args: { ref: structuredClone(f.ref), expectedSource, expectedEnabled, enabled },
  };
}

// This facade supplies trusted host responses only. It does not compile, execute,
// inspect or infer Luau syntax; real compiler behavior has its own test suite.
function trustedFacade(verify: (source: string) => ScriptSourceVerification | Promise<ScriptSourceVerification> = proof) {
  const sources: string[] = [];
  const verifier: ScriptSourceVerifier = Object.freeze({
    async verify(source: string) { sources.push(source); return verify(source); },
    dispose() {},
  });
  return { verifier, sources };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function pendingFacade() {
  const started = deferred<string>(), response = deferred<ScriptSourceVerification>();
  const facade = trustedFacade(source => { started.resolve(source); return response.promise; });
  return { ...facade, started, response };
}

const verificationEvents = (store: StudioStore) => store.events().map(event => object(event)).filter(event => event.kind === 'script_syntax_verified');

function stateMutation(input: ReturnType<typeof activation>) {
  return {
    kind: input.method, ref: structuredClone(input.args.ref),
    before: { source: input.args.expectedSource, enabled: input.args.expectedEnabled },
    after: { source: input.args.expectedSource, enabled: input.args.enabled },
  };
}

function complete(f: Fixture, command: StudioCommand, mutation: unknown) {
  assert.deepEqual(f.store.poll(f.pair.sessionId).map(item => item.id), [command.id]);
  f.store.result({ sessionId: f.pair.sessionId, commandId: command.id, state: 'succeeded', result: { ref: f.ref, mutation } });
  assert.equal(f.store.command(command.id).state, 'succeeded');
}

function priorDisable(f: Fixture) {
  const input = activation(f, 'prior-disable', false, 'local =', true);
  const command = f.store.enqueue(input), mutation = stateMutation(input);
  complete(f, command, mutation);
  return { command, mutation, source: input.args.expectedSource };
}

test('raw enqueue and a missing host verifier refuse activation, including claimed JSON proof', async t => {
  for (const className of ['Script', 'LocalScript']) await t.test(className, async sub => {
    const f = fixture(sub); f.ref.className = className;
    for (const expectedEnabled of [false, true]) {
      const input = activation(f, 'activate-0001', true, SOURCE, expectedEnabled);
      const claimed = { ...input, verification: proof(SOURCE) };
      assert.throws(() => f.store.enqueue(claimed), { code: 'SOURCE_VERIFICATION' });
      assert.throws(() => f.store.enqueue(claimed, false, proof(SOURCE)), { code: 'SOURCE_VERIFICATION' });
      await assert.rejects(f.store.enqueueVerified(claimed, null), { code: 'SOURCE_VERIFICATION' });
      assert.deepEqual(f.store.commands(), []);
      assert.deepEqual(verificationEvents(f.store), []);
    }
  });
});

test('disabling permits empty or invalid syntax sources without a compiler on either enqueue path', async t => {
  const f = fixture(t), facade = trustedFacade(() => assert.fail('disable called the verifier'));
  for (const [index, source] of ['', ' \r\n\t', 'local ='].entries()) {
    const raw = f.store.enqueue(activation(f, `disable-raw-${index}`, false, source));
    const absent = await f.store.enqueueVerified(activation(f, `disable-null-${index}`, false, source), null);
    const supplied = await f.store.enqueueVerified(activation(f, `disable-host-${index}`, false, source), facade.verifier);
    for (const command of [raw, absent, supplied]) {
      assert.equal(command.state, 'queued');
      assert.equal(command.args.enabled, false);
      assert.equal(command.args.expectedSource, source);
    }
  }
  assert.deepEqual(facade.sources, []);
  assert.deepEqual(verificationEvents(f.store), []);
});

test('trusted proof binds exact UTF-8 source bytes and is persisted for Script and LocalScript', async t => {
  for (const className of ['Script', 'LocalScript']) await t.test(className, async sub => {
    const f = fixture(sub); f.ref.className = className;
    const facade = trustedFacade(), input = activation(f);
    const command = await f.store.enqueueVerified(input, facade.verifier);
    assert.deepEqual(facade.sources, [SOURCE]);
    assert.equal(command.state, 'queued');
    assert.deepEqual(command.args, input.args);
    const events = verificationEvents(f.store);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.entityId, command.id);
    assert.deepEqual(events[0]!.detail, proof(SOURCE));
    assert.equal(sha256(SOURCE) === sha256(SOURCE.trim()), false);
    assert.deepEqual(f.store.command(command.id), command);
  });
});

test('wrong source hashes and malformed proof fields cannot admit an activation', async t => {
  const invalid: Array<[string, (valid: ScriptSourceVerification) => unknown]> = [
    ['absent proof', () => undefined], ['null proof', () => null],
    ['false syntax', valid => ({ ...valid, syntaxVerified: false })],
    ['truthy syntax', valid => ({ ...valid, syntaxVerified: 'true' })],
    ['missing source hash', ({ sourceSha256: _source, ...rest }) => rest],
    ['trimmed source hash', valid => ({ ...valid, sourceSha256: sha256(SOURCE.trim()) })],
    ['different source hash', valid => ({ ...valid, sourceSha256: sha256(SOURCE + ' ') })],
    ['uppercase source hash', valid => ({ ...valid, sourceSha256: valid.sourceSha256.toUpperCase() })],
    ['missing compiler hash', ({ compilerSha256: _compiler, ...rest }) => rest],
    ['short compiler hash', valid => ({ ...valid, compilerSha256: 'a'.repeat(63) })],
    ['nonhex compiler hash', valid => ({ ...valid, compilerSha256: 'g'.repeat(64) })],
    ['uppercase compiler hash', valid => ({ ...valid, compilerSha256: COMPILER_SHA256.toUpperCase() })],
    ['missing elapsed time', ({ elapsedMs: _elapsed, ...rest }) => rest],
    ...[-1, NaN, Infinity, '1', null].map((elapsedMs): [string, (valid: ScriptSourceVerification) => unknown] =>
      [`elapsed time ${String(elapsedMs)}`, valid => ({ ...valid, elapsedMs })]),
  ];
  for (const [label, change] of invalid) await t.test(label, async sub => {
    const f = fixture(sub), facade = trustedFacade(source => change(proof(source)) as ScriptSourceVerification);
    await assert.rejects(f.store.enqueueVerified(activation(f), facade.verifier), { code: 'SOURCE_VERIFICATION' });
    assert.deepEqual(facade.sources, [SOURCE]);
    assert.deepEqual(f.store.commands(), []);
    assert.deepEqual(verificationEvents(f.store), []);
  });
  await t.test('zero elapsed time is a valid proof', async sub => {
    const f = fixture(sub), facade = trustedFacade(source => ({ ...proof(source), elapsedMs: 0 }));
    assert.equal((await f.store.enqueueVerified(activation(f), facade.verifier)).state, 'queued');
  });
});

test('verifier failure is sanitized, queues nothing and leaves the request ID available for retry', async t => {
  const f = fixture(t), input = activation(f);
  const failed = trustedFacade(async () => { throw new Error('PRIVATE COMPILER PATH AND DIAGNOSTIC'); });
  await assert.rejects(f.store.enqueueVerified(input, failed.verifier), error => {
    assert.equal(object(error).code, 'SOURCE_VERIFICATION');
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  assert.deepEqual(f.store.commands(), []);
  assert.deepEqual(verificationEvents(f.store), []);
  const retry = trustedFacade();
  assert.equal((await f.store.enqueueVerified(input, retry.verifier)).state, 'queued');
  assert.deepEqual(retry.sources, [SOURCE]);
});

test('source, nested reference and command identity are snapshotted before awaiting verification', async t => {
  const f = fixture(t), input = activation(f), snapshot = structuredClone(input), facade = pendingFacade();
  const pending = f.store.enqueueVerified(input, facade.verifier);
  assert.equal(await facade.started.promise, SOURCE);
  assert.deepEqual(f.store.commands(), []);
  input.args.expectedSource = 'print("changed while awaiting")';
  input.args.expectedEnabled = true;
  input.args.enabled = false;
  input.args.ref.instanceId = 'other-script';
  input.args.ref.pathSegments.push('Moved');
  input.args.ref.className = 'ModuleScript';
  input.sessionId = 'other-session'; input.requestId = 'changed-request'; input.method = 'script.update';
  facade.response.resolve(proof(SOURCE));
  const command = await pending;
  assert.equal(command.sessionId, snapshot.sessionId);
  assert.equal(command.requestId, snapshot.requestId);
  assert.equal(command.method, snapshot.method);
  assert.deepEqual(command.args, snapshot.args);
  assert.deepEqual(facade.sources, [snapshot.args.expectedSource]);
  assert.deepEqual(await f.store.enqueueVerified(snapshot, null), command);
});

test('guard denies before compilation and is called again after the verification await', async t => {
  await t.test('initial denial', async sub => {
    const f = fixture(sub), facade = trustedFacade(), denied = new Error('Caller authority revoked');
    await assert.rejects(f.store.enqueueVerified(activation(f), facade.verifier, () => { throw denied; }), error => error === denied);
    assert.deepEqual(facade.sources, []);
    assert.deepEqual(f.store.commands(), []);
  });
  await t.test('revocation while awaiting', async sub => {
    const f = fixture(sub), facade = pendingFacade(), denied = new Error('Caller authority revoked');
    let live = true, calls = 0;
    const pending = f.store.enqueueVerified(activation(f), facade.verifier, () => { calls++; if (!live) throw denied; });
    await facade.started.promise;
    assert.equal(calls, 1);
    live = false;
    facade.response.resolve(proof(SOURCE));
    await assert.rejects(pending, error => error === denied);
    assert.equal(calls, 2);
    assert.deepEqual(f.store.commands(), []);
    assert.deepEqual(verificationEvents(f.store), []);
  });
});

test('revoked or replaced exact Studio sessions are fenced after verification', async t => {
  for (const action of ['revoke', 're-pair'] as const) await t.test(action, async sub => {
    const f = fixture(sub), facade = pendingFacade();
    const pending = f.store.enqueueVerified(activation(f), facade.verifier);
    await facade.started.promise;
    if (action === 'revoke') f.store.revoke(f.pair.sessionId);
    else {
      const grant = f.store.createGrant({ allowedRoots: ['Workspace'], allowWrites: true });
      const replacement = f.store.pair({ ...f.pairing, code: grant.code });
      assert.notEqual(replacement.sessionId, f.pair.sessionId);
    }
    facade.response.resolve(proof(SOURCE));
    await assert.rejects(pending, { code: 'REVOKED' });
    assert.deepEqual(f.store.commands(), []);
    assert.deepEqual(verificationEvents(f.store), []);
  });
});

test('request ID retries return the prior command without recompiling; changed requests conflict first', async t => {
  const f = fixture(t), input = activation(f), facade = trustedFacade();
  const command = await f.store.enqueueVerified(input, facade.verifier);
  assert.deepEqual(await f.store.enqueueVerified(structuredClone(input), facade.verifier), command);
  assert.deepEqual(await f.store.enqueueVerified(input, null), command);
  const changed = [
    { ...input, args: { ...input.args, expectedSource: SOURCE + ' ' } },
    { ...input, args: { ...input.args, expectedEnabled: true } },
    { ...input, args: { ...input.args, enabled: false } },
    { ...input, args: { ...input.args, ref: { ...f.ref, instanceId: 'other-script' } } },
    { ...input, method: 'script.read', args: { ref: f.ref } },
  ];
  for (const other of changed) await assert.rejects(f.store.enqueueVerified(other, facade.verifier), { code: 'IDEMPOTENCY' });
  assert.deepEqual(facade.sources, [SOURCE]);
  assert.equal(f.store.commands().length, 1);
  assert.equal(verificationEvents(f.store).length, 1);
  complete(f, command, stateMutation(input));
  const receipt = f.store.command(command.id);
  assert.deepEqual(await f.store.enqueueVerified(input, facade.verifier), receipt);
  assert.deepEqual(await f.store.enqueueVerified(input, null), receipt);
  assert.deepEqual(facade.sources, [SOURCE]);
});

test('write grant, capability, class, scope, baseline and source validation refuse before compilation', async t => {
  const cases: Array<{ label: string; code: string; options?: Parameters<typeof fixture>[1]; change?: (input: ReturnType<typeof activation>) => unknown }> = [
    { label: 'read-only grant', code: 'READ_ONLY', options: { allowWrites: false } },
    { label: 'missing capability', code: 'CAPABILITY', options: { capabilities: [...READ_METHODS, ...WRITE_METHODS.filter(method => method !== 'script.set_enabled')] } },
    ...['ModuleScript', 'Part', 'Folder'].map(className => ({ label: className, code: 'CLASS', change: (input: ReturnType<typeof activation>) => ({ ...input, args: { ...input.args, ref: { ...input.args.ref, className } } }) })),
    { label: 'different session ref', code: 'SCOPE', change: input => ({ ...input, args: { ...input.args, ref: { ...input.args.ref, sessionId: 'other-session' } } }) },
    { label: 'ungranted root', code: 'SCOPE', change: input => ({ ...input, args: { ...input.args, ref: { ...input.args.ref, root: 'ServerStorage' } } }) },
    { label: 'missing enabled baseline', code: 'INPUT', change: input => { const { expectedEnabled: _enabled, ...args } = input.args; return { ...input, args }; } },
    { label: 'nonboolean enabled', code: 'INPUT', change: input => ({ ...input, args: { ...input.args, enabled: 1 } }) },
    { label: 'empty source', code: 'SOURCE_EMPTY', change: input => ({ ...input, args: { ...input.args, expectedSource: '' } }) },
    { label: 'whitespace source', code: 'SOURCE_EMPTY', change: input => ({ ...input, args: { ...input.args, expectedSource: ' \r\n\t' } }) },
    { label: 'oversized ASCII source', code: 'INPUT', change: input => ({ ...input, args: { ...input.args, expectedSource: 'x'.repeat(100 * 1024 + 1) } }) },
    { label: 'oversized UTF-8 source', code: 'INPUT', change: input => ({ ...input, args: { ...input.args, expectedSource: '\u{1f680}'.repeat(25 * 1024 + 1) } }) },
    { label: 'NUL source', code: 'INPUT', change: input => ({ ...input, args: { ...input.args, expectedSource: 'print("\0")' } }) },
    { label: 'invalid request ID', code: 'INPUT', change: input => ({ ...input, requestId: 'short' }) },
  ];
  for (const { label, code, options, change } of cases) await t.test(label, async sub => {
    const f = fixture(sub, options), facade = trustedFacade(), input = activation(f);
    await assert.rejects(f.store.enqueueVerified(change ? change(input) : input, facade.verifier), { code });
    assert.deepEqual(facade.sources, []);
    assert.deepEqual(f.store.commands(), []);
    assert.deepEqual(verificationEvents(f.store), []);
  });
  await t.test('exact 100 KiB boundary reaches the verifier', async sub => {
    const f = fixture(sub), facade = trustedFacade(), source = '--' + 'x'.repeat(100 * 1024 - 2);
    const command = await f.store.enqueueVerified(activation(f, 'source-boundary', true, source), facade.verifier);
    assert.deepEqual(facade.sources, [source]);
    assert.equal(command.args.expectedSource, source);
  });
});

test('execution receipts require the exact source, enabled booleans and changed opaque reference identity', async t => {
  for (const enabled of [true, false]) await t.test(enabled ? 'enable' : 'disable', async sub => {
    const f = fixture(sub), input = activation(f, 'receipt-state', enabled), facade = trustedFacade();
    const command = await f.store.enqueueVerified(input, enabled ? facade.verifier : null);
    assert.deepEqual(f.store.poll(f.pair.sessionId).map(item => item.id), [command.id]);
    const mutation = stateMutation(input);
    const wrong: unknown[] = [
      { ...mutation, before: { ...mutation.before, source: SOURCE.trim() } },
      { ...mutation, after: { ...mutation.after, source: SOURCE + ' ' } },
      { ...mutation, before: { ...mutation.before, enabled } },
      { ...mutation, after: { ...mutation.after, enabled: !enabled } },
      { ...mutation, before: { ...mutation.before, enabled: String(!enabled) } },
      { ...mutation, after: { ...mutation.after, enabled: Number(enabled) } },
      { ...mutation, before: { ...mutation.before, extra: true } },
      { ...mutation, after: { ...mutation.after, extra: true } },
      ...[
        { instanceId: 'other-script' }, { sessionId: 'other-session' }, { root: 'ServerStorage' },
        { className: 'LocalScript' },
      ].map(change => ({ ...mutation, ref: { ...mutation.ref, ...change } })),
    ];
    const receipt = { sessionId: f.pair.sessionId, commandId: command.id, state: 'succeeded', result: { ref: f.ref, mutation } };
    for (const invalid of wrong) {
      assert.throws(() => f.store.result({ ...receipt, result: { ref: f.ref, mutation: invalid } }), { code: 'RECEIPT' });
      assert.equal(f.store.command(command.id).state, 'dispatched');
      assert.equal(f.store.command(command.id).result, null);
    }
    f.store.result(receipt); f.store.result(structuredClone(receipt));
    assert.equal(f.store.command(command.id).state, 'succeeded');
    assert.deepEqual(f.store.command(command.id).result, receipt.result);
    assert.throws(() => f.store.result({ ...receipt, result: { ...receipt.result, mutation: wrong[0] } }), { code: 'RECEIPT_CONFLICT' });
  });
});

test('restoring prior activation disables without a compiler and preserves the exact receipt', async t => {
  const f = fixture(t), input = activation(f), facade = trustedFacade();
  const command = await f.store.enqueueVerified(input, facade.verifier), mutation = stateMutation(input);
  complete(f, command, mutation);
  const snapshot = structuredClone(mutation);
  mutation.before.enabled = true; mutation.after.source = 'caller changed its receipt copy';
  const raw = f.store.restore({ commandId: command.id, requestId: 'restore-raw-disable' });
  let guardCalls = 0;
  const absent = await f.store.restoreVerified({ commandId: command.id, requestId: 'restore-null-disable' }, null, () => { guardCalls++; });
  const supplied = await f.store.restoreVerified({ commandId: command.id, requestId: 'restore-host-disable' }, facade.verifier);
  for (const restored of [raw, absent, supplied]) {
    assert.equal(restored.method, 'scene.restore');
    assert.equal(restored.state, 'queued');
    assert.deepEqual(restored.args, { receiptCommandId: command.id, mutation: snapshot });
  }
  assert.equal(guardCalls, 1);
  assert.deepEqual(facade.sources, [SOURCE]);
  assert.equal(verificationEvents(f.store).length, 1);
});

test('restoring a prior disable requires fresh host verification; raw restore and forged inverse refuse', async t => {
  const f = fixture(t), prior = priorDisable(f), restoreInput = { commandId: prior.command.id, requestId: 'restore-enable' };
  assert.throws(() => f.store.restore(restoreInput), { code: 'SOURCE_VERIFICATION' });
  await assert.rejects(f.store.restoreVerified(restoreInput, null), { code: 'SOURCE_VERIFICATION' });
  const inverse = { sessionId: f.pair.sessionId, requestId: restoreInput.requestId, method: 'scene.restore', args: { receiptCommandId: prior.command.id, mutation: prior.mutation } };
  assert.throws(() => f.store.enqueue(inverse, true, proof(prior.source)), { code: 'SOURCE_VERIFICATION' });
  const facade = trustedFacade();
  await assert.rejects(f.store.enqueueVerified(inverse, facade.verifier), { code: 'RESTORE' });
  assert.deepEqual(facade.sources, []);
  assert.equal(f.store.commands().length, 1);
  let guardCalls = 0;
  const restored = await f.store.restoreVerified(restoreInput, facade.verifier, () => { guardCalls++; });
  assert.equal(guardCalls, 2);
  assert.deepEqual(facade.sources, [prior.source]);
  assert.deepEqual(restored.args, inverse.args);
  assert.deepEqual(verificationEvents(f.store).map(event => event.detail), [proof(prior.source)]);
  assert.deepEqual(await f.store.restoreVerified(restoreInput, null), restored);
  const fresh = await f.store.restoreVerified({ ...restoreInput, requestId: 'restore-enable-fresh' }, facade.verifier);
  assert.notEqual(fresh.id, restored.id);
  assert.deepEqual(facade.sources, [prior.source, prior.source]);
});

test('restoration that activates rechecks both caller guard and exact session after awaiting', async t => {
  for (const fence of ['guard', 'session'] as const) await t.test(fence, async sub => {
    const f = fixture(sub), prior = priorDisable(f), facade = pendingFacade();
    let live = true, guardCalls = 0;
    const denied = new Error('Restoration authority revoked');
    const pending = f.store.restoreVerified({ commandId: prior.command.id, requestId: 'restore-fenced' }, facade.verifier,
      () => { guardCalls++; if (!live) throw denied; });
    assert.equal(await facade.started.promise, prior.source);
    if (fence === 'guard') live = false;
    else f.store.revoke(f.pair.sessionId);
    facade.response.resolve(proof(prior.source));
    if (fence === 'guard') await assert.rejects(pending, error => error === denied);
    else await assert.rejects(pending, { code: 'REVOKED' });
    assert.equal(guardCalls, 2);
    assert.deepEqual(f.store.commands().map(command => command.id), [prior.command.id]);
    assert.deepEqual(verificationEvents(f.store), []);
  });
});

const vector = (x: number, y: number, z: number): Json => ({ type: 'Vector3', value: [x, y, z] });
const color = (r: number, g: number, b: number): Json => ({ type: 'Color3', value: [r, g, b] });
// Fixed readback from the existing native-property regression fixture.
const NATIVE_COLOR = color(0.14901961386203766, 0.4470588266849518, 0.800000011920929);

test('scene.update accepts canonical RGB8 and equivalent Orientation only after the write, with strict before/ref', async t => {
  for (const [label, requestedRotation, observedRotation] of [
    ['full turn', vector(360, 0, 0), vector(0, 0, 0)],
    ['gimbal equivalent', vector(90, 30, 60), vector(90, -30, 0)],
  ] as const) await t.test(label, async sub => {
    const f = fixture(sub); f.ref.className = 'Part';
    const before = engineProperties({ Color: color(0.15, 0.45, 0.8), Orientation: vector(0, 360, 0) });
    const properties = { Color: color(0.15, 0.45, 0.8), Orientation: requestedRotation };
    const after = { Color: NATIVE_COLOR, Orientation: observedRotation };
    const command = f.store.enqueue({ sessionId: f.pair.sessionId, requestId: 'native-update', method: 'scene.update', args: { ref: f.ref, expected: before, properties } });
    assert.deepEqual(f.store.poll(f.pair.sessionId).map(item => item.id), [command.id]);
    const mutation = { kind: 'scene.update', ref: f.ref, before: { properties: before }, after: { properties: after } };
    const wrong = [
      { ...mutation, before: { properties: { ...before, Color: NATIVE_COLOR } } },
      { ...mutation, before: { properties: { ...before, Orientation: vector(0, 0, 0) } } },
      { ...mutation, ref: { ...f.ref, instanceId: 'other-part' } },
      { ...mutation, ref: { ...f.ref, className: 'MeshPart' } },
      { ...mutation, after: { properties: { ...after, Color: color(Math.fround(39 / 255), Math.fround(114 / 255), Math.fround(204 / 255)) } } },
      { ...mutation, after: { properties: { ...after, Color: color(Math.fround(38 / 255), Math.fround(115 / 255), Math.fround(204 / 255)) } } },
      { ...mutation, after: { properties: { ...after, Orientation: vector(0, 0, 1) } } },
      { ...mutation, after: { properties: { Orientation: observedRotation } } },
      { ...mutation, after: { properties: { ...after, Anchored: true } } },
    ];
    const receipt = { sessionId: f.pair.sessionId, commandId: command.id, state: 'succeeded', result: { ref: f.ref, mutation } };
    for (const invalid of wrong) {
      assert.throws(() => f.store.result({ ...receipt, result: { ref: f.ref, mutation: invalid } }), { code: 'RECEIPT' });
      assert.equal(f.store.command(command.id).state, 'dispatched');
      assert.equal(f.store.command(command.id).result, null);
    }
    f.store.result(receipt);
    assert.deepEqual(f.store.command(command.id).result, receipt.result);
    assert.notDeepEqual(command.args.properties, after);
    const restored = await f.store.restoreVerified({ commandId: command.id, requestId: 'native-restore' }, null);
    assert.deepEqual(restored.args, { receiptCommandId: command.id, mutation });
    assert.deepEqual(object(object(restored.args.mutation).after).properties, after);
    assert.deepEqual(verificationEvents(f.store), []);
  });
});
