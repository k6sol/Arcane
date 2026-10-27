import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ELECTRON, ARTIFACT_FILES, packagedNodeVersionMatches, assertHostedEnvironment, assertSourceIdentity,
  acquisitionEnvironment, validateElectronMetadata, selectElectronArchive, packagedGitOutcome, packagedChangedPaths } from '../../scripts/check-packaged-component-ci.mjs';

const hosted = () => ({ platform: 'win32', arch: 'x64', nodeVersion: '24.19.0', electronVersion: undefined,
  env: { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'k6sol/Arcane', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKSPACE: 'D:\\a\\Arcane\\Arcane' } });

test('packaged component guard refuses local, self-hosted, non-Windows and wrong-runtime execution', () => {
  assert.doesNotThrow(() => assertHostedEnvironment(hosted())); // Metadata only, never a native observation.
  for (const patch of [{ platform: 'linux' }, { arch: 'arm64' }, { nodeVersion: '22.0.0' }, { nodeVersion: '24.0.0-rc.1' }, { electronVersion: '44.9.1' }])
    assert.throws(() => assertHostedEnvironment({ ...hosted(), ...patch }), /HOST_TOOLCHAIN_REQUIRED/);
  for (const patch of [{ CI: 'false' }, { GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_OS: 'Linux' },
    { RUNNER_ARCH: 'ARM64' }, { GITHUB_REPOSITORY: 'other/Arcane' }, { GITHUB_SHA: 'a'.repeat(39) }, { GITHUB_WORKSPACE: 'relative' },
    { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: '0' }])
    assert.throws(() => assertHostedEnvironment({ ...hosted(), env: { ...hosted().env, ...patch } }), /HOSTED_ACTIONS_REQUIRED/);
});

