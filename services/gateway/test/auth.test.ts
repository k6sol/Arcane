import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyedHash } from '../src/auth.ts';
import { bearer, formPost, postJson, signIn, startHarness } from './helpers.ts';

test('device code + email link issues an opaque bearer token once and stores only hashes', async () => {
  const h = await startHarness();
  try {
    const device = await (await postJson(h.base + '/v1/auth/device', {})).json() as Record<string, any>;
    assert.match(device.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.equal(device.verificationUrl, h.config.publicUrl + '/v1/auth/verify');
    assert.equal(device.interval, 5);
    // Not approved yet.
    assert.deepEqual(await (await postJson(h.base + '/v1/auth/token', { deviceCode: device.deviceCode })).json(), { error: 'authorization_pending' });
    // Polling faster than the interval is told to slow down.
    assert.deepEqual(await (await postJson(h.base + '/v1/auth/token', { deviceCode: device.deviceCode })).json(), { error: 'slow_down' });

    // Wrong code: same page, no mail.
    const wrong = await fetch(h.base + '/v1/auth/verify', formPost({ user_code: 'BBBB-BBBB', email: 'maker@example.com' }));
    assert.equal(wrong.status, 200); assert.equal(h.mails.length, 0);
    // Cross-site form posts are refused.
    const cross = await fetch(h.base + '/v1/auth/verify', { ...formPost({ user_code: device.userCode, email: 'a@example.com' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' } });
    assert.equal(cross.status, 403); assert.equal(h.mails.length, 0);

    await fetch(h.base + '/v1/auth/verify', formPost({ user_code: device.userCode.toLowerCase(), email: ' Maker@Example.com ' }));
    assert.equal(h.mails.length, 1); assert.equal(h.mails[0].to, 'maker@example.com');
    const link = /confirm\?t=([A-Za-z0-9_-]+)/.exec(h.mails[0].text)![1];

    // GET shows the code but does not approve (mail scanners prefetch links).
    const confirmPage = await (await fetch(h.base + '/v1/auth/confirm?t=' + link)).text();
    assert.ok(confirmPage.includes(device.userCode));
    h.clock.now += 6000;
    assert.deepEqual(await (await postJson(h.base + '/v1/auth/token', { deviceCode: device.deviceCode })).json(), { error: 'authorization_pending' });

    assert.equal((await fetch(h.base + '/v1/auth/confirm', formPost({ t: link }))).status, 200);
    assert.equal((await fetch(h.base + '/v1/auth/confirm', formPost({ t: link }))).status, 410, 'links are single use');
    h.clock.now += 6000;
    const issued = await (await postJson(h.base + '/v1/auth/token', { deviceCode: device.deviceCode })).json() as Record<string, any>;
    assert.match(issued.token, /^arc_[A-Za-z0-9_-]{43}$/); assert.equal(issued.tokenType, 'Bearer');
    h.clock.now += 6000;
    assert.deepEqual(await (await postJson(h.base + '/v1/auth/token', { deviceCode: device.deviceCode })).json(), { error: 'invalid_grant' }, 'issued once');

    // Only hashes at rest.
    const stored = h.db.prepare('SELECT hash FROM tokens').all() as { hash: string }[];
    assert.deepEqual(stored.map(row => row.hash), [keyedHash(h.config, 'token', issued.token)]);
    const dump = JSON.stringify([h.db.prepare('SELECT * FROM tokens').all(), h.db.prepare('SELECT * FROM device_requests').all(), h.db.prepare('SELECT * FROM login_links').all()]);
    assert.ok(!dump.includes(issued.token) && !dump.includes(device.deviceCode) && !dump.includes(link));

    // Token works, then logout revokes it.
    assert.equal((await fetch(h.base + '/v1/balance', { headers: bearer(issued.token) })).status, 200);
    assert.equal((await fetch(h.base + '/v1/auth/logout', { method: 'POST', headers: bearer(issued.token) })).status, 200);
    assert.equal((await fetch(h.base + '/v1/balance', { headers: bearer(issued.token) })).status, 401);
    const events = (h.db.prepare('SELECT event FROM audit ORDER BY id').all() as { event: string }[]).map(row => row.event);
    for (const event of ['auth.link_sent', 'account.created', 'auth.device_approved', 'auth.token_issued']) assert.ok(events.includes(event), event);
  } finally { await h.close(); }
});

test('expired device codes and bad tokens are refused', async () => {
  const h = await startHarness();
  try {
    const device = await (await postJson(h.base + '/v1/auth/device', {})).json() as Record<string, any>;
    h.clock.now += 11 * 60_000;
    assert.deepEqual(await (await postJson(h.base + '/v1/auth/token', { deviceCode: device.deviceCode })).json(), { error: 'expired_token' });
    for (const header of [undefined, 'Bearer nope', 'Basic abc', 'Bearer arc_' + 'a'.repeat(43)]) {
      const response = await fetch(h.base + '/v1/balance', { headers: header ? { Authorization: header } : {} });
      assert.equal(response.status, 401, String(header));
    }
    const token = await signIn(h);
    assert.equal((await fetch(h.base + '/v1/usage', { headers: bearer(token) })).status, 200);
  } finally { await h.close(); }
});
