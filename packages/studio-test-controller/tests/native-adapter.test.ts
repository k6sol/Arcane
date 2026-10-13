import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTestAdapter, StudioTestError, reviewedTestTools } from '../src/index.js';
import { BINDING, fixture, ManualScheduler, pumpUntil, result } from './harness.js';
const code = (expected: string) => (error: unknown) => error instanceof StudioTestError && error.code === expected;
const signal = () => new AbortController().signal;

test('names and inventory order do not select a target; every read/mutation uses exact studio_id', async t => {
  const f = await fixture(); t.after(f.close); const runId = await f.launch();
  await pumpUntil(() => f.control.requests.status().phase === 'waiting'); await f.control.requests.stop({ runId });
  assert.ok(f.calls.filter(call => call.name !== 'list_roblox_studios').every(call => call.args.studio_id === BINDING.nativeStudioId));
  assert.ok(!JSON.stringify(f.effects()).includes('other-studio-B'));
});

for (const kind of ['missing', 'duplicate'] as const) {
  test(`${kind} exact inventory identity rejects preparation with no mutation`, async t => {
    const f = await fixture(); t.after(f.close);
    f.state.inventory = kind === 'missing' ? [{ id: 'other-studio-B', name: 'same untrusted name' }]
      : [{ id: BINDING.nativeStudioId, name: 'same' }, { id: BINDING.nativeStudioId, name: 'same' }];
    await assert.rejects(f.control.requests.prepare(f.proposal), code('BINDING_CHANGED')); assert.equal(f.effects().length, 0);
  });
}

test('native nonzero place is denied even when paired proof and approved request claim place 0', async t => {
  const f = await fixture(); t.after(f.close); f.state.placeId = 1234;
  await assert.rejects(f.control.requests.prepare(f.proposal), code('PLACE_DENIED')); assert.equal(f.effects().length, 0);
});

test('absent native place proof has no inferred place-zero default', async t => {
  const f = await fixture({ beforeTool: async name => name === 'get_studio_state'
    ? result({ nativeStudioId: BINDING.nativeStudioId, mode: 'Edit', datamodels: ['Edit'] }) : undefined }); t.after(f.close);
  await assert.rejects(f.control.requests.prepare(f.proposal), code('PLACE_DENIED')); assert.equal(f.effects().length, 0);
});

test('request cannot change place 0 to an arbitrary saved place', async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(f.control.requests.prepare({ ...f.proposal, binding: { ...BINDING, placeId: 12 } }), code('INVALID_REQUEST'));
  assert.equal(f.calls.length, 0);
});

for (const property of ['protectedPlace', 'revoked', 'testActionsAllowed', 'continuitySupported', 'connected'] as const) {
  test(`authoritative ${property} fails closed before native start`, async t => {
    const f = await fixture(); t.after(f.close);
    f.state[property] = property === 'protectedPlace' || property === 'revoked';
    await assert.rejects(f.control.requests.prepare(f.proposal)); assert.equal(f.effects().length, 0);
  });
}

for (const age of ['old', 'future', 'expired'] as const) {
  test(`${age} paired proof is refused`, async t => {
    const f = await fixture({ proof: proof => ({ ...proof,
      observedAt: age === 'old' ? proof.observedAt - 1001 : age === 'future' ? proof.observedAt + 1 : proof.observedAt,
      expiresAt: age === 'expired' ? proof.observedAt : proof.expiresAt,
    }) }); t.after(f.close);
    await assert.rejects(f.control.requests.prepare(f.proposal), code('STALE_PROOF')); assert.equal(f.effects().length, 0);
  });
}

test('paired proof changing within native observation bracket cannot create a lease', async t => {
  const f = await fixture({ proof: (proof, count) => count > 1 ? { ...proof, binding: { ...proof.binding, clientLifetimeId: 'replacement' } } : proof }); t.after(f.close);
  await assert.rejects(f.control.requests.prepare(f.proposal), code('BINDING_CHANGED')); assert.equal(f.effects().length, 0);
});

