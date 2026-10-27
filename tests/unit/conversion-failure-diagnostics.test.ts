import assert from 'node:assert/strict';
import test from 'node:test';
import { conversionWorkerFailure, decodeAssetJobError, failureMessage, failureStage, workerFailure } from '../../packages/asset-pipeline/src/failure-diagnostics.js';
import type { CommandResult } from '../../packages/asset-pipeline/src/process.js';

const command = (stdout: string, extra: Partial<CommandResult> = {}): CommandResult => ({
  stdout, stderr: 'private native traceback must not be copied', exitCode: 1, signal: null, ...extra,
});
const report = (stage: string, reason: string) => 'ARCANE_FAILURE ' + JSON.stringify({ stage, reason, type: 'conversion-refused' });

test('conversion failures retain the exact bounded stage and reason through journal decoding', () => {
  const error = conversionWorkerFailure(command(report('source-map', 'MAP')), 'generate');
  assert.equal(error.code, 'BLENDER_FAILED');
  assert.equal(error.diagnostic?.stage, 'source-map');
  assert.equal(error.diagnostic?.reasonCode, 'CONVERSION_MAP');
  assert.equal(error.diagnostic?.exceptionType, null);
  const diagnostic = { ...error.diagnostic!, logPath: 'failure.json' as const };
  const saved = { code: error.code, message: failureMessage(error.message, diagnostic), diagnostic };
  assert.deepEqual(decodeAssetJobError(JSON.parse(JSON.stringify(saved))), saved);
  assert.match(saved.message, /source-map/);
  assert.match(saved.message, /matched to the source primitive map/);
  assert.match(saved.message, /failure\.json/);
  assert.doesNotMatch(saved.message, /private native traceback/);
});

test('all fixed worker reason tokens and conversion stages round-trip without invented exception types', () => {
  const reasons = ['INPUT', 'SOURCE', 'MAP', 'FEATURE', 'GEOMETRY', 'MATERIAL', 'COLLISION', 'EXPORT', 'REOPEN', 'RENDER', 'IO', 'NATIVE', 'IO_PATH', 'IO_LINK', 'IO_TYPE', 'IO_SIZE', 'IO_IDENTITY', 'IO_READ', 'IO_CHANGED', 'IO_EXISTS', 'IO_ACCESS', 'GEOMETRY_COUNTS', 'GEOMETRY_TRANSFORM', 'GEOMETRY_DIRECTION', 'GEOMETRY_TOPOLOGY', 'GEOMETRY_AREA', 'GEOMETRY_UV', 'GEOMETRY_TRIANGLES', 'GEOMETRY_HASH', 'GEOMETRY_HASH_POSITION', 'GEOMETRY_HASH_NORMAL', 'GEOMETRY_HASH_TANGENT', 'GEOMETRY_HASH_UV', 'GEOMETRY_HASH_COLOR', 'GEOMETRY_HASH_CORNER_ASSOCIATION', 'FIDELITY_POSITION', 'FIDELITY_NORMAL', 'FIDELITY_TANGENT', 'FIDELITY_UV', 'FIDELITY_COLOR', 'FIDELITY_TRANSFORM', 'FIDELITY_CONDITION', 'FIDELITY_CORRESPONDENCE', 'FIDELITY_HIERARCHY'];
  const stages = ['input', 'source-import', 'source-map', 'collision', 'scene-save', 'export', 'scene-reopen', 'export-roundtrip', 'review-render', 'audit-write'];
  for (const reason of reasons) for (const stage of stages) {
    const error = conversionWorkerFailure(command(report(stage, reason)), 'generate');
    assert.equal(failureStage(stage), stage);
    assert.equal(error.diagnostic?.stage, stage);
    assert.equal(error.diagnostic?.reasonCode, 'CONVERSION_' + reason);
    assert.equal(error.diagnostic?.exceptionType, null);
    assert.deepEqual(decodeAssetJobError({ code: error.code, message: error.message, diagnostic: error.diagnostic }).diagnostic, error.diagnostic);
  }
});

test('invalid or ambiguous conversion wire reports fall back without exposing native text', () => {
  const good = report('export', 'EXPORT');
  const malformed = [
    good + '\n' + good,
    'ARCANE_FAILURE not-json',
    'ARCANE_FAILURE null',
    'ARCANE_FAILURE []',
    report('private-stage-secret', 'EXPORT'),
    report('export', 'private-reason-secret'),
    'ARCANE_FAILURE ' + JSON.stringify({ stage: 'export', reason: 'EXPORT', type: 'conversion-refused', path: 'private-path-secret' }),
    'ARCANE_FAILURE ' + JSON.stringify({ stage: 'export', reason: 'EXPORT', type: 'private-type-secret' }),
    'ARCANE_FAILURE ' + ' '.repeat(513) + '{}',
  ];
  for (const stdout of malformed) {
    const error = conversionWorkerFailure(command(stdout), 'source-import');
    assert.equal(error.diagnostic?.stage, 'source-import');
    assert.equal(error.diagnostic?.reasonCode, 'WORKER_EXIT');
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /private-/);
    assert.doesNotMatch(error.message, /private-/);
  }
});

test('conversion result text cannot claim process closure, success, cancellation or retry authority', () => {
  const error = conversionWorkerFailure(command(report('collision', 'COLLISION'), { exitCode: null, signal: 'SIGTERM' }), 'generate');
  assert.equal(error.code, 'BLENDER_FAILED');
  assert.match(error.message, /SIGTERM/);
  assert.equal(error.diagnostic?.reasonCode, 'CONVERSION_COLLISION');
  assert.equal(Object.hasOwn(error.diagnostic!, 'closed'), false);
  assert.equal(Object.hasOwn(error.diagnostic!, 'retry'), false);
  assert.equal(Object.hasOwn(error.diagnostic!, 'state'), false);
});

