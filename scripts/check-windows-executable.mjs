import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import policy from '../apps/desktop/electron/policy.cjs';
const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
/** Trusted host only. No shell, retries, detached children or public command strings. */
export async function runBoundedChild(command, args, options = {}) {
  const { deadlineMs = 60000, maxOutputBytes = 65536, env = process.env, cwd, ipc = false, onMessage } = options;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 180000 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 262144) throw new Error('Invalid child-process bounds.');
  return new Promise((resolve, reject) => {
    let bytes = 0, output = '', failure = null, done = false, child, timer, terminalTimer, drainTimer, exited = null;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(terminalTimer); clearTimeout(drainTimer);
      if (error) reject(error); else resolve(result);
    };
    const stop = reason => {
      if (failure || done) return; failure = reason;
      if (exited) { terminal(exited.code, exited.signal); return; }
      terminalTimer = setTimeout(() => finish(new Error(reason + ' Terminal acknowledgement missing; do not restart without inspection.')), 10000);
      try { child.kill(); } catch { /* Keep waiting for this owned process's terminal acknowledgement. */ }
    };
    try { child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      stdio: ipc ? ['ignore','pipe','pipe','ipc'] : ['ignore','pipe','pipe'] }); }
    catch { finish(new Error('Owned process could not be created.')); return; }
    timer = setTimeout(() => stop('Owned process deadline exceeded.'), deadlineMs);
    const collect = chunk => { bytes += chunk.length; if (bytes > maxOutputBytes) stop('Owned process diagnostics exceeded their bound.'); else output += chunk.toString('utf8'); };
    // Windows can report a pipe connection failure on the stream instead of the
    // child. Observe both pipes and retain the actual terminal outcome.
    child.stdout.on('error', () => stop('Owned process output pipe failed.'));
    child.stderr.on('error', () => stop('Owned process output pipe failed.'));
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    if (onMessage) child.on('message', message => { try { onMessage(message, child); } catch { stop('Invalid private child message.'); } });
    child.once('error', () => finish(new Error('Owned process could not be launched. No security settings were changed.')));
    const terminal = (code, signal) => {
      const result = { code, signal, pid: child.pid, output, outputBytes: bytes };
      if (failure) finish(Object.assign(new Error(failure + ' Process exit acknowledged.'), { outcome: { code, signal, pid: child.pid, outputBytes: bytes } }));
      else finish(null, result);
    };
    child.once('close', terminal);
    // Windows IPC may leave inherited stream handles open after a proven process exit.
    // Bound the drain, then close only our read handles; exit status is authoritative.
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      clearTimeout(timer);
      drainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); if (child.connected) child.disconnect(); terminal(code,signal); }, 250);
    });
  });
}
/** Product build is required for actual EXE verification; importing the bounded
 * subprocess helper alone does not load compiled product modules. Reuse the same
 * checked metadata writer so cloud sharing locks cannot mask the original phase. */
