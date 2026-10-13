import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, lstat, realpath, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { projectLaunchPlan } from '../../scripts/open-project.mjs';

const launcherSource = await readFile(new URL('../../scripts/open-project.mjs', import.meta.url), 'utf8');
const productSource = await readFile(new URL('../../apps/daemon/src/product-main.ts', import.meta.url), 'utf8');
const digest = path => createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of ['ARCANE_PROJECT', 'ARCANE_STATE_DIRECTORY', 'ARCANE_PORT',
    'ARCANE_LUAU_COMPILER_PATH', 'ARCANE_LUAU_COMPILER_SHA256', 'ARCANE_LUAU_EVIDENCE_DIRECTORY']) delete env[name];
  return { ...env, ...extra };
}
function observed(output, label = 'fixture-child:') {
  const line = output.split(/\r?\n/).find(value => value.startsWith(label));
  assert.ok(line, 'Expected offline fixture observation.');
  return JSON.parse(line.slice(label.length));
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arcane-project-test-')));
  t.after(async () => {
    const boundary = await realpath(tmpdir()), path = relative(boundary, root);
    assert.ok(path.startsWith('arcane-project-test-') && !path.includes(sep) && !isAbsolute(path));
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
  const repository = join(root, 'Arcane source & fixture');
  const projectA = join(root, 'User project & one');
  const projectB = join(root, 'Another project café');
  await Promise.all([repository, projectA, projectB].map(path => mkdir(path)));
  const write = async (path, content) => {
    const target = join(repository, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  await write('package.json', '{"type":"module"}');
  await write('scripts/open-project.mjs', launcherSource);
  await write('scripts/product-doctor.mjs', `
    export async function productDoctor({repository}) {
      console.log('fixture-doctor:' + JSON.stringify({repository}));
      const readyToLaunch = process.env.FIXTURE_DOCTOR_FAIL !== '1';
      return {readyToLaunch, checks: [{id: 'fixture-dependencies', status: readyToLaunch ? 'pass' : 'fail', detail: 'Offline prerequisite fixture.'}]};
    }
  `);
  // An inert child, never the real daemon. It records only explicitly selected variables.
  await write('dist/apps/daemon/src/product-main.js', `
    import {existsSync, readFileSync, writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const file = join(process.env.ARCANE_STATE_DIRECTORY, 'fixture-state.json');
    const stateFresh = !existsSync(file);
    const previous = stateFresh ? null : JSON.parse(readFileSync(file, 'utf8'));
    if (stateFresh) writeFileSync(file, JSON.stringify({project: process.env.ARCANE_PROJECT}), {flag: 'wx'});
    console.log('fixture-child:' + JSON.stringify({executable: process.execPath, args: process.argv.slice(2),
      cwd: process.cwd(), project: process.env.ARCANE_PROJECT, directory: process.env.ARCANE_STATE_DIRECTORY,
      port: process.env.ARCANE_PORT, stateFresh, previous}));
    process.exit(Number(process.env.FIXTURE_EXIT_CODE ?? '0'));
  `);
  // Execute the unchanged product entry/configuration with services and compiler configuration replaced
  // by metadata-only fixtures. No HTTP listener, SQLite engine, compiler, provider or Studio.
  let productFixture = productSource;
  for (const path of ['../../../packages/storage/src/studio-store.js', '../../../packages/storage/src/work-store.js', './lab-server.js', './asset-service.js', './learning-service.js', './workflow-code-host.js']) {
    assert.ok(productFixture.includes("from '" + path + "'"));
    productFixture = productFixture.replace("from '" + path + "'", "from './product-services.fixture.mjs'");
  }
  await write('product.fixture.ts', productFixture);
  await write('product-services.fixture.mjs', `
    import assert from 'node:assert/strict';
    import {existsSync, mkdirSync, readFileSync} from 'node:fs';
    import {join} from 'node:path';
    const data = (directory, file) => existsSync(join(directory,file)) ? JSON.parse(readFileSync(join(directory,file),'utf8')) : [];
    // This path/state fixture keeps the optional compiler unconfigured; it never creates a verifier.
    export function workflowCodeHostConfiguration(environment) {
      for (const name of ['ARCANE_LUAU_COMPILER_PATH', 'ARCANE_LUAU_COMPILER_SHA256', 'ARCANE_LUAU_EVIDENCE_DIRECTORY']) {
        assert.equal(environment[name], undefined, 'Compiler configuration is outside this offline fixture.');
      }
      return undefined;
    }
    export class StudioStore {
      constructor({directory}) { mkdirSync(directory,{recursive:true}); this.directory=directory; this.keys=data(directory,'studio.sqlite'); }
      close() {}
    }
    export class WorkStore {
      constructor({directory,projectPath}) { this.directory=directory; this.projectPath=projectPath; this.tasks=data(directory,'work.sqlite'); }
      close() {}
    }
    export async function createAssetService(options) {
      const outputRoot = options.outputRoot ?? join(options.cwd,'runtime','assets');
      return {options,outputRoot,jobs:data(outputRoot,'index.json'),close:async()=>{}};
    }
    export function createLearningService() { return { close() {} }; }
    export async function createConnectionLab(options) {
      mkdirSync(options.stateDirectory,{recursive:true});
      console.log('fixture-product:' + JSON.stringify({cwd:options.cwd,projectPath:options.projectPath,port:options.port,
        studioDirectory:options.studioStore.directory,workDirectory:options.workStore.directory,
        connectionDirectory:options.stateDirectory,keys:options.studioStore.keys,tasks:options.workStore.tasks,
        assetProject:options.assetService.options.projectPath,assetCwd:options.assetService.options.cwd,
        assetOutputOverride:options.assetService.options.outputRoot??null,assetRoot:options.assetService.outputRoot,
        assetJobs:options.assetService.jobs}));
      return {origin:'http://127.0.0.1:49999',token:'offline-fixture',url:'offline-fixture',close:async()=>{}};
    }
  `);
  const run = (args, env = cleanEnv()) => spawnSync(process.execPath, [join(repository, 'scripts', 'open-project.mjs'), ...args], {
    cwd: projectB, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 32768,
  });
  const runProduct = (env = cleanEnv()) => spawnSync(process.execPath, [join(repository, 'product.fixture.ts')], {
    cwd: repository, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 32768,
  });
  return { root, repository, projectA, projectB, write, run, runProduct };
}
async function directoryLink(t, target, path) {
  try { await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('OS denied disposable link fixture creation.'); return false; }
    throw error;
  }
}

test('plan fixes Node/entry/source cwd and hashes the canonical project without mutating inherited environment or creating state', async t => {
  const f = await fixture(t);
  const env = { ARCANE_PROJECT: f.projectB, ARCANE_STATE_DIRECTORY: f.projectB, FIXTURE_PRIVATE: 'not-for-logs' };
  const original = { ...env };
  const plan = await projectLaunchPlan(f.projectA, { repository: f.repository, env });
  assert.equal(plan.executable, process.execPath);
  assert.deepEqual(plan.args, [join(f.repository, 'dist', 'apps', 'daemon', 'src', 'product-main.js')]);
  assert.equal(plan.cwd, f.repository);
  assert.equal(plan.projectPath, await realpath(f.projectA));
  assert.equal(plan.stateDirectory, join(f.repository, 'runtime', 'projects', digest(plan.projectPath)));
  assert.equal(plan.env.ARCANE_PROJECT, plan.projectPath);
  assert.equal(plan.env.ARCANE_STATE_DIRECTORY, plan.stateDirectory);
  assert.equal(plan.env.ARCANE_PORT, '0');
  assert.equal(plan.env.FIXTURE_PRIVATE, 'not-for-logs');
  assert.deepEqual(env, original);
  await assert.rejects(lstat(join(f.repository, 'runtime')), { code: 'ENOENT' });
  const equivalent = await projectLaunchPlan(f.projectA + sep, { repository: f.repository, env });
  assert.equal(equivalent.stateDirectory, plan.stateDirectory);
  if (process.platform === 'win32') {
    const caseAlias = await projectLaunchPlan(f.projectA.toUpperCase(), { repository: f.repository, env });
    assert.equal(caseAlias.stateDirectory, plan.stateDirectory);
  }
  assert.notEqual((await projectLaunchPlan(f.projectB, { repository: f.repository, env })).stateDirectory, plan.stateDirectory);
});

test('human CLI rejects missing/extra arguments before doctor, state creation or any child', async t => {
  const f = await fixture(t);
  for (const args of [[], [f.projectA, f.projectB], [f.projectA, '--port', '45871'], ['--help']]) {
    const result = f.run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: npm run open:project/);
  }
  await assert.rejects(lstat(join(f.repository, 'runtime')), { code: 'ENOENT' });
});

test('only existing direct local folders are selectable; roots, UNC, device, control and traversal paths fail', async t => {
  const f = await fixture(t);
  const file = join(f.root, 'not-a-directory'); await writeFile(file, 'fixture');
  const bad = ['', '.', 'relative/project', parse(f.root).root, '\\\\server\\share\\project', '//server/share/project',
    '\\\\?\\C:\\project', join(f.root, 'absent'), file, f.projectA + '\n', f.projectA + sep + '..' + sep + 'Another project café'];
  if (process.platform === 'win32') bad.push('C:relative', '\\root-relative', f.projectA + ':stream', f.projectA + '.', f.projectA + sep + 'NUL');
  for (const path of bad) await assert.rejects(projectLaunchPlan(path, { repository: f.repository, env: {} }), Error, path);
});

test('selected project and ancestor junctions cannot redirect the canonical identity', async t => {
  const f = await fixture(t), alias = join(f.root, 'linked-project');
  if (!await directoryLink(t, f.projectA, alias)) return;
  await assert.rejects(projectLaunchPlan(alias, { repository: f.repository, env: {} }), /links|redirected/);
  await mkdir(join(f.projectA, 'child'));
  await assert.rejects(projectLaunchPlan(join(alias, 'child'), { repository: f.repository, env: {} }), /links|redirected/);
});

test('runtime parent junctions are refused even when the hashed state directory does not exist', async t => {
  const f = await fixture(t);
  if (!await directoryLink(t, f.projectB, join(f.repository, 'runtime'))) return;
  const result = f.run([f.projectA]);
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
  assert.match(result.stderr, /links|redirected/);
  await assert.rejects(lstat(join(f.projectB, 'projects')), { code: 'ENOENT' });
});

test('foreground child receives exact project/state/port and source cwd, with no inherited secret logs', async t => {
  const f = await fixture(t);
  await writeFile(join(f.projectA, '.env'), 'FIXTURE_PRIVATE=project-content-must-not-be-read');
  const result = f.run([f.projectA], cleanEnv({ ARCANE_PROJECT: f.projectB, ARCANE_STATE_DIRECTORY: f.projectB, FIXTURE_PRIVATE: 'inherited-secret-must-not-be-logged' }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(observed(result.stdout, 'fixture-doctor:'), { repository: f.repository });
  const child = observed(result.stdout);
  assert.equal(child.executable, process.execPath); assert.deepEqual(child.args, []);
  assert.equal(child.cwd, f.repository); assert.equal(child.project, f.projectA);
  assert.equal(child.directory, join(f.repository, 'runtime', 'projects', digest(f.projectA)));
  assert.equal(child.port, '0'); assert.equal(child.stateFresh, true);
  assert.doesNotMatch(result.stdout + result.stderr, /inherited-secret-must-not-be-logged|project-content-must-not-be-read/);
});

test('doctor prerequisite failure leaves no runtime state and never starts the child', async t => {
  const f = await fixture(t), result = f.run([f.projectA], cleanEnv({ FIXTURE_DOCTOR_FAIL: '1' }));
  assert.equal(result.status, 1); assert.match(result.stderr, /fixture-dependencies/);
  assert.deepEqual(observed(result.stdout, 'fixture-doctor:'), { repository: f.repository });
  assert.doesNotMatch(result.stdout, /fixture-child:|Arcane project:/);
  await assert.rejects(lstat(join(f.repository, 'runtime')), { code: 'ENOENT' });
});

test('wrapper propagates the final owned child exit code', async t => {
  const f = await fixture(t);
  for (const code of [0, 37]) {
    const result = f.run([f.projectA], cleanEnv({ FIXTURE_EXIT_CODE: String(code) }));
    assert.equal(result.status, code, result.stderr); assert.equal(result.signal, null);
  }
});

test('explicit port override is validated, and no extra CLI switches can change the child command', async t => {
  const f = await fixture(t);
  const result = f.run([f.projectA], cleanEnv({ ARCANE_PORT: '51432' }));
  assert.equal(result.status, 0, result.stderr); assert.equal(observed(result.stdout).port, '51432');
  for (const port of ['', '-1', '65536', '1.5', '0x10', '1e3', ' 45871', '45871 ', '0001', 'NaN']) {
    await assert.rejects(projectLaunchPlan(f.projectA, { repository: f.repository, env: { ARCANE_PORT: port } }), /ARCANE_PORT/);
  }
});

test('another project starts fresh while same-project state resumes and legacy state remains intact', async t => {
  const f = await fixture(t);
  await f.write('runtime/product/studio.sqlite', '["legacy-key"]');
  await f.write('runtime/connection-lab/preferences.json', '{"fixture":"legacy-selection"}');
  const first = observed(f.run([f.projectA]).stdout), second = observed(f.run([f.projectB]).stdout);
  assert.equal(first.stateFresh, true); assert.equal(second.stateFresh, true); assert.equal(second.previous, null);
  assert.notEqual(second.directory, first.directory);
  const resumed = observed(f.run([f.projectA]).stdout);
  assert.equal(resumed.stateFresh, false); assert.deepEqual(resumed.previous, { project: f.projectA });
  assert.equal(await readFile(join(f.repository, 'runtime/product/studio.sqlite'), 'utf8'), '["legacy-key"]');
  assert.equal(await readFile(join(f.repository, 'runtime/connection-lab/preferences.json'), 'utf8'), '{"fixture":"legacy-selection"}');
});

test('preexisting hashed state cannot be a junction to another project', async t => {
  const f = await fixture(t), plan = await projectLaunchPlan(f.projectA, { repository: f.repository, env: {} });
  await mkdir(dirname(plan.stateDirectory), { recursive: true });
  if (!await directoryLink(t, f.projectB, plan.stateDirectory)) return;
  const result = f.run([f.projectA]);
  assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /links|redirected/);
});

test('product configuration preserves default product/lab/asset paths and default port', async t => {
  const f = await fixture(t);
  await f.write('runtime/assets/index.json', '["legacy-asset-job"]');
  const result = f.runProduct();
  assert.equal(result.status, 0, result.stderr);
  const product = observed(result.stdout, 'fixture-product:');
  assert.equal(product.studioDirectory, join(f.repository, 'runtime', 'product'));
  assert.equal(product.workDirectory, product.studioDirectory);
  assert.equal(product.connectionDirectory, join(f.repository, 'runtime', 'connection-lab'));
  assert.equal(product.assetOutputOverride, null);
  assert.equal(product.assetRoot, join(f.repository, 'runtime', 'assets'));
  assert.deepEqual(product.assetJobs, ['legacy-asset-job']);
  assert.equal(product.projectPath, f.repository); assert.equal(product.port, 45871);
  const descriptor = JSON.parse(await readFile(join(product.studioDirectory, 'daemon.json'), 'utf8'));
  assert.deepEqual(Object.keys(descriptor).sort(), ['origin', 'pid', 'protocolVersion']);
});

test('product isolates stores, lab, descriptor and asset root/history from legacy and other projects', async t => {
  const f = await fixture(t);
  const previous = await projectLaunchPlan(f.projectA, { repository: f.repository, env: {} });
  const next = await projectLaunchPlan(f.projectB, { repository: f.repository, env: {} });
  for (const directory of [join(f.repository, 'runtime', 'product'), previous.stateDirectory]) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'studio.sqlite'), '["old-project-key"]');
    await writeFile(join(directory, 'work.sqlite'), '["old-project-task"]');
  }
  await f.write('runtime/assets/index.json', '["legacy-asset-job"]');
  for (const [directory, jobs] of [[previous.stateDirectory, ['other-project-asset-job']], [next.stateDirectory, ['selected-project-asset-job']]]) {
    await mkdir(join(directory, 'assets'), { recursive: true });
    await writeFile(join(directory, 'assets', 'index.json'), JSON.stringify(jobs));
  }
  const result = f.runProduct(cleanEnv(next.env));
  assert.equal(result.status, 0, result.stderr);
  const product = observed(result.stdout, 'fixture-product:');
  assert.equal(product.cwd, f.repository); assert.equal(product.projectPath, f.projectB); assert.equal(product.port, 0);
  assert.equal(product.studioDirectory, next.stateDirectory); assert.equal(product.workDirectory, next.stateDirectory);
  assert.equal(product.connectionDirectory, join(next.stateDirectory, 'connection-lab'));
  assert.deepEqual(product.keys, []); assert.deepEqual(product.tasks, []);
  assert.equal(product.assetProject, f.projectB); assert.equal(product.assetCwd, f.repository);
  assert.equal(product.assetOutputOverride, join(next.stateDirectory, 'assets'));
  assert.equal(product.assetRoot, join(next.stateDirectory, 'assets'));
  assert.deepEqual(product.assetJobs, ['selected-project-asset-job']);
  assert.equal(await readFile(join(f.repository, 'runtime/assets/index.json'), 'utf8'), '["legacy-asset-job"]');
  assert.equal(await readFile(join(previous.stateDirectory, 'assets', 'index.json'), 'utf8'), '["other-project-asset-job"]');
  assert.ok((await lstat(join(next.stateDirectory, 'daemon.json'))).isFile());
  for (const directory of [join(f.repository, 'runtime', 'product'), previous.stateDirectory]) {
    assert.equal(await readFile(join(directory, 'studio.sqlite'), 'utf8'), '["old-project-key"]');
    assert.equal(await readFile(join(directory, 'work.sqlite'), 'utf8'), '["old-project-task"]');
    await assert.rejects(lstat(join(directory, 'daemon.json')), { code: 'ENOENT' });
  }
});

