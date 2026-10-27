import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createStudioTestOwnedClose, closeAfterStudioTestConnectFailure, STUDIO_TEST_OWNED_CLOSE_MS } from '../../apps/daemon/src/studio-test-owned-close.js';

// A fixed test-owned Node stdio peer, never the native Studio executable.
// Only the actual SDK/child cases below can establish an actual process close.
const CHILD = [
  'const readline=require("node:readline");',
  'const mode=process.argv[1];',
  'const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});',
  'const send=value=>process.stdout.write(JSON.stringify(value)+"\\n");',
  'lines.on("line",line=>{',
  '  const request=JSON.parse(line);',
  '  if(request.method==="initialize"){',
  '    if(mode==="exit-initialize"){process.exit(0);return;}',
  '    send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:mode==="invalid-initialize"?"unsupported-fixture-version":request.params.protocolVersion,capabilities:{tools:{},logging:{}},serverInfo:{name:"arcane-owned-close-fixture",version:"1"}}});',
  '    return;',
  '  }',
  '  if(request.method==="tools/call"){',
  '    send({jsonrpc:"2.0",method:"notifications/message",params:{level:"info",logger:"owned-close-fixture",data:"held-request-entered"}});',
  '    return;',
  '  }',
  '  if(Object.hasOwn(request,"id"))send({jsonrpc:"2.0",id:request.id,result:{}});',
  '});',
  'lines.on("close",()=>process.exit(0));',
].join('\n');

function peer(t: TestContext, mode: 'ready' | 'invalid-initialize' | 'exit-initialize') {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['-e', CHILD, mode], stderr: 'ignore' });
  const client = new Client({ name: 'arcane-owned-close-test', version: '1' }, { capabilities: {} });
  let sdkCloses = 0;
  client.onclose = () => { sdkCloses++; };
  const owned = createStudioTestOwnedClose(client, transport);
  t.after(async () => { await owned.close(); });
  return { client, transport, owned, sdkCloses: () => sdkCloses };
}
function virtualClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
}

test('actual SDK child close preserves its client callback and rejects an actually entered pending request', { timeout: 30000 }, async t => {
  const f = peer(t, 'ready');
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  f.client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
    if (notification.params.logger === 'owned-close-fixture' && notification.params.data === 'held-request-entered') enter();
  });
  await f.client.connect(f.transport, { timeout: 10000, maxTotalTimeout: 10000 });
  assert.equal(f.client.getServerVersion()?.name, 'arcane-owned-close-fixture');
  const request = f.client.callTool({ name: 'held', arguments: {} }, CallToolResultSchema, { timeout: 15000, maxTotalTimeout: 15000 });
  void request.catch(() => {});
  await Promise.race([entered, request.then(() => assert.fail('Held request unexpectedly returned.'), () => assert.fail('Held request failed before entry.'))]);
  const rejected = assert.rejects(request);
  const closing = f.owned.close();
  assert.strictEqual(f.owned.close(), closing);
  await closing;
  await rejected;
  assert.equal(f.sdkCloses(), 1, 'The SDK callback chain must survive the preconnect witness.');
  assert.strictEqual(f.owned.close(), closing);
  await f.owned.close();
  assert.equal(f.sdkCloses(), 1);
});

for (const mode of ['invalid-initialize', 'exit-initialize'] as const) {
  test('actual SDK failed initialization retains its original error after owned close: ' + mode, { timeout: 30000 }, async t => {
    const f = peer(t, mode);
    let failed = false, original: unknown;
    try { await f.client.connect(f.transport, { timeout: 10000, maxTotalTimeout: 10000 }); }
    catch (error) { failed = true; original = error; }
    assert.equal(failed, true);
    await assert.rejects(closeAfterStudioTestConnectFailure(f.owned, original), (error: unknown) => error === original);
    await f.owned.close();
    assert.equal(f.sdkCloses(), 1);
  });
}

