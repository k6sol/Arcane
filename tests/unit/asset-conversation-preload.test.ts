import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
const source = readFileSync(join(process.cwd(), 'apps/desktop/electron/preload.cjs'), 'utf8');
const ID = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const calls: unknown[][] = []; let bridge: any, reply: unknown = { state: 'selected' };
  vm.runInNewContext(source, { Object, Reflect, Error, Promise, require(name: string) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(name: string, value: unknown) { assert.equal(name, 'arcaneDesktop'); bridge = value; } },
      ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args); return reply; } } };
  } });
  return { calls, bridge, setReply: (value: unknown) => { reply = value; } };
}
test('review selection preload exposes only fixed human focus payloads and bounded acknowledgements', async () => {
  const f = fixture(); assert.equal(Object.isFrozen(f.bridge), true);
  for (const value of [null, { provider: 'codex' }, { provider: 'claude-code', conversationId: ID }, { provider: 'arcane', conversationId: ID }]) {
    const result = await f.bridge.selectAssetConversation(value);
    assert.equal(result.state, 'selected');
    assert.equal(JSON.stringify(f.calls.at(-1)), JSON.stringify(['arcane:asset-conversation-select', value]));
  }
  f.setReply({ state: 'unavailable' }); assert.equal((await f.bridge.selectAssetConversation(null)).state, 'unavailable');
  for (const reply of [{ state: 'selected', credential: 'PRIVATE' }, { state: 'opened' }, null, { get state() { throw new Error('PRIVATE'); } }]) {
    f.setReply(reply); await assert.rejects(f.bridge.selectAssetConversation(null), /^Error: Model review conversation is unavailable\.$/);
  }
});
test('review selection preload rejects paths, native identities, malformed UUIDs and extra authority before IPC', async () => {
  const f = fixture(); let reads = 0;
  const getter = { get provider() { reads++; return 'arcane'; }, conversationId: ID };
  for (const value of [undefined, 'codex', {}, getter, { provider: 'claude', conversationId: ID },
    { provider: 'codex', threadId: ID }, { provider: 'codex', conversationId: ID },
    { provider: 'arcane', conversationId: '../chat' }, { provider: 'arcane', conversationId: ID + '\n' },
    { provider: 'arcane', conversationId: ID, token: 'PRIVATE' }]) await assert.rejects(f.bridge.selectAssetConversation(value));
  await assert.rejects(f.bridge.selectAssetConversation()); await assert.rejects(f.bridge.selectAssetConversation(null, 'extra'));
  assert.deepEqual(f.calls, []); assert.equal(reads, 0);
});
