// Offline owned Node helpers only. Never run the real desktop pipeline or build.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DESKTOP_STAGE_BUDGETS, runDesktopStage } from '../../scripts/desktop-pipeline.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
let directory;
before(async () => {
  const root = join(repository, 'runtime', 'verification');
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, 'desktop-stage-fixtures-'));
  console.log('Retained owned-stage fixtures: ' + directory);
});
const launch = code => spawn(process.execPath, ['-e', code], {
  shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
async function failed(work) {
  let error;
  try { await work(); } catch (caught) { error = caught; }
  assert.ok(error?.outcome, 'Failure must expose the retained stage outcome.');
  return error.outcome;
}
async function evidence(result) {
  assert.deepEqual(JSON.parse(await readFile(join(result.stageDirectory, 'result.json'), 'utf8')), JSON.parse(JSON.stringify(result)));
  assert.equal(result.verification, 'owned-process-stage-only');
  assert.equal(result.fullProductVerified, false);
  assert.equal(result.automaticRetries, 0);
  assert.equal(result.nativeCounterScope, 'runner-only; child native activity is not assessed');
  assert.deepEqual(result.runnerOperations, { providerInferenceRuns: 0, studioOperations: 0, blenderRuns: 0, browserLaunches: 0 });
  const files = (await readdir(result.stageDirectory)).filter(n => /^progress-\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  assert.ok(files.length >= 2, 'Created and terminal/stop progress must survive.');
  const progress = await Promise.all(files.map(n => readFile(join(result.stageDirectory, n), 'utf8').then(JSON.parse)));
  assert.equal(progress[0].phase, 'created');
  return { log: await readFile(result.logPath, 'utf8'), progress };
}

test('stage budgets cover the sealed 19.5 minute inventory without changing fixture deadlines', () => {
  assert.deepEqual(DESKTOP_STAGE_BUDGETS, { compile: 300000, 'plugin-build': 120000, 'unit-browser': 2700000, 'offline-release-plugin': 900000 });
  assert.ok(Object.isFrozen(DESKTOP_STAGE_BUDGETS));
  assert.ok(DESKTOP_STAGE_BUDGETS['unit-browser'] > 1169910);
  assert.ok(DESKTOP_STAGE_BUDGETS.compile < DESKTOP_STAGE_BUDGETS['offline-release-plugin']);
});

test('zero exit waits for the owned child and retains stdout/stderr with stage-only claims', async () => {
  let calls = 0, child;
  const result = await runDesktopStage({ directory, label: 'compile',
    startOwned: () => { calls++; child = launch("process.stdout.write('before-exit\\n');process.stderr.write('fixture-stderr\\n');setTimeout(()=>process.exit(0),80)"); return child; } });
  assert.equal(calls, 1); assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.equal(result.passed, true); assert.equal(result.status, 'passed');
  assert.equal(result.terminalAcknowledged, true); assert.equal(child.exitCode, 0);
  assert.equal(result.killRequested, false); assert.equal(result.deadlineMs, DESKTOP_STAGE_BUDGETS.compile);
  const proof = await evidence(result);
  assert.match(proof.log, /before-exit/); assert.match(proof.log, /fixture-stderr/);
  assert.equal(result.retainedBytes, Buffer.byteLength(proof.log));
});

test('nonzero exit retains failed-stage output and never retries the callback', async () => {
  let calls = 0;
  const result = await failed(() => runDesktopStage({ directory, label: 'plugin-build',
    startOwned: () => { calls++; return launch("process.stdout.write('original failure');process.exit(7)"); } }));
  assert.equal(calls, 1); assert.equal(result.code, 7); assert.equal(result.failure, 'nonzero-exit');
  assert.equal(result.passed, false); assert.equal(result.terminalAcknowledged, true);
  assert.equal(result.killRequested, false); assert.equal((await evidence(result)).log, 'original failure');
});

test('synchronous spawn failure retains exclusive log and failure progress without retry', async () => {
  let calls = 0;
  const result = await failed(() => runDesktopStage({ directory, label: 'compile',
    startOwned: () => { calls++; throw new Error('synthetic launch failure'); } }));
  assert.equal(calls, 1); assert.equal(result.failure, 'spawn-error');
  assert.equal(result.pid, null); assert.equal(result.processStarted, false);
  assert.equal(result.terminalAcknowledged, false); assert.equal(result.phase, 'not-started');
  assert.equal((await evidence(result)).log, '');
});

test('Node spawn error awaits close and retains failed evidence rather than falling back', async () => {
  let calls = 0;
  const result = await failed(() => runDesktopStage({ directory, label: 'compile', cleanupMs: 2000,
    startOwned: () => { calls++; return spawn(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: join(directory, 'nonexistent-cwd'), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }); } }));
  assert.equal(calls, 1); assert.equal(result.failure, 'spawn-error');
  assert.equal(result.processStarted, false); assert.equal(result.killRequested, false);
  assert.equal(result.terminalAcknowledged, true); assert.equal(result.terminalEvent, 'close');
  assert.equal(result.passed, false); await evidence(result);
});

test('output overflow retains the bounded prefix and awaits only its killed child', async () => {
  let calls = 0, child;
  const result = await failed(() => runDesktopStage({ directory, label: 'unit-browser',
    maxOutputBytes: 1024, cleanupMs: 2000,
    startOwned: () => { calls++; child = launch("process.stdout.write('overflow-prefix\\n'+'x'.repeat(32768));setInterval(()=>{},1000)"); return child; } }));
  assert.equal(calls, 1); assert.equal(result.failure, 'output-overflow');
  assert.equal(result.killRequested, true); assert.equal(result.killAccepted, true);
  assert.equal(result.terminalAcknowledged, true); assert.notEqual(child.exitCode ?? child.signalCode, null);
  const proof = await evidence(result); assert.match(proof.log, /^overflow-prefix/);
  assert.equal(result.retainedBytes, 1024); assert.ok(result.outputBytes > 1024);
  assert.equal(Buffer.byteLength(proof.log), 1024); assert.equal(result.passed, false);
});

test('stage timeout retains output and resolves only after owned terminal cleanup', async () => {
  let calls = 0, child;
  const result = await failed(() => runDesktopStage({ directory, label: 'unit-browser',
    deadlineMs: 1500, cleanupMs: 2000,
    startOwned: () => { calls++; child = launch("process.stdout.write('timeout-prefix');setInterval(()=>{},1000)"); return child; } }));
  assert.equal(calls, 1); assert.equal(result.failure, 'timeout');
  assert.equal(result.killRequested, true); assert.equal(result.terminalAcknowledged, true);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
  const proof = await evidence(result); assert.equal(proof.log, 'timeout-prefix');
  assert.ok(proof.progress.some(p => p.phase === 'stopping')); assert.equal(result.passed, false);
});

test('pre-cancellation retains evidence and never creates a child', async () => {
  const cancellation = new AbortController(); cancellation.abort(); let calls = 0;
  const result = await failed(() => runDesktopStage({ directory, label: 'compile', signal: cancellation.signal,
    startOwned: () => { calls++; return launch('process.exit(0)'); } }));
  assert.equal(calls, 0); assert.equal(result.failure, 'cancelled'); assert.equal(result.pid, null);
  assert.equal(result.passed, false); assert.equal(result.terminalAcknowledged, false);
  assert.equal(result.killRequested, false); assert.equal(result.phase, 'not-started'); await evidence(result);
});

test('cancellation kills only the owned stage child and waits for its terminal event', async t => {
  const unrelated = launch("process.stdout.write('unrelated-ready');setInterval(()=>{},1000)");
  t.after(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      const closing = once(unrelated, 'close'); unrelated.kill('SIGKILL'); await closing;
    }
  });
  await once(unrelated.stdout, 'data');
  const cancellation = new AbortController(); let child, calls = 0;
  const result = await failed(() => runDesktopStage({ directory, label: 'offline-release-plugin',
    signal: cancellation.signal, cleanupMs: 2000,
    startOwned: () => {
      calls++; child = launch("process.stdout.write('cancel-prefix');setInterval(()=>{},1000)");
      child.stdout.once('data', () => cancellation.abort()); return child;
    } }));
  assert.equal(calls, 1); assert.equal(result.failure, 'cancelled');
  assert.equal(result.terminalAcknowledged, true); assert.notEqual(child.exitCode ?? child.signalCode, null);
  assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
  assert.equal((await evidence(result)).log, 'cancel-prefix'); assert.equal(result.passed, false);
});

