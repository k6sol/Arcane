import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import * as managed from '../../scripts/managed-luau-compiler.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { createCodeVerification, SETTINGS_FILE } = require('../../apps/desktop/electron/code-verification.cjs');
const policy = require('../../apps/desktop/electron/policy.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => fs.readFileSync(join(repository, path));
const windows = { skip: process.platform !== 'win32' };

function scratch(t) {
  const boundary = fs.realpathSync.native(tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-managed-luau-test-')));
  t.after(() => {
    const path = relative(boundary, root);
    assert.ok(path.startsWith('arcane-managed-luau-test-') && !isAbsolute(path) && !path.includes(sep));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function write(root, path, bytes) {
  const full = join(root, path); fs.mkdirSync(dirname(full), { recursive: true }); fs.writeFileSync(full, bytes); return full;
}
function product(root) {
  for (const path of managed.REQUIRED_MANAGED_LUAU_FILES) write(root, path, read(path));
  return root;
}
function fixture(t, { packaged = false, custom = false } = {}) {
  const root = scratch(t), productRoot = product(packaged ? join(root, 'bundle/resources/product') : join(root, 'checkout'));
  // Use real files and the normal profile/projects/Untitled layout with the
  // current Windows owner. No filesystem, hash, permissions or compiler doubles.
  const projectPath = join(root, 'profile/projects/Untitled'); fs.mkdirSync(projectPath, { recursive: true });
  const projectId = hash(process.platform === 'win32' ? projectPath.toLowerCase() : projectPath);
  const stateRoot = join(root, 'profile/runtime/projects', projectId); fs.mkdirSync(stateRoot, { recursive: true });
  const customCompiler = write(root, 'custom tools/luau-compile.exe', read(managed.MANAGED_LUAU_FILES[0]));
  fs.mkdirSync(join(projectPath, 'custom-evidence'));
  const project = { projectId, projectPath, stateRoot };
  const settingsPath = join(stateRoot, SETTINGS_FILE);
  const settings = { version: 1, projectId, compilerPath: customCompiler, compilerSha256: managed.MANAGED_LUAU_SHA256, evidenceDirectory: 'custom-evidence' };
  if (custom) fs.writeFileSync(settingsPath, JSON.stringify(settings) + '\n');
  const codeVerification = createCodeVerification({ dialog: { showOpenDialog() { assert.fail('No compiler picker.'); } }, getSession() { assert.fail('No UI session required.'); } });
  const configure = () => managed.managedCodeVerificationConfiguration({ codeVerification, project, productRoot });
  return { root, productRoot, project, settingsPath, settings, customCompiler, codeVerification, configure };
}

test('shipped binary has fixed PE identity, pin, version and exact primary license/provenance', () => {
  const compiler = managed.verifyManagedLuauCompiler(repository);
  assert.equal(compiler.executablePath, join(repository, managed.MANAGED_LUAU_FILES[0]));
  assert.equal(compiler.sha256, '74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8');
  const manifest = JSON.parse(read(managed.MANAGED_LUAU_FILES[2]));
  assert.equal(manifest.version, '0.742');
  assert.equal(manifest.repository, 'https://github.com/luau-lang/luau');
  assert.equal(manifest.archive.sha256, '1114966cd8198f407069f07e8b4e6bacf2ded933e4a57d6ddc75617969278c75');
  assert.equal(manifest.license.spdx, 'MIT');
  assert.equal(hash(read(managed.MANAGED_LUAU_FILES[1])), manifest.license.sha256);
  assert.match(read(managed.MANAGED_LUAU_FILES[1]).toString(), /2019-2026 Roblox Corporation/);
});

test('source text, padded text, wrong PE architecture, appended data and tampered native bytes cannot satisfy the pin', () => {
  const original = read(managed.MANAGED_LUAU_FILES[0]);
  const padded = Buffer.alloc(original.length); padded.write('--!strict\nreturn true\n');
  const architecture = Buffer.from(original); architecture.writeUInt16LE(0xaa64, architecture.readUInt32LE(0x3c) + 4);
  const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
  for (const bytes of [Buffer.from('return true'), padded, architecture, changed, Buffer.concat([original, Buffer.from('padding')])])
    assert.throws(() => managed.validateManagedLuauExecutable(bytes), /unavailable/);
});

test('managed closure refuses missing license/manifest/compiler, metadata edits, and unexpected executables or hidden files', t => {
  const root = product(scratch(t));
  for (const path of managed.MANAGED_LUAU_FILES) {
    const original = fs.readFileSync(join(root, path)); fs.unlinkSync(join(root, path));
    assert.throws(() => managed.verifyManagedLuauCompiler(root));
    fs.writeFileSync(join(root, path), original);
    fs.writeFileSync(join(root, path), path.endsWith('.exe') ? Buffer.alloc(original.length) : 'Tampered');
    assert.throws(() => managed.verifyManagedLuauCompiler(root), /unavailable/);
    fs.writeFileSync(join(root, path), original);
  }
  for (const name of ['luau.exe', 'other.exe', '.hidden', 'extra.txt']) {
    const full = write(root, managed.MANAGED_LUAU_DIRECTORY + '/' + name, 'Unselected payload');
    assert.throws(() => managed.verifyManagedLuauCompiler(root), /unavailable/); fs.unlinkSync(full);
  }
  managed.verifyManagedLuauCompiler(root);
});

test('manifest/descriptor rehashes cannot change compiler or license authority', () => {
  const files = managed.REQUIRED_MANAGED_LUAU_FILES.map(path => ({ path, bytes: read(path) }));
  managed.validateManagedLuauFiles(files);
  for (const path of managed.MANAGED_LUAU_FILES) {
    const changed = files.map(file => file.path === path ? { ...file, bytes: Buffer.alloc(file.bytes.length), sha256: hash(Buffer.alloc(file.bytes.length)) } : file);
    assert.throws(() => managed.validateManagedLuauFiles(changed), /unavailable/);
    assert.throws(() => managed.validateManagedLuauFiles(files.filter(file => file.path !== path)), /unavailable/);
  }
  assert.throws(() => managed.validateManagedLuauFiles([...files, { path: managed.MANAGED_LUAU_DIRECTORY + '/extra.exe', bytes: Buffer.alloc(1) }]), /unavailable/);
});

test('hardlinks and redirected managed directories are refused', t => {
  const root = scratch(t), productRoot = product(join(root, 'product'));
  const compiler = join(productRoot, managed.MANAGED_LUAU_FILES[0]), alias = join(root, 'hardlink.exe');
  fs.linkSync(compiler, alias);
  assert.throws(() => managed.verifyManagedLuauCompiler(productRoot), /unavailable/); fs.unlinkSync(alias);
  const redirect = join(root, 'redirect'); fs.symlinkSync(productRoot, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => managed.verifyManagedLuauCompiler(redirect), /unavailable/);
  fs.unlinkSync(redirect);
});

test('absent saved settings use the fixed compiler in both checkout and packaged resources with existing scoped evidence', windows, t => {
  for (const packaged of [false, true]) {
    const f = fixture(t, { packaged }), result = f.configure();
    assert.deepEqual(result, { environment: {
      ARCANE_LUAU_COMPILER_PATH: join(f.productRoot, managed.MANAGED_LUAU_FILES[0]),
      ARCANE_LUAU_COMPILER_SHA256: managed.MANAGED_LUAU_SHA256,
      ARCANE_LUAU_EVIDENCE_DIRECTORY: managed.MANAGED_LUAU_EVIDENCE_DIRECTORY,
    }, settingsHash: null, failure: null });
    assert.equal(fs.existsSync(f.settingsPath), false, 'The default does not write saved settings.');
    assert.equal(fs.lstatSync(join(f.project.projectPath, managed.MANAGED_LUAU_EVIDENCE_DIRECTORY)).isDirectory(), true);
    assert.deepEqual(f.configure(), result);
  }
});

test('valid saved custom compiler preserves its exact path, digest, evidence directory and settings bytes', windows, t => {
  const f = fixture(t, { custom: true }), bytes = fs.readFileSync(f.settingsPath);
  // A managed distribution fault must not affect a valid saved selection.
  fs.unlinkSync(join(f.productRoot, managed.MANAGED_LUAU_FILES[0]));
  const result = f.configure();
  assert.deepEqual(result.environment, { ARCANE_LUAU_COMPILER_PATH: f.customCompiler,
    ARCANE_LUAU_COMPILER_SHA256: managed.MANAGED_LUAU_SHA256, ARCANE_LUAU_EVIDENCE_DIRECTORY: 'custom-evidence' });
  assert.equal(result.settingsHash, hash(bytes)); assert.equal(result.failure, null);
  assert.deepEqual(fs.readFileSync(f.settingsPath), bytes);
  assert.equal(fs.existsSync(join(f.project.projectPath, 'arcane-evidence')), false);
});

test('missing, tampered or hardlinked custom compiler stays unavailable despite a valid managed compiler', windows, t => {
  for (const mode of ['missing', 'tampered', 'hardlink']) {
    const f = fixture(t, { custom: true }), bytes = fs.readFileSync(f.settingsPath);
    if (mode === 'missing') fs.unlinkSync(f.customCompiler);
    if (mode === 'tampered') fs.writeFileSync(f.customCompiler, 'Tampered');
    const alias = join(f.root, 'custom-alias.exe');
    if (mode === 'hardlink') fs.linkSync(f.customCompiler, alias);
    assert.deepEqual(f.configure(), { environment: {}, settingsHash: null, failure: 'compiler-unavailable' });
    assert.deepEqual(fs.readFileSync(f.settingsPath), bytes);
    assert.equal(fs.existsSync(join(f.project.projectPath, 'arcane-evidence')), false);
    if (mode === 'hardlink') fs.unlinkSync(alias);
  }
});

test('corrupt saved settings and invalid saved evidence fail closed without using the managed default', windows, t => {
  for (const invalid of [Buffer.from('{corrupt'), Buffer.from(JSON.stringify({ extra: true }) + '\n')]) {
    const f = fixture(t); fs.writeFileSync(f.settingsPath, invalid);
    assert.throws(f.configure, /configuration is unavailable/); assert.deepEqual(fs.readFileSync(f.settingsPath), invalid);
  }
  const f = fixture(t, { custom: true }); fs.rmdirSync(join(f.project.projectPath, 'custom-evidence'));
  assert.throws(f.configure, /configuration is unavailable/);
});

test('managed tamper and redirected evidence produce no environment and do not repair any files', windows, t => {
  const f = fixture(t), compiler = join(f.productRoot, managed.MANAGED_LUAU_FILES[0]);
  fs.writeFileSync(compiler, 'Tampered');
  assert.deepEqual(f.configure(), { environment: {}, settingsHash: null, failure: 'compiler-unavailable' });
  assert.equal(fs.readFileSync(compiler, 'utf8'), 'Tampered'); assert.equal(fs.existsSync(f.settingsPath), false);
  const second = fixture(t), outside = join(second.root, 'outside'); fs.mkdirSync(outside);
  const redirect = join(second.project.projectPath, 'arcane-evidence'); fs.symlinkSync(outside, redirect, 'junction');
  assert.deepEqual(second.configure(), { environment: {}, settingsHash: null, failure: 'compiler-unavailable' });
  assert.deepEqual(fs.readdirSync(outside), []); fs.unlinkSync(redirect);
});

test('saved settings appearing during managed preparation fail closed before forwarding any compiler fields', windows, t => {
  const f = fixture(t); let calls = 0;
  const codeVerification = { daemonConfiguration(project) {
    const result = f.codeVerification.daemonConfiguration(project);
    if (++calls === 1) fs.writeFileSync(f.settingsPath, JSON.stringify(f.settings) + '\n');
    return result;
  } };
  assert.throws(() => managed.managedCodeVerificationConfiguration({ codeVerification, project: f.project, productRoot: f.productRoot }), /configuration is unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(f.settingsPath)).compilerPath, f.customCompiler);
});

test('actual root-project cold-start bootstrap emits managed adapter fields with normal owned directories', windows, async t => {
  const f = fixture(t), source = read('apps/desktop/electron/main.cjs').toString();
  const begin = source.indexOf('async function startDaemon('), end = source.indexOf('function makeWindow()', begin);
  assert.ok(begin >= 0 && end > begin);
  const moduleLoad = "await import(require('node:url').pathToFileURL(join(productRoot, 'scripts/managed-luau-compiler.mjs')).href)";
  const bootstrap = source.slice(begin, end); assert.ok(bootstrap.includes(moduleLoad));
  // Only Electron's module loader and daemon process are boundary doubles. All
  // bootstrap files, directory ownership, policy, host settings and managed pins are real.
  const child = new EventEmitter(), calls = [], warnings = [];
  const context = { fs, Buffer, join, resolve, createHash, policy, managedBootstrap: managed, codeVerification: f.codeVerification,
    process: { platform: process.platform, env: { SystemRoot: process.env.SystemRoot,
      ARCANE_LUAU_COMPILER_PATH: 'C:\\foreign.exe', ARCANE_LUAU_COMPILER_SHA256: 'b'.repeat(64) } },
    productRoot: f.productRoot, userRoot: join(f.root, 'profile'), nodeExecutable: process.execPath,
    projectSession: null, child: null, origin: '', token: '', closing: false, switching: false,
    performance, started: performance.now(), daemonReadyMs: 0, projectPath: '',
    setTimeout, clearTimeout, console: { warn: value => warnings.push(value) }, CODE_VERIFICATION_WARNING: 'Compiler unavailable',
    ownedDirectory: async full => { await policy.directPath(full); return full; },
    spawn(executable, args, options) { calls.push({ executable, args, options });
      queueMicrotask(() => child.emit('message', { type: 'arcane-ready', protocolVersion: 1, origin: 'http://127.0.0.1:45873', token: 'a'.repeat(64) })); return child; },
    failStartup() { assert.fail('No runtime process executed.'); },
  };
  write(f.productRoot, 'dist/apps/daemon/src/product-main.js', '// Startup entry boundary fixture; never executed.\n');
  vm.createContext(context);
  vm.runInContext(bootstrap.replace(moduleLoad, 'managedBootstrap') + '\nglobalThis.coldStart = startDaemon;', context);
  await context.coldStart(f.project.projectPath);
  assert.equal(calls.length, 1); assert.deepEqual(warnings, []);
  const env = calls[0].options.env;
  assert.equal(env.ARCANE_LUAU_COMPILER_PATH, join(f.productRoot, managed.MANAGED_LUAU_FILES[0]));
  assert.equal(env.ARCANE_LUAU_COMPILER_SHA256, managed.MANAGED_LUAU_SHA256);
  assert.equal(env.ARCANE_LUAU_EVIDENCE_DIRECTORY, managed.MANAGED_LUAU_EVIDENCE_DIRECTORY);
  assert.equal(context.projectSession.verificationUnavailable, false); assert.equal(context.projectSession.verificationEnvironmentAbsent, false);
});

async function compiledAdapters(t) {
  const root = scratch(t), output = join(root, 'compiled');
  const entries = ['apps/daemon/src/workflow-code-host.ts', 'packages/core/src/script-source-verifier.ts'];
  const config = { extends: join(repository, 'tsconfig.json'), compilerOptions: { outDir: output,
    rootDir: repository, typeRoots: [join(repository, 'node_modules/@types')] }, include: [], files: entries.map(path => join(repository, path)) };
  const configPath = write(root, 'tsconfig.json', JSON.stringify(config)); write(output, 'package.json', '{"type":"module"}');
  // Isolated output; do not compete with the parent's root build or import stale dist code.
  const run = spawnSync(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'), '-p', configPath], {
    cwd: repository, env: { ...process.env, GOMAXPROCS: '1', GOMEMLIMIT: '256MiB' },
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  for (const path of entries) {
    const map = JSON.parse(fs.readFileSync(join(output, path.replace(/\.ts$/, '.js.map'))));
    assert.equal(map.sourcesContent[0].replace(/^\uFEFF/, ''), read(path).toString().replace(/^\uFEFF/, ''), 'Compiled source must still match the current owned dependency.');
  }
  const host = await import(pathToFileURL(join(output, 'apps/daemon/src/workflow-code-host.js')).href);
  const source = await import(pathToFileURL(join(output, 'packages/core/src/script-source-verifier.js')).href);
  const recipes = await import(pathToFileURL(join(output, 'packages/core/src/workflow-recipes.js')).href);
  return { ...host, ...source, ...recipes };
}

test('REAL BUNDLED COMPILER: trusted config contains bundled compiler and both normal syntax verifiers compile without running source', { ...windows, timeout: 60000 }, async t => {
  const f = fixture(t, { packaged: true }), result = f.configure(), adapters = await compiledAdapters(t);
  const config = adapters.workflowCodeHostConfiguration(result.environment);
  assert.deepEqual(config.compiler, { executablePath: join(f.productRoot, managed.MANAGED_LUAU_FILES[0]), sha256: managed.MANAGED_LUAU_SHA256 });
  assert.equal(config.evidenceDirectory, managed.MANAGED_LUAU_EVIDENCE_DIRECTORY);
  // Activation and workflow verification consume the same host-attested tuple.
  assert.deepEqual(Object.keys(config).sort(), ['compiler', 'evidenceDirectory']);
  const sourceText = '--!strict\nerror("MUST NEVER RUN")\nwhile true do end\n';
  const path = 'src/implementation.luau'; write(f.project.projectPath, path, sourceText);
  const before = read(managed.MANAGED_LUAU_FILES[0]);
  const verifier = await adapters.createWorkflowCodeHostVerifier(f.project.projectPath, config);
  assert.equal(verifier.available(), true, 'Real packaged compiler must complete the normal help preflight.');
  const recipe = adapters.createWorkflowRecipe({ deliverable: 'code-change', engine: 'roblox', title: 'Managed compiler proof',
    prompt: 'Compile source without executing it.', scope: ['src', 'arcane-evidence'], model: null });
  const request = content => ({ projectPath: f.project.projectPath, projectId: f.project.projectId,
    workflowId: hash(content).slice(0, 32), recipeId: recipe.id, step: recipe.steps.find(step => step.action === 'verify-code'),
    inputArtifacts: [{ path, role: 'patch', stepKey: 'implementation', sha256: hash(content), bytes: Buffer.byteLength(content) }],
    subjectDigest: adapters.workflowSubjectDigest([hash(content)]) });
  const valid = await verifier.verify(request(sourceText)); assert.equal(valid.status, 'evidence');
  const report = JSON.parse(fs.readFileSync(join(f.project.projectPath, valid.submission.artifacts[0].path)));
  assert.equal(report.syntaxCompilation, 'pass'); assert.equal(report.compiler.sha256, managed.MANAGED_LUAU_SHA256);
  assert.deepEqual(report.compiler.flags, ['--null', '-O0', '-g0']);
  assert.equal(fs.readFileSync(join(f.project.projectPath, path), 'utf8'), sourceText);
  const invalid = 'local =\n'; write(f.project.projectPath, path, invalid);
  const failed = await verifier.verify(request(invalid)); assert.equal(failed.status, 'evidence');
  assert.equal(JSON.parse(fs.readFileSync(join(f.project.projectPath, failed.submission.artifacts[0].path))).syntaxCompilation, 'fail');
  const directory = join(f.project.stateRoot, 'script-verification'); fs.mkdirSync(directory);
  const scriptVerifier = await adapters.createScriptSourceVerifier({ compiler: config.compiler, directory });
  try {
    const verified = await scriptVerifier.verify(sourceText);
    assert.equal(verified.syntaxVerified, true); assert.equal(verified.sourceSha256, hash(sourceText));
    assert.equal(verified.compilerSha256, managed.MANAGED_LUAU_SHA256);
    await assert.rejects(scriptVerifier.verify(invalid));
    assert.deepEqual(fs.readFileSync(join(f.productRoot, managed.MANAGED_LUAU_FILES[0])), before);
    const tampered = Buffer.from(before); tampered[tampered.length - 1] ^= 1;
    fs.writeFileSync(config.compiler.executablePath, tampered);
    const afterTamper = 'return 42\n'; write(f.project.projectPath, path, afterTamper);
    assert.deepEqual(await verifier.verify(request(afterTamper)), { status: 'unsupported' });
    assert.equal(verifier.available(), false);
    await assert.rejects(scriptVerifier.verify(afterTamper));
    assert.deepEqual(f.configure(), { environment: {}, settingsHash: null, failure: 'compiler-unavailable' });
    assert.deepEqual(fs.readFileSync(config.compiler.executablePath), tampered, 'No repair or fallback after tamper.');
  } finally { scriptVerifier.dispose(); }
});
