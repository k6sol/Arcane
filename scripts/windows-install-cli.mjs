// Internal installer protocol. The setup bootstrapper runs this with the bundled Node only:
//   node windows-install-cli.mjs --bundle <ABSOLUTE> --install-root <ABSOLUTE>
// stdout: newline-delimited JSON frames (schemaVersion 1), progress then exactly one result.
// stdin: at most one {"type":"cancel"} frame; end or error means the parent was lost.
// Contract: docs/build/WINDOWS_INSTALLER_PROTOCOL.md
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWindowsInstallation, WindowsInstallationError } from './windows-installation.mjs';

export const WINDOWS_INSTALL_CLI_EXIT = Object.freeze({ success: 0, failed: 1, cancelled: 2 });
export const WINDOWS_INSTALL_CLI_LIMITS = Object.freeze({ controlBytes: 1024, frameBytes: 1024, progressIntervalMs: 250, argumentChars: 4096, drainMs: 5000 });
const SCHEMA = 1;
const PHASES = new Set(['verifying-source', 'copying', 'verifying-copy', 'publishing', 'installed', 'already-active']);
// Fixed engine codes only; anything else is reported as ENGINE so no arbitrary text reaches the parent.
const ENGINE_CODES = new Set(['CANCELLED', 'CHANGED', 'COPY', 'INPUT', 'IO', 'JSON', 'LOCKED', 'LOCK_CHANGED', 'LOCK_UNCONFIRMED', 'MANIFEST',
  'OVERLAP', 'PATH', 'PATH_LENGTH', 'PROGRESS', 'PUBLISH_UNCONFIRMED', 'RECORD', 'REDIRECT', 'RELEASE_CHANGED', 'RELEASE_MISSING', 'RETENTION',
  'SIZE', 'SOURCE_CHANGED', 'UNOWNED']);
const ABORT_CODES = Object.freeze({ protocol: 'PROTOCOL', 'parent-lost': 'PARENT_LOST', output: 'OUTPUT' });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, RELEASE = /^[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const counter = value => Number.isSafeInteger(value) && value >= 0;
const noop = () => {};

/** Production argv admission: exactly --bundle ABSOLUTE --install-root ABSOLUTE, in that order. */
export function admitWindowsInstallArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== '--bundle' || argv[2] !== '--install-root') return null;
  const path = value => typeof value === 'string' && value.length <= WINDOWS_INSTALL_CLI_LIMITS.argumentChars && value === value.trim() &&
    !/[\x00-\x1f\x7f]/.test(value) && !value.startsWith('-') && isAbsolute(value) && (process.platform !== 'win32' || /^[A-Za-z]:\\/.test(value));
  return path(argv[1]) && path(argv[3]) ? Object.freeze({ bundle: argv[1], installRoot: argv[3] }) : null;
}

function resultFrame(state, { published, code = null, installationId = null, activeReleaseId = null, abort = null, lockRetained = false, stagingRetained = false }) {
  return { schemaVersion: SCHEMA, type: 'result', state, published, code, installationId, activeReleaseId, abort, lockRetained, stagingRetained };
}
/** Copies only known primitive progress fields; anything else is not reported. */
function progressFrame(value) {
  if (!value || typeof value !== 'object') return null;
  const { phase, filesCopied, totalFiles, bytesCopied, totalBytes } = value;
  if (!PHASES.has(phase) || ![filesCopied, totalFiles, bytesCopied, totalBytes].every(counter) || filesCopied > totalFiles || bytesCopied > totalBytes) return null;
  return { schemaVersion: SCHEMA, type: 'progress', phase, filesCopied, totalFiles, bytesCopied, totalBytes };
}
function classify(result, failure, failed, abort) {
  if (!failed) {
    if (result && (result.state === 'installed' || result.state === 'already-active') && typeof result.installationId === 'string' && UUID.test(result.installationId) &&
        typeof result.activeReleaseId === 'string' && RELEASE.test(result.activeReleaseId)) {
      return { exit: WINDOWS_INSTALL_CLI_EXIT.success, frame: resultFrame(result.state, { published: result.state === 'installed',
        installationId: result.installationId, activeReleaseId: result.activeReleaseId, abort }) };
    }
    // An unrecognised success shape cannot prove what was selected.
    return { exit: WINDOWS_INSTALL_CLI_EXIT.failed, frame: resultFrame('failed', { published: null, code: 'RESULT', abort }) };
  }
  if (!(failure instanceof WindowsInstallationError)) {
    // The engine types every failure after it takes its lock; untyped failures (source verification, admission I/O) precede any release publication.
    return { exit: WINDOWS_INSTALL_CLI_EXIT.failed, frame: resultFrame('failed', { published: false, code: 'IO', abort }) };
  }
  const published = failure.published === true || failure.published === false ? failure.published : null;
  const details = { published, abort, lockRetained: failure.cleanup?.state === 'retained', stagingRetained: typeof failure.stagingDirectory === 'string' };
  if (failure.code === 'CANCELLED' && published === false) {
    if (abort === 'cancel') return { exit: WINDOWS_INSTALL_CLI_EXIT.cancelled, frame: resultFrame('cancelled', { ...details, code: 'CANCELLED' }) };
    if (abort) return { exit: WINDOWS_INSTALL_CLI_EXIT.failed, frame: resultFrame('failed', { ...details, code: ABORT_CODES[abort] }) };
  }
  return { exit: WINDOWS_INSTALL_CLI_EXIT.failed, frame: resultFrame('failed', { ...details, code: ENGINE_CODES.has(failure.code) ? failure.code : 'ENGINE' }) };
}