test('packaged component guard rejects Node injection, custom trust and relaxed TLS', () => {
  for (const key of ['NODE_OPTIONS', 'node_path', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_CONF'])
    assert.throws(() => assertHostedEnvironment({ ...hosted(), env: { ...hosted().env, [key]: 'untrusted' } }), /NODE_ENVIRONMENT_OVERRIDE_REFUSED/);
  for (const value of ['0', '', 'false'])
    assert.throws(() => assertHostedEnvironment({ ...hosted(), env: { ...hosted().env, NODE_TLS_REJECT_UNAUTHORIZED: value } }), /TLS_OVERRIDE_REFUSED/);
});

test('packaged component source identity requires the actual exact canonical commit', () => {
  assert.doesNotThrow(() => assertSourceIdentity('a'.repeat(40), 'a'.repeat(40)));
  for (const head of ['b'.repeat(40), 'A'.repeat(40), 'a'.repeat(40) + '\n', '', null])
    assert.throws(() => assertSourceIdentity(head, 'a'.repeat(40)), /SOURCE_SHA_MISMATCH/);
});

test('Electron child receives a fixed private cache and no inherited download, proxy or secret overrides', () => {
  const clean = acquisitionEnvironment({ Path: 'system-tools', SystemRoot: 'C:\\Windows', TEMP: 'temp',
    ELECTRON_OVERRIDE_DIST_PATH: 'bad', electron_config_cache: 'old-cache', ELECTRON_INSTALL_PLATFORM: 'linux', ELECTRON_INSTALL_ARCH: 'arm64',
    ELECTRON_MIRROR: 'https://invalid.example', ELECTRON_CUSTOM_DIR: 'custom', ELECTRON_CUSTOM_FILENAME: 'other.zip',
    electron_use_remote_checksums: 'true', npm_config_electron_use_remote_checksums: 'true', npm_config_arch: 'arm64',
    npm_config_proxy: 'secret', force_no_cache: 'true', ELECTRON_GET_USE_PROXY: '1', GLOBAL_AGENT_HTTP_PROXY: 'secret',
    HTTPS_PROXY: 'secret', NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: 'inject', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret',
    OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', NPM_TOKEN: 'secret', GIT_CONFIG_COUNT: '1',
  }, 'fresh-cache');
  assert.deepEqual(clean, { Path: 'system-tools', SystemRoot: 'C:\\Windows', TEMP: 'temp', electron_config_cache: 'fresh-cache', CI: 'true' });
  assert.throws(() => acquisitionEnvironment({ Path: 'one', PATH: 'two' }, 'cache'), /AMBIGUOUS_CHILD_ENVIRONMENT/);
});

const electronMetadata = () => ({
  pkg: { name: 'arcane', devDependencies: { electron: ELECTRON.version } },
  lock: { packages: { '': { devDependencies: { electron: ELECTRON.version } }, 'node_modules/electron': {
    version: ELECTRON.version, resolved: 'https://registry.npmjs.org/electron/-/electron-44.9.1.tgz', integrity: ELECTRON.integrity } } },
  installed: { name: 'electron', version: ELECTRON.version, bin: { 'install-electron': 'install.js' } },
  installerSha256: ELECTRON.installerSha256, checksumsSha256: ELECTRON.checksumsSha256, checksums: { [ELECTRON.archive]: ELECTRON.archiveSha256 },
});

test('Electron acquisition pins match the actual checked-out lock and installed package metadata', async () => {
  const read = path => readFile(new URL('../../' + path, import.meta.url));
  const [pkg, lock, installed, installer, checksums] = await Promise.all([
    read('package.json'), read('package-lock.json'), read('node_modules/electron/package.json'),
    read('node_modules/electron/install.js'), read('node_modules/electron/checksums.json'),
  ]);
  const digest = value => createHash('sha256').update(value).digest('hex');
  validateElectronMetadata({ pkg: JSON.parse(pkg), lock: JSON.parse(lock), installed: JSON.parse(installed),
    installerSha256: digest(installer), checksumsSha256: digest(checksums), checksums: JSON.parse(checksums) });
});

test('Electron metadata pins manifest, lock entry, installed version and official package SRI', () => {
  assert.doesNotThrow(() => validateElectronMetadata(electronMetadata()));
  for (const mutate of [
    value => { value.pkg.devDependencies.electron = '^44.9.1'; },
    value => { value.lock.packages[''].devDependencies.electron = '44.9.0'; },
    value => { value.lock.packages['node_modules/electron'].version = '44.9.0'; },
    value => { value.lock.packages['node_modules/electron'].resolved = 'https://invalid.example/electron.tgz'; },
    value => { value.lock.packages['node_modules/electron'].integrity = 'sha512-changed'; },
    value => { value.installed.version = '44.9.0'; }, value => { value.installed.bin['install-electron'] = 'other.js'; },
  ]) { const value = electronMetadata(); mutate(value); assert.throws(() => validateElectronMetadata(value), /ELECTRON_METADATA_MISMATCH/); }
});

test('Electron acquisition refuses altered installer, checksum metadata and wrong archive digest', () => {
  for (const mutate of [value => { value.installerSha256 = 'a'.repeat(64); }, value => { value.checksumsSha256 = 'b'.repeat(64); },
    value => { delete value.checksums[ELECTRON.archive]; }, value => { value.checksums[ELECTRON.archive] = 'c'.repeat(64); }]) {
    const value = electronMetadata(); mutate(value); assert.throws(() => validateElectronMetadata(value), /ELECTRON_CHECKSUM_MISMATCH/);
  }
});

test('Electron cache metadata requires one exact archive and rejects foreign, duplicate and escaping paths', () => {
  const path = 'cache-key/' + ELECTRON.archive;
  assert.equal(selectElectronArchive([{ path, bytes: 100 }]), path); // Inventory selection only; no binary/proof is manufactured.
  for (const entries of [[], [{ path: 'other.zip', bytes: 100 }], [{ path, bytes: 100 }, { path: 'second/' + ELECTRON.archive, bytes: 100 }],
    [{ path: '../' + ELECTRON.archive, bytes: 100 }], [{ path: 'cache\\' + ELECTRON.archive, bytes: 100 }],
    [{ path, bytes: 0 }], [{ path, bytes: 512 * 1024 * 1024 + 1 }], Array.from({ length: 33 }, () => ({ path, bytes: 100 }))])
    assert.throws(() => selectElectronArchive(entries), /CACHE_|UNEXPECTED_ELECTRON_ARCHIVE/);
});

test('packaged component source has one canonical package/check pair and no native-proof or install substitutes', async () => {
  const source = await readFile(new URL('../../scripts/check-packaged-component-ci.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/await packageWindows\(\{ nodeLicense \}\)/g) ?? []).length, 1);
  assert.equal((source.match(/await checkWindowsExecutable\(bundle\.directory\)/g) ?? []).length, 1);
  const acquisition = source.indexOf('installed = await runBoundedChild(nodeExecutable, [names.installer]');
  assert.ok(acquisition >= 0);
  assert.ok(source.indexOf("await absent(dist)") >= 0 && source.indexOf("await absent(dist)") < acquisition);
  const verifiedArchive = source.indexOf('requireThat(await fileHash(join(cache, archive), 512 * MiB) === ELECTRON.archiveSha256');
  assert.ok(verifiedArchive >= 0 && verifiedArchive < source.indexOf('bundle = await packageWindows'));
  assert.ok(source.includes("deadlineMs: 180000, maxOutputBytes: 65536"));
  assert.ok(source.includes("fileHash(join(cache, archive), 512 * MiB) === ELECTRON.archiveSha256"));
  assert.ok(source.includes('JSON.stringify(proof) === JSON.stringify(recorded)'));
  assert.ok(source.includes('smokeChecksComplete(proof.checks) && smokeChecksComplete(app.checks)'));
  assert.ok(source.includes("['runtimeImportsVerified', 'parentLossShutdownVerified', 'mcpProtocolVerified', 'bundledGuidanceVerified', 'mcpShutdownVerified']"));
  assert.doesNotMatch(source, /inspectNode\s*:|verifyWindowsBundle\(|install-desktop|build-windows-setup|taskkill|shell\s*:\s*true|detached\s*:\s*true|Promise\.race|setInterval/);
  assert.ok(source.includes('automaticRetries: 0') && source.includes('fullProductVerified: false') && source.includes('studioOperations: 0'));
});

test('packaged component upload inventory is fixed metadata and screenshot only', () => {
  assert.deepEqual(ARTIFACT_FILES, ['progress.json', 'success.json', 'failure.json', 'toolchain.json', 'package-proof.json',
    'windows-manifest.json', 'verification.json', 'process-outcome.json', 'mcp-runtime.json', 'app-checks.json', 'workspace.png', 'app-error.json']);
  assert.equal(new Set(ARTIFACT_FILES).size, 12);
  for (const path of ARTIFACT_FILES) assert.match(path, /^(?:[a-z-]+\.json|workspace\.png)$/);
});

test('packaged Node version matches the canonical v-prefixed package receipt exactly', () => {
  assert.equal(packagedNodeVersionMatches('v24.22.1', '24.22.1'), true);
  for (const value of ['24.22.1', 'vv24.22.1', 'v24.22.0', 'v24.22.1-rc.1', 'v24.22.1\n', null, undefined, 24])
    assert.equal(packagedNodeVersionMatches(value, '24.22.1'), false);
  for (const value of ['v24.22.1', '22.22.1', '24.22.1-rc.1', null])
    assert.equal(packagedNodeVersionMatches('v24.22.1', value), false);
});


test('source preflight diagnostics retain exit and captured-text hash without output or environment', () => {
  const text = 'private diagnostic content';
  const projected = packagedGitOutcome({ code: 1, signal: null, outputBytes: Buffer.byteLength(text), output: text, env: 'secret' });
  assert.deepEqual(projected, { state: 'reported', code: 1, signal: null, outputBytes: Buffer.byteLength(text),
    outputTextSha256: createHash('sha256').update(text).digest('hex') });
  assert.ok(!JSON.stringify(projected).includes(text)); assert.ok(!JSON.stringify(projected).includes('secret'));
  assert.deepEqual(packagedGitOutcome({ code: null, signal: 'SIGTERM', outputBytes: 2000 }),
    { state: 'reported', code: null, signal: 'SIGTERM', outputBytes: 2000, outputTextSha256: null });
  for (const value of [null, {}, { code: 1, signal: 'private diagnostic', outputBytes: 1 }, { code: 1, signal: null, outputBytes: -1 }])
    assert.deepEqual(packagedGitOutcome(value), { state: 'unavailable', code: null, signal: null, outputBytes: null, outputTextSha256: null });
  assert.equal(packagedGitOutcome({ code: 1, signal: null, outputBytes: 98305, output: 'x'.repeat(98305) }).outputTextSha256, null);
});

test('changed-path diagnostics accept only complete bounded relative NUL-delimited names, never source or partial output', () => {
  const result = output => ({ code: 0, signal: null, outputBytes: Buffer.byteLength(output), output });
  const names = ['plugin/build/manifest.json', 'plugin/build/ArcaneLocalBridge.rbxmx'];
  assert.deepEqual(packagedChangedPaths(result(names.join('\0') + '\0')), { state: 'complete', paths: names });
  assert.deepEqual(packagedChangedPaths(result('')), { state: 'complete', paths: [] });
  for (const output of ['../source\0', '/absolute\0', 'C:/private\0', 'plugin\\source\0', '.git/config\0',
    'source with spaces\0', 'source\ncontent\0', 'unterminated', 'same\0same\0', '\0', 'part//file\0', 'x'.repeat(513) + '\0',
    Array.from({ length: 65 }, (_, i) => 'file' + i).join('\0') + '\0', 'x'.repeat(32769)])
    assert.deepEqual(packagedChangedPaths(result(output)), { state: 'unavailable', paths: [] });
  for (const patch of [{ code: 1 }, { signal: 'SIGTERM' }, { outputBytes: 1 }, { outputBytes: 32769 }])
    assert.deepEqual(packagedChangedPaths({ ...result('file\0'), ...patch }), { state: 'unavailable', paths: [] });
});
