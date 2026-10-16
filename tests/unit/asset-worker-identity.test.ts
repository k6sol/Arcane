import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { WORKER_QUERY_SCRIPT, QUERY_MAX_OUTPUT_BYTES, QUERY_TIMEOUT_MS, QUERY_WATCHDOG_MS, canonicalTimestamp, attestRecordedWorker, captureWorkerIdentity,
  parseWorkerIdentity, workerQueryInvocation, type ProcessQueryHost, type WorkerIdentity } from '../../packages/asset-pipeline/src/worker-identity.js';

// Synthetic process boundary only: no PowerShell, CIM, Studio or real process query runs here.
const SYSTEM_ROOT = 'C:\\Windows';
const BLENDER = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
const CREATED = '2026-10-16T01:02:03.4567890Z';
const identity: WorkerIdentity = { schemaVersion: 1, role: 'generate', pid: 4242, processCreatedAt: CREATED, executable: BLENDER };
type Reply = { error?: Error & { code?: unknown; killed?: boolean; signal?: unknown }; stdout?: string; throws?: boolean };
function host(reply: Reply | ((pid: string) => Reply), overrides: Partial<ProcessQueryHost> = {}) {
  const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  const value: ProcessQueryHost = {
    platform: 'win32', systemRoot: SYSTEM_ROOT,
    execFile(file, args, options, callback) {
      calls.push({ file, args, options: options as unknown as Record<string, unknown> });
      const r = typeof reply === 'function' ? reply(options.env.ARCANE_WORKER_PID!) : reply;
      if (r.throws) throw new Error('spawn EPERM C:\\private\\path');
      queueMicrotask(() => callback(r.error ?? null, r.stdout ?? '', 'stderr C:\\private\\stderr'));
      return undefined;
    },
    ...overrides,
  };
  return { value, calls };
}
const present = (fields: Record<string, unknown> = {}) => ({ stdout: JSON.stringify({ v: 1, found: true, pid: 4242, created: CREATED, executable: BLENDER, ...fields }) });
const absent = { stdout: '{"v":1,"found":false}' };