test('a proven zero exit cancels the stage deadline before bounded pipe drain', async () => {
  let child, kills = 0;
  const result = await runDesktopStage({ directory, label: 'compile', deadlineMs: 1500, drainMs: 20,
    startOwned: () => {
      child = launch("process.stdout.write('drain-prefix')");
      const emit = child.emit;
      child.emit = function (event, ...args) { return event === 'close' ? false : emit.call(this, event, ...args); };
      const kill = child.kill; child.kill = function (...args) { kills++; return kill.apply(this, args); };
      return child;
    } });
  assert.equal(child.exitCode, 0); assert.equal(kills, 0); assert.equal(result.passed, true);
  assert.equal(result.terminalAcknowledged, true); assert.equal(result.terminalEvent, 'exit');
  assert.equal(result.pipeDrain, 'bounded-after-exit'); assert.equal(result.logComplete, false);
  const proof = await evidence(result); assert.equal(proof.log, 'drain-prefix');
  assert.ok(proof.progress.some(p => p.phase === 'pipe-drained'));
});

test('missing terminal acknowledgement is an unconfirmed failure, never a completed stage or restart', async () => {
  const cancellation = new AbortController(); let calls = 0, actualExit;
  const result = await failed(() => runDesktopStage({ directory, label: 'compile',
    signal: cancellation.signal, cleanupMs: 60,
    startOwned: () => {
      calls++; const child = launch("process.stdout.write('unconfirmed-prefix');setInterval(()=>{},1000)");
      let proveExit; actualExit = new Promise(resolve => { proveExit = resolve; });
      const emit = child.emit;
      child.emit = function (event, ...args) {
        if (event === 'exit' || event === 'close') { proveExit(args); return false; }
        return emit.call(this, event, ...args);
      };
      child.stdout.once('data', () => cancellation.abort()); return child;
    } }));
  await actualExit; // The fixture itself owns/awaits the helper even when events are withheld.
  assert.equal(calls, 1); assert.equal(result.terminalAcknowledged, false);
  assert.equal(result.code, null); assert.equal(result.passed, false);
  assert.equal(result.status, 'cleanup-unconfirmed'); assert.equal(result.phase, 'cleanup-unconfirmed');
  assert.equal(result.killRequested, true); assert.equal((await evidence(result)).log, 'unconfirmed-prefix');
});

