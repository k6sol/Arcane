import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeProbeFailure, RUNTIME_PROBE_REASONS, runtimeProbeDiagnostic, missingRuntimeCapability, runtimeProbeException } from '../../packages/asset-pipeline/src/probe-diagnostics.js';
import { decodeAssetJobError, workerFailure } from '../../packages/asset-pipeline/src/failure-diagnostics.js';
import { AssetError } from '../../packages/asset-pipeline/src/types.js';
import type { CommandResult } from '../../packages/asset-pipeline/src/process.js';

const result = (stderr: string, extra: Partial<CommandResult> = {}): CommandResult => ({ stdout: '', stderr, exitCode: 127, signal: null, ...extra });
const loader = (name: string) => `/private/runtime/blender: error while loading shared libraries: ${name}: cannot open shared object file: No such file or directory`;

test('known system loader names become fixed reasons rather than copied loader text', () => {
  for (const [name, code] of [
    ['libX11.so.6', 'RUNTIME_LIB_X11'], ['libXrender.so.1', 'RUNTIME_LIB_XRENDER'],
    ['libXfixes.so.3', 'RUNTIME_LIB_XFIXES'], ['libXi.so.6', 'RUNTIME_LIB_XI'],
    ['libXxf86vm.so.1', 'RUNTIME_LIB_XXF86VM'], ['libxkbcommon.so.0', 'RUNTIME_LIB_XKBCOMMON'],
    ['libSM.so.6', 'RUNTIME_LIB_SM'], ['libICE.so.6', 'RUNTIME_LIB_ICE'], ['libGL.so.1', 'RUNTIME_LIB_GL'],
    ['libGLX.so.0', 'RUNTIME_LIB_GLX'], ['libEGL.so.1', 'RUNTIME_LIB_EGL'], ['libgomp.so.1', 'RUNTIME_LIB_GOMP'],
    ['libstdc++.so.6', 'RUNTIME_LIB_STDCXX'], ['libc.so.6', 'RUNTIME_LIB_C'], ['libwayland-client.so.0', 'RUNTIME_LIB_WAYLAND'],
  ]) {
    const error = runtimeProbeFailure(result(loader(name!)));
    assert.equal(error.code, 'BLENDER_PROBE'); assert.equal(error.diagnostic?.reasonCode, code);
    assert.equal(error.diagnostic?.reason, RUNTIME_PROBE_REASONS[code!]); assert.equal(error.diagnostic?.stage, 'probe');
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /private\/runtime|error while loading/);
    assert.deepEqual(decodeAssetJobError({ code: error.code, message: error.message, diagnostic: error.diagnostic }).diagnostic, error.diagnostic);
  }
});

test('unknown, malformed, ambiguous and oversized loader output falls back without arbitrary text', () => {
  for (const stderr of [loader('private-library-secret.so.1'), loader('libSM.so.6') + '\n' + loader('libSM.so.6'),
    loader('libSM.so.6') + '\n' + loader('libICE.so.6'), loader('libSM.so.6') + ' private-suffix',
    'private-exception-secret', ' '.repeat(32769) + loader('libSM.so.6')]) {
    const error = runtimeProbeFailure(result(stderr)); assert.equal(error.diagnostic?.reasonCode, 'RUNTIME_PROBE_EXIT');
    assert.doesNotMatch(error.message, /private-|private\/|libSM|libICE/);
  }
});

test('loader tokens in stdout, exit-zero text and signalled probes cannot claim a missing dependency', () => {
  assert.equal(runtimeProbeFailure(result('', { stdout: loader('libSM.so.6') })).diagnostic?.reasonCode, 'RUNTIME_PROBE_EXIT');
  assert.equal(runtimeProbeFailure(result(loader('libSM.so.6'), { exitCode: 0 })).diagnostic?.reasonCode, 'RUNTIME_PROBE_EXIT');
  const error = runtimeProbeFailure(result(loader('libSM.so.6'), { exitCode: null, signal: 'SIGTERM' }));
  assert.equal(error.diagnostic?.reasonCode, 'RUNTIME_PROBE_SIGNAL');
  assert.equal(Object.hasOwn(error.diagnostic!, 'closed'), false); assert.equal(Object.hasOwn(error.diagnostic!, 'retry'), false);
});

test('retained runtime reasons cannot claim a different stage, arbitrary text or extra authority', () => {
  const error = runtimeProbeFailure(result(loader('libSM.so.6'))), saved = { code: error.code, message: error.message, diagnostic: error.diagnostic! };
  for (const change of [{ stage: 'generate' }, { reasonCode: 'RUNTIME_PRIVATE' }, { reason: 'private-secret' },
    { exceptionType: 'OSError' }, { metrics: {} }, { closed: true }, { artifactPath: 'asset.glb' }]) {
    assert.throws(() => decodeAssetJobError({ ...saved, diagnostic: { ...saved.diagnostic, ...change } }));
  }
  assert.equal(workerFailure(result(''), 'generate').diagnostic?.reasonCode, 'WORKER_EXIT');
});

test('missing capabilities are identified independently without claiming loader or process failure', () => {
  const good = { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true };
  assert.equal(missingRuntimeCapability(good), null);
  for (const [key, reason] of [['glbExport', 'RUNTIME_CAPABILITY_GLB_EXPORT'], ['glbImport', 'RUNTIME_CAPABILITY_GLB_IMPORT'],
    ['fbxExport', 'RUNTIME_CAPABILITY_FBX_EXPORT'], ['fbxImport', 'RUNTIME_CAPABILITY_FBX_IMPORT'], ['cycles', 'RUNTIME_CAPABILITY_CYCLES']] as const) {
    const diagnostic = missingRuntimeCapability({ ...good, [key]: false }); assert.equal(diagnostic?.reasonCode, reason);
    assert.deepEqual(decodeAssetJobError({ code: 'BLENDER_UNAVAILABLE', message: diagnostic!.reason, diagnostic }).diagnostic, diagnostic);
  }
});

test('thrown probe failures use fixed host codes and never copy exception text or paths', () => {
  for (const [code, reason] of [['PROCESS_START', 'RUNTIME_PROCESS_START'], ['PROCESS_PATH', 'RUNTIME_PROCESS_PATH'],
    ['PROCESS_LIMIT', 'RUNTIME_PROCESS_LIMIT'], ['PROCESS_OUTPUT', 'RUNTIME_PROCESS_OUTPUT'],
    ['SUPERVISION_UNRECORDED', 'RUNTIME_PROCESS_IDENTITY'], ['WORKER_PROTOCOL', 'RUNTIME_PROBE_INVALID'], ['BLENDER_PROBE', 'RUNTIME_PROBE_INVALID']] as const) {
    const diagnostic = runtimeProbeException(new AssetError(code, '/private/failure-secret'));
    assert.equal(diagnostic.reasonCode, reason); assert.doesNotMatch(JSON.stringify(diagnostic), /private|failure-secret/);
    assert.deepEqual(decodeAssetJobError({ code, message: diagnostic.reason, diagnostic }).diagnostic, diagnostic);
  }
  assert.equal(runtimeProbeException(new Error('private-native-secret')).reasonCode, 'RUNTIME_PROBE_FAILED');
  assert.equal(runtimeProbeException(new AssetError('constructor', 'private-native-secret')).reasonCode, 'RUNTIME_PROBE_FAILED');
  assert.throws(() => runtimeProbeDiagnostic('RUNTIME_PRIVATE_SECRET'));
  const loaderError = runtimeProbeFailure(result(loader('libSM.so.6')));
  assert.deepEqual(runtimeProbeException(loaderError), loaderError.diagnostic);
});