/** Ordered bounded frames. Copy progress waiting behind backpressure is coalesced; phase changes and the result are never dropped. */
function frameWriter(output, onFailure) {
  const queue = []; let blocked = false, failed = false, inFlight = 0, waiter = null;
  const settle = () => { if (waiter && (failed || !queue.length && !inFlight)) { const done = waiter; waiter = null; done(); } };
  const fail = () => { if (failed) return; failed = true; queue.length = 0; onFailure(); settle(); };
  const write = line => {
    inFlight++;
    let accepted;
    try { accepted = output.write(line, error => { inFlight--; if (error) fail(); settle(); }); } catch { inFlight--; fail(); return; }
    if (accepted === false) blocked = true;
  };
  const pump = () => { while (!failed && !blocked && queue.length) write(queue.shift().line); settle(); };
  const encode = frame => { const line = JSON.stringify(frame) + '\n'; return Buffer.byteLength(line) <= WINDOWS_INSTALL_CLI_LIMITS.frameBytes ? line : null; };
  // Listeners stay attached: a late broken pipe after the result is absorbed, never an unhandled event.
  output.on('error', fail); output.on('drain', () => { blocked = false; pump(); });
  return {
    progress(frame) {
      if (failed) return; const line = encode(frame); if (!line) return;
      // A newer copy counter supersedes an unsent one; every other phase frame is kept, so the queue is bounded by the phase count.
      if (frame.phase === 'copying' && queue.at(-1)?.phase === 'copying') queue[queue.length - 1] = { phase: frame.phase, line };
      else queue.push({ phase: frame.phase, line });
      pump();
    },
    // The result follows queued frames even under backpressure; the bounded queue keeps buffered bytes small.
    result(frame) {
      if (failed) return; const line = encode(frame) ?? encode(resultFrame('failed', { published: null, code: 'RESULT' }));
      while (!failed && queue.length) write(queue.shift().line);
      if (!failed) write(line);
      settle();
    },
    flush() { return new Promise(resolve => { waiter = resolve; settle(); }); },
    // Confirmed only when the port acknowledged every write, including the result.
    delivered() { return !failed && !queue.length && !inFlight; },
    abandon() { if (!failed) { failed = true; queue.length = 0; } settle(); },
  };
}

/** Bounded terminal drain. Returns true only when every frame, including the result, was acknowledged by the output port. */
async function drain(writer, output, timers) {
  const drained = await new Promise(resolve => {
    let timer = null, done = false;
    const finish = value => { if (done) return; done = true; if (timer !== null) { try { timers.clearTimeout(timer); } catch { /* Owned timer only. */ } } resolve(value); };
    try { timer = timers.setTimeout(() => { timer = null; finish(false); }, WINDOWS_INSTALL_CLI_LIMITS.drainMs); } catch { finish(false); }
    void writer.flush().then(() => finish(true));
  });
  const delivered = drained && writer.delivered();
  if (!delivered) {
    // Unknown delivery: stop owning the output port; listeners remain attached so late errors are absorbed.
    writer.abandon();
    try { output.destroy?.(); } catch { /* Absorbed. */ }
  }
  return delivered;
}