test('malformed piped host child is terminated and awaited without an orphan or retry', async () => {
  let child, calls = 0;
  const result = await failed(() => runDesktopStage({ directory, label: 'compile', cleanupMs: 2000,
    startOwned: () => { calls++; child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    }); return child; } }));
  assert.equal(calls, 1); assert.equal(result.failure, 'invalid-host-child');
  assert.equal(result.killRequested, true); assert.equal(result.terminalAcknowledged, true);
  assert.notEqual(child.exitCode ?? child.signalCode, null); assert.equal(result.passed, false); await evidence(result);
});

test('invalid labels, callbacks and bounds reject before any host callback or evidence stage', async () => {
  let calls = 0; const startOwned = () => { calls++; return launch('process.exit(0)'); };
  const before = await readdir(directory);
  for (const options of [
    { label: '../outside' }, { deadlineMs: 0 }, { deadlineMs: NaN }, { deadlineMs: 300001 },
    { maxOutputBytes: 0 }, { maxOutputBytes: 16777217 }, { cleanupMs: 10001 }, { drainMs: 1001 },
    { signal: {} }, { startOwned: 'node' },
    { startOwned: async () => { calls++; } }, { startOwned: _input => { calls++; } },
  ]) await assert.rejects(runDesktopStage({ directory, label: 'compile', startOwned, ...options }), /Invalid owned stage configuration/);
  assert.equal(calls, 0); assert.deepEqual(await readdir(directory), before);
});

