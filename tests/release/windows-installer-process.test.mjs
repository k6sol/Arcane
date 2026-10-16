import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Compiles the ACTUAL installer/InstallProcess.cs (with the actual KitVerifier.cs for KitReceipt) using the in-box
// .NET Framework csc.exe into a SEPARATE owned console harness. The harness builds a labelled SYNTHETIC KitReceipt
// that points at this test's own Node (process.execPath) and an owned peer script named windows-install-cli.mjs.
// The peer either runs the actual released CLI with a SCRIPTED engine (protocol agreement) or writes scripted frames.
// No bundle extraction, installation, user Programs, registry, shortcuts, providers or Studio. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const repository = new URL('../../', import.meta.url);
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const ADMITTED = ['SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'windir'];
const UUID = '0123abcd-0000-4000-8000-00000000abcd', RELEASE = 'a'.repeat(64) + '-' + UUID;

const harnessSource = String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Web.Script.Serialization;
using Arcane.Installer;
internal static class Harness
{
    private static int Main(string[] args)
    {
        JavaScriptSerializer json = new JavaScriptSerializer();
        string mode = args[0];
        if (mode == "quote")
        {
            List<string> quoted = new List<string>();
            for (int i = 1; i < args.Length; i++) quoted.Add(InstallProcess.Quote(args[i]));
            Console.Out.Write(json.Serialize(quoted)); return 0;
        }
        // Labelled SYNTHETIC receipt for an owned Node peer; production supplies only KitVerifier's receipt.
        KitReceipt kit = new KitReceipt();
        kit.NodeExecutable = args[1]; kit.EntryPoint = args[2]; kit.BundleDirectory = args[3];
        kit.BundleManifestSha256 = new string('0', 64); kit.KitManifestSha256 = new string('0', 64);
        CancellationTokenSource source = new CancellationTokenSource();
        if (mode == "cancel-before") source.Cancel();
        List<object> progress = new List<object>(); object sync = new object();
        Action<InstallProgress> onProgress = delegate (InstallProgress p)
        {
            lock (sync) progress.Add(new Dictionary<string, object> { { "phase", p.Phase }, { "filesCopied", p.FilesCopied }, { "totalFiles", p.TotalFiles }, { "bytesCopied", p.BytesCopied }, { "totalBytes", p.TotalBytes } });
            if (mode == "cancel-on-copying" && p.Phase == "copying") source.Cancel();
            if (mode == "cancel-on-installed" && p.Phase == "installed") source.Cancel();
            if (mode == "throw-callback") throw new InvalidOperationException("fixture callback failure");
            if (mode == "slow-callback") Thread.Sleep(400);
        };
        Stopwatch watch = Stopwatch.StartNew();
        InstallOutcome o = InstallProcess.Run(kit, args[4], onProgress, source.Token).Result;
        Dictionary<string, object> report = new Dictionary<string, object>();
        report["state"] = o.State.ToString(); report["published"] = o.Published; report["code"] = o.Code;
        report["installationId"] = o.InstallationId; report["activeReleaseId"] = o.ActiveReleaseId; report["started"] = o.Started;
        report["cancelRequested"] = o.CancelRequested; report["lockRetained"] = o.LockRetained; report["stagingRetained"] = o.StagingRetained;
        report["exitCode"] = o.ExitCode; report["stderrBytes"] = o.StderrBytes; report["elapsedMs"] = watch.ElapsedMilliseconds;
        lock (sync) report["progress"] = progress.ToArray();
        Console.Out.Write(json.Serialize(report)); Console.Out.Flush();
        return 0;
    }
}
`;

const peerSource = `// Owned harmless peer for the install process controller test; never an installer.
import fs from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), bundle = args[args.indexOf('--bundle') + 1];
const scenario = JSON.parse(fs.readFileSync(join(bundle, 'scenario.json'), 'utf8'));
fs.writeFileSync(join(bundle, 'observed.json'), JSON.stringify({ entry: process.argv[1], args, cwd: process.cwd(), env: Object.keys(process.env).sort() }));
const write = (stream, text) => new Promise(resolve => stream.write(text, resolve));
if (scenario.realCli) {
  const { runWindowsInstallCli } = await import(scenario.realCli);
  const { WindowsInstallationError } = await import(scenario.engineModule);
  const plan = scenario.engine, stdinBytes = [];
  process.stdin.on('data', chunk => stdinBytes.push(...chunk));
  // SCRIPTED engine port: no filesystem work; it only drives the actual CLI protocol.
  process.exitCode = await runWindowsInstallCli({ bundle, installRoot: args[3], input: process.stdin, output: process.stdout, installation: { async install({ signal, onProgress }) {
    for (const [phase, files, total] of plan.progress) { onProgress({ phase, filesCopied: files, totalFiles: total, bytesCopied: files, totalBytes: total }); await new Promise(resolve => setTimeout(resolve, 5)); }
    if (plan.waitAbort) await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    if (plan.result) return plan.result;
    throw new WindowsInstallationError(plan.error.code, { published: plan.error.published });
  } } });
  fs.writeFileSync(join(bundle, 'stdin.json'), JSON.stringify(Buffer.from(stdinBytes).toString('utf8')));
  process.stdin.destroy();
} else {
  for (const line of scenario.lines) await write(process.stdout, line);
  if (scenario.stderr) await write(process.stderr, scenario.stderr);
  if (scenario.grandchild) {
    // Owned bounded-lifetime grandchild: holds the inherited stdout pipe, writes its marker, then exits by itself.
    // detached: libuv otherwise places it in the peer's kill-on-close job, ending it (and the pipe) with the peer.
    spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(process.argv[1], "done"), 7000)', scenario.grandchild],
      { stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true, detached: true }).unref();
  }
  process.exitCode = scenario.exit;
}
`;

const progress = (phase, files, total) => JSON.stringify({ schemaVersion: 1, type: 'progress', phase, filesCopied: files, totalFiles: total, bytesCopied: files, totalBytes: total }) + '\n';
const result = fields => JSON.stringify({ schemaVersion: 1, type: 'result', state: 'failed', published: false, code: 'MANIFEST', installationId: null, activeReleaseId: null,
  abort: null, lockRetained: false, stagingRetained: false, ...fields }) + '\n';
const installed = result({ state: 'installed', published: true, code: null, installationId: UUID, activeReleaseId: RELEASE });

let shared;
function setup(t) {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-installer-process-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-installer-process-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  for (const name of ['KitVerifier.cs', 'InstallProcess.cs']) fs.copyFileSync(new URL('installer/' + name, repository), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), harnessSource);
  const harness = join(build, 'Harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', '/out:' + harness,
    join(build, 'KitVerifier.cs'), join(build, 'InstallProcess.cs'), join(build, 'Harness.cs')], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  const scripts = join(root, 'kit', 'scripts'); fs.mkdirSync(scripts, { recursive: true });
  const entry = join(scripts, 'windows-install-cli.mjs'); fs.writeFileSync(entry, peerSource);
  let cases = 0;
  const run = (mode, scenario, { env = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }, installRoot, node = process.execPath, entryPoint = entry } = {}) => {
    const bundle = join(root, 'case-' + ++cases, 'bundle'); fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(join(bundle, 'scenario.json'), JSON.stringify(scenario ?? { lines: [], exit: 1 }));
    const target = installRoot ?? join(root, 'Install Root (' + cases + ')');
    const ran = spawnSync(harness, [mode, node, entryPoint, bundle, target], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
    assert.equal(ran.status, 0, 'harness failed: ' + ran.stdout + ran.stderr); assert.equal(ran.stderr, '');
    const read = name => { try { return JSON.parse(fs.readFileSync(join(bundle, name), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    assert.equal(fs.existsSync(target), false, 'the controller never creates the install root itself');
    return { outcome: JSON.parse(ran.stdout), observed: read('observed.json'), stdin: read('stdin.json'), bundle, target };
  };
  const real = engine => ({ realCli: pathToFileURL(fileURLPath('scripts/windows-install-cli.mjs')).href, engineModule: pathToFileURL(fileURLPath('scripts/windows-installation.mjs')).href, engine });
  shared = { root, harness, entry, scripts, run, real };
  return shared;
}
const fileURLPath = path => decodeURIComponent(new URL(path, repository).pathname).replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\');

test('fixed argv, working directory and a cleared environment reach only the bundled Node peer', windows, t => {
  const s = setup(t);
  const env = { SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH,
    NODE_OPTIONS: '--require=C:\\arcane-fixture-missing.js', NODE_PATH: 'C:\\arcane-fixture', OPENAI_API_KEY: 'fixture-not-a-key', ANTHROPIC_API_KEY: 'fixture-not-a-key',
    ARCANE_DAEMON_URL: 'http://127.0.0.1:1', ELECTRON_RUN_AS_NODE: '1' };
  const { outcome, observed, bundle, target } = s.run('plain', { lines: [progress('verifying-source', 0, 0), installed], exit: 0 }, { env });
  assert.equal(outcome.state, 'Installed'); assert.equal(outcome.code, null);
  assert.equal(observed.entry, s.entry); assert.deepEqual(observed.args, ['--bundle', bundle, '--install-root', target]);
  assert.match(target, / \(\d+\)$/, 'spaces and parentheses survive quoting');
  assert.equal(observed.cwd.toLowerCase(), s.scripts.toLowerCase());
  assert.deepEqual(observed.env.filter(name => !ADMITTED.some(admitted => admitted.toLowerCase() === name.toLowerCase())), [], 'only admitted system/temp variables');
  const quoted = JSON.parse(spawnSync(s.harness, ['quote', 'C:\\a b\\c', 'C:\\a b\\', 'C:\\x\\\\'], { windowsHide: true, encoding: 'utf8' }).stdout);
  assert.deepEqual(quoted, ['"C:\\a b\\c"', '"C:\\a b\\\\"', '"C:\\x\\\\\\\\"']);
});

test('actual CLI frames agree with the controller: installed, already-active and failed outcomes keep published exactly', windows, t => {
  const s = setup(t);
  const success = { state: 'installed', installationId: UUID, activeReleaseId: RELEASE };
  let r = s.run('plain', s.real({ progress: [['verifying-source', 0, 0], ['copying', 0, 3], ['copying', 3, 3], ['verifying-copy', 3, 3], ['publishing', 3, 3], ['installed', 3, 3]], result: success }));
  assert.deepEqual([r.outcome.state, r.outcome.published, r.outcome.code, r.outcome.exitCode, r.outcome.started], ['Installed', true, null, 0, true]);
  assert.equal(r.outcome.installationId, UUID); assert.equal(r.outcome.activeReleaseId, RELEASE);
  assert.deepEqual(r.outcome.progress.map(p => p.phase).filter((phase, i, all) => phase !== all[i - 1]), ['verifying-source', 'copying', 'verifying-copy', 'publishing', 'installed']);
  assert.equal(r.outcome.progress.filter(p => p.phase === 'copying').at(-1).filesCopied, 3);
  r = s.run('plain', s.real({ progress: [['verifying-source', 0, 0], ['already-active', 0, 0]], result: { ...success, state: 'already-active' } }));
  assert.deepEqual([r.outcome.state, r.outcome.published, r.outcome.exitCode], ['AlreadyActive', false, 0]);
  r = s.run('plain', s.real({ progress: [['verifying-source', 0, 0]], error: { code: 'PUBLISH_UNCONFIRMED', published: null } }));
  assert.deepEqual([r.outcome.state, r.outcome.published, r.outcome.code, r.outcome.installationId], ['Failed', null, 'PUBLISH_UNCONFIRMED', null]);
  r = s.run('plain', s.real({ progress: [], error: { code: 'MANIFEST', published: false } }));
  assert.deepEqual([r.outcome.state, r.outcome.published, r.outcome.code, r.outcome.exitCode], ['Failed', false, 'MANIFEST', 1]);
});

test('Windows drive-letter casing preserves admitted owned process paths', windows, t => {
  const s = setup(t), lowerDrive = path => path[0].toLowerCase() + path.slice(1);
  const { outcome } = s.run('plain', { lines: [installed], exit: 0 }, {
    node: lowerDrive(process.execPath), entryPoint: lowerDrive(s.entry), installRoot: lowerDrive(join(s.root, 'Drive Case (1)')),
  });
  assert.equal(outcome.state, 'Installed'); assert.equal(outcome.code, null);
});

test('cancellation sends exactly one cancel frame and waits for the actual exit; late cancel never becomes rollback', windows, t => {
  const s = setup(t);
  let r = s.run('cancel-on-copying', s.real({ progress: [['verifying-source', 0, 0], ['copying', 0, 9]], waitAbort: true, error: { code: 'CANCELLED', published: false } }));
  assert.deepEqual([r.outcome.state, r.outcome.published, r.outcome.code, r.outcome.exitCode, r.outcome.cancelRequested], ['Cancelled', false, 'CANCELLED', 2, true]);
  assert.equal(r.stdin, '{"type":"cancel"}\n', 'one small cancel frame on the owned stdin');
  r = s.run('cancel-on-installed', s.real({ progress: [['verifying-source', 0, 0], ['publishing', 1, 1], ['installed', 1, 1]], waitAbort: true,
    result: { state: 'installed', installationId: UUID, activeReleaseId: RELEASE } }));
  assert.deepEqual([r.outcome.state, r.outcome.published, r.outcome.cancelRequested, r.outcome.exitCode], ['Installed', true, true, 0]);
  assert.equal(r.stdin, '{"type":"cancel"}\n');
  r = s.run('cancel-before', { lines: [installed], exit: 0 });
  assert.deepEqual([r.outcome.state, r.outcome.published, r.outcome.started, r.outcome.exitCode], ['Cancelled', false, false, null]);
  assert.equal(r.observed, null, 'no process started');
});

test('stderr, malformed, oversize, duplicate, missing or mismatched results are unconfirmed, never previous-retained', windows, t => {
  const s = setup(t);
  const cases = [
    ['STDERR', { lines: [result({})], stderr: 'diagnostic C:\\secret', exit: 1 }],
    ['FRAME', { lines: ['not json\n', installed], exit: 0 }],
    ['FRAME', { lines: ['{"schemaVersion":1,"type":"progress","phase":"copying"' + ' '.repeat(1000) + '}\n', installed], exit: 0 }],
    ['FRAME', { lines: [installed.replace('"type":"result",', '"type": "result",')], exit: 0 }],
    ['FRAME', { lines: [installed.replace('\n', '\r\n')], exit: 0 }],
    ['FRAME', { lines: [progress('secret-phase', 0, 0), installed], exit: 0 }],
    ['FRAME', { lines: [progress('copying', 5, 3), installed], exit: 0 }],
    ['FRAME', { lines: [progress('copying', 0, 3).replace('}', ',"token":"x"}'), installed], exit: 0 }],
    ['FRAME', { lines: [installed, progress('copying', 0, 3)], exit: 0 }],
    ['FRAME', { lines: [installed.slice(0, -1)], exit: 0 }],
    ['FRAME', { lines: [result({ state: 'cancelled', code: 'CANCELLED', abort: 'cancel' })], exit: 2 }],
    ['FRAME', { lines: [result({ state: 'installed', published: true, code: 'MANIFEST', installationId: UUID, activeReleaseId: RELEASE })], exit: 0 }],
    ['FRAME', { lines: [result({ code: 'secret text' })], exit: 1 }],
    ['FRAME', { lines: [result({ code: 'NOT_A_CLI_CODE' })], exit: 1 }],
    ['RESULT_DUPLICATE', { lines: [installed, installed], exit: 0 }],
    ['RESULT_MISSING', { lines: [progress('verifying-source', 0, 0)], exit: 1 }],
    ['EXIT_MISMATCH', { lines: [installed], exit: 1 }],
    ['EXIT_MISMATCH', { lines: [result({})], exit: 0 }],
  ];
  for (const [code, scenario] of cases) {
    const { outcome } = s.run('plain', scenario);
    assert.equal(outcome.state, 'Unconfirmed', code + ' ' + JSON.stringify(scenario.lines));
    assert.equal(outcome.code, code); assert.equal(outcome.published, null); assert.equal(outcome.started, true);
    assert.equal(outcome.installationId, null); assert.equal(outcome.activeReleaseId, null);
    assert.doesNotMatch(JSON.stringify(outcome), /secret|token|diagnostic/);
  }
  const { outcome } = s.run('plain', { lines: [result({})], stderr: 'x'.repeat(200000), exit: 1 });
  assert.equal(outcome.code, 'STDERR'); assert.equal(outcome.stderrBytes, 65536, 'stderr is counted (capped), never retained');
});

test('callback failures and slow callbacks cannot block the pipe or ownership cleanup', windows, t => {
  const s = setup(t), many = Array.from({ length: 200 }, (_, i) => ['copying', i, 199]);
  let r = s.run('throw-callback', s.real({ progress: [['verifying-source', 0, 0], ...many], result: { state: 'installed', installationId: UUID, activeReleaseId: RELEASE } }));
  assert.deepEqual([r.outcome.state, r.outcome.exitCode], ['Installed', 0]); assert.equal(r.outcome.progress.length, 1, 'delivery stops after the first callback failure');
  r = s.run('slow-callback', { lines: [progress('verifying-source', 0, 0), ...many.map(([phase, files, total]) => progress(phase, files, total)), progress('verifying-copy', 199, 199), installed], exit: 0 });
  assert.equal(r.outcome.state, 'Installed');
  assert.ok(r.outcome.progress.length <= 4, 'slow delivery is coalesced, not queued per frame: ' + r.outcome.progress.length);
  assert.ok(r.outcome.elapsedMs < 4000);
});

test('post-exit pipe drain is bounded when an owned descendant keeps stdout open', windows, t => {
  const s = setup(t), marker = join(s.root, 'grandchild-done');
  const { outcome } = s.run('plain', { lines: [installed], exit: 0, grandchild: marker });
  assert.deepEqual([outcome.state, outcome.code, outcome.published, outcome.exitCode], ['Unconfirmed', 'DRAIN', null, 0]);
  assert.ok(outcome.elapsedMs >= 4500 && outcome.elapsedMs < 6900, 'bounded drain: ' + outcome.elapsedMs);
  // Terminal proof for the owned grandchild: it writes its marker immediately before exiting by itself.
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(marker)) { assert.ok(Date.now() < deadline, 'owned grandchild did not finish'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  assert.equal(fs.readFileSync(marker, 'utf8'), 'done');
});

test('start failures and refused inputs return explicit unconfirmed outcomes without a process', windows, t => {
  const s = setup(t);
  let r = s.run('plain', null, { node: join(s.root, 'missing', 'node.exe') });
  assert.deepEqual([r.outcome.state, r.outcome.code, r.outcome.started, r.outcome.published], ['Unconfirmed', 'START', false, null]);
  for (const options of [{ installRoot: 'relative\\Arcane' }, { installRoot: join(s.root, 'quote"d') }, { installRoot: join(s.root, 'trailing') + '\\' },
    { installRoot: s.root + '\\forward/slash' }, { entryPoint: join(s.scripts, 'other.mjs') }, { node: join(s.root, 'node.cmd') }]) {
    r = s.run('plain', { lines: [installed], exit: 0 }, options);
    assert.deepEqual([r.outcome.state, r.outcome.code, r.outcome.started], ['Unconfirmed', 'INPUT', false], JSON.stringify(options));
    assert.equal(r.observed, null);
  }
});