test('fixed argv, env, cwd and bounds; only the validated PID reaches the query', async () => {
  const h = host(absent);
  await attestRecordedWorker(identity, h.value);
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call!.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(call!.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(call!.args.length, 5);
  assert.equal(Buffer.from(call!.args[4]!, 'base64').toString('utf16le'), WORKER_QUERY_SCRIPT);
  assert.deepEqual(call!.options, { cwd: 'C:\\Windows\\System32', env: { SystemRoot: SYSTEM_ROOT, ARCANE_WORKER_PID: '4242' },
    shell: false, windowsHide: true, timeout: QUERY_TIMEOUT_MS, maxBuffer: QUERY_MAX_OUTPUT_BYTES, encoding: 'utf8' });
  // The constant script performs one exact-PID lookup and nothing else.
  assert.match(WORKER_QUERY_SCRIPT, /Get-CimInstance -ClassName Win32_Process -Filter \('ProcessId = ' \+ \$id\)/);
  assert.doesNotMatch(WORKER_QUERY_SCRIPT, /CommandLine|Stop-Process|Terminate|Invoke-|taskkill|Get-Process|\$env:(?!x)/i);
});

test('invocation cannot be widened by caller values or an untrusted system root', () => {
  for (const pid of [0, -1, 1.5, 2 ** 32, Number.NaN, '4242' as never]) assert.throws(() => workerQueryInvocation(host(absent).value, pid), /Invalid worker PID/);
  for (const systemRoot of [undefined, '', 'Windows', '\\\\server\\share', 'C:\\Windows\\..\\Users', 'C:\\Win\u0000dows']) {
    assert.throws(() => workerQueryInvocation(host(absent, { systemRoot }).value, 4242), /Trusted system root unavailable/);
  }
  const invocation = workerQueryInvocation(host(absent).value, 4242);
  assert.ok(Object.isFrozen(invocation) && Object.isFrozen(invocation.args) && Object.isFrozen(invocation.options.env));
});

test('absent PID: the recorded worker is gone', async () => {
  assert.deepEqual(await attestRecordedWorker(identity, host(absent).value), { verdict: 'recorded-worker-gone', reason: 'pid-absent' });
});

test('reused PID with a different creation time: the recorded worker is gone', async () => {
  assert.deepEqual(await attestRecordedWorker(identity, host(present({ created: '2026-10-16T05:00:00.0000000Z', executable: 'C:\\Windows\\notepad.exe' })).value),
    { verdict: 'recorded-worker-gone', reason: 'pid-reused' });
});

test('matching PID, creation time and executable: the same worker is still running', async () => {
  assert.deepEqual(await attestRecordedWorker(identity, host(present({ executable: BLENDER.toUpperCase() })).value), { verdict: 'same-worker-running', reason: 'identity-matched' });
});

test('inaccessible or partial metadata is unknown, never gone', async () => {
  assert.deepEqual(await attestRecordedWorker(identity, host(present({ created: null })).value), { verdict: 'unknown', reason: 'metadata-inaccessible' });
  assert.deepEqual(await attestRecordedWorker(identity, host(present({ created: null, executable: null })).value), { verdict: 'unknown', reason: 'metadata-inaccessible' });
  assert.deepEqual(await attestRecordedWorker(identity, host(present({ executable: null })).value), { verdict: 'unknown', reason: 'metadata-inaccessible' });
  assert.deepEqual(await attestRecordedWorker(identity, host(present({ executable: 'C:\\Other\\blender.exe' })).value), { verdict: 'unknown', reason: 'identity-conflict' });
});

test('malformed, partial or oversized output is unknown', async () => {
  const cases: [string, string][] = [
    ['', 'output-malformed'], ['not json', 'output-malformed'], ['[]', 'output-malformed'], ['null', 'output-malformed'],
    ['{"v":2,"found":false}', 'output-malformed'], ['{"v":1,"found":false,"extra":1}', 'output-malformed'], ['{"v":1,"found":"false"}', 'output-malformed'],
    [JSON.stringify({ v: 1, found: true, pid: 4243, created: CREATED, executable: BLENDER }), 'output-malformed'],
    [JSON.stringify({ v: 1, found: true, pid: 4242, created: '2026-10-16 01:02:03', executable: BLENDER }), 'output-malformed'],
    [JSON.stringify({ v: 1, found: true, pid: 4242, created: CREATED, executable: 'relative\\blender.exe' }), 'output-malformed'],
    [JSON.stringify({ v: 1, found: true, pid: 4242, created: CREATED }), 'output-malformed'],
    ['x'.repeat(QUERY_MAX_OUTPUT_BYTES + 1), 'output-oversized'],
  ];
  for (const [stdout, reason] of cases) assert.deepEqual(await attestRecordedWorker(identity, host({ stdout }).value), { verdict: 'unknown', reason }, stdout.slice(0, 60));
  const maxBuffer = Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  assert.deepEqual(await attestRecordedWorker(identity, host({ error: maxBuffer }).value), { verdict: 'unknown', reason: 'output-oversized' });
  assert.deepEqual(await attestRecordedWorker(identity, host({ stdout: '\uFEFF{"v":1,"found":false}\r\n' }).value), { verdict: 'recorded-worker-gone', reason: 'pid-absent' });
});

test('timeout, failed exit, spawn failure and unavailable host are unknown', async () => {
  assert.deepEqual(await attestRecordedWorker(identity, host({ error: Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }) }).value), { verdict: 'unknown', reason: 'query-timeout' });
  assert.deepEqual(await attestRecordedWorker(identity, host({ error: Object.assign(new Error('exit 4'), { code: 4 }), stdout: '{"v":1,"found":false}' }).value), { verdict: 'unknown', reason: 'query-failed' });
  assert.deepEqual(await attestRecordedWorker(identity, host({ throws: true }).value), { verdict: 'unknown', reason: 'query-failed' });
  assert.deepEqual(await attestRecordedWorker(identity, host(absent, { systemRoot: undefined }).value), { verdict: 'unknown', reason: 'host-unavailable' });
});

test('missing, legacy or invalid identity is unknown without running a query', async () => {
  const h = host(absent);
  assert.deepEqual(await attestRecordedWorker(undefined, h.value), { verdict: 'unknown', reason: 'identity-missing' });
  assert.deepEqual(await attestRecordedWorker(null, h.value), { verdict: 'unknown', reason: 'identity-missing' });
  for (const value of [{}, { ...identity, schemaVersion: 2 }, { ...identity, role: 'other' }, { ...identity, pid: 0 }, { ...identity, processCreatedAt: null },
    { ...identity, executable: 'blender.exe' }, { ...identity, extra: true }, { pid: 4242 }, 'pid:4242']) {
    assert.deepEqual(await attestRecordedWorker(value, h.value), { verdict: 'unknown', reason: 'identity-invalid' });
  }
  assert.equal(h.calls.length, 0);
  const copy = parseWorkerIdentity({ ...identity });
  assert.deepEqual(copy, identity); assert.ok(Object.isFrozen(copy));
});

