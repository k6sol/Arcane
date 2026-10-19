import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { workerLaunchDirectory, workerFileArgument, workerDirectoryArgument } from '../../packages/asset-pipeline/src/launch-paths.js';
import { workerFailure } from '../../packages/asset-pipeline/src/failure-diagnostics.js';
import { validateManifestFiles } from '../../packages/asset-pipeline/src/validation.js';

const executable = 'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe';
const windowsPath = (length: number) => 'C:\\assets\\' + 'a'.repeat(length - 'C:\\assets\\'.length);

test('only Windows long launch directories use the trusted executable parent', () => {
  assert.equal(workerLaunchDirectory(executable, windowsPath(259), 'win32'), windowsPath(259));
  assert.equal(workerLaunchDirectory(executable, windowsPath(260), 'win32'), win32.dirname(executable));
  assert.equal(workerLaunchDirectory(executable, windowsPath(400), 'win32'), win32.dirname(executable));
  assert.equal(workerLaunchDirectory('/opt/blender/blender', '/tmp/' + 'a'.repeat(400), 'linux'), '/tmp/' + 'a'.repeat(400));
});

test('fixed Python arguments gain extended spelling only at the Windows path limit', () => {
  assert.equal(workerFileArgument(windowsPath(259), 'win32'), windowsPath(259));
  assert.equal(workerFileArgument(windowsPath(260), 'win32'), '\\\\?\\' + windowsPath(260));
  const namespaced = '\\\\?\\' + windowsPath(400);
  assert.equal(workerFileArgument(namespaced, 'win32'), namespaced);
  assert.equal(workerFileArgument('/tmp/' + 'a'.repeat(400), 'darwin'), '/tmp/' + 'a'.repeat(400));
});

test('directory spelling covers long children while preserving local and UNC targets', () => {
  assert.equal(workerDirectoryArgument('C:\\short\\job', 'win32'), '\\\\?\\C:\\short\\job');
  assert.equal(workerDirectoryArgument('\\\\server\\share\\job', 'win32'), '\\\\?\\UNC\\server\\share\\job');
  assert.equal(workerDirectoryArgument('\\\\?\\C:\\short\\job', 'win32'), '\\\\?\\C:\\short\\job');
  assert.equal(workerDirectoryArgument('/tmp/job', 'linux'), '/tmp/job');
});

test('unavailable verified alias is a bounded diagnostic at the observed scene stage', () => {
  const report = { schemaVersion: 1, stage: 'checkpoint-save', reasonCode: 'WINDOWS_PATH_LIMIT', exceptionType: 'ValueError', artifactPath: 'blockout.blend' };
  const error = workerFailure({ stdout: 'ARCANE_FAILURE ' + JSON.stringify(report) + '\n', stderr: '', exitCode: 1, signal: null }, 'generate');
  assert.equal(error.diagnostic!.stage, 'checkpoint-save');
  assert.equal(error.diagnostic!.reasonCode, 'WINDOWS_PATH_LIMIT');
  assert.equal(error.diagnostic!.artifactPath, 'blockout.blend');
  assert.match(error.message, /verified short directory alias/);
  assert.doesNotMatch(error.message, /C:\\|\\\\\?\\/);
});

test('native long job remains in its original directory and survives deep scene audit', { skip: !process.env.ARCANE_LONG_PATH_NATIVE_REPORT }, async () => {
  const report = JSON.parse(await readFile(process.env.ARCANE_LONG_PATH_NATIVE_REPORT!, 'utf8'));
  assert.equal(report.result.state, 'succeeded');
  assert.equal(report.deepValidation, 'passed');
  assert.ok(report.directory.length >= 260);
  const manifest = await validateManifestFiles(report.directory, JSON.parse(await readFile(report.manifestPath, 'utf8')));
  assert.equal(manifest.validation.savedSceneReopened, true);
  assert.ok(report.launches.length >= 6);
  for (const launch of report.launches) {
    assert.ok(launch.cwd.length < 260);
    assert.equal(launch.cwd, win32.dirname(launch.executable));
    assert.ok(launch.environmentDirectory.startsWith(report.directory));
  }
  assert.equal(report.shortResult.state, 'succeeded');
});
