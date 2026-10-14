import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalRelease, verifyLocalRelease, REQUIRED_FRONTEND_FILES, BRAND_BITMAP_PATH } from '../../scripts/create-local-release.mjs';
import { productDoctor } from '../../scripts/product-doctor.mjs';
import { MANAGED_LUAU_FILES, REQUIRED_MANAGED_LUAU_FILES } from '../../scripts/managed-luau-compiler.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  // Windows runners may expose TEMP through an 8.3 alias. Complete the fixture
  // at its native physical path before the production no-redirection preflight.
  const boundary = realpathSync.native(tmpdir());
  const root = realpathSync.native(await mkdtemp(join(boundary, 'arcane-release-test-')));
  t.after(async () => {
    const full = resolve(root), path = relative(boundary, full);
    assert.ok(path.startsWith('arcane-release-test-') && !path.includes(sep) && !isAbsolute(path));
    assert.equal((await lstat(full)).isSymbolicLink(), false);
    await rm(full, { recursive: true, force: true });
  });
  for (const dir of ['apps', 'packages', 'workers', 'plugin', 'scripts', 'skills', 'docs', 'tests', 'dist', '.github']) await mkdir(join(root, dir));
  const write = async (path, value) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), value); };
  for (const path of ['package.json', 'tsconfig.json']) await write(path, JSON.stringify({ name: 'arcane', version: '0.1.0', type: 'module' }));
  await write('package-lock.json', JSON.stringify({ name: 'arcane', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'arcane', version: '0.1.0' } } }));
  for (const path of ['README.md', 'LICENSE']) await write(path, 'Fixture content.\n');
  for (const path of ['dist/apps/daemon/src/product-main.js', 'dist/apps/mcp/src/main.js', 'dist/apps/desktop/src/studio.js', 'apps/desktop/public/studio.html', 'workers/blender/asset_worker.py']) await write(path, '// Test fixture only.\n');
  const shellSource = 'export const fixtureShell = true;\n';
  const bitmap = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWooAAAAASUVORK5CYII=', 'base64');
  for (const path of REQUIRED_FRONTEND_FILES) {
    const bytes = path === BRAND_BITMAP_PATH ? bitmap : path.endsWith('.json') ? JSON.stringify({fixture:true}) : path.endsWith('.ts') || path.endsWith('workspace-shell.js') || path.endsWith('asset-downloads.js') || path.endsWith('learning-panel.js') ? shellSource : path.endsWith('.map') ? JSON.stringify({ version: 3, sources: ['../../../../apps/desktop/src/' + path.split('/').at(-1).replace('.js.map', '.ts')], sourcesContent: [shellSource] }) : '// Test fixture only.\n';
    await write(path, bytes);
  }
  await write('skills/registry.json', '{}');
  // Use the shipped pinned bytes: synthetic executable bytes cannot satisfy this trust gate.
  for (const path of REQUIRED_MANAGED_LUAU_FILES) await write(path, await readFile(new URL('../../' + path, import.meta.url)));
  const pluginSource = '--!strict\nlocal __arcaneFactories = {}\n';
  await write('plugin/src/Main.server.luau', pluginSource);
  await write('plugin/build/ArcaneLocalBridge.lua', pluginSource);
  await write('plugin/build/manifest.json', JSON.stringify({ schemaVersion: 1, preferredArtifact: 'ArcaneLocalBridge.lua', sources: [{ path: 'src/Main.server.luau', sha256: hash(pluginSource) }], artifacts: [{ name: 'ArcaneLocalBridge.lua', bytes: Buffer.byteLength(pluginSource), sha256: hash(pluginSource) }] }));
  return { root, write };
}

test('release snapshots compiled/source files and never copies runtime, tokens, dependencies or caches', async t => {
  const { root, write } = await fixture(t);
  await write('runtime/product/daemon.json', '{"token":"never-copy-me"}');
  await write('node_modules/private/auth.json', '{"access_token":"never-copy-me"}');
  await write('apps/mcp/generated/claude.mcp.json', '{"password":"never-copy-me"}');
  await write('packages/asset-pipeline/.runtime/job/log.txt', 'never-copy-me');
  await write('tests/.tmp/auth.json', '{}');
  const result = await createLocalRelease({ repository: root });
  assert.equal(result.dependencyInstallRequired, true); assert.equal(result.fullProductVerified, false);
  const manifest = JSON.parse(await readFile(join(result.directory, 'release-manifest.json'), 'utf8'));
  assert.ok(manifest.files.some(file => file.path === 'plugin/build/ArcaneLocalBridge.lua'));
  assert.ok(manifest.files.every(file => !/(?:^|\/)(?:runtime|node_modules|generated|\.tmp)(?:\/|$)/.test(file.path)));
  const verified = await verifyLocalRelease(result.directory);
  assert.equal(verified.signed, false); assert.equal(verified.runtimeVerified, false);
  await mkdir(join(result.directory, 'runtime')); await writeFile(join(result.directory, 'runtime', 'user-data.json'), '{}');
  await mkdir(join(result.directory, 'node_modules')); await writeFile(join(result.directory, 'node_modules', 'installed.json'), '{}');
  assert.deepEqual((await verifyLocalRelease(result.directory)).mutableRootsNotVerified, ['node_modules', 'runtime', 'apps/mcp/generated']);
});

