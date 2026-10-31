import test from 'node:test';
import assert from 'node:assert/strict';
import {USER_ERRORS,userError,userErrorLabel,userErrorText} from '../../apps/desktop/src/user-errors.js';

test('the same failure has a stable readable reference instead of a job-specific identity',()=>{
  assert.equal(userError('FRAME_LIMIT'),USER_ERRORS[411]);
  assert.equal(userError('NATIVE_FRAME_LIMIT'),USER_ERRORS[411]);
  assert.equal(userError('TASK_RECOVERY_REQUIRED'),USER_ERRORS[412]);
  assert.match(userErrorText(userError('FRAME_LIMIT')),/^Error 411 · .+size.+unconfirmed/i);
  assert.match(userErrorText(USER_ERRORS[412]),/Reconnecting does not settle/);
  assert.ok(Object.isFrozen(USER_ERRORS)&&Object.isFrozen(userError('FRAME_LIMIT')));
});

test('model details distinguish geometry, material, texture, export and preview failures',()=>{
  assert.equal(userError('MESH_AUDIT','model').number,432);
  assert.equal(userError('MESH_MATERIAL_NODE','model').number,433);
  assert.equal(userError('HOST_FAILURE','model','texture-authoring').number,434);
  assert.equal(userError('HOST_FAILURE','model','export-roundtrip').number,435);
  assert.equal(userError('STUDIO_STAGE_CONTINUITY','import').number,436);
  assert.equal(userError(null,'preview').number,437);
  assert.match(userErrorText(userError('STUDIO_STAGE_CONTINUITY','import')),/not proof of an uploaded asset/);
});

test('unknown data cannot inject a reference, explanation or private provider output into the catalogue',()=>{
  const privateText='private@example.invalid token=private-fixture C:\\private\\model.blend';let reads=0;
  const accessor=Object.defineProperty({},'code',{get(){reads++;return privateText;}});
  for(const code of [undefined,null,accessor,'constructor','__proto__',privateText]){
    assert.equal(userError(code).number,499);
    assert.doesNotMatch(userErrorText(userError(code)),/private|token=|model\.blend/);
  }
  assert.equal(reads,0);
  const numbers=Object.values(USER_ERRORS).map(error=>error.number);
  assert.equal(new Set(numbers).size,numbers.length);
  for(const error of Object.values(USER_ERRORS)){assert.match(userErrorLabel(error),/^Error \d{3} · /);assert.ok(error.explanation&&error.nextStep);}
});
