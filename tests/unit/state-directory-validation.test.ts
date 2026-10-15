import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, sep, relative, isAbsolute } from 'node:path';
import { STATE_VALIDATION_DEPTH_LIMIT, STATE_VALIDATION_ENTRY_LIMIT, validatedStateDirectory } from '../../apps/daemon/src/state-directory-validation.js';

// Standalone filesystem fixtures only: no daemon, store, provider or Studio process.
async function fixture(t: test.TestContext) {
  const runtimeRoot = await mkdtemp(join(await realpath(tmpdir()), 'arcane-state-validation-'));
  t.after(async () => {
    const base=await realpath(tmpdir()),actual=await realpath(runtimeRoot),child=relative(base,actual);
    assert.ok(!isAbsolute(child)&&child.startsWith('arcane-state-validation-')&&!child.includes(sep)&&!child.includes('..'));
    await rm(actual,{recursive:true,force:true});
  });
  const state = join(runtimeRoot, 'runtime', 'projects', 'a'.repeat(64));
  await mkdir(state, { recursive: true });
  return { runtimeRoot, state };
}
async function linked(t: test.TestContext, target: string, path: string): Promise<boolean> {
  try { await symlink(target, path, 'junction'); return true; }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Directory links are unavailable on this host.'); return false; } throw error; }
}
const JOB_FILES = ['job.json', 'input.json', 'request.json', 'audit.json', 'manifest.json', 'asset_worker.py', 'audit.py', 'probe.py',
  'asset.blend', 'blockout.blend', 'asset.glb', 'asset.fbx', 'collision.glb', 'preview-hero.png', 'preview-side.png'];
// Mirrors packages/asset-pipeline/src/index.ts job layout: job directory, .worker scratch and retained artifacts.
async function retainedJobs(state: string, count: number): Promise<number> {
  let entries = 0;
  for (let job = 0; job < count; job++) {
    const directory = join(state, 'assets', 'crate-' + job.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000');
    await mkdir(join(directory, '.worker', 'config'), { recursive: true }); entries += 3;
    await Promise.all(JOB_FILES.map(name => writeFile(join(directory, name), '{}'))); entries += JOB_FILES.length;
    await writeFile(join(directory, '.worker', 'config', 'userpref.blend'), 'x'); entries += 1;
  }
  return entries;
}

test('retained asset history beyond the metadata entry limit starts and is left unchanged', async t => {
  const { runtimeRoot, state } = await fixture(t);
  await writeFile(join(state, 'studio.sqlite'), 'x'); await writeFile(join(state, 'daemon.json'), '{}');
  const entries = await retainedJobs(state, 256);
  assert.ok(entries > STATE_VALIDATION_ENTRY_LIMIT, 'fixture must exceed the metadata limit: ' + entries);
  const before = (await readdir(join(state, 'assets'))).sort();
  assert.equal(await validatedStateDirectory(state, runtimeRoot), await realpath(state));
  assert.deepEqual((await readdir(join(state, 'assets'))).sort(), before);
  assert.equal(await readFile(join(state, 'daemon.json'), 'utf8'), '{}');
});

test('startup metadata outside the asset subtree keeps the entry limit', async t => {
  const { runtimeRoot, state } = await fixture(t);
  await mkdir(join(state, 'learning'));
  await Promise.all(Array.from({ length: STATE_VALIDATION_ENTRY_LIMIT + 1 }, (_, file) => writeFile(join(state, 'learning', file + '.json'), '{}')));
  await assert.rejects(validatedStateDirectory(state, runtimeRoot), /validation entry limit/);
});

test('an assets directory below the state root is not exempt', async t => {
  const { runtimeRoot, state } = await fixture(t);
  await mkdir(join(state, 'learning', 'assets'), { recursive: true });
  await Promise.all(Array.from({ length: STATE_VALIDATION_ENTRY_LIMIT + 1 }, (_, file) => writeFile(join(state, 'learning', 'assets', file + '.json'), '{}')));
  await assert.rejects(validatedStateDirectory(state, runtimeRoot), /validation entry limit/);
});

test('startup metadata retains its depth bound outside generated assets',async t=>{
  const {runtimeRoot,state}=await fixture(t);
  await mkdir(join(state,...Array.from({length:STATE_VALIDATION_DEPTH_LIMIT+1},()=> 'nested')),{recursive:true});
  await assert.rejects(validatedStateDirectory(state,runtimeRoot),/validation depth limit/);
});

test('a hardlinked fixed store path is refused', async t => {
  const { runtimeRoot, state } = await fixture(t);
  await writeFile(join(state, 'studio.sqlite'), 'x');
  await link(join(state, 'studio.sqlite'), join(runtimeRoot, 'outside.sqlite'));
  await assert.rejects(validatedStateDirectory(state, runtimeRoot), /links or non-regular files/);
});

test('a hardlinked descriptor in a nested metadata directory is refused', async t => {
  const { runtimeRoot, state } = await fixture(t);
  await mkdir(join(state, 'connection-lab'));
  await writeFile(join(state, 'connection-lab', 'state.json'), '{}');
  await link(join(state, 'connection-lab', 'state.json'), join(runtimeRoot, 'outside.json'));
  await assert.rejects(validatedStateDirectory(state, runtimeRoot), /links or non-regular files/);
});

test('a linked asset root is refused', async t => {
  const { runtimeRoot, state } = await fixture(t);
  const elsewhere = join(runtimeRoot, 'elsewhere'); await mkdir(elsewhere);
  if (!await linked(t, elsewhere, join(state, 'assets'))) return;
  await assert.rejects(validatedStateDirectory(state, runtimeRoot), /links or non-regular files/);
});

test('a linked state-root ancestor is refused', async t => {
  const { runtimeRoot } = await fixture(t);
  const elsewhere = join(runtimeRoot, 'elsewhere', 'projects'); await mkdir(elsewhere, { recursive: true });
  await mkdir(join(runtimeRoot, 'runtime', 'linked'), { recursive: true });
  if (!await linked(t, elsewhere, join(runtimeRoot, 'runtime', 'linked', 'projects'))) return;
  await assert.rejects(validatedStateDirectory(join(runtimeRoot, 'runtime', 'linked', 'projects', 'b'.repeat(64)), runtimeRoot), /links or redirected directories/);
});

test('unsafe, relative and escaping state paths are refused', async t => {
  const { runtimeRoot, state } = await fixture(t);
  await assert.rejects(validatedStateDirectory('runtime/projects/x', runtimeRoot), /absolute local directory/);
  await assert.rejects(validatedStateDirectory(state + '\u0000', runtimeRoot), /absolute local directory/);
  await assert.rejects(validatedStateDirectory([runtimeRoot, 'runtime', 'projects', '..', '..', 'outside'].join(sep), runtimeRoot), /unsafe path segment/);
  await assert.rejects(validatedStateDirectory(join(runtimeRoot, 'outside'), runtimeRoot), /strictly inside Arcane\/runtime/);
  await assert.rejects(validatedStateDirectory(join(runtimeRoot, 'runtime'), runtimeRoot), /strictly inside Arcane\/runtime/);
  if (process.platform === 'win32') {
    await assert.rejects(validatedStateDirectory(join(runtimeRoot, 'runtime', 'con'), runtimeRoot), /unsafe path segment/);
    await assert.rejects(validatedStateDirectory(join(runtimeRoot, 'runtime', 'trailing.'), runtimeRoot), /unsafe path segment/);
    await assert.rejects(validatedStateDirectory('\\\\server\\share\\runtime\\x', runtimeRoot), /absolute local directory/);
  }
});
