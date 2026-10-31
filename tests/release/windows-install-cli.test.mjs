import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createWindowsInstallation, WindowsInstallationError } from '../../scripts/windows-installation.mjs';
import { runWindowsInstallCli, admitWindowsInstallArguments, WINDOWS_INSTALL_CLI_LIMITS } from '../../scripts/windows-install-cli.mjs';

// Actual protocol runner and actual filesystem engine on owned temporary roots. The small inventory
// verifier below is SCRIPTED (fixture hashes only); the production entry point always uses the full
// bundle verifier and has no flag or environment that selects another one.
const hash = value => createHash('sha256').update(value).digest('hex');
const cli = fileURLToPath(new URL('../../scripts/windows-install-cli.mjs', import.meta.url));
const RESULT_KEYS = 'abort,activeReleaseId,code,installationId,lockRetained,published,schemaVersion,stagingRetained,state,type';
const PROGRESS_KEYS = 'bytesCopied,filesCopied,phase,schemaVersion,totalBytes,totalFiles,type';

async function fixture(t) {
  const boundary = await fs.realpath(tmpdir()), root = await fs.realpath(await fs.mkdtemp(join(boundary, 'arcane-install-cli-test-')));
  t.after(async () => { const p = relative(boundary, root); assert.ok(p.startsWith('arcane-install-cli-test-') && !isAbsolute(p) && !p.includes(sep)); await fs.rm(root, { recursive: true, force: true }); });
  const target = join(root, 'Arcane');
  const makeBundle = async (name, extra = 0) => {
    const directory = join(root, name); await fs.mkdir(join(directory, 'resources/node'), { recursive: true });
    const files = [];
    const entries = [['Arcane.exe', 'fixture ' + name], ['resources/node/node.exe', 'fixture node'], ...Array.from({ length: extra }, (_, i) => ['resources/data-' + i + '.txt', name + ' data ' + i])];
    for (const [path, text] of entries) { const bytes = Buffer.from(text); await fs.writeFile(join(directory, path), bytes); files.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
    const manifest = { schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files };
    await fs.writeFile(join(directory, 'windows-manifest.json'), JSON.stringify(manifest)); return directory;
  };
  const verify = async directory => {
    const bytes = await fs.readFile(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    for (const f of manifest.files) assert.equal(hash(await fs.readFile(join(directory, f.path))), f.sha256, 'fixture verifier hash ' + f.path);
    return { manifestSha256: hash(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  };
  const record = async () => { try { return await fs.readFile(join(target, 'installation.json'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  return { root, target, makeBundle, verify, record, engine: createWindowsInstallation({ verifyBundle: verify }) };
}

/** Owned output port: optional backpressure, delayed callbacks or write failure; it records every line exactly as written. */
function sink({ highWaterMark = 16384, delay = false, failAt = -1, onFrame = () => {} } = {}) {
  const lines = []; let writes = 0;
  const stream = new Writable({ highWaterMark, decodeStrings: false, write(chunk, _encoding, callback) {
    const index = writes++;
    if (index === failAt) { const error = Object.assign(new Error('fixture broken pipe C:\\secret'), { code: 'EPIPE' }); if (delay) setImmediate(callback, error); else callback(error); return; }
    const text = String(chunk); lines.push(text);
    try { onFrame(JSON.parse(text)); } catch { /* Frame shape is asserted separately. */ }
    if (delay) setImmediate(callback); else callback();
  } });
  return { stream, lines };
}
function frames(lines) {
  const parsed = lines.map(line => {
    assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'), 'one frame per line');
    assert.ok(Buffer.byteLength(line) <= WINDOWS_INSTALL_CLI_LIMITS.frameBytes, 'bounded frame');
    const frame = JSON.parse(line); assert.equal(frame.schemaVersion, 1);
    assert.equal(Object.keys(frame).sort().join(','), frame.type === 'result' ? RESULT_KEYS : PROGRESS_KEYS);
    return frame;
  });
  assert.equal(parsed.filter(frame => frame.type === 'result').length, 1, 'exactly one terminal result');
  assert.equal(parsed.at(-1).type, 'result', 'the result is the final frame');
  return { progress: parsed.slice(0, -1), result: parsed.at(-1) };
}
async function run(f, bundle, { input = new PassThrough(), output = sink(), installation = f.engine, now } = {}) {
  const code = await runWindowsInstallCli({ bundle, installRoot: f.target, input, output: output.stream, installation, ...(now ? { now } : {}) });
  return { code, ...frames(output.lines) };
}
const cancelFrame = '{"type":"cancel"}\n';

test('known installs report bounded progress and one result; repeat is already-active and unpublished', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first');
  const first = await run(f, bundle);
  assert.equal(first.code, 0); assert.equal(first.result.state, 'installed'); assert.equal(first.result.published, true);
  assert.equal(first.result.code, null); assert.equal(first.result.abort, null);
  const status = await f.engine.status(f.target);
  assert.equal(first.result.installationId, status.installationId); assert.equal(first.result.activeReleaseId, status.activeReleaseId);
  const phases = first.progress.map(frame => frame.phase).filter((phase, i, all) => phase !== all[i - 1]);
  assert.deepEqual(phases, ['verifying-source', 'copying', 'verifying-copy', 'publishing', 'installed']);
  const copied = first.progress.filter(frame => frame.phase === 'copying').at(-1);
  assert.equal(copied.filesCopied, copied.totalFiles); assert.equal(copied.bytesCopied, copied.totalBytes);
  const record = await f.record(), repeat = await run(f, bundle);
  assert.equal(repeat.code, 0); assert.equal(repeat.result.state, 'already-active'); assert.equal(repeat.result.published, false);
  assert.equal(repeat.result.activeReleaseId, status.activeReleaseId); assert.equal(await f.record(), record);
});

test('the optional absent-release selector is admitted exactly and reaches the original install with unchanged protocol frames',async()=>{
  const bundle=process.platform==='win32'?'C:\\bundle':'/bundle',installRoot=process.platform==='win32'?'C:\\installed':'/installed';
  const id='a'.repeat(64)+'-11111111-2222-4333-8444-555555555555',args=['--bundle',bundle,'--install-root',installRoot,'--replace-absent-release',id];
  const admitted=admitWindowsInstallArguments(args);assert.deepEqual({...admitted},{bundle,installRoot,replaceAbsentReleaseId:id});
  const output=sink();let observed;
  const code=await runWindowsInstallCli({...admitted,input:new PassThrough(),output:output.stream,installation:{async install(options){observed=options;
    return{state:'installed',installationId:'11111111-2222-4333-8444-555555555555',activeReleaseId:'b'.repeat(64)+'-11111111-2222-4333-8444-555555555555',replacedAbsentReleaseId:id};}}});
  assert.equal(code,0);assert.equal(observed.bundle,bundle);assert.equal(observed.installRoot,installRoot);assert.equal(observed.replaceAbsentReleaseId,id);
  assert.ok(observed.signal instanceof AbortSignal);assert.equal(typeof observed.onProgress,'function');assert.equal(frames(output.lines).result.published,true);
  for(const bad of [args.slice(0,-1),[...args,'extra'],[...args.slice(0,4),'--replace-absent-release','../slot'],[...args.slice(0,4),'--replace-absent-release',id.toUpperCase()],
    ['--replace-absent-release',id,...args.slice(0,4)],[...args.slice(0,4),'--replacement',id]])assert.equal(admitWindowsInstallArguments(bad),null);
  for(const bad of [null,'',{},'../slot'])await assert.rejects(runWindowsInstallCli({bundle,installRoot,replaceAbsentReleaseId:bad,input:new PassThrough(),output:sink().stream,
    installation:{install(){assert.fail('Invalid selector must not invoke the engine.');}}}),TypeError);
});

test('protocol replacement changes only the selected absent row and cancellation still reaches the original signal',async t=>{
  const f=await fixture(t),first=await f.engine.install({bundle:await f.makeBundle('first'),installRoot:f.target});
  const active=await f.engine.install({bundle:await f.makeBundle('second'),installRoot:f.target});await fs.rename(join(f.target,'releases',first.activeReleaseId),join(f.root,'preserved'));
  const bundle=await f.makeBundle('third'),output=sink();
  const code=await runWindowsInstallCli({bundle,installRoot:f.target,replaceAbsentReleaseId:first.activeReleaseId,input:new PassThrough(),output:output.stream,installation:f.engine});
  assert.equal(code,0);const result=frames(output.lines).result;assert.equal(result.state,'installed');assert.equal(result.published,true);
  const record=JSON.parse(await f.record());assert.equal(record.releases.length,2);assert.equal(record.releases[0].id,result.activeReleaseId);assert.equal(record.releases[1].id,active.activeReleaseId);
  assert.equal((await fs.readdir(join(f.root,'preserved'))).length,3);
  const input=new PassThrough(),cancelled=sink();input.write(cancelFrame);let signal;
  const exit=await runWindowsInstallCli({bundle,installRoot:f.target,replaceAbsentReleaseId:active.activeReleaseId,input,output:cancelled.stream,
    installation:{async install(options){signal=options.signal;assert.equal(options.replaceAbsentReleaseId,active.activeReleaseId);
      await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
      assert.equal(signal.aborted,true);throw new WindowsInstallationError('CANCELLED');}}});
  assert.equal(exit,2);assert.equal(frames(cancelled.lines).result.published,false);assert.equal(signal.aborted,true);
});

test('a cancel frame before work is a safe prepublication cancellation with no target mutation (LF and CRLF)', async t => {
  for (const frame of [cancelFrame, '{"type":"cancel"}\r\n']) {
    const f = await fixture(t), bundle = await f.makeBundle('first'), input = new PassThrough(); input.write(frame);
    const { code, result } = await run(f, bundle, { input });
    assert.equal(code, 2); assert.equal(result.state, 'cancelled'); assert.equal(result.code, 'CANCELLED');
    assert.equal(result.published, false); assert.equal(result.abort, 'cancel'); assert.equal(result.installationId, null);
    await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  }
});

test('cancel during copying retains the previous selection and reports the retained stage, never a rollback', async t => {
  const f = await fixture(t), previous = await f.engine.install({ bundle: await f.makeBundle('first'), installRoot: f.target });
  const before = await f.record(), bundle = await f.makeBundle('second', 24), input = new PassThrough(); let sent = false;
  // With a frozen clock only the first copy frame is emitted before the final one, so cancel on it.
  const output = sink({ onFrame: frame => { if (!sent && frame.phase === 'copying') { sent = true; input.write(cancelFrame); } } });
  const { code, result, progress } = await run(f, bundle, { input, output, now: () => 0 });
  assert.ok(sent); assert.equal(code, 2); assert.equal(result.state, 'cancelled'); assert.equal(result.published, false);
  assert.equal(result.stagingRetained, true); assert.equal(result.lockRetained, false);
  assert.equal(progress.some(frame => frame.phase === 'publishing'), false);
  assert.equal(await f.record(), before); assert.equal((await f.engine.status(f.target)).activeReleaseId, previous.activeReleaseId);
  const last = progress.at(-1); assert.equal(last.phase, 'copying'); assert.ok(last.filesCopied < last.totalFiles);
  // SCRIPTED engine: throttled counters held at cancellation are still reported before the result.
  const held = sink(), control = new PassThrough();
  const exit = await runWindowsInstallCli({ bundle: 'C:\\b', installRoot: 'C:\\r', input: control, output: held.stream, now: () => 0,
    installation: { async install({ onProgress, signal }) {
      for (let files = 0; files <= 7; files++) onProgress({ phase: 'copying', filesCopied: files, totalFiles: 10, bytesCopied: files, totalBytes: 10 });
      control.write(cancelFrame); await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      throw new WindowsInstallationError('CANCELLED', { stagingDirectory: 'C:\\r\\releases\\stage' });
    } } });
  const reported = frames(held.lines);
  assert.equal(exit, 2); assert.deepEqual(reported.progress.map(frame => frame.filesCopied), [0, 7]); assert.equal(reported.result.stagingRetained, true);
});

test('cancellation after completed publication reports the actual install; a publishing-time cancel agrees with disk', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first'), input = new PassThrough();
  const output = sink({ onFrame: frame => { if (frame.phase === 'installed') input.write(cancelFrame); } });
  const late = await run(f, bundle, { input, output });
  assert.equal(late.code, 0); assert.equal(late.result.state, 'installed'); assert.equal(late.result.published, true);
  assert.equal(late.result.abort, 'cancel'); assert.equal((await f.engine.status(f.target)).activeReleaseId, late.result.activeReleaseId);
  const g = await fixture(t), racing = new PassThrough();
  const raceOutput = sink({ onFrame: frame => { if (frame.phase === 'publishing') racing.write(cancelFrame); } });
  const race = await run(g, await g.makeBundle('first'), { input: racing, output: raceOutput });
  const active = JSON.parse(await g.record()).activeReleaseId;
  if (race.result.state === 'installed') { assert.equal(race.code, 0); assert.equal(race.result.published, true); assert.equal(active, race.result.activeReleaseId); }
  else { assert.equal(race.code, 2); assert.equal(race.result.state, 'cancelled'); assert.equal(race.result.published, false); assert.equal(active, null); }
});

test('parent loss (stdin end or error) aborts unfinished work before publication', async t => {
  for (const lose of [input => input.end(), input => input.destroy(new Error('fixture parent loss C:\\secret'))]) {
    const f = await fixture(t), previous = await f.engine.install({ bundle: await f.makeBundle('first'), installRoot: f.target });
    const before = await f.record(), input = new PassThrough(); let lost = false;
    const output = sink({ onFrame: frame => { if (!lost && frame.phase === 'copying') { lost = true; lose(input); } } });
    const { code, result, progress } = await run(f, await f.makeBundle('second', 8), { input, output });
    assert.equal(code, 1); assert.equal(result.state, 'failed'); assert.equal(result.code, 'PARENT_LOST');
    assert.equal(result.abort, 'parent-lost'); assert.equal(result.published, false);
    assert.equal(progress.some(frame => frame.phase === 'publishing'), false);
    assert.equal(await f.record(), before); assert.equal((await f.engine.status(f.target)).activeReleaseId, previous.activeReleaseId);
  }
});

test('malformed, extra or oversize control input is an explicit protocol failure before any mutation', async t => {
  const controls = [
    'not json\n', '{"type":"stop"}\n', '{"type":"cancel","force":true}\n', '[]\n', 'null\n', '"cancel"\n',
    Buffer.concat([Buffer.from('{"type":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]),
    cancelFrame + cancelFrame, cancelFrame.slice(0, -1) + '\nX', 'x'.repeat(WINDOWS_INSTALL_CLI_LIMITS.controlBytes + 1),
    '{"type":"cancel","__proto__":{"type":"cancel"}}\n',
  ];
  for (const control of controls) {
    const f = await fixture(t), bundle = await f.makeBundle('first'), input = new PassThrough(); input.write(control);
    const { code, result } = await run(f, bundle, { input });
    assert.equal(code, 1, String(control)); assert.equal(result.state, 'failed'); assert.equal(result.code, 'PROTOCOL');
    assert.equal(result.abort, 'protocol'); assert.equal(result.published, false);
    await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  }
});

test('output failure aborts unfinished work, waits for the engine, and late pipe errors stay handled', async t => {
  const f = await fixture(t), previous = await f.engine.install({ bundle: await f.makeBundle('first'), installRoot: f.target });
  const before = await f.record(), output = sink({ failAt: 1 });
  const code = await runWindowsInstallCli({ bundle: await f.makeBundle('second', 8), installRoot: f.target, input: new PassThrough(), output: output.stream, installation: f.engine });
  assert.equal(code, 1); assert.equal(output.lines.length, 1, 'nothing is written after the failure');
  assert.equal(await f.record(), before); assert.equal((await f.engine.status(f.target)).activeReleaseId, previous.activeReleaseId);
  output.stream.emit('error', new Error('late broken pipe'));
  // A synchronously throwing output port is also contained.
  const g = await fixture(t), throwing = { on() {}, write() { throw new Error('fixture write failure C:\\secret'); } };
  assert.equal(await runWindowsInstallCli({ bundle: await g.makeBundle('first'), installRoot: g.target, input: new PassThrough(), output: throwing, installation: g.engine }), 1);
  assert.equal(await g.record(), null);
});

test('copy progress is throttled and coalesced under backpressure without losing phases or final counters', async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first', 40), slow = sink({ highWaterMark: 1, delay: true });
  const quiet = await run(f, bundle, { output: slow, now: () => 0 });
  assert.equal(quiet.code, 0);
  const copying = quiet.progress.filter(frame => frame.phase === 'copying');
  // Throttled: at most the first and the final counter (backpressure may coalesce even those into the final one).
  assert.ok(copying.length >= 1 && copying.length <= 2); assert.equal(copying.at(-1).filesCopied, copying.at(-1).totalFiles);
  assert.equal(copying.at(-1).totalFiles, 43); assert.equal(copying.at(-1).bytesCopied, copying.at(-1).totalBytes);
  assert.deepEqual(quiet.progress.map(frame => frame.phase).filter((phase, i, all) => phase !== all[i - 1]),
    ['verifying-source', 'copying', 'verifying-copy', 'publishing', 'installed']);
  const g = await fixture(t); let clock = 0;
  const every = await run(g, await g.makeBundle('first', 40), { now: () => (clock += WINDOWS_INSTALL_CLI_LIMITS.progressIntervalMs) });
  const counts = every.progress.filter(frame => frame.phase === 'copying').map(frame => frame.filesCopied);
  assert.deepEqual(counts, Array.from({ length: 44 }, (_, i) => i), 'an elapsed interval reports every counter');
  for (let i = 1; i < every.progress.length; i++) assert.ok(every.progress[i].filesCopied >= every.progress[i - 1].filesCopied, 'monotonic counters');
  // SCRIPTED engine: a burst into a blocked pipe is coalesced to the newest copy counter, phase frames are kept in order.
  const blocked = sink({ highWaterMark: 1, delay: true });
  const code = await runWindowsInstallCli({ bundle: 'C:\\b', installRoot: 'C:\\r', input: new PassThrough(), output: blocked.stream, now: () => (clock += 1000),
    installation: { async install({ onProgress }) {
      const at = (phase, files) => onProgress({ phase, filesCopied: files, totalFiles: 1000, bytesCopied: files, totalBytes: 1000 });
      at('verifying-source', 0); for (let files = 0; files <= 1000; files++) at('copying', files); at('verifying-copy', 1000);
      throw new WindowsInstallationError('COPY');
    } } });
  const burst = frames(blocked.lines);
  assert.equal(code, 1); assert.deepEqual(burst.progress.map(frame => [frame.phase, frame.filesCopied]), [['verifying-source', 0], ['copying', 1000], ['verifying-copy', 1000]]);
});

test('scripted engines: no raw causes, unknown codes or unproven success reach the parent; result waits for the engine', async () => {
  // SCRIPTED engine ports only; no filesystem, verifier or process is involved.
  const scripted = async (install, input = new PassThrough()) => {
    const output = sink(); const code = await runWindowsInstallCli({ bundle: 'C:\\b', installRoot: 'C:\\r', input, output: output.stream, installation: { install } });
    assert.doesNotMatch(output.lines.join(''), /secret|token|stack|at /i); return { code, ...frames(output.lines) };
  };
  let r = await scripted(async () => { throw new Error('raw cause C:\\secret token=abc'); });
  assert.deepEqual([r.code, r.result.state, r.result.code, r.result.published], [1, 'failed', 'IO', false]);
  r = await scripted(async () => { throw new WindowsInstallationError('PUBLISH_UNCONFIRMED', { published: null, cause: new Error('secret') }); });
  assert.deepEqual([r.code, r.result.code, r.result.published], [1, 'PUBLISH_UNCONFIRMED', null]);
  r = await scripted(async () => { throw new WindowsInstallationError('SECRET_TOKEN_VALUE', { published: true }); });
  assert.deepEqual([r.code, r.result.code, r.result.published], [1, 'ENGINE', true]);
  r = await scripted(async () => ({ state: 'installed', installationId: 'secret', activeReleaseId: 'x' }));
  assert.deepEqual([r.code, r.result.state, r.result.code, r.result.published], [1, 'failed', 'RESULT', null]);
  r = await scripted(async ({ onProgress }) => {
    for (const value of [null, 'copying', { phase: 'secret', filesCopied: 0, totalFiles: 0, bytesCopied: 0, totalBytes: 0 },
      { phase: 'copying', filesCopied: '1', totalFiles: 1, bytesCopied: 0, totalBytes: 0 }, { phase: 'copying', filesCopied: 2, totalFiles: 1, bytesCopied: 0, totalBytes: 0 },
      { get phase() { throw new Error('secret getter'); } }]) assert.equal(onProgress(value), undefined);
    assert.equal(onProgress({ phase: 'verifying-source', filesCopied: 0, totalFiles: 0, bytesCopied: 0, totalBytes: 0, token: 'secret' }), undefined);
    throw new WindowsInstallationError('MANIFEST');
  });
  assert.equal(r.progress.length, 1); assert.equal(r.progress[0].phase, 'verifying-source'); assert.equal(r.result.code, 'MANIFEST');
  // An engine that is slow to observe cancellation is awaited; no result precedes its terminal state.
  let finish; const input = new PassThrough(), output = sink();
  const pending = runWindowsInstallCli({ bundle: 'C:\\b', installRoot: 'C:\\r', input, output: output.stream,
    installation: { install: ({ signal }) => new Promise((resolve, reject) => { finish = () => reject(new WindowsInstallationError('CANCELLED')); assert.equal(signal.aborted, false); }) } });
  input.write(cancelFrame); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(output.lines.length, 0, 'no result before the engine settles');
  finish(); assert.equal(await pending, 2); assert.equal(frames(output.lines).result.state, 'cancelled');
  await assert.rejects(runWindowsInstallCli({ bundle: 'C:\\b', installRoot: 'C:\\r', input: new PassThrough(), output: sink().stream }), TypeError);
});

test('production entry admits only exact absolute --bundle/--install-root arguments and refuses before any engine work', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), bundle = await f.makeBundle('first');
  const child = (args, control) => new Promise((resolve, reject) => {
    // Bundled-Node shape: no shell, fixed argv, minimal environment. Only the owned temp root is named.
    const owned = spawn(process.execPath, [cli, ...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot } });
    let stdout = '', stderr = ''; owned.stdout.on('data', data => { stdout += data; }); owned.stderr.on('data', data => { stderr += data; });
    const deadline = setTimeout(() => { owned.kill(); reject(new Error('Owned protocol child exceeded its deadline.')); }, 30000);
    owned.on('error', reject); owned.on('close', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
    if (control !== undefined) owned.stdin.write(control);
  });
  const refused = [[], ['--bundle', bundle], ['--install-root', f.target, '--bundle', bundle], ['--bundle', bundle, '--install-root', f.target, '--verbose'],
    ['--bundle=' + bundle, '--install-root', f.target], ['--bundle', 'relative', '--install-root', f.target], ['--bundle', bundle, '--install-root', '\\\\server\\share\\Arcane'],
    ['--bundle', bundle, '--install-root', ' ' + f.target], ['--bundle', bundle, '--bundle', f.target], ['--bundle', bundle, '--install-root', f.target.replaceAll('\\', '/')],
    ['--bundle',bundle,'--install-root',f.target,'--replace-absent-release'],['--bundle',bundle,'--install-root',f.target,'--replace-absent-release','../slot'],
    ['--bundle',bundle,'--install-root',f.target,'--replace-absent-release','a'.repeat(64)+'-11111111-2222-4333-8444-555555555555','--replace-absent-release','extra']];
  for (const args of refused) {
    assert.equal(admitWindowsInstallArguments(args), null, JSON.stringify(args));
    const { code, stdout, stderr } = await child(args);
    assert.equal(code, 1); assert.equal(stderr, '');
    const { result } = frames([stdout]); assert.equal(result.code, 'ARGUMENTS'); assert.equal(result.published, false);
    await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  }
  // Admitted arguments reach the production engine and its full verifier, which refuses this scripted fixture before mutation.
  assert.deepEqual({ ...admitWindowsInstallArguments(['--bundle', bundle, '--install-root', f.target]) }, { bundle, installRoot: f.target });
  const real = await child(['--bundle', bundle, '--install-root', f.target]);
  assert.equal(real.code, 1); assert.equal(real.stderr, '');
  const { result } = frames(real.stdout.split(/(?<=\n)/));
  assert.equal(result.state, 'failed'); assert.equal(result.published, false); assert.doesNotMatch(real.stdout, /PE executable|manifest\.|C:\\\\/);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  const replacement=await child(['--bundle',bundle,'--install-root',f.target,'--replace-absent-release','a'.repeat(64)+'-11111111-2222-4333-8444-555555555555']);
  assert.equal(replacement.code,1);assert.equal(replacement.stderr,'');const rejected=frames(replacement.stdout.split(/(?<=\n)/)).result;
  assert.equal(rejected.state,'failed');assert.notEqual(rejected.code,'ARGUMENTS','the admitted option reaches the unchanged full verifier');assert.equal(rejected.published,false);
  await assert.rejects(fs.stat(f.target),{code:'ENOENT'});
  // A cancel frame reaches the production child, which then exits on its own.
  const cancelled = await child(['--bundle', bundle, '--install-root', f.target], cancelFrame);
  assert.ok([1, 2].includes(cancelled.code)); assert.equal(frames(cancelled.stdout.split(/(?<=\n)/)).result.published, false);
});

/** Owned stuck output port: accepts writes into memory and never acknowledges them (a parent that never reads stdout). */
function stuckPort() {
  const writes = [], listeners = new Map(); let destroyed = 0;
  return { writes, listeners, destroyed: () => destroyed,
    on(event, listener) { listeners.set(event, [...listeners.get(event) ?? [], listener]); },
    write(chunk) { writes.push(String(chunk)); return false; }, destroy() { destroyed++; } };
}
/** Owned manual timer seam: records when the drain deadline is armed and fires it only on request. */
function manualTimers(observe = () => null) {
  const armed = [], cleared = [];
  return { armed, cleared, fire: () => armed.at(-1).callback(),
    setTimeout(callback, ms) { armed.push({ callback, ms, observed: observe() }); return armed.length; }, clearTimeout(handle) { cleared.push(handle); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('terminal drain is bounded after the engine settles; unknown delivery exits 1 without losing the disk outcome', async t => {
  // SCRIPTED engine: the deadline is armed only after its terminal state.
  let settled = false; const port = stuckPort(), timers = manualTimers(() => settled);
  let finished = false;
  const pending = runWindowsInstallCli({ bundle: 'C:\b', installRoot: 'C:\r', input: new PassThrough(), output: port, timers,
    installation: { async install() { await tick(); assert.equal(timers.armed.length, 0, 'no drain timer while the engine runs'); settled = true;
      return { state: 'installed', installationId: '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), activeReleaseId: 'a'.repeat(64) + '-' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) }; } } })
    .then(code => { finished = true; return code; });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(finished, false, 'an unread result waits only for the bounded drain');
  assert.deepEqual(timers.armed.map(entry => [entry.ms, entry.observed]), [[WINDOWS_INSTALL_CLI_LIMITS.drainMs, true]]);
  assert.equal(WINDOWS_INSTALL_CLI_LIMITS.drainMs, 5000);
  timers.fire();
  assert.equal(await pending, 1, 'success without a confirmed result write is reported as unknown delivery');
  assert.equal(port.destroyed(), 1);
  const { result } = frames(port.writes); assert.equal(result.state, 'installed');
  for (const listener of port.listeners.get('error') ?? []) listener(new Error('late broken pipe'));
  assert.ok((port.listeners.get('error') ?? []).length >= 1, 'late output errors stay absorbed');
  // ACTUAL engine: the published release is retained on disk although the result was never consumed.
  const f = await fixture(t), real = stuckPort(), realTimers = manualTimers();
  const run = runWindowsInstallCli({ bundle: await f.makeBundle('first'), installRoot: f.target, input: new PassThrough(), output: real, installation: f.engine, timers: realTimers });
  while (!realTimers.armed.length) await tick();
  realTimers.fire(); assert.equal(await run, 1);
  const written = frames(real.writes).result; assert.equal(written.state, 'installed');
  assert.equal((await f.engine.status(f.target)).activeReleaseId, written.activeReleaseId);
  // A confirmed drain clears its owned timer and keeps the engine outcome.
  const quick = manualTimers(), okSink = sink();
  assert.equal(await runWindowsInstallCli({ bundle: 'C:\b', installRoot: 'C:\r', input: new PassThrough(), output: okSink.stream, timers: quick,
    installation: { async install() { throw new WindowsInstallationError('MANIFEST'); } } }), 1);
  assert.deepEqual(quick.cleared, [1]); assert.equal(frames(okSink.lines).result.code, 'MANIFEST');
  await assert.rejects(runWindowsInstallCli({ bundle: 'C:\b', installRoot: 'C:\r', input: new PassThrough(), output: sink().stream,
    installation: { install() {} }, timers: { setTimeout() {} } }), TypeError);
});

test('an asynchronous result-write failure after a successful outcome returns 1, never 0', async () => {
  // SCRIPTED engine with no progress: the result is write 0 and its callback fails later.
  const output = sink({ delay: true, failAt: 0 });
  const code = await runWindowsInstallCli({ bundle: 'C:\b', installRoot: 'C:\r', input: new PassThrough(), output: output.stream,
    installation: { async install() { return { state: 'already-active', installationId: '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), activeReleaseId: 'a'.repeat(64) + '-' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) }; } } });
  assert.equal(code, 1); assert.equal(output.lines.length, 0);
});

test('invalid control bytes in a second chunk after a valid cancel are PROTOCOL; a plain end after cancel stays cancelled', async () => {
  // SCRIPTED engine: it observes the cancel, then the parent sends a second chunk before the engine settles.
  const scripted = (second, finish = input => input.write(second)) => {
    const input = new PassThrough(), output = sink();
    const code = runWindowsInstallCli({ bundle: 'C:\b', installRoot: 'C:\r', input, output: output.stream,
      installation: { async install({ signal }) {
        input.write(cancelFrame);
        await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
        finish(input); await tick(); await tick();
        throw new WindowsInstallationError('CANCELLED');
      } } });
    return code.then(exit => ({ exit, ...frames(output.lines) }));
  };
  for (const second of ['X', '\n', cancelFrame, '{"type":"cancel"}', Buffer.from([0xff])]) {
    const { exit, result, progress } = await scripted(second);
    assert.equal(exit, 1, JSON.stringify(String(second))); assert.equal(result.state, 'failed'); assert.equal(result.code, 'PROTOCOL');
    assert.equal(result.abort, 'protocol'); assert.equal(result.published, false); assert.equal(progress.length, 0);
  }
  const ended = await scripted(null, input => input.end());
  assert.equal(ended.exit, 2); assert.equal(ended.result.state, 'cancelled'); assert.equal(ended.result.abort, 'cancel');
});