test('separate invocations retain unique stage logs and exclusive immutable progress', async () => {
  const startOwned = () => launch("process.stdout.write('retained')");
  const first = await runDesktopStage({ directory, label: 'compile', startOwned });
  const original = await readFile(join(first.stageDirectory, 'result.json'));
  const second = await runDesktopStage({ directory, label: 'compile', startOwned });
  assert.notEqual(first.stageDirectory, second.stageDirectory);
  assert.deepEqual(await readFile(join(first.stageDirectory, 'result.json')), original);
  await evidence(first); await evidence(second);
});

test('runner import works in a fixture without product, packaging or compiled dist modules', async () => {
  const isolated = await mkdtemp(join(directory, 'import-only-'));
  const entry = join(isolated, 'desktop-pipeline.mjs');
  await writeFile(entry, await readFile(new URL('../../scripts/desktop-pipeline.mjs', import.meta.url)));
  const script = "import(" + JSON.stringify(pathToFileURL(entry).href) + ").then(m=>{if(typeof m.runDesktopStage!=='function')process.exit(2);console.log('import-only')})";
  const result = await runDesktopStage({ directory, label: 'compile', startOwned: () => launch(script) });
  assert.equal(result.passed, true); assert.equal((await evidence(result)).log.trim(), 'import-only');
});

test('pipe read failure retains output and awaits owned terminal cleanup', async () => {
  let child, calls = 0;
  const result = await failed(() => runDesktopStage({ directory, label: 'compile', cleanupMs: 2000,
    startOwned: () => {
      calls++; child = launch("process.stdout.write('pipe-error-prefix');setInterval(()=>{},1000)");
      child.stdout.once('data', () => child.stdout.emit('error', new Error('synthetic owned pipe error')));
      return child;
    } }));
  assert.equal(calls, 1); assert.equal(result.failure, 'pipe-error');
  assert.equal(result.killRequested, true); assert.equal(result.terminalAcknowledged, true);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
  assert.equal((await evidence(result)).log, 'pipe-error-prefix'); assert.equal(result.passed, false);
});

test('overflow during post-exit pipe drain remains a failure despite zero process exit', async () => {
  let kills = 0;
  const result = await failed(() => runDesktopStage({ directory, label: 'compile',
    maxOutputBytes: 16, drainMs: 50,
    startOwned: () => {
      const child = launch("process.stdout.write('after-exit')");
      const emit = child.emit;
      child.emit = function (event, ...args) { return event === 'close' ? false : emit.call(this, event, ...args); };
      child.once('exit', () => queueMicrotask(() => child.stdout.emit('data', Buffer.alloc(32, 'x'))));
      const kill = child.kill; child.kill = function (...args) { kills++; return kill.apply(this, args); };
      return child;
    } }));
  assert.equal(result.code, 0); assert.equal(result.failure, 'output-overflow');
  assert.equal(result.terminalAcknowledged, true); assert.equal(result.killRequested, false); assert.equal(kills, 0);
  assert.equal(result.passed, false); assert.equal(result.status, 'failed');
  assert.equal(result.retainedBytes, 16); assert.ok(result.outputBytes > 16);
  assert.match((await evidence(result)).log, /^after-exit/);
});

