import test from 'node:test';
import assert from 'node:assert/strict';
import {studioUploadContextObservation, type StudioSession} from '../../packages/protocol/src/studio.js';
import {validateCommandArgs} from '../../packages/core/src/studio-policy.js';
import {importContextFixture} from './studio-import-context-fixture.js';

test('published uploader is observed independently of the place creator and grants no permission', () => {
  const {observation} = importContextFixture();
  for (const uploader of [{status: 'available', id: 78, provenance: 'StudioService:GetUserId'}, {status: 'unavailable', id: null, provenance: 'StudioService:GetUserId'}]) {
    const result = studioUploadContextObservation({...observation, uploader});
    assert.deepEqual(result.uploader, uploader); assert.equal(result.creator.id, 56);
    assert.equal(result.studioUser.status, 'not_applicable');
    assert.equal(Object.hasOwn(result, 'uploadAllowed'), false); assert.equal(Object.hasOwn(result, 'rightsCertified'), false);
  }
});
test('upload observation rejects inferred IDs, permission claims and accessor records', () => {
  const {observation} = importContextFixture();
  const input = {...observation, uploader: {status: 'available', id: 78, provenance: 'StudioService:GetUserId'}};
  for (const uploader of [{...input.uploader, id: 0}, {...input.uploader, id: '78'}, {...input.uploader, id: Infinity},
    {...input.uploader, provenance: 'game.CreatorId'}, {...input.uploader, uploadAllowed: true}, {status: 'unavailable', id: 56, provenance: 'StudioService:GetUserId'}])
    assert.throws(() => studioUploadContextObservation({...input, uploader}), {code: 'INPUT'});
  assert.throws(() => studioUploadContextObservation({...input, rightsCertified: true}), {code: 'INPUT'});
  let called = false;
  const accessor = {...input}; Object.defineProperty(accessor, 'uploader', {get() {called = true; return input.uploader;}});
  assert.throws(() => studioUploadContextObservation(accessor), {code: 'INPUT'}); assert.equal(called, false);
});
test('upload context is a fixed empty read confined to the granted Workspace', () => {
  const {session} = importContextFixture();
  const paired: StudioSession = {...session, capabilities: ['scene.upload_context']};
  assert.deepEqual(validateCommandArgs('scene.upload_context', {}, paired), {});
  for (const args of [[], {creatorId: 56}, {uploaderId: 78}, {rightsCertified: true}])
    assert.throws(() => validateCommandArgs('scene.upload_context', args, paired), {code: 'INPUT'});
  assert.throws(() => validateCommandArgs('scene.upload_context', {}, {...paired, allowedRoots: ['ServerStorage']}), {code: 'SCOPE'});
});