test('product rejects unbounded, relative, UNC, empty, control and traversal state overrides before service creation', async t => {
  const f = await fixture(t);
  const bad = ['', 'runtime/projects/test', f.repository, join(f.repository, 'runtime'), f.projectA,
    join(f.repository, 'runtime-sibling', 'test'), '\\\\server\\share\\state', '//server/share/state',
    join(f.repository, 'runtime', 'test') + '\n', join(f.repository, 'runtime') + sep + '..' + sep + 'escape'];
  for (const directory of bad) {
    const result = f.runProduct(cleanEnv({ ARCANE_STATE_DIRECTORY: directory }));
    assert.equal(result.status, 1, directory); assert.equal(result.stdout, '');
    assert.match(result.stderr, /ARCANE_STATE_DIRECTORY/);
  }
  await assert.rejects(lstat(join(f.repository, 'runtime')), { code: 'ENOENT' });
});

test('product state parent junctions cannot redirect writes outside runtime', async t => {
  const f = await fixture(t);
  if (!await directoryLink(t, f.projectA, join(f.repository, 'runtime'))) return;
  const result = f.runProduct(cleanEnv({ ARCANE_STATE_DIRECTORY: join(f.repository, 'runtime', 'projects', 'new') }));
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /links|redirected/);
  await assert.rejects(lstat(join(f.projectA, 'projects')), { code: 'ENOENT' });
});