test('preexisting manual Play is never adopted or stopped', async t => {
  const f = await fixture(); t.after(f.close); f.state.mode = 'Play';
  await assert.rejects(f.control.requests.prepare(f.proposal), code('MODE_MISMATCH'));
  await assert.rejects(f.adapter.stop(BINDING, 'unowned-run', f.scheduler.now() + 1000, signal()), code('NOT_OWNED_PLAY'));
  assert.equal(f.effects().length, 0);
});

test('native state identity cannot differ from the exact inventory and authenticated pairing', async t => {
  const f = await fixture({ beforeTool: async name => name === 'get_studio_state'
    ? result({ nativeStudioId: 'other-studio-B', placeId: 0, mode: 'Edit', datamodels: ['Edit'] }) : undefined }); t.after(f.close);
  await assert.rejects(f.control.requests.prepare(f.proposal), code('BINDING_CHANGED')); assert.equal(f.effects().length, 0);
});

for (const kind of ['missing', 'schema', 'annotation'] as const) {
  test(`runtime tool ${kind} drift is rejected rather than sending a guessed wire request`, async t => {
    const f = await fixture(); t.after(f.close);
    const tool = f.state.tools.find(tool => tool.name === 'start_stop_play')!;
    if (kind === 'missing') f.state.tools = f.state.tools.filter(item => item !== tool);
    if (kind === 'schema') tool.inputSchema.required = ['studio_id', 'is_start', 'fictionalFence'];
    if (kind === 'annotation') tool.annotations = { ...tool.annotations, openWorldHint: true };
    await assert.rejects(f.control.requests.prepare(f.proposal), code('UNSUPPORTED_TOOL')); assert.equal(f.effects().length, 0);
  });
}

test('list-change notification invalidates cached tools and prevents a stale start', async t => {
  const f = await fixture(); t.after(f.close); const approved = await f.approve();
  f.state.tools = f.state.tools.filter(tool => tool.name !== 'start_stop_play');
  await f.server.sendToolListChanged(); await new Promise<void>(resolve => setImmediate(resolve));
  const started = await f.control.requests.start({ proposalId: approved.proposalId, consentId: approved.consentId });
  const review = await f.control.requests.wait({ runId: started.runId });
  assert.equal(review.code, 'UNSUPPORTED_TOOL'); assert.equal(f.effects().length, 0); assert.ok(f.state.lists >= 2);
});

test('bounded capability pagination handles a real SDK page cursor', async t => {
  const f = await fixture({ pages: cursor => cursor ? { tools: structuredClone(reviewedTestTools.slice(2)) }
    : { tools: structuredClone(reviewedTestTools.slice(0, 2)), nextCursor: 'second-page' } }); t.after(f.close);
  await f.control.requests.prepare(f.proposal); assert.equal(f.state.lists, 2);
});

test('capability cursor loops and duplicate tools fail closed', async t => {
  const f = await fixture({ pages: () => ({ tools: [...structuredClone(reviewedTestTools)], nextCursor: 'same-page' }) }); t.after(f.close);
  await assert.rejects(f.control.requests.prepare(f.proposal), code('UNSUPPORTED_TOOL')); assert.equal(f.effects().length, 0);
});

test('a native result error during stop is an unknown cleanup, never retried', async t => {
  const f = await fixture({ beforeTool: async (name, args) => name === 'start_stop_play' && !args.is_start
    ? { content: [{ type: 'text', text: 'fixture stop failure' }], isError: true } : undefined }); t.after(f.close);
  const runId = await f.launch(); await pumpUntil(() => f.control.requests.status().phase === 'waiting');
  const review = await f.control.requests.stop({ runId });
  assert.equal(review.outcome, 'cancelled'); assert.equal(review.cleanup, 'unknown'); assert.equal(f.effects().length, 2);
  await f.control.requests.stop({ runId }); assert.equal(f.effects().length, 2);
});

