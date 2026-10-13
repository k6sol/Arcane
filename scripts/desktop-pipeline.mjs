import { spawn, ChildProcess } from 'node:child_process';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const minute = 60 * 1000;
// Sealed inventory: 922 tests at concurrency 1 took 1,169,910 ms (~19.5 min),
// with 10 browser cases skipped. A 15-minute unit deadline cannot reach terminal.
// Allow 45 minutes for that inventory plus the required browser cases. The
// offline release fixture gate took ~10.6 minutes; its budget remains 15 minutes.
// Compile/plugin are short stages. These are outer stage budgets only; security
// checker and individual fixture deadlines are unchanged.
export const DESKTOP_STAGE_BUDGETS = Object.freeze({
  compile: 5 * minute,
  'plugin-build': 2 * minute,
  'unit-browser': 45 * minute,
  'offline-release-plugin': 15 * minute,
});
const maximumOutput = 16 * 1024 * 1024;

function exclusiveJson(directory, name, record) {
  const fd = openSync(join(directory, name), 'wx', 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const remaining = bytes.length - offset, written = writeSync(fd, bytes, offset, remaining);
      if (!Number.isSafeInteger(written) || written < 1 || written > remaining) throw new Error('Progress metadata write did not advance within its bound.');
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Trusted host seam: one synchronous, zero-argument callback creates ONE fresh
 * ChildProcess. Never pass renderer input, a command string, or a retry callback.
 * Smaller bounds support offline fixtures; they cannot enlarge a stage budget.
 * Evidence uses exclusive files in a unique stage directory: no compiled product
 * import or mutable fixed progress file is needed before the compile stage. */
export async function runDesktopStage({
  directory, label, startOwned, signal,
  deadlineMs = DESKTOP_STAGE_BUDGETS[label],
  maxOutputBytes = maximumOutput, cleanupMs = 10000, drainMs = 250,
}) {
  if (!Object.hasOwn(DESKTOP_STAGE_BUDGETS, label) ||
      typeof startOwned !== 'function' || startOwned.length !== 0 ||
      startOwned.constructor.name === 'AsyncFunction' ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DESKTOP_STAGE_BUDGETS[label] ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > maximumOutput ||
      !Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 10000 ||
      !Number.isSafeInteger(drainMs) || drainMs < 1 || drainMs > 1000 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) throw new Error('Invalid owned stage configuration.');
  directory = resolve(directory);
  const stat = await lstat(directory), physical = await realpath(directory);
  const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(physical) !== canonical(directory)) throw new Error('Stage evidence directory must be a direct owned directory.');
  const stageDirectory = await mkdtemp(join(directory, label + '-'));
  const logPath = join(stageDirectory, 'stage.log');
  const logFd = openSync(logPath, 'wx', 0o600);
  const startedAt = new Date().toISOString(), started = Date.now();
  let sequence = 0, child, deadline, cleanup, drain, done = false;
  let failure = null, processStarted = false, terminalAcknowledged = false;
  let code = null, exitSignal = null, terminalEvent = null, pipeDrain = 'pending';
  let outputBytes = 0, retainedBytes = 0, killRequested = false, killAccepted = null;
  const base = { schemaVersion: 1, kind: 'arcane-desktop-stage', label, startedAt,
    deadlineMs, maxOutputBytes, cleanupMs, drainMs, stageDirectory, logPath,
    verification: 'owned-process-stage-only', fullProductVerified: false, automaticRetries: 0,
    // These count runner operations only, never infer native activity in a child.
    nativeCounterScope: 'runner-only; child native activity is not assessed',
    runnerOperations: { providerInferenceRuns: 0, studioOperations: 0, blenderRuns: 0, browserLaunches: 0 } };
  const state = (phase, extra = {}) => ({ ...base, phase, elapsedMs: Date.now() - started,
    processStarted, pid: child?.pid ?? null, code, signal: exitSignal, terminalEvent,
    terminalAcknowledged, pipeDrain, outputBytes, retainedBytes, killRequested, killAccepted, failure, ...extra });
  const progress = phase => exclusiveJson(stageDirectory, 'progress-' + (++sequence) + '.json', state(phase));
  try { progress('created'); }
  catch (error) { closeSync(logFd); throw error; }

  return new Promise((accept, reject) => {
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(deadline); clearTimeout(cleanup); clearTimeout(drain);
      signal?.removeEventListener('abort', cancelled);
      let evidenceError;
      try { fsyncSync(logFd); } catch (error) { evidenceError = error.code ?? 'LOG_SYNC'; }
      try { closeSync(logFd); } catch (error) { evidenceError ??= error.code ?? 'LOG_CLOSE'; }
      if (evidenceError) failure ??= 'evidence-error';
      const passed = terminalAcknowledged && processStarted && code === 0 && exitSignal === null && failure === null;
      const status = passed ? 'passed' : killRequested && !terminalAcknowledged ? 'cleanup-unconfirmed' : 'failed';
      const phase = terminalAcknowledged ? 'terminal' : child?.pid ? 'cleanup-unconfirmed' : 'not-started';
      const record = state(phase, { status, passed, logComplete: pipeDrain === 'closed', endedAt: new Date().toISOString(), evidenceError });
      try { exclusiveJson(stageDirectory, 'result.json', record); }
      catch (error) { record.passed = false; record.status = 'failed'; record.evidenceError = error.code ?? 'RESULT_WRITE'; }
      if (record.passed) accept(record);
      else reject(Object.assign(new Error(label + ' ' + record.status + ' (' + (failure ?? record.evidenceError) + '); retained evidence: ' + stageDirectory + (record.status === 'cleanup-unconfirmed' ? '; terminal acknowledgement missing; inspect before any manual restart.' : '')), { outcome: record }));
    };
    const snapshot = phase => {
      try { progress(phase); } catch { failure ??= 'evidence-error'; }
    };
    const stop = reason => {
      if (done || failure) return;
      failure = reason; clearTimeout(deadline);
      if (terminalAcknowledged) { snapshot('failed-after-exit'); return; }
      if (child?.pid) {
        killRequested = true;
        // Only this callback's child is targeted: no PID search, tree kill or restart.
        try { killAccepted = child.kill('SIGKILL'); } catch { killAccepted = false; }
      }
      snapshot('stopping');
      cleanup = setTimeout(() => {
        // Observation timeout is NOT a terminal acknowledgement. Retain an
        // explicit unconfirmed failure, close only our pipes, and stop the pipeline.
        child?.stdout?.destroy(); child?.stderr?.destroy();
        pipeDrain = 'closed-after-unconfirmed-cleanup';
        finish();
      }, cleanupMs);
    };
    const cancelled = () => { if (!terminalAcknowledged) stop('cancelled'); };
    const exited = (exitCode, signalCode, event) => {
      if (done) return;
      const first = !terminalAcknowledged;
      terminalAcknowledged = true; code = exitCode; exitSignal = signalCode; terminalEvent = event;
      clearTimeout(deadline); clearTimeout(cleanup);
      signal?.removeEventListener('abort', cancelled);
      if (code !== 0 || exitSignal !== null) failure ??= 'nonzero-exit';
      if (first) snapshot('exited');
      if (event === 'close') { pipeDrain = 'closed'; finish(); }
      else drain = setTimeout(() => {
        // Actual exit is proved; only inherited read handles can still be open.
        pipeDrain = 'bounded-after-exit';
        child.stdout?.destroy(); child.stderr?.destroy();
        snapshot('pipe-drained'); finish();
      }, drainMs);
    };
    const capture = chunk => {
      if (done) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      const keep = Math.min(bytes.length, maxOutputBytes - retainedBytes);
      try {
        let offset = 0;
        while (offset < keep) {
          const remaining = keep - offset;
          const written = writeSync(logFd, bytes, offset, remaining);
          if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) throw new Error('Invalid stage log write count.');
          offset += written; retainedBytes += written;
        }
      } catch { stop('log-write-error'); }
      if (outputBytes > maxOutputBytes) stop('output-overflow');
    };
    if (signal?.aborted) { failure = 'cancelled'; pipeDrain = 'not-created'; snapshot('cancelled-before-spawn'); finish(); return; }
    try {
      child = startOwned();
      if (!(child instanceof ChildProcess)) throw new Error('Host callback must return one fresh piped ChildProcess.');
    } catch { failure = 'spawn-error'; pipeDrain = 'not-created'; snapshot('spawn-error'); finish(); return; }
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    child.stdout?.on('error', () => stop('pipe-error')); child.stderr?.on('error', () => stop('pipe-error'));
    child.once('spawn', () => { if (!done) { processStarted = true; if (!failure) snapshot('running'); if (failure === 'evidence-error') { failure = null; stop('evidence-error'); } } });
    child.on('error', () => stop('spawn-error'));
    child.once('exit', (c, s) => exited(c, s, 'exit'));
    child.once('close', (c, s) => exited(c, s, 'close'));
    if (child.exitCode !== null || child.signalCode !== null) {
      failure = 'invalid-host-child'; pipeDrain = 'not-owned-live'; snapshot('invalid-host-child'); finish(); return;
    }
    if (!child.stdout || !child.stderr) { stop('invalid-host-child'); return; }
    deadline = setTimeout(() => stop('timeout'), deadlineMs);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}

export async function buildDesktopPipeline({ signal } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Desktop release automation needs Windows x64.');
  const root = join(repository, 'runtime', 'verification'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'desktop-pipeline-')), stages = [];
  let phase = 'preflight';
  try {
    const browserModule = join(repository, 'node_modules', 'playwright-core', 'index.mjs');
    const browserExecutable = process.env.ARCANE_UI_BROWSER_EXE ?? join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    for (const path of [browserModule, browserExecutable]) if (!(await lstat(path)).isFile()) throw new Error('Desktop release requires installed test-only Playwright and an explicit Chromium/Edge executable; checks cannot be silently skipped.');
    async function run(label, args) {
      phase = label; console.log('Arcane verification: ' + label);
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      env.ARCANE_UI_BROWSER_MODULE = browserModule; env.ARCANE_UI_BROWSER_EXE = browserExecutable;
      try {
        const result = await runDesktopStage({ directory, label, signal,
          startOwned: () => spawn(process.execPath, args, { cwd: repository, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) });
        stages.push(result);
        console.log(label + ': exit ' + result.code + '; ' + result.elapsedMs + 'ms; log ' + result.logPath);
      } catch (error) { if (error.outcome) stages.push(error.outcome); throw error; }
    }
    await run('compile', ['scripts/compile-product.mjs']);
    await run('plugin-build', ['scripts/build-plugin.mjs']);
    const unit = (await readdir(join(repository, 'dist/tests/unit'))).filter(x => /^[a-z0-9-]+\.test\.js$/.test(x)).sort().map(x => join('dist/tests/unit', x));
    if (unit.length < 10 || unit.length > 256) throw new Error('Unexpected unit verification inventory.');
    await run('unit-browser', ['--test', '--test-concurrency=1', ...unit]);
    const offline = [];
    for (const category of ['skills', 'release', 'plugin']) for (const file of (await readdir(join(repository, 'tests', category))).sort()) if (/^[a-z0-9-]+\.test\.mjs$/.test(file)) offline.push(join('tests', category, file));
    await run('offline-release-plugin', ['--test', '--test-concurrency=1', ...offline]);
    if (signal?.aborted) throw new Error('Desktop pipeline cancelled before packaging.');
    // These imports/calls are needed only by the real pipeline after its gates.
    phase = 'package'; const { packageWindows } = await import('./package-windows.mjs');
    const bundle = await packageWindows();
    phase = 'executable'; const { checkWindowsExecutable } = await import('./check-windows-executable.mjs');
    const executable = await checkWindowsExecutable(bundle.directory);
    const proof = { schemaVersion: 1, kind: 'arcane-desktop-pipeline', stages, bundle, executable,
      automaticRetries: 0, providerInference: false, studioOperations: 0, fullProductVerified: false };
    exclusiveJson(directory, 'pipeline.json', proof);
    return { ...proof, verificationDirectory: directory };
  } catch (error) {
    exclusiveJson(directory, 'pipeline-failed.json', { schemaVersion: 1, kind: 'arcane-desktop-pipeline',
      status: 'failed', phase, stages, automaticRetries: 0, fullProductVerified: false });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/desktop-pipeline.mjs');
  const cancellation = new AbortController(), cancel = () => cancellation.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { console.log(JSON.stringify(await buildDesktopPipeline({ signal: cancellation.signal }), null, 2)); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