test('product refuses a linked nested connection lab before reading previous project preferences or opening stores', async t => {
  const f = await fixture(t), directory = join(f.repository, 'runtime', 'projects', 'nested');
  await mkdir(directory, { recursive: true });
  await writeFile(join(f.projectA, 'preferences.json'), 'private-fixture-selection');
  if (!await directoryLink(t, f.projectA, join(directory, 'connection-lab'))) return;
  const result = f.runProduct(cleanEnv({ ARCANE_STATE_DIRECTORY: directory }));
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /links/);
  assert.doesNotMatch(result.stderr, /private-fixture-selection/);
  await assert.rejects(lstat(join(directory, 'daemon.json')), { code: 'ENOENT' });
});

test('product rejects hardlinked database and descriptor files without exposing their contents', async t => {
  const f = await fixture(t);
  const outside = join(f.projectA, 'fixture-state'); await writeFile(outside, 'private-fixture-state');
  for (const name of ['work.sqlite', 'studio.sqlite', 'daemon.json']) {
    const directory = join(f.repository, 'runtime', 'projects', name.replace('.', '-'));
    await mkdir(directory, { recursive: true }); await link(outside, join(directory, name));
    const result = f.runProduct(cleanEnv({ ARCANE_STATE_DIRECTORY: directory }));
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /links|non-regular/);
    assert.doesNotMatch(result.stderr, /private-fixture-state/);
  }
  assert.equal(await readFile(outside, 'utf8'), 'private-fixture-state');
});

test('product state metadata inspection has a bounded depth', async t => {
  const f = await fixture(t), directory = join(f.repository, 'runtime', 'projects', 'too-deep');
  await mkdir(join(directory, ...Array(18).fill('child')), { recursive: true });
  const result = f.runProduct(cleanEnv({ ARCANE_STATE_DIRECTORY: directory }));
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /depth limit/);
});