/** Accepts at most one small {"type":"cancel"} frame. Malformed, extra or oversize input is a protocol failure. */
function controlReader(input, abort) {
  let received = false, closed = false; const chunks = []; let bytes = 0;
  const onData = chunk => {
    if (closed) return;
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk instanceof Uint8Array ? Buffer.from(chunk) : null;
    if (!data) { abort('protocol'); return; }
    if (received) { if (data.length) abort('protocol'); return; }
    bytes += data.length; if (bytes > WINDOWS_INSTALL_CLI_LIMITS.controlBytes) { received = true; abort('protocol'); return; }
    chunks.push(data);
    const all = Buffer.concat(chunks), newline = all.indexOf(0x0a); if (newline < 0) return;
    received = true;
    if (newline !== all.length - 1) { abort('protocol'); return; }
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all.subarray(0, newline)).replace(/\r$/, '')); } catch { abort('protocol'); return; }
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 1 || value.type !== 'cancel') { abort('protocol'); return; }
    abort('cancel');
  };
  const onLoss = () => { if (closed) return; abort('parent-lost'); };
  input.on('data', onData); input.on('end', onLoss); input.on('close', onLoss); input.on('error', noop); input.on('error', onLoss);
  return { close() { closed = true; input.removeListener('data', onData); input.removeListener('end', onLoss); input.removeListener('close', onLoss); input.removeListener('error', onLoss); try { input.pause?.(); } catch {} } };
}

/**
 * Host-only runner with explicit ports. Production main passes stdin/stdout and the default engine (full bundle verifier);
 * owned fixtures pass an engine created with their labelled verifier. Waits for the engine's terminal state and never kills it.
 */
export async function runWindowsInstallCli({ bundle, installRoot, input, output, installation, now = () => performance.now(),
  timers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle) } } = {}) {
  const port = (value, names) => value && names.every(name => typeof value[name] === 'function');
  if (!port(installation, ['install']) || !port(input, ['on', 'removeListener']) || !port(output, ['write', 'on']) || typeof now !== 'function' ||
      !port(timers, ['setTimeout', 'clearTimeout'])) {
    throw new TypeError('The Windows install protocol requires explicit engine, input and output ports.');
  }
  const controller = new AbortController(); let abort = null;
  // The first reason wins, except that a protocol violation overrides an earlier cancel: invalid input is never reported as a clean cancel.
  const stop = reason => { if (abort && !(abort === 'cancel' && reason === 'protocol')) return; abort = reason; controller.abort(); };
  const writer = frameWriter(output, () => stop('output'));
  const control = controlReader(input, stop);
  let lastPhase = null, lastAt = 0, held = null;
  const clock = () => { try { const value = now(); return Number.isFinite(value) ? value : Infinity; } catch { return Infinity; } };
  const onProgress = value => {
    let frame; try { frame = progressFrame(value); } catch { frame = null; }
    if (!frame) return;
    const at = clock();
    if (frame.phase === 'copying' && lastPhase === 'copying' && frame.filesCopied !== frame.totalFiles && at - lastAt < WINDOWS_INSTALL_CLI_LIMITS.progressIntervalMs) { held = frame; return; }
    held = null; lastPhase = frame.phase; lastAt = at; writer.progress(frame);
  };
  let result, failure, failed = false;
  try { result = await installation.install({ bundle, installRoot, signal: controller.signal, onProgress }); }
  catch (error) { failure = error; failed = true; }
  // Throttled counters are reported before the terminal frame.
  if (held) writer.progress(held);
  const outcome = classify(result, failure, failed, abort);
  writer.result(outcome.frame);
  // Armed only after the engine settled, so it never times out engine work.
  const delivered = await drain(writer, output, timers);
  control.close();
  // Exit 0 requires a confirmed result write; the disk outcome is unchanged and readable through the engine status.
  return delivered ? outcome.exit : WINDOWS_INSTALL_CLI_EXIT.failed;
}

async function main() {
  const admitted = admitWindowsInstallArguments(process.argv.slice(2));
  if (!admitted) {
    const writer = frameWriter(process.stdout, noop);
    writer.result(resultFrame('failed', { published: false, code: 'ARGUMENTS' }));
    await drain(writer, process.stdout, { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle) });
    process.exitCode = WINDOWS_INSTALL_CLI_EXIT.failed; process.stdin.destroy(); return;
  }
  process.exitCode = await runWindowsInstallCli({ ...admitted, input: process.stdin, output: process.stdout, installation: createWindowsInstallation() });
  process.stdin.destroy();
}

let entry = false;
try { entry = !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { entry = false; }
if (entry) main().catch(() => { process.exitCode = WINDOWS_INSTALL_CLI_EXIT.failed; });
