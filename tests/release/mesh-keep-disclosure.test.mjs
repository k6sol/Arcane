import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMeshKeepHost } = require('../../apps/desktop/electron/mesh-keep.cjs');

test('trusted Keep confirmation discloses geometry-only upload and session texture maps before consent', async () => {
  const calls = [], sent = [], window = {}, origin = 'http://127.0.0.1:45871', token = 'a'.repeat(64);
  const prepared = { prepareId: '11111111-2222-4333-8444-555555555555', account: { kind: 'user', userId: 78 },
    name: 'Old oak', meshCount: 2, placeName: 'My place' };
  const session = { window, origin, token, send: message => sent.push(message) };
  const host = createMeshKeepHost({ getSession: () => session,
    fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
      assert.ok(url.endsWith('/prepare'), 'declining the confirmation must not reach start');
      return { ok: true, json: async () => prepared }; },
    confirm: async question => {
      assert.equal(calls.length, 1); assert.deepEqual(sent, [], 'consent has not crossed IPC before the question');
      assert.equal(question.confirmLabel, 'Upload and keep');
      assert.match(question.detail, /Account: Roblox user ID 78/); assert.match(question.detail, /Asset name: Old oak/);
      assert.match(question.detail, /2 mesh assets/); assert.match(question.detail, /upload quota/);
      assert.match(question.detail, /Generated texture maps stay in this Studio session unless saved separately as assets\./);
      assert.match(question.detail, /uploads mesh geometry only\./);
      return false;
    } });
  assert.deepEqual(await host.keep({ digest: 'ab'.repeat(32), sessionId: 's-1' }), { state: 'cancelled', message: 'Not uploaded.' });
  assert.equal(calls.length, 1); assert.deepEqual(sent, []);
  assert.equal(calls[0].auth, 'Bearer ' + token);
});
