import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCommandArgs} from '../../packages/core/src/studio-policy.js';
import {isWrite, type StudioSession, type StudioAssetStageArgs} from '../../packages/protocol/src/studio.js';
import {importContextFixture} from './studio-import-context-fixture.js';

function fixture() {
  const base = importContextFixture().session;
  const session: StudioSession = {...base, allowWrites: true, capabilities: ['asset.stage_packet'], proof: {
    sessionId: base.id, clientLifetimeId: base.clientSessionId, pluginArtifactHash: 'a'.repeat(64), markerName: 'synthetic-marker',
    placeId: base.placeId, universeId: base.universeId, placeName: base.name, mode: 'Edit', playEpoch: 0,
    continuitySupported: true, connected: true, observedAt: base.lastSeenAt, expiresAt: '2026-10-14T00:00:07.000Z',
  }};
  const expected = {digest: 'b'.repeat(64), payloadDigest: 'c'.repeat(64), manifestDigest: 'd'.repeat(64)};
  const args: StudioAssetStageArgs = {expected, packet: JSON.stringify({formatVersion: 1, payloadDigest: expected.payloadDigest,
    manifestDigest: expected.manifestDigest, ordinal: 0, kind: 'begin'}),
    target: {sessionId: session.id, placeId: session.placeId, universeId: session.universeId, root: 'Workspace', parentRef: 'synthetic-parent', creator: {kind: 'group', id: '56'}},
    continuity: {clientLifetimeId: session.clientSessionId, pluginArtifactHash: 'a'.repeat(64), playEpoch: 0}};
  return {session, args};
}
test('binary intake is write-fenced but is separate from generic scene changes', () => {
  const {session, args} = fixture();
  assert.equal(isWrite('asset.stage_packet'), true);
  assert.deepEqual(validateCommandArgs('asset.stage_packet', args, session), args);
  assert.throws(() => validateCommandArgs('asset.stage_packet', args, {...session, allowWrites: false}), {code: 'READ_ONLY'});
  assert.throws(() => validateCommandArgs('asset.stage_packet', args, {...session, capabilities: []}), {code: 'CAPABILITY'});
});
test('staging envelope rejects changed place, native lifetime, artifact and Edit epoch', () => {
  const {session, args} = fixture();
  for (const [field, value] of Object.entries({sessionId: 'other', placeId: 13, universeId: 35, root: 'ServerStorage'})) {
    const changed = structuredClone(args); Object.assign(changed.target, {[field]: value});
    assert.throws(() => validateCommandArgs('asset.stage_packet', changed, session), {code: 'SCOPE'});
  }
  for (const [field, value] of Object.entries({clientLifetimeId: 'other', pluginArtifactHash: 'f'.repeat(64), playEpoch: 1})) {
    const changed = structuredClone(args); Object.assign(changed.continuity, {[field]: value});
    assert.throws(() => validateCommandArgs('asset.stage_packet', changed, session), {code: 'SCOPE'});
  }
  const missing = {...session}; delete missing.proof;
  assert.throws(() => validateCommandArgs('asset.stage_packet', args, missing), {code: 'SCOPE'});
  for (const patch of [{mode: 'Play' as const}, {connected: false}, {continuitySupported: false}])
    assert.throws(() => validateCommandArgs('asset.stage_packet', args, {...session, proof: {...session.proof!, ...patch}}), {code: 'SCOPE'});
});
test('packet metadata cannot substitute another revision or smuggle unbounded binary data', () => {
  const {session, args} = fixture();
  for (const packet of ['not-json', 'null', '[]', '{}', JSON.stringify({formatVersion: 1, ordinal: 512, kind: 'begin', payloadDigest: args.expected.payloadDigest, manifestDigest: args.expected.manifestDigest})])
    assert.throws(() => validateCommandArgs('asset.stage_packet', {...args, packet}, session), {code: 'INPUT'});
  assert.throws(() => validateCommandArgs('asset.stage_packet', {...args, permission: true}, session), {code: 'INPUT'});
  assert.throws(() => validateCommandArgs('asset.stage_packet', {...args, packet: args.packet+' '.repeat(256*1024)}, session), {code: 'BODY_LIMIT'});
});
