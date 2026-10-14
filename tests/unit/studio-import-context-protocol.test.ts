import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isWrite, methodField, studioImportContextObservation } from '../../packages/protocol/src/studio.js';
import { importContextFixture } from './studio-import-context-fixture.js';

test('import context is a closed read capability with copied Workspace metadata', () => {
  const { observation } = importContextFixture();
  assert.equal(methodField('scene.import_context'), 'scene.import_context');
  assert.equal(isWrite('scene.import_context'), false);
  assert.throws(() => methodField('scene.import_context.execute'), { code: 'METHOD' });
  const decoded = studioImportContextObservation(observation);
  assert.deepEqual(decoded, observation);
  assert.notEqual(decoded, observation);
  assert.notEqual(decoded.parentRef, observation.parentRef);
  assert.notEqual(decoded.parentRef.pathSegments, observation.parentRef.pathSegments);
  assert.notEqual(decoded.creator, observation.creator);
  assert.notEqual(decoded.studioUser, observation.studioUser);
});

test('creator ownership and local Studio identity retain distinct provenance', () => {
  const { observation } = importContextFixture();
  for (const kind of ['user', 'group'] as const) for (const mode of ['Edit', 'Play'] as const) {
    assert.equal(studioImportContextObservation({ ...observation, mode, creator: { ...observation.creator, kind } }).creator.kind, kind);
  }
  const local = { ...observation, placeId: 0, universeId: 0,
    creator: { status: 'unavailable', kind: null, id: 0, provenance: 'game.CreatorType/CreatorId' },
    studioUser: { status: 'available', id: 78, provenance: 'StudioService:GetUserId' } };
  assert.equal(studioImportContextObservation(local).studioUser.id, 78);
  assert.equal(studioImportContextObservation({ ...local, studioUser: { ...local.studioUser, status: 'unavailable', id: null } }).studioUser.id, null);
  for (const partial of [{ placeId: 1 }, { universeId: 1 }, { creator: { ...local.creator, id: 1 } }]) {
    assert.throws(() => studioImportContextObservation({ ...local, ...partial }), { code: 'INPUT' });
    assert.equal(studioImportContextObservation({ ...local, ...partial, studioUser: observation.studioUser }).studioUser.status, 'not_applicable');
  }
  assert.throws(() => studioImportContextObservation({ ...local, studioUser: observation.studioUser }), { code: 'INPUT' });
});

test('all IDs are exact safe integers; anonymous and invalid identities never become positive creators', () => {
  const { observation } = importContextFixture();
  for (const id of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12', null]) {
    for (const key of ['placeId', 'universeId']) assert.throws(() => studioImportContextObservation({ ...observation, [key]: id }), { code: 'INPUT' });
    assert.throws(() => studioImportContextObservation({ ...observation, creator: { ...observation.creator, id } }), { code: 'INPUT' });
  }
  for (const change of [{ id: 0 }, { kind: 'organization' }, { kind: null }, { provenance: 'browser' }]) {
    assert.throws(() => studioImportContextObservation({ ...observation, creator: { ...observation.creator, ...change } }), { code: 'INPUT' });
  }
  assert.equal(studioImportContextObservation({ ...observation, creator: { ...observation.creator, status: 'unavailable', kind: null } }).creator.status, 'unavailable');
  const local = { ...observation, placeId: 0, universeId: 0,
    creator: { status: 'unavailable', kind: null, id: 0, provenance: 'game.CreatorType/CreatorId' } };
  for (const id of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '78', null]) {
    assert.throws(() => studioImportContextObservation({ ...local, studioUser: { ...observation.studioUser, status: 'available', id } }), { code: 'INPUT' });
  }
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(studioImportContextObservation({ ...observation, placeId: max, universeId: max, creator: { ...observation.creator, id: max } }).creator.id, max);
});

test('result, nested observations and root refs refuse extra, missing or invented authority fields', () => {
  const { observation } = importContextFixture();
  const hidden = Object.defineProperty({ ...observation }, 'accepted', { value: true });
  const accessor = Object.defineProperty({ ...observation }, 'placeId', { get: () => 12 });
  assert.throws(() => studioImportContextObservation(hidden), { code: 'INPUT' });
  assert.throws(() => studioImportContextObservation(accessor), { code: 'INPUT' });
  assert.throws(() => studioImportContextObservation({ ...observation, [Symbol('extra')]: true }), { code: 'INPUT' });
  for (const value of [null, [], new Map(), { ...observation, accepted: true }, { ...observation, mutation: {} },
    { ...observation, mode: 'Unknown' }, { ...observation, modeProvenance: 'RunService:IsEdit' },
    { ...observation, creator: { ...observation.creator, token: 'fixture-only' } },
    { ...observation, studioUser: { ...observation.studioUser, id: 78 } },
    { ...observation, studioUser: { ...observation.studioUser, provenance: 'current-ui' } }]) {
    assert.throws(() => studioImportContextObservation(value));
  }
  for (const key of Object.keys(observation)) {
    const missing = { ...observation } as Record<string, unknown>; delete missing[key];
    assert.throws(() => studioImportContextObservation(missing));
  }
  for (const change of [{ instanceId: '' }, { instanceId: 'x'.repeat(257) }, { sessionId: 'other' },
    { root: 'ServerStorage' }, { className: 'Folder' }, { pathSegments: ['Workspace'] },
    { pathSegments: {} }, { guessedPath: 'Workspace' }]) {
    assert.throws(() => studioImportContextObservation({ ...observation, parentRef: { ...observation.parentRef, ...change } }));
  }
});

const wireProof = process.env.ARCANE_IMPORT_CONTEXT_WIRE_PROOF;
test('actual offline Transport POST bodies decode with the closed host DTO including explicit null fields',
  { skip: !wireProof && 'Run the standalone plugin wire fixture first and supply its retained wire-receipts.json.' }, () => {
    const cases = JSON.parse(readFileSync(wireProof!, 'utf8')) as { label: string; body: string }[];
    assert.deepEqual(cases.map(item => item.label), ['published-user', 'published-group', 'published-unavailable', 'local-available', 'local-anonymous', 'local-api-unavailable']);
    for (const item of cases) {
      const receipt = JSON.parse(item.body) as { state: string; sessionId: string; result: unknown };
      assert.equal(receipt.state, 'succeeded');
      const decoded = studioImportContextObservation(receipt.result);
      assert.equal(decoded.sessionId, receipt.sessionId);
      assert.equal(decoded.parentRef.sessionId, receipt.sessionId);
      assert.equal(decoded.mode, 'Edit');
      if (item.label === 'published-user' || item.label === 'published-group') {
        assert.equal(decoded.creator.status, 'available');
        assert.equal(decoded.creator.kind, item.label === 'published-user' ? 'user' : 'group');
        assert.equal(decoded.creator.id, 56);
      } else {
        assert.equal(decoded.creator.status, 'unavailable');
        assert.equal(decoded.creator.kind, null);
        assert.equal(decoded.creator.id, 0);
      }
      assert.equal(decoded.studioUser.status, item.label.startsWith('published-') ? 'not_applicable' : item.label === 'local-available' ? 'available' : 'unavailable');
      assert.equal(decoded.studioUser.id, item.label === 'local-available' ? 78 : null);
    }
  });
