import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTextOnlyChatSource } from './chat-source-contract.js';
import { readFile } from 'node:fs/promises';
import { boundedText, notificationBody, notificationsEnabled, NOTIFY_SETTING_KEY } from '../../apps/desktop/src/notifications.js';
import { readDesktopCheckout } from '../../apps/desktop/src/plans.js';

test('notification body: fixed phrase plus a bounded chat title, never more than 120 characters', () => {
  assert.equal(notificationBody('claude', 'finished', 'Castle'), 'Claude finished in “Castle”.');
  assert.equal(notificationBody('codex', 'finished', ''), 'ChatGPT finished.');
  assert.equal(notificationBody('claude', 'attention', 'Run'), 'Claude stopped and needs a look in “Run”.');
  assert.equal(notificationBody('codex', 'attention', 'Run', 'approval'), 'ChatGPT is waiting for your approval in “Run”.');
  const long = notificationBody('claude', 'finished', 'x'.repeat(500) + '‮\n');
  assert.ok(long.length <= 120); assert.doesNotMatch(long, /[‮\n]/);
  assert.equal(boundedText('a\u0000b  c'), 'a b c');
});

test('notification setting defaults on and only an exact saved false turns it off', () => {
  const store = (value: string | null) => ({ getItem: (key: string) => key === NOTIFY_SETTING_KEY ? value : null, setItem() {} });
  assert.equal(notificationsEnabled(null), true);
  assert.equal(notificationsEnabled(store(null)), true);
  assert.equal(notificationsEnabled(store('{bad')), true);
  assert.equal(notificationsEnabled(store(JSON.stringify({ version: 1, enabled: false }))), false);
  assert.equal(notificationsEnabled(store(JSON.stringify({ version: 1, enabled: true }))), true);
  assert.equal(notificationsEnabled({ getItem: () => { throw new Error('denied'); }, setItem() {} }), true);
});

test('desktop checkout replies map to fixed states; plans routes desktop buys through the host bridge', async () => {
  assert.equal(readDesktopCheckout({ version: 1, state: 'opened', message: 'x' }), 'opened');
  assert.equal(readDesktopCheckout({ version: 1, state: 'charged' }), 'unavailable');
  assert.equal(readDesktopCheckout(null), 'unavailable');
  const source = await readFile('apps/desktop/src/plans.ts', 'utf8');
  assert.match(source, /bridge\.openCheckout\(id\)/);
  const notifications = await readFile('apps/desktop/src/notifications.ts', 'utf8');
  assert.doesNotMatch(notifications, /\.innerHTML|\.outerHTML/);
  const codex = await readFile('apps/desktop/src/codex-chat.ts', 'utf8');
  assertTextOnlyChatSource(codex);
});