async function filesystemBoundaryDoubleFixture(moduleUrl, directory) {
  // Explicit filesystem boundary double, isolated in an externally bounded
  // owned Node helper. This is synthetic writeSync behavior, not a native run.
  const { default: fs } = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const { spawn } = await import('node:child_process');
  const { default: assert } = await import('node:assert/strict');
  const { join } = await import('node:path');
  const { runDesktopStage } = await import(moduleUrl);
  const originalWrite = fs.writeSync, marker = 'fs-boundary-double-output';
  const variants = [
    ['zero', () => 0], ['negative', () => -1], ['nan', () => NaN],
    ['infinity', () => Infinity], ['oversized', remaining => remaining + 1],
    ['fractional', () => 0.5], ['undefined', () => undefined], ['string', () => '1'],
  ];
  const cases = [];
  for (const [name, invalidCount] of variants) {
    let writes = 0, calls = 0, child, error;
    fs.writeSync = (...args) => {
      const [, bytes, offset, remaining] = args;
      if (Buffer.isBuffer(bytes) && bytes.toString('utf8').startsWith(marker)) {
        writes++;
        if (writes === 1) return originalWrite(args[0], bytes, offset, 4);
        return invalidCount(remaining);
      }
      return originalWrite(...args);
    };
    syncBuiltinESMExports();
    try {
      await runDesktopStage({ directory, label: 'compile', deadlineMs: 3000, cleanupMs: 2000,
        startOwned: () => {
          calls++;
          // The fixture child also self-exits and exits on IPC loss, so even a
          // regressed host capture loop cannot leave an indefinite helper orphan.
          child = spawn(process.execPath, ['-e',
            "process.once('disconnect',()=>process.exit(0));setTimeout(()=>process.exit(0),5000);process.stdout.write(" + JSON.stringify(marker) + ")"],
            { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
          return child;
        } });
    } catch (caught) { error = caught; }
    finally { fs.writeSync = originalWrite; syncBuiltinESMExports(); }
    const result = error?.outcome;
    assert.ok(result, name + ': expected failed-stage evidence');
    assert.equal(result.failure, 'log-write-error', name);
    assert.equal(result.passed, false); assert.equal(result.status, 'failed');
    assert.equal(calls, 1); assert.equal(writes, 2, name + ': no spinning or retry');
    assert.equal(result.killRequested, true); assert.equal(result.terminalAcknowledged, true);
    assert.notEqual(child.exitCode ?? child.signalCode, null);
    assert.equal(result.retainedBytes, 4); assert.equal(result.outputBytes, Buffer.byteLength(marker));
    assert.equal(fs.readFileSync(result.logPath, 'utf8'), 'fs-b');
    const saved = JSON.parse(fs.readFileSync(join(result.stageDirectory, 'result.json'), 'utf8'));
    assert.equal(saved.failure, 'log-write-error'); assert.equal(saved.terminalAcknowledged, true);
    assert.equal(saved.automaticRetries, 0); assert.equal(saved.fullProductVerified, false);
    assert.ok(Object.values(saved.runnerOperations).every(n => n === 0));
    const progress = fs.readdirSync(result.stageDirectory).filter(n => /^progress-\d+\.json$/.test(n))
      .map(n => JSON.parse(fs.readFileSync(join(result.stageDirectory, n), 'utf8')));
    assert.ok(progress.some(record => record.phase === 'stopping'));
    cases.push({ double: 'explicit writeSync filesystem boundary double', name, writes, calls,
      failure: saved.failure, retainedBytes: saved.retainedBytes,
      terminalAcknowledged: saved.terminalAcknowledged, logPath: saved.logPath,
      resultPath: join(result.stageDirectory, 'result.json') });
  }
  fs.writeFileSync(join(directory, 'fs-boundary-double-cases.json'),
    JSON.stringify({ kind: 'explicit-filesystem-boundary-double', cases }, null, 2) + '\n', { flag: 'wx' });
  console.log('filesystem boundary double: ' + cases.length + ' invalid counts rejected with owned cleanup');
}

test('filesystem boundary double: invalid log write counts fail within an external bound', { timeout: 20000 }, async () => {
  const doubleDirectory = await mkdtemp(join(directory, 'fs-boundary-double-'));
  const moduleUrl = new URL('../../scripts/desktop-pipeline.mjs', import.meta.url).href;
  const script = '(' + filesystemBoundaryDoubleFixture.toString() + ')(' +
    JSON.stringify(moduleUrl) + ',' + JSON.stringify(doubleDirectory) +
    ').catch(error=>{console.error(error);process.exitCode=1})';
  const result = await runDesktopStage({ directory, label: 'compile',
    deadlineMs: 12000, cleanupMs: 2000, startOwned: () => launch(script) });
  assert.equal(result.passed, true); assert.equal(result.terminalAcknowledged, true);
  assert.match((await evidence(result)).log, /filesystem boundary double: 8 invalid counts rejected with owned cleanup/);
  const proof = JSON.parse(await readFile(join(doubleDirectory, 'fs-boundary-double-cases.json'), 'utf8'));
  assert.equal(proof.kind, 'explicit-filesystem-boundary-double'); assert.equal(proof.cases.length, 8);
  assert.ok(proof.cases.every(item => item.writes === 2 && item.calls === 1 &&
    item.failure === 'log-write-error' && item.terminalAcknowledged));
});


async function metadataBoundaryDoubleFixture(moduleUrl, directory) {
  // Explicit filesystem boundary double in a separately bounded owned helper.
  // The invalid first progress record must never start the stage child.
  const { default: fs } = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const { default: assert } = await import('node:assert/strict');
  const { join } = await import('node:path');
  const { runDesktopStage } = await import(moduleUrl);
  const originalOpen = fs.openSync, originalWrite = fs.writeSync, originalClose = fs.closeSync;
  const variants = [ ['zero',()=>0], ['negative',()=>-1], ['nan',()=>NaN],
    ['infinity',()=>Infinity], ['oversized',remaining=>remaining+1], ['fractional',()=>0.5],
    ['undefined',()=>undefined], ['string',()=>'1'] ];
  const cases = [];
  for (const [name, invalidCount] of variants) {
    let fd, progressPath, writes=0, closes=0, calls=0, caught;
    fs.openSync = (...args) => {
      const result=originalOpen(...args);
      if (String(args[0]).endsWith('progress-1.json')) { fd=result; progressPath=String(args[0]); }
      return result;
    };
    fs.writeSync = (...args) => {
      if (args[0]===fd) {
        writes++;
        if(writes===1) return originalWrite(args[0],args[1],args[2],4);
        return invalidCount(args[3]);
      }
      return originalWrite(...args);
    };
    fs.closeSync = value => { if(value===fd)closes++; return originalClose(value); };
    syncBuiltinESMExports();
    try {
      await runDesktopStage({ directory, label:'compile', deadlineMs:3000,
        startOwned:()=>{calls++;throw new Error('Stage child must not start.');} });
    } catch(error) { caught=error; }
    finally { fs.openSync=originalOpen;fs.writeSync=originalWrite;fs.closeSync=originalClose;syncBuiltinESMExports(); }
    assert.match(caught?.message??'',/Progress metadata write did not advance within its bound/,name);
    assert.equal(calls,0,name+': no stage child or retry');assert.equal(writes,2,name+': bounded partial write');
    assert.equal(closes,1,name+': metadata descriptor closed');
    assert.equal(fs.readFileSync(progressPath).length,4,name+': original partial evidence retained');
    cases.push({name,writes,closes,calls,progressPath,double:'explicit metadata writeSync boundary double'});
  }
  fs.writeFileSync(join(directory,'metadata-boundary-cases.json'),JSON.stringify({kind:'explicit-filesystem-boundary-double',cases},null,2)+'\n',{flag:'wx'});
  console.log('metadata boundary double: '+cases.length+' invalid counts rejected before stage spawn');
}

test('filesystem boundary double: invalid metadata writes never spin or start a stage child', {timeout:20000}, async()=>{
  const doubleDirectory=await mkdtemp(join(directory,'metadata-boundary-double-'));
  const moduleUrl=new URL('../../scripts/desktop-pipeline.mjs',import.meta.url).href;
  const script='('+metadataBoundaryDoubleFixture.toString()+')('+JSON.stringify(moduleUrl)+','+JSON.stringify(doubleDirectory)+').catch(error=>{console.error(error);process.exitCode=1})';
  const result=await runDesktopStage({directory,label:'compile',deadlineMs:12000,cleanupMs:2000,startOwned:()=>launch(script)});
  assert.equal(result.passed,true);assert.equal(result.terminalAcknowledged,true);
  assert.match((await evidence(result)).log,/metadata boundary double: 8 invalid counts rejected before stage spawn/);
  const proof=JSON.parse(await readFile(join(doubleDirectory,'metadata-boundary-cases.json'),'utf8'));
  assert.equal(proof.cases.length,8);assert.ok(proof.cases.every(item=>item.calls===0&&item.writes===2&&item.closes===1));
});
