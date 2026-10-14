import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommandArgs, validateStudioImportContextReceipt } from '../../packages/core/src/studio-policy.js';
import type { Json, StudioCommand, StudioSession } from '../../packages/protocol/src/studio.js';
import { importContextFixture } from './studio-import-context-fixture.js';

test('import context requires an empty JSON object, Workspace scope and explicit plugin capability', () => {
  const { session } = importContextFixture();
  assert.deepEqual(validateCommandArgs('scene.import_context', {}, session), {});
  assert.throws(() => validateCommandArgs('scene.import_context', Object.defineProperty({}, 'creatorId', { value: 56 }), session), { code: 'INPUT' });
  assert.throws(() => validateCommandArgs('scene.import_context', { [Symbol('creatorId')]: 56 }, session), { code: 'INPUT' });
  for (const args of [null, [], new Date(), new Map(), { root: 'Workspace' }, { ref: {} }, { creatorId: 56 }, { execute: 'print(1)' }, { hidden: undefined }]) {
    assert.throws(() => validateCommandArgs('scene.import_context', args, session), { code: 'INPUT' });
  }
  assert.throws(() => validateCommandArgs('scene.import_context', {}, { ...session, allowedRoots: ['ServerStorage'] }), { code: 'SCOPE' });
  assert.throws(() => validateCommandArgs('scene.import_context', {}, { ...session, capabilities: ['scene.children'] }), { code: 'CAPABILITY' });
});

test('host receipt decoder requires exact succeeded command, paired identity and root grant continuity', () => {
  const { session, command, observation } = importContextFixture();
  assert.deepEqual(validateStudioImportContextReceipt(command, session), observation);
  for (const change of [{ state: 'queued' }, { state: 'dispatched' }, { state: 'failed' }, { state: 'needs_reconciliation' },
    { method: 'scene.children' }, { protocolVersion: 2 }, { sessionId: 'other' }, { clientSessionId: 'other' },
    { allowedRoots: ['Workspace', 'ServerStorage'] }, { allowedRoots: ['ServerStorage'] }, { allowWrites: true }, { error: 'failed' }]) {
    assert.throws(() => validateStudioImportContextReceipt({ ...command, ...change } as StudioCommand, session), { code: 'SCOPE' });
  }
  for (const change of [{ id: 'other' }, { clientSessionId: 'other' }, { placeId: 13 }, { universeId: 35 }, { revokedAt: '2026-10-14T00:00:03.000Z' }]) {
    assert.throws(() => validateStudioImportContextReceipt(command, { ...session, ...change }), { code: 'SCOPE' });
  }
  for (const change of [{ sessionId: 'other' }, { placeId: 13 }, { universeId: 35 }]) {
    const result = { ...observation, ...change } as unknown as Json;
    assert.throws(() => validateStudioImportContextReceipt({ ...command, result }, session), { code: 'SCOPE' });
  }
  assert.throws(() => validateStudioImportContextReceipt({ ...command, args: { root: 'Workspace' } }, session), { code: 'INPUT' });
  assert.throws(() => validateStudioImportContextReceipt(command, { ...session, capabilities: [] }), { code: 'CAPABILITY' });
});

test('observation validation never invents manifest authority or treats local Studio user as place owner', () => {
  const { session, command, observation } = importContextFixture();
  const localSession: StudioSession = { ...session, placeId: 0, universeId: 0 };
  for (const status of ['available', 'unavailable'] as const) {
    const local = { ...observation, placeId: 0, universeId: 0,
      creator: { status: 'unavailable', kind: null, id: 0, provenance: 'game.CreatorType/CreatorId' },
      studioUser: { status, id: status === 'available' ? 78 : null, provenance: 'StudioService:GetUserId' } };
    const result = validateStudioImportContextReceipt({ ...command, result: local as unknown as Json }, localSession);
    assert.equal(result.creator.status, 'unavailable');
    assert.equal(result.creator.id, 0);
    assert.equal(result.studioUser.status, status);
    assert.equal(Object.hasOwn(result, 'accepted'), false);
    assert.equal(Object.hasOwn(result, 'creatorId'), false);
  }
});