test('start postcheck rejects extra play transitions and never claims ownership of replacement play', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ beforeTool: async (name, args) => {
    if (name === 'start_stop_play' && args.is_start) f.state.epoch += 2;
    return undefined;
  } }); t.after(f.close);
  const runId = await f.launch(); const review = await f.control.requests.wait({ runId });
  assert.equal(review.code, 'EFFECT_UNKNOWN'); assert.equal(review.cleanup, 'unknown'); assert.equal(f.effects().length, 1);
});

test('an original request that outlives the cleanup grace stays fenced after its late ACK', async t => {
  let release: (() => void) | undefined;
  const f = await fixture({ controllerTimeout: 500, adapterTimeout: 2000,
    beforeTool: async (name, args) => {
      if (name === 'start_stop_play' && args.is_start) await new Promise<void>(resolve => { release = resolve; }); return undefined;
    } }); t.after(f.close);
  const runId = await f.launch(); await pumpUntil(() => !!release);
  (f.scheduler as ManualScheduler).advance(500);
  await pumpUntil(() => f.control.requests.status().phase === 'stopping');
  // Advance beyond the full consented cleanup deadline while ACK is outstanding.
  await pumpUntil(() => (f.scheduler as ManualScheduler).pending() >= 1);
  (f.scheduler as ManualScheduler).advance(1000);
  const before = await f.control.requests.wait({ runId });
  assert.equal(before.cleanup, 'unknown'); assert.equal(f.effects().length, 1);
  release!(); await pumpUntil(() => f.state.mode === 'Play');
  assert.equal(await f.adapter.settle(signal()), true);
  assert.deepEqual(f.control.requests.status(), before); assert.equal(f.effects().length, 1);
});

test('oversized or malformed console evidence refuses the run rather than exposing raw text', async t => {
  const f = await fixture(); t.after(f.close);
  f.state.logs.push({ id: 'oversized', level: 'error', message: 'x'.repeat(2049) });
  await assert.rejects(f.control.requests.prepare(f.proposal), code('BAD_NATIVE_RESPONSE')); assert.equal(f.effects().length, 0);
});

test('loss of the actual SDK connection invokes lifecycle callback and cannot dispatch stop elsewhere', async t => {
  const f = await fixture(); t.after(f.close); const runId = await f.launch();
  await pumpUntil(() => f.control.requests.status().phase === 'waiting'); await f.client.close();
  const review = await f.control.requests.wait({ runId });
  assert.equal(review.code, 'DISCONNECTED'); assert.equal(review.cleanup, 'unknown'); assert.equal(f.effects().length, 1);
});

test('fixture SDK handshake cannot be relabeled native by constructing the adapter', async t => {
  const f = await fixture(); t.after(f.close);
  assert.throws(() => new NativeTestAdapter({ client: f.client, evidence: 'native', pairedProof: { async read() { return null; } },
    decoder: { inventory() { return null; }, state() { return null; }, logs() { return null; } } }), code('BAD_NATIVE_RESPONSE'));
});

test('timed out cleanup stop is issued once and its late ACK cannot clear the durable fence', async t => {
  let release: (() => void) | undefined;
  const f = await fixture({ controllerTimeout: 500, adapterTimeout: 2000, beforeTool: async (name, args) => {
    if (name === 'start_stop_play' && !args.is_start) await new Promise<void>(resolve => { release = resolve; }); return undefined;
  } }); t.after(f.close);
  const runId = await f.launch(); await pumpUntil(() => f.control.requests.status().phase === 'waiting');
  const stopped = f.control.requests.stop({ runId }); await pumpUntil(() => !!release);
  (f.scheduler as ManualScheduler).advance(500); const review = await stopped;
  assert.equal(review.outcome, 'cancelled'); assert.equal(review.cleanup, 'unknown'); assert.equal(f.effects().length, 2);
  release!(); assert.equal(await f.adapter.settle(signal()), true); assert.equal(f.state.mode, 'Edit');
  assert.deepEqual(f.control.requests.status(), review); assert.equal(f.ledger.unresolved(), true);
});