test('resolved cleanup without the physical callback refuses at the fixed deadline and never retries', async t => {
  virtualClock(t);
  const calls: string[] = [];
  let entered!: () => void;
  const transportEntered = new Promise<void>(resolve => { entered = resolve; });
  const client = { close(): Promise<void> { calls.push('client'); return Promise.resolve(); } };
  const transport: { onclose?: () => void; close(): Promise<void> } = {
    close(): Promise<void> { calls.push('transport'); entered(); return Promise.resolve(); },
  };
  const owned = createStudioTestOwnedClose(client, transport), closing = owned.close();
  const refused = assert.rejects(closing, { code: 'FENCED' });
  await transportEntered;
  t.mock.timers.tick(STUDIO_TEST_OWNED_CLOSE_MS - 1);
  let finished = false;
  void closing.then(() => { finished = true; }, () => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  await refused;
  assert.deepEqual(calls, ['client', 'transport']);
  transport.onclose?.(); // A synthetic late callback is NOT positive native evidence.
  assert.strictEqual(owned.close(), closing);
  await assert.rejects(owned.close(), { code: 'FENCED' });
  assert.deepEqual(calls, ['client', 'transport']);
});

test('deadline bounds an unresolved client close while its single cleanup chain remains observed', async t => {
  virtualClock(t);
  const calls: string[] = [];
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const transportEntered = new Promise<void>(resolve => { entered = resolve; });
  const client = { close(): Promise<void> { calls.push('client'); return held; } };
  const transport: { onclose?: () => void; close(): Promise<void> } = {
    close(): Promise<void> { calls.push('transport'); entered(); return Promise.resolve(); },
  };
  const owned = createStudioTestOwnedClose(client, transport), closing = owned.close(), refused = assert.rejects(closing, { code: 'FENCED' });
  t.mock.timers.tick(STUDIO_TEST_OWNED_CLOSE_MS);
  await refused;
  assert.deepEqual(calls, ['client']);
  release();
  await transportEntered;
  transport.onclose?.();
  assert.strictEqual(owned.close(), closing);
  await assert.rejects(owned.close(), { code: 'FENCED' });
  assert.deepEqual(calls, ['client', 'transport']);
});

test('both cleanup methods run in order and the first actual rejection wins over missing closure', async t => {
  virtualClock(t);
  const first = new Error('fixed client-close fixture failure'), second = new Error('fixed transport-close fixture failure');
  const calls: string[] = [];
  let entered!: () => void;
  const transportEntered = new Promise<void>(resolve => { entered = resolve; });
  const owned = createStudioTestOwnedClose({
    close(): Promise<void> { calls.push('client'); return Promise.reject(first); },
  }, {
    close(): Promise<void> { calls.push('transport'); entered(); return Promise.reject(second); },
  });
  const closing = owned.close(), refused = assert.rejects(closing, (error: unknown) => error === first);
  await transportEntered;
  await Promise.resolve(); // The known rejected transport promise reaches the cleanup catch.
  t.mock.timers.tick(STUDIO_TEST_OWNED_CLOSE_MS);
  await refused;
  assert.deepEqual(calls, ['client', 'transport']);
  assert.strictEqual(owned.close(), closing);
});

test('transport rejection is preserved and failed connect still returns its distinct original error', async t => {
  virtualClock(t);
  const transportFailure = new Error('fixed transport failure'), connectFailure = new Error('fixed connect failure');
  let entered!: () => void;
  const transportEntered = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  const owned = createStudioTestOwnedClose({ close(): Promise<void> { calls.push('client'); return Promise.resolve(); } }, {
    close(): Promise<void> { calls.push('transport'); entered(); return Promise.reject(transportFailure); },
  });
  const closing = owned.close(), refused = assert.rejects(closing, (error: unknown) => error === transportFailure);
  const original = assert.rejects(closeAfterStudioTestConnectFailure(owned, connectFailure), (error: unknown) => error === connectFailure);
  await transportEntered;
  await Promise.resolve();
  t.mock.timers.tick(STUDIO_TEST_OWNED_CLOSE_MS);
  await refused;
  await original;
  assert.deepEqual(calls, ['client', 'transport']);
});

test('a synthetic physical callback cannot erase the original cleanup rejection', async () => {
  const first = new Error('fixed earlier cleanup rejection'), calls: string[] = [];
  const transport: { onclose?: () => void; close(): Promise<void> } = {
    close(): Promise<void> { calls.push('transport'); transport.onclose?.(); return Promise.resolve(); },
  };
  const owned = createStudioTestOwnedClose({
    close(): Promise<void> { calls.push('client'); return Promise.reject(first); },
  }, transport);
  await assert.rejects(owned.close(), (error: unknown) => error === first);
  assert.deepEqual(calls, ['client', 'transport']);
  // This negative controlled case is not successful native process evidence.
});

test('an already assigned callback is refused before replacement or cleanup', () => {
  let calls = 0;
  const previous = () => { calls++; };
  const transport = { onclose: previous, close(): Promise<void> { calls++; return Promise.resolve(); } };
  const client = { close(): Promise<void> { calls++; return Promise.resolve(); } };
  assert.throws(() => createStudioTestOwnedClose(client, transport), { code: 'FENCED' });
  assert.strictEqual(transport.onclose, previous);
  assert.equal(calls, 0);
});