test('integrity verification rejects modified, unlisted and traversal payloads', async t => {
  const { root } = await fixture(t);
  const { directory } = await createLocalRelease({ repository: root });
  await writeFile(join(directory, 'README.md'), 'Modified');
  await assert.rejects(verifyLocalRelease(directory), /checksum/);
  const other = await createLocalRelease({ repository: root });
  await writeFile(join(other.directory, 'unlisted.lua'), 'payload');
  await assert.rejects(verifyLocalRelease(other.directory), /Unlisted/);
  const third = await createLocalRelease({ repository: root });
  const path = join(third.directory, 'release-manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.files[0].path = '../../outside'; await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(verifyLocalRelease(third.directory), /Forbidden/);
});

test('actual key/session-link strings and credential-like JSON fields fail packaging', async t => {
  const { root, write } = await fixture(t);
  await write('docs/secret.md', 'arcane_local_v1_45871_' + 'a'.repeat(64));
  await assert.rejects(createLocalRelease({ repository: root }), /credential/);
  await write('docs/secret.md', 'http://127.0.0.1:45871/studio#' + 'a'.repeat(64));
  await assert.rejects(createLocalRelease({ repository: root }), /credential/);
  await write('docs/secret.md', 'Cleared'); await write('docs/secret.json', '{"refresh_token":"private"}');
  await assert.rejects(createLocalRelease({ repository: root }), /Credential-like/);
});

test('managed compiler, primary license and provenance are required even when release descriptors are rehashed', async t => {
  const { root } = await fixture(t);
  for (const path of REQUIRED_MANAGED_LUAU_FILES) {
    const original = await readFile(join(root, path)); await rm(join(root, path));
    await assert.rejects(createLocalRelease({ repository: root }), error => error.message.includes('missing ' + path));
    await writeFile(join(root, path), original);
  }
  const result = await createLocalRelease({ repository: root });
  const manifestPath = join(result.directory, 'release-manifest.json'), baseline = await readFile(manifestPath);
  for (const path of MANAGED_LUAU_FILES) {
    const original = await readFile(join(result.directory, path));
    const bytes = path.endsWith('manifest.json')
      ? Buffer.from(original.toString().replace('"version": "0.742"', '"version": "0.741"')) : Buffer.alloc(original.length);
    assert.equal(bytes.length, original.length);
    await writeFile(join(result.directory, path), bytes);
    const manifest = JSON.parse(baseline), entry = manifest.files.find(file => file.path === path);
    entry.sha256 = hash(bytes); await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyLocalRelease(result.directory), /Managed Luau compiler is unavailable/);
    await writeFile(join(result.directory, path), original); await writeFile(manifestPath, baseline);
  }
  await verifyLocalRelease(result.directory);
});

test('links and hardlinks cannot redirect release reads or outputs', async t => {
  const { root, write } = await fixture(t);
  await write('docs/target.md', 'target'); await link(join(root, 'docs/target.md'), join(root, 'docs/alias.md'));
  await assert.rejects(createLocalRelease({ repository: root }), /single-link/);
  const second = await fixture(t);
  await mkdir(join(second.root, 'outside'));
  try { await symlink(join(second.root, 'outside'), join(second.root, 'docs/linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('OS disallowed fixture link creation; hardlink rejection still proved.'); return; } throw error; }
  await assert.rejects(createLocalRelease({ repository: second.root }), /Link/);
});

test('build prerequisite failure is explicit and preflight never treats parent dependencies as local', async t => {
  const { root, write } = await fixture(t);
  const report = await productDoctor({ repository: root });
  assert.equal(report.credentialsRead, false); assert.equal(report.networkUsed, false); assert.equal(report.installsPerformed, false);
  assert.equal(report.readyToLaunch, false);
  assert.equal(report.checks.find(check => check.id === 'plugin-artifact').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'studio-runtime').status, 'unverified');
  assert.equal((await productDoctor({ repository: root, nodeVersion: '22.0.0' })).checks.find(check => check.id === 'node').status, 'fail');
  await write('plugin/src/Main.server.luau', '-- changed');
  assert.equal((await productDoctor({ repository: root })).checks.find(check => check.id === 'plugin-artifact').status, 'fail');
  await rm(join(root, 'dist/apps/daemon/src/product-main.js')); // Single explicitly named fixture file, no recursive deletion.
  await assert.rejects(createLocalRelease({ repository: root }), /Build the product/);
});

test('packaging fails before emission when workspace lock entries or pinned root dependencies are stale', async t => {
  const { root, write } = await fixture(t);
  await write('package.json', JSON.stringify({ name: 'arcane', version: '0.1.0', workspaces: ['packages/*'] }));
  await write('packages/new-worker/package.json', JSON.stringify({ name: '@arcane/new-worker', version: '0.1.0' }));
  await assert.rejects(createLocalRelease({ repository: root }), /Workspace is missing/);
  await write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'packages/new-worker': { name: '@arcane/new-worker', version: '0.1.0' }, 'node_modules/@arcane/new-worker': { link: true, resolved: 'packages/new-worker' } } }));
  assert.equal((await createLocalRelease({ repository: root })).dependencyInstallRequired, true);
  await write('package.json', JSON.stringify({ name: 'arcane', version: '0.1.0', dependencies: { zod: '4.6.6' } }));
  await assert.rejects(createLocalRelease({ repository: root }), /out of sync/);
});