test('recovered conversion diagnostics reject forged text, extra evidence or an invented exception', () => {
  const error = conversionWorkerFailure(command(report('source-import', 'FEATURE')), 'generate');
  const valid = { code: error.code, message: error.message, diagnostic: error.diagnostic! };
  for (const change of [
    { reason: 'private-reason-secret' }, { reasonCode: 'CONVERSION_UNKNOWN' },
    { stage: 'blockout' }, { exceptionType: 'RuntimeError' },
    { metrics: {} }, { artifactPath: 'asset.glb' }, { auditPath: 'audit.json' },
    { logPath: 'private-path-secret' },
  ]) assert.throws(() => decodeAssetJobError({ ...valid, diagnostic: { ...valid.diagnostic, ...change } }));
});

test('legacy worker failures retain their existing wire protocol', () => {
  const diagnostic = { schemaVersion: 1, stage: 'mesh-validation', reasonCode: 'MESH_AUDIT', exceptionType: 'ValueError',
    metrics: { renderTriangles: 0, triangleBudget: 20000 }, auditPath: 'audit.json' };
  const result = command('ARCANE_FAILURE ' + JSON.stringify(diagnostic));
  const old = workerFailure(result, 'generate');
  assert.equal(old.diagnostic?.reasonCode, 'MESH_AUDIT');
  assert.match(old.message, /outside 1\.\.20000/);
  assert.equal(conversionWorkerFailure(result, 'source-map').diagnostic?.reasonCode, 'WORKER_EXIT');
  assert.equal(workerFailure(command(report('source-map', 'MAP')), 'generate').diagnostic?.reasonCode, 'WORKER_EXIT');
});

test('conversion file failures explain the refused check without paths or native exception text', () => {
  const explanations: Record<string, RegExp> = {
    IO_PATH: /absolute owned path/, IO_LINK: /multiple hard links/, IO_TYPE: /ordinary file or directory/,
    IO_SIZE: /allowed byte range/, IO_IDENTITY: /opened conversion file metadata/, IO_READ: /ended early/,
    IO_CHANGED: /changed while/, IO_EXISTS: /will not be overwritten/, IO_ACCESS: /operating system refused/,
  };
  for (const [reason, explanation] of Object.entries(explanations)) {
    const error = conversionWorkerFailure(command(report('input', reason)), 'source-import');
    assert.match(error.message, explanation); assert.doesNotMatch(error.message, /private|traceback/);
    assert.deepEqual(decodeAssetJobError({ code: error.code, message: error.message, diagnostic: error.diagnostic }).diagnostic, error.diagnostic);
  }
});

test('conversion geometry details identify the refused check without model coordinates or names', () => {
  const explanations: Record<string, RegExp> = {
    GEOMETRY_COUNTS: /count is outside/, GEOMETRY_TRANSFORM: /cannot be inverted/,
    GEOMETRY_DIRECTION: /cannot be normalized/, GEOMETRY_TOPOLOGY: /not used by its faces/,
    GEOMETRY_AREA: /world-space face area/, GEOMETRY_UV: /UV coordinate is nonfinite/,
    GEOMETRY_TRIANGLES: /triangle count differs/, GEOMETRY_HASH: /digest does not match/,
  };
  for (const [reason, explanation] of Object.entries(explanations)) {
    const error = conversionWorkerFailure(command(report('source-map', reason)), 'source-import');
    assert.equal(error.diagnostic?.reasonCode, 'CONVERSION_' + reason); assert.match(error.message, explanation);
    assert.doesNotMatch(error.message, /private native traceback/);
    assert.deepEqual(decodeAssetJobError({ code: error.code, message: error.message, diagnostic: error.diagnostic }).diagnostic, error.diagnostic);
  }
});

test('conversion semantic hints retain full-comparison refusal without claiming numerical drift or approval', () => {
  const hints: Record<string, RegExp> = {
    POSITION: /world-position projection/, NORMAL: /surface-normal projection/,
    TANGENT: /surface-tangent projection/, UV: /texture-coordinate projections/,
    COLOR: /vertex-color projections/, CORNER_ASSOCIATION: /corner association remains unverified/,
  };
  for (const [group, explanation] of Object.entries(hints)) {
    const error = conversionWorkerFailure(command(report('source-map', 'GEOMETRY_HASH_' + group)), 'source-import');
    assert.equal(error.code, 'BLENDER_FAILED');
    assert.equal(error.diagnostic?.reasonCode, 'CONVERSION_GEOMETRY_HASH_' + group);
    assert.match(error.message, explanation);
    assert.doesNotMatch(error.message, /harmless|tolerance|approved|private native traceback/);
    assert.deepEqual(Object.keys(error.diagnostic!).sort(), ['exceptionType', 'reason', 'reasonCode', 'schemaVersion', 'stage']);
    assert.deepEqual(decodeAssetJobError({ code: error.code, message: error.message, diagnostic: error.diagnostic }).diagnostic, error.diagnostic);
    for (const extra of [{ coordinates: [0, 0, 0] }, { expectedHash: 'a'.repeat(64) }, { closed: true }]) {
      const forged = 'ARCANE_FAILURE ' + JSON.stringify({ stage: 'source-map', reason: 'GEOMETRY_HASH_' + group, type: 'conversion-refused', ...extra });
      assert.equal(conversionWorkerFailure(command(forged), 'source-import').diagnostic?.reasonCode, 'WORKER_EXIT');
    }
  }
});