test('non-Windows platforms are unknown without running a query', async () => {
  const h = host(absent, { platform: 'linux' });
  assert.deepEqual(await attestRecordedWorker(identity, h.value), { verdict: 'unknown', reason: 'platform-unsupported' });
  assert.deepEqual(await captureWorkerIdentity({ pid: 4242, role: 'probe', executable: BLENDER }, h.value), { status: 'uncertain', reason: 'platform-unsupported' });
  assert.equal(h.calls.length, 0);
});

test('capture records the exact identity for probe and generate workers', async () => {
  for (const role of ['probe', 'python-probe', 'generate'] as const) {
    assert.deepEqual(await captureWorkerIdentity({ pid: 4242, role, executable: BLENDER }, host(present()).value),
      { status: 'captured', identity: { schemaVersion: 1, role, pid: 4242, processCreatedAt: CREATED, executable: BLENDER } });
  }
});

test('incomplete capture is uncertain, never a captured identity', async () => {
  const run = (reply: Reply, input: Record<string, unknown> = {}) => captureWorkerIdentity({ pid: 4242, role: 'generate', executable: BLENDER, ...input }, host(reply).value);
  assert.deepEqual(await run(absent), { status: 'uncertain', reason: 'pid-absent' });
  assert.deepEqual(await run(present({ created: null })), { status: 'uncertain', reason: 'metadata-inaccessible' });
  assert.deepEqual(await run(present({ executable: null })), { status: 'uncertain', reason: 'metadata-inaccessible' });
  assert.deepEqual(await run(present({ executable: 'C:\\Windows\\notepad.exe' })), { status: 'uncertain', reason: 'executable-mismatch' });
  assert.deepEqual(await run({ error: Object.assign(new Error('timeout'), { killed: true }) }), { status: 'uncertain', reason: 'query-timeout' });
  assert.deepEqual(await run(absent, { role: 'shell' }), { status: 'uncertain', reason: 'identity-invalid' });
  assert.deepEqual(await run(absent, { executable: 'blender' }), { status: 'uncertain', reason: 'identity-invalid' });
});

test('diagnostics never carry raw process paths, command lines or query output', async () => {
  const outputs = [present({ executable: 'C:\\Users\\private\\evil.exe' }), { stdout: 'C:\\Users\\private\\leak' }, { throws: true },
    { error: Object.assign(new Error('C:\\Users\\private\\failure'), { code: 1 }) }];
  for (const reply of outputs) {
    const text = JSON.stringify([await attestRecordedWorker(identity, host(reply).value), await captureWorkerIdentity({ pid: 4242, role: 'probe', executable: BLENDER }, host(reply).value)]);
    assert.doesNotMatch(text, /private|Users|evil|leak|failure|stderr|\\\\/);
  }
});

test('a caller mutating its identity object during the query cannot turn a live worker into gone', async () => {
  const mutable: Record<string, unknown> = { ...identity };
  const h = host(() => { mutable.processCreatedAt = '2020-01-01T00:00:00.0000000Z'; mutable.pid = 1; mutable.executable = 'C:\Windows\notepad.exe'; return present(); });
  assert.deepEqual(await attestRecordedWorker(mutable, h.value), { verdict: 'same-worker-running', reason: 'identity-matched' });
  assert.equal(h.calls[0]!.options.env && (h.calls[0]!.options.env as Record<string, string>).ARCANE_WORKER_PID, '4242');
});

test('accessor-backed identities are refused before any query', async () => {
  let reads = 0;
  const tricky = { ...identity } as Record<string, unknown>;
  Object.defineProperty(tricky, 'processCreatedAt', { enumerable: true, get: () => (++reads === 1 ? CREATED : '2020-01-01T00:00:00.0000000Z') });
  const h = host(absent);
  assert.deepEqual(await attestRecordedWorker(tricky, h.value), { verdict: 'unknown', reason: 'identity-invalid' });
  assert.equal(h.calls.length, 0); assert.equal(reads, 0);
});