export async function writeVerificationProgress(directory, record) {
  const { atomicAssetJson } = await import('../dist/packages/asset-pipeline/src/atomic-json.js');
  await atomicAssetJson(directory, 'progress.json', JSON.stringify(record, null, 2) + '\n');
}
export async function checkWindowsExecutable(directory) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !isAbsolute(directory)) throw new Error('Use a Windows x64 host and an absolute Arcane bundle directory.');
  directory = await policy.directPath(directory);
  const root = join(repository, 'runtime', 'verification');
  await policy.directPath(root, 'directory', true); await mkdir(root, { recursive: true });
  const reportDirectory = await mkdtemp(join(root, 'windows-executable-')); await policy.directPath(reportDirectory);
  const smokeDirectory = join(reportDirectory, 'app'); await mkdir(smokeDirectory);
  const started = Date.now(); let phase = 'created';
  async function progress(status, extra = {}) {
    const record = { schemaVersion: 1, kind: 'arcane-executable-verifier-progress', phase, status,
      elapsedMs: Date.now() - started, ...extra, inferenceStarted: false, studioOperations: 0 };
    await writeVerificationProgress(reportDirectory, record);
    console.log(JSON.stringify({ phase, status, reportDirectory }));
  }
  async function integrity(stage) {
    phase = stage; await progress('running');
    // Complete existing hash/provenance/path/credential guards, in a bounded owned process.
    const result = await runBoundedChild(process.execPath, [join(repository,'scripts','package-windows.mjs'), '--verify', directory], {
      deadlineMs: 90000, maxOutputBytes: 32768, env: policy.daemonEnvironment(process.env,
        { productRoot: join(directory,'resources','product'), stateRoot: join(reportDirectory,'runtime','product'), projectPath: reportDirectory }),
    });
    if (result.code !== 0) throw new Error('Bundle integrity verifier rejected this directory.');
    const proof = JSON.parse(result.output);
    if (proof.integrityOnly !== true || proof.applicationLaunchVerified !== false ||
        !/^[a-f0-9]{64}$/.test(proof.manifestSha256) || !Number.isSafeInteger(proof.files) || proof.files < 1 ||
        !Number.isSafeInteger(proof.bytes) || proof.bytes < 1) throw new Error('Invalid bundle integrity proof.');
    return proof;
  }
  try {
    const before = await integrity('verify-before');
    phase = 'runtime-imports'; await progress('running');
    const imported = await runBoundedChild(join(directory,'resources','node','node.exe'), ['--input-type=module','-e',
      "await import('@modelcontextprotocol/sdk/server/mcp.js'); await import('@modelcontextprotocol/sdk/client/index.js'); await import('zod'); console.log('ARCANE_RUNTIME_IMPORT_OK');"], {
      cwd: join(directory,'resources','product'), deadlineMs: 15000,
      env: policy.daemonEnvironment(process.env,{productRoot:join(directory,'resources','product'),stateRoot:join(reportDirectory,'runtime','product'),projectPath:reportDirectory}),
    });
    if(imported.code !== 0 || imported.output.trim() !== 'ARCANE_RUNTIME_IMPORT_OK') throw new Error('Bundled production dependency imports failed.');
    phase = 'mcp-runtime'; await progress('running');
    const productRoot = await policy.directPath(join(directory, 'resources', 'product'));
    const toolModule = await policy.directPath(join(productRoot, 'dist/packages/protocol/src/arcane-tools.js'), 'file');
    const { ARCANE_TOOL_NAMES } = await import(pathToFileURL(toolModule).href);
    const { checkMcpRuntime } = await import('./check-mcp-runtime.mjs');
    const mcp = await checkMcpRuntime({
      nodeExecutable: await policy.directPath(join(directory, 'resources', 'node', 'node.exe'), 'file'),
      productRoot, workingDirectory: reportDirectory,
      env: policy.daemonEnvironment(process.env, { productRoot, stateRoot: join(reportDirectory, 'mcp-state'), projectPath: reportDirectory }),
      expectedTools: ARCANE_TOOL_NAMES,
    });
    await writeFile(join(reportDirectory, 'mcp-runtime.json'), JSON.stringify(mcp, null, 2) + '\n', { flag: 'wx' });
    const executable = await policy.directPath(join(directory, 'Arcane.exe'), 'file');
    const env = policy.daemonEnvironment(process.env, { productRoot: join(directory,'resources','product'),
      stateRoot: join(smokeDirectory,'profile','runtime','product'), projectPath: smokeDirectory });
    phase = 'launch'; await progress('running');
    const result = await runBoundedChild(executable, ['--arcane-smoke', smokeDirectory], { deadlineMs: 60000, env });
    await writeFile(join(reportDirectory,'process-outcome.json'), JSON.stringify({code:result.code,signal:result.signal,pid:result.pid,diagnosticBytes:result.outputBytes,diagnosticSha256:digest(result.output)})+'\n',{flag:'wx'});
    await progress('process-exited', { code: result.code, signal: result.signal, pid: result.pid,
      diagnosticBytes: result.outputBytes, diagnosticSha256: digest(result.output) });
    if (result.code !== 0) throw new Error('Executable smoke did not exit successfully; retained reports must be inspected.');
    phase = 'report'; await progress('running');
    const reportFile = await policy.directPath(join(smokeDirectory,'checks.json'),'file');
    const raw = await readFile(reportFile); if (raw.length > 32768) throw new Error('Oversized executable report.');
    const report = JSON.parse(raw.toString('utf8'));
    if (report.schemaVersion !== 1 || report.kind !== 'arcane-windows-executable-smoke' || report.inferenceStarted !== false ||
        report.studioOperations !== 0 || !report.checks || Object.keys(report.checks).length < 15 ||
        Object.values(report.checks).some(value => value !== true)) throw new Error('Incomplete executable verification.');
    phase = 'parent-loss'; await progress('running');
    const lossRoot = join(reportDirectory,'parent-loss'); await mkdir(lossRoot);
    const lossProject = join(lossRoot,'project'); await mkdir(lossProject);
    const lossEnv = policy.daemonEnvironment(process.env, { productRoot: join(directory,'resources','product'),
      stateRoot: join(lossRoot,'runtime','product'), projectPath: lossProject });
    let ready = false;
    const loss = await runBoundedChild(join(directory,'resources','node','node.exe'),
      [join(directory,'resources','product','dist','apps','daemon','src','product-main.js')], {
        cwd: lossRoot, env: lossEnv, deadlineMs: 20000, ipc: true,
        onMessage: (message, owned) => { policy.readyMessage(message); if (ready) throw new Error('Duplicate ready handoff.'); ready = true; owned.disconnect(); },
      });
    if (!ready || loss.code !== 0) throw new Error('Bundled runtime failed graceful parent-loss shutdown.');
    const after = await integrity('verify-after');
    // Inventory hashing includes Arcane.exe: do not retain another 246 MiB buffer.
    if (after.manifestSha256 !== before.manifestSha256 || after.files !== before.files || after.bytes !== before.bytes)
      throw new Error('Bundle changed during verification.');
    const proof = { schemaVersion: 1, executable, directory, reportDirectory, screenshot: join(smokeDirectory,'workspace.png'),
      manifestSha256: after.manifestSha256, checks: { ...report.checks, runtimeImportsVerified: true, parentLossShutdownVerified: true,
        mcpProtocolVerified: true, bundledGuidanceVerified: true, mcpShutdownVerified: true },
      elapsed: report.elapsed, verifierElapsedMs: Date.now()-started, inferenceStarted: false, studioOperations: 0,
      signed: false, fullProductVerified: false };
    await writeFile(join(reportDirectory,'verification.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
    phase = 'complete'; await progress('passed'); return proof;
  } catch (error) {
    let progressSaved = true;
    try { await progress('failed', { error: error instanceof Error ? error.message.slice(0,512) : 'Verification failed.' }); }
    catch { progressSaved = false; } // Never replace the first failure with a second diagnostic-write error.
    throw new Error('Executable verification failed in '+phase+'. Inspect '+reportDirectory+
      (progressSaved ? '.' : '. Failure progress could not be saved; retained snapshots remain.')+
      ' No process replay or protection change was attempted.', { cause: error });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-windows-executable.mjs ABSOLUTE_BUNDLE_DIRECTORY');
  console.log(JSON.stringify(await checkWindowsExecutable(process.argv[2]),null,2));
}
