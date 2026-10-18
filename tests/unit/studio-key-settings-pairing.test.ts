import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalText, pairingView, readPairingReply, StudioPairing, PAIRING_MESSAGES, STUDIO_PAIRED_EVENT, waitingText } from '../../apps/desktop/src/studio-key-settings.js';

const offerId = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', keyId = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
const pending = (code = '042718', discovery: 'listening' | 'unavailable' = 'listening') => ({
  offer: { offerId, code, issuedAt: '2026-10-18T10:00:00.000Z', expiresAt: '2026-10-18T10:10:00.000Z', state: 'pending', allowedRoots: ['Workspace'], allowWrites: true, claim: null, request: null },
  discovery: { state: discovery, port: discovery === 'listening' ? 45870 : null },
});
const claimed = () => ({ ...pending(), offer: { ...pending().offer, state: 'claimed',
  claim: { placeName: 'Obby Place', placeId: 4242, universeId: 7, sessionId: 's-1', keyId, claimedAt: '2026-10-18T10:01:00.000Z' } } });
const asking = (approved = false) => ({ ...pending(), offer: { ...pending().offer, state: 'awaiting-approval',
  request: { placeName: 'Obby Place', placeId: 4242, universeId: 7, requestedAt: '2026-10-18T10:00:30.000Z', approved } } });

test('pairing replies are copied to fixed fields and anything else is refused', () => {
  assert.deepEqual(pairingView(readPairingReply(pending())), { phase: 'waiting', code: '042718', expiresAt: '2026-10-18T10:10:00.000Z', claim: null, request: null, message: waitingText('042718') });
  assert.equal(waitingText('042718'), 'Waiting for Studio… In Roblox Studio, type 042 718 into the Arcane plugin and click Connect.');
  assert.equal(pairingView(readPairingReply(pending('042718', 'unavailable'))).phase, 'busy');
  const ask = pairingView(readPairingReply(asking()));
  assert.deepEqual([ask.phase, ask.code, ask.request], ['approval', null, { placeName: 'Obby Place', placeId: 4242, universeId: 7 }], 'The code is no longer shown once a place asks.');
  assert.equal(ask.message, approvalText(ask.request!));
  assert.ok(ask.message.includes('“Obby Place” (place 4242) wants to connect. Approve only if'));
  assert.equal(pairingView(readPairingReply(asking(true))).phase, 'approved');
  const done = pairingView(readPairingReply(claimed()));
  assert.equal(done.phase, 'claimed');
  assert.deepEqual(done.claim, { placeName: 'Obby Place', placeId: 4242, keyId });
  assert.match(done.message, /Obby Place \(place 4242\).*Not you\? Revoke/);
  assert.equal(pairingView(readPairingReply({ offer: null, discovery: { state: 'idle', port: null } })).phase, 'idle');
  assert.equal(pairingView(readPairingReply({ ...pending(), offer: { ...pending().offer, state: 'expired' } })).message, PAIRING_MESSAGES.expired);
  for (const bad of [null, {}, { ...pending(), ticket: 'arcane_pair_v1_1_' + 'a'.repeat(48) }, { ...pending(), offer: { ...pending().offer, code: '1234' } }, { ...pending(), offer: { ...pending().offer, state: 'awaiting-approval' } },
    { ...asking(), offer: { ...asking().offer, request: { ...asking().offer.request, approved: 'yes' } } },
    { ...pending(), offer: { ...pending().offer, state: 'claimed' } }, { ...claimed(), offer: { ...claimed().offer, claim: { ...claimed().offer.claim, placeName: 'line\nbreak' } } },
    { ...pending(), offer: { ...pending().offer, apiKey: 'arcane_local_v1_1_' + 'a'.repeat(64) } }, { ...pending(), discovery: { state: 'open', port: 1 } }])
    assert.throws(() => readPairingReply(bad), Error, JSON.stringify(bad));
});

function fakeDocument() {
  const events: string[] = [];
  const doc = {
    getElementById: () => null,
    dispatchEvent: (event: { type: string }) => { events.push(event.type); return true; },
    defaultView: { CustomEvent: class { constructor(public type: string) {} } },
  } as unknown as Document;
  return { doc, events };
}

test('the controller sends one trusted-intent request with the control bearer and only shows the code', async t => {
  const { doc, events } = fakeDocument();
  const calls: { url: string; init: RequestInit }[] = [];
  let reply: unknown = pending('903112');
  const pairing = new StudioPairing(doc, 'http://127.0.0.1:5000', 'human-token', async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(reply), { status: 200 }); });
  t.after(() => pairing.cleanup());
  const seen: string[] = [];
  pairing.subscribe(() => seen.push(pairing.view().phase));
  await pairing.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:5000/v1/studio/pairing-offer');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer human-token');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { allowedRoots: ['Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPlayer', 'Lighting'], allowWrites: true });
  assert.deepEqual(seen, ['starting', 'waiting']);
  assert.equal(pairing.view().code, '903112');
  // A place asks; only a decision for this exact offer goes to the daemon.
  reply = asking();
  await pairing.refresh();
  assert.equal(pairing.view().phase, 'approval');
  reply = asking(true);
  await pairing.decide(true);
  assert.equal(calls.at(-1)!.url, 'http://127.0.0.1:5000/v1/studio/pairing-offer/decide');
  assert.deepEqual(JSON.parse(calls.at(-1)!.init.body as string), { offerId, approve: true });
  assert.equal(pairing.view().phase, 'approved');
  const before = calls.length;
  await pairing.decide(true);
  assert.equal(calls.length, before, 'No second decision once approved.');
  reply = claimed();
  await pairing.refresh();
  assert.equal(pairing.view().phase, 'claimed');
  assert.deepEqual(events, [STUDIO_PAIRED_EVENT], 'The key card learns the claimed key ID once.');
  reply = { revoked: true };
  await pairing.revokeClaim();
  assert.equal(calls.at(-1)!.url, 'http://127.0.0.1:5000/v1/studio/keys/revoke');
  assert.deepEqual(JSON.parse(calls.at(-1)!.init.body as string), { keyId });
  assert.equal(pairing.view().phase, 'idle');
});

test('a failed or tokenless start never pretends to wait', async t => {
  const { doc } = fakeDocument();
  const failing = new StudioPairing(doc, 'http://127.0.0.1:5000', 'human-token', async () => new Response('{}', { status: 500 }));
  t.after(() => failing.cleanup());
  await failing.start();
  assert.deepEqual(failing.view(), { phase: 'error', code: null, expiresAt: null, claim: null, request: null, message: PAIRING_MESSAGES.error });
  let called = false;
  const tokenless = new StudioPairing(doc, 'http://127.0.0.1:5000', '', async () => { called = true; return new Response('{}'); });
  t.after(() => tokenless.cleanup());
  await tokenless.start();
  assert.equal(called, false);
  assert.equal(tokenless.available(), false);
});