test('timestamps must be real canonical UTC instants, never a reuse proof when invalid', async () => {
  for (const value of ['2028-02-29T00:00:00.0000000Z', '2026-12-31T23:59:59.9999999Z', '1601-01-01T00:00:00.0000000Z']) assert.equal(canonicalTimestamp(value), true, value);
  const invalid = ['2026-02-30T00:00:00.0000000Z', '2027-02-29T00:00:00.0000000Z', '2026-04-31T00:00:00.0000000Z', '2026-13-01T00:00:00.0000000Z',
    '2026-10-16T24:00:00.0000000Z', '2026-10-16T23:60:00.0000000Z', '2026-10-16T23:59:60.0000000Z', '1600-12-31T23:59:59.0000000Z',
    '2026-10-16T01:02:03.456Z', '2026-10-16T01:02:03.4567890+00:00', '2026-10-16T01:02:03.4567890z'];
  for (const value of invalid) {
    assert.equal(canonicalTimestamp(value), false, value);
    assert.deepEqual(await attestRecordedWorker({ ...identity, processCreatedAt: value }, host(absent).value), { verdict: 'unknown', reason: 'identity-invalid' }, value);
    assert.deepEqual(await attestRecordedWorker(identity, host(present({ created: value })).value), { verdict: 'unknown', reason: 'output-malformed' }, value);
  }
});

test('a query host that never settles is bounded by the adapter watchdog, never gone', async t => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  let kills = 0, late: ((error: null, stdout: string, stderr: string) => void) | undefined;
  const never: ProcessQueryHost = { platform: 'win32', systemRoot: SYSTEM_ROOT, execFile(_f, _a, _o, callback) { late = callback; return { kill() { kills++; return true; } }; } };
  const pending = attestRecordedWorker(identity, never);
  mock.timers.tick(QUERY_WATCHDOG_MS - 1); await Promise.resolve();
  let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve();
  assert.equal(settled, false);
  mock.timers.tick(1);
  assert.deepEqual(await pending, { verdict: 'unknown', reason: 'query-unsettled' });
  assert.equal(kills, 1);
  late!(null, '{"v":1,"found":false}', ''); // A late completion cannot change the settled verdict.
  assert.deepEqual(await pending, { verdict: 'unknown', reason: 'query-unsettled' });
  const capture = captureWorkerIdentity({ pid: 4242, role: 'generate', executable: BLENDER },
    { platform: 'win32', systemRoot: SYSTEM_ROOT, execFile() { return undefined; } });
  mock.timers.tick(QUERY_WATCHDOG_MS);
  assert.deepEqual(await capture, { status: 'uncertain', reason: 'query-unsettled' });
  const throwingKill = attestRecordedWorker(identity, { platform: 'win32', systemRoot: SYSTEM_ROOT, execFile() { return { kill() { throw new Error('C:\private'); } }; } });
  mock.timers.tick(QUERY_WATCHDOG_MS);
  assert.deepEqual(await throwingKill, { verdict: 'unknown', reason: 'query-unsettled' });
});

test('watchdog settles unknown BEFORE cleanup: a kill that synchronously reports found:false cannot win', async t => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  let kills = 0;
  const reentrant: ProcessQueryHost = { platform: 'win32', systemRoot: SYSTEM_ROOT, execFile(_f, _a, _o, callback) {
    return { kill() { kills++; callback(null, '{"v":1,"found":false}', ''); return true; } };
  } };
  const pending = attestRecordedWorker(identity, reentrant);
  mock.timers.tick(QUERY_WATCHDOG_MS);
  assert.deepEqual(await pending, { verdict: 'unknown', reason: 'query-unsettled' });
  assert.equal(kills, 1);
  const capture = captureWorkerIdentity({ pid: 4242, role: 'generate', executable: BLENDER }, { platform: 'win32', systemRoot: SYSTEM_ROOT,
    execFile(_f, _a, _o, callback) { return { kill() { callback(null, JSON.stringify({ v: 1, found: true, pid: 4242, created: CREATED, executable: BLENDER }), ''); return true; } }; } });
  mock.timers.tick(QUERY_WATCHDOG_MS);
  assert.deepEqual(await capture, { status: 'uncertain', reason: 'query-unsettled' });
});