test('compiled-source provenance rejects stale, missing and external source-map inputs', async t => {
  const { root, write } = await fixture(t);
  const text = 'export const policy = 1;\n';
  await write('apps/daemon/src/policy.ts', text);
  await assert.rejects(createLocalRelease({ repository: root }), /no current compiled map/);
  await write('dist/apps/daemon/src/policy.js', 'export const policy = 1;\n');
  const map = { version: 3, sources: ['../../../../apps/daemon/src/policy.ts'], sourcesContent: [text] };
  await write('dist/apps/daemon/src/policy.js.map', JSON.stringify(map));
  await createLocalRelease({ repository: root });
  await write('apps/daemon/src/policy.ts', 'export const policy = 2;\n');
  await assert.rejects(createLocalRelease({ repository: root }), /Compiled source is stale/);
  map.sources[0] = '/outside/private.ts'; await write('dist/apps/daemon/src/policy.js.map', JSON.stringify(map));
  await assert.rejects(createLocalRelease({ repository: root }), /Invalid compiled/);
});


test('Windows compiler wrapper scopes memory settings to its child, preserves host overrides and rejects extra flags',async t=>{
  const {root,write}=await fixture(t);await write('scripts/compile-product.mjs',await readFile(new URL('../../scripts/compile-product.mjs',import.meta.url)));await write('tsconfig.json',JSON.stringify({include:['apps/desktop/src/**/*.ts']}));
  // Synthetic compiler only: the real installed compiler is separately tested by product builds.
  await write('node_modules/typescript/bin/tsc',"const fs=require('fs');console.log(JSON.stringify({args:process.argv.slice(2),config:JSON.parse(fs.readFileSync(process.argv[3],'utf8')),cwd:process.cwd(),gomax:process.env.GOMAXPROCS??null,gomem:process.env.GOMEMLIMIT??null}));");
  const env={...process.env};delete env.GOMAXPROCS;delete env.GOMEMLIMIT;
  const run=(args=[],variables=env)=>spawnSync(process.execPath,[join(root,'scripts/compile-product.mjs'),...args],{cwd:root,env:variables,shell:false,windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
  const plain=run();assert.equal(plain.status,0);const observed=JSON.parse(plain.stdout.trim().split(/\r?\n/)[0]);assert.equal(observed.args[0],'-p');assert.ok(observed.args[1].startsWith(join(root,'runtime','build','compile-')));assert.equal(observed.args.length,2);assert.equal(observed.config.extends,join(root,'tsconfig.json'));
  assert.deepEqual(observed.config.files,['asset-downloads.ts','asset-viewer.ts','automatic-asset-previews.ts','chat-attachments.ts','chat-tabs.ts','codex-history.ts','desktop-verification.ts','glb-preflight.ts','learning-panel.ts','playtest-panel.ts','provider-setup.ts','studio-key-settings.ts','task-usage-ui.ts','task-usage.ts','workflow-panel.ts','workspace-shell.ts'].map(name=>join(root,'apps','desktop','src',name)));
  assert.equal(observed.cwd,root);await assert.rejects(readFile(observed.args[1]),{code:'ENOENT'});
  if(process.platform==='win32'){assert.equal(observed.gomax,'1');assert.equal(observed.gomem,'256MiB');}else{assert.equal(observed.gomax,null);assert.equal(observed.gomem,null);}
  const overridden=run(['--noEmit'],{...env,GOMAXPROCS:'2',GOMEMLIMIT:'512MiB'});assert.equal(overridden.status,0);const meta=JSON.parse(overridden.stdout.trim().split(/\r?\n/)[0]);assert.equal(meta.gomax,'2');assert.equal(meta.gomem,'512MiB');assert.equal(meta.args.at(-1),'--noEmit');
  const refused=run(['--outDir','outside']);assert.equal(refused.status,2);assert.equal(refused.stdout,'');assert.match(refused.stderr,/Usage:/);assert.equal(Object.hasOwn(env,'GOMAXPROCS'),false);
});
