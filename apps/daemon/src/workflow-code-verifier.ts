import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync,
  type BigIntStats,
} from 'node:fs';
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { types } from 'node:util';
import {
  workflowSubjectDigest, type WorkflowCheckResult, type WorkflowContext,
} from '../../../packages/core/src/workflow-recipes.js';
import type {
  PinnedWorkflowArtifact, WorkflowVerificationRequest, WorkflowVerificationResult, WorkflowVerifier,
} from './workflow-service.js';

/** Fixed host policy, deliberately smaller than the coordinator's general evidence budget. */
export const WORKFLOW_CODE_VERIFY_LIMITS = Object.freeze({
  files: 16, fileBytes: 1024 * 1024, inputBytes: 4 * 1024 * 1024,
  compilerBytes: 32 * 1024 * 1024, pathBytes: 300, absolutePathBytes: 2048, pathDepth: 64,
  checks: 20, scopes: 20, diagnosticsPerFile: 128, reportBytes: 64 * 1024,
  childOutputBytes: 64 * 1024, totalOutputBytes: 256 * 1024,
  childDeadlineMs: 1500, requestDeadlineMs: 10_000, cleanupDeadlineMs: 500,
  cachedRequests: 64, readAttempts: 3,
});
export interface WorkflowCodeVerifierOptions {
  /** Host-selected physical project root, never a browser/route field. */
  projectPath: string;
  /** Existing safe project-relative directory; it must also be within step.scope. */
  evidenceDirectory: string;
  /** Host attests an installed official luau-compile binary and pins its release bytes. */
  compiler: { executablePath: string; sha256: string };
}
type Capability = NonNullable<WorkflowContext['capabilities']>[number];
const observers = new WeakMap<WorkflowVerifier, () => readonly Capability[]>();
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const FLAGS = Object.freeze(['--null', '-O0', '-g0']);
const PRIVATE = new Set([
  '.git', '.codex', '.claude', '.agents', '.aws', '.ssh', '.azure', '.env', '.config', '.arcane',
  '.gnupg', '.kube', '.npm', '.docker', '.pki', '.vscode', '.idea', 'node_modules', 'credentials', 'secrets',
]);
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const equalPath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
class Rejected extends Error {
  constructor(readonly readRace = false) { super('Code verification is unsupported.'); }
}
function reject(): never { throw new Rejected(); }
function fields(value: unknown, names: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) reject();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length || names.some(n =>
    !Object.hasOwn(descriptors, n) || !Object.hasOwn(descriptors[n]!, 'value') || !descriptors[n]!.enumerable)) reject();
}
function safeRelative(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > WORKFLOW_CODE_VERIFY_LIMITS.pathBytes ||
    value !== value.normalize('NFKC') || value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ud800-\udfff]/u.test(value)) reject();
  const path = value.replaceAll('\\', '/');
  if (isAbsolute(path) || path.split('/').some(part =>
    !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
    PRIVATE.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env.') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) reject();
  return path;
}
function absolute(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value !== resolve(value) ||
    Buffer.byteLength(value) > WORKFLOW_CODE_VERIFY_LIMITS.absolutePathBytes ||
    /[\u0000-\u001f]/.test(value) || (process.platform === 'win32' && !/^[a-z]:\\/i.test(value))) reject();
  return value;
}
function inScope(path: string, scopes: readonly string[]): boolean {
  // Same component boundary policy as WorkStore; no glob expansion or directory discovery.
  const key = (p: string): string => process.platform === 'win32' ? p.toLowerCase() : p;
  const p = key(path);
  return scopes.some(scope => p === key(scope) || p.startsWith(key(scope) + '/'));
}
interface NodeIdentity { path: string; stat: BigIntStats }
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Checks every ancestor, including root ancestors and Windows junctions. Never follows a discovered link. */
function checkedPath(full: string, kind: 'file' | 'directory'): NodeIdentity[] {
  absolute(full);
  const root = parse(full).root;
  const parts = full.slice(root.length).split(sep).filter(Boolean);
  if (parts.length > WORKFLOW_CODE_VERIFY_LIMITS.pathDepth) reject();
  let current = root;
  const chain: NodeIdentity[] = [];
  for (const part of [null, ...parts]) {
    if (part !== null) current = join(current, part);
    const stat = lstatSync(current, { bigint: true });
    const last = equalPath(current, full);
    if (stat.isSymbolicLink() || (last && kind === 'file'
      ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) reject();
    chain.push({ path: current, stat });
  }
  if (!equalPath(realpathSync(full), full)) reject();
  return chain;
}
function unchangedChain(before: NodeIdentity[], after: NodeIdentity[]): boolean {
  return before.length === after.length && before.every((n, i) =>
    equalPath(n.path, after[i]!.path) && sameIdentity(n.stat, after[i]!.stat));
}
interface Pin { full: string; bytes: number; digest: string; fd: number; before: BigIntStats; chain: NodeIdentity[] }
function readBounded(fd: number, bytes: number): Buffer {
  const data = Buffer.alloc(bytes + 1);
  let length = 0;
  while (length < data.length) {
    const count = readSync(fd, data, length, data.length - length, length);
    if (!count) break;
    length += count;
  }
  return data.subarray(0, length);
}
function isBusy(error: unknown): boolean {
  return ['EBUSY', 'EAGAIN', 'ETXTBSY'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}
function checkPin(pin: Pin): void {
  const first = fstatSync(pin.fd, { bigint: true });
  const data = readBounded(pin.fd, pin.bytes);
  const last = fstatSync(pin.fd, { bigint: true });
  const chain = checkedPath(pin.full, 'file'), current = chain.at(-1)!.stat;
  if (!unchangedChain(pin.chain, chain) || !sameFile(pin.before, first) ||
    !sameFile(first, last) || !sameFile(last, current)) throw new Rejected(true);
  // A stable wrong hash/size is never a retryable read race.
  if (data.length !== pin.bytes || sha(data) !== pin.digest) reject();
}
function openPin(full: string, bytes: number, digest: string): Pin {
  const chain = checkedPath(full, 'file'), initial = chain.at(-1)!.stat;
  if (initial.size !== BigInt(bytes)) reject();
  let fd: number;
  try { fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    // Only after a validated existing ordinary file. Missing-at-entry/permission errors are not busy.
    if (isBusy(error) || (error as NodeJS.ErrnoException).code === 'ENOENT') throw new Rejected(true);
    throw error;
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) reject();
    if (!sameFile(initial, before)) throw new Rejected(true);
    const pin = { full, bytes, digest, fd, before, chain };
    try { checkPin(pin); } catch (error) { if (isBusy(error)) throw new Rejected(true); throw error; }
    return pin;
  } catch (error) { closeSync(fd); throw error; }
}
function closePins(pins: Pin[]): void { for (const pin of pins) closeSync(pin.fd); }

interface ProcessResult {
  reason: 'closed' | 'spawn-error' | 'deadline' | 'output-limit' | 'cleanup-unknown';
  code: number | null; signal: string | null; stdout: Buffer; stderr: Buffer; outputBytes: number;
}
/** Exactly one own child, no shell, PATH search, inherited credentials, signal broadcasts or retries. */
function runCompiler(executable: string, args: string[], cwd: string, budget: number, deadline: number): Promise<ProcessResult> {
  return new Promise(resolveResult => {
    let child: ReturnType<typeof childProcess.spawn>;
    const env: NodeJS.ProcessEnv = {};
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    try {
      child = childProcess.spawn(executable, args, {
        cwd, env, shell: false, windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolveResult({ reason: 'spawn-error', code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), outputBytes: 0 });
      return;
    }
    let done = false, stopped: ProcessResult['reason'] | null = null, count = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const finish = (reason: ProcessResult['reason'], code: number | null, signal: string | null): void => {
      if (done) return;
      done = true; clearTimeout(timer); if (cleanup) clearTimeout(cleanup);
      child.stdout?.destroy(); child.stderr?.destroy();
      if (reason === 'cleanup-unknown') child.unref();
      resolveResult({ reason, code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), outputBytes: count });
    };
    const stop = (reason: ProcessResult['reason']): void => {
      if (done || stopped) return;
      stopped = reason;
      // ChildProcess.kill targets this ChildProcess only. Never use taskkill, process groups or global PIDs.
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* Unknown until close. */ }
      cleanup = setTimeout(() => finish('cleanup-unknown', null, null), WORKFLOW_CODE_VERIFY_LIMITS.cleanupDeadlineMs);
    };
    const receive = (chunks: Buffer[], data: Buffer): void => {
      if (done || stopped) return;
      const remaining = Math.min(budget, WORKFLOW_CODE_VERIFY_LIMITS.childOutputBytes) - count;
      if (data.length > remaining) {
        count += Math.max(0, remaining); stop('output-limit'); return;
      }
      count += data.length; chunks.push(Buffer.from(data));
    };
    child.stdout?.on('data', data => receive(stdout, data as Buffer));
    child.stderr?.on('data', data => receive(stderr, data as Buffer));
    child.on('error', () => stop('spawn-error'));
    child.stdout?.on('error', () => stop('spawn-error'));
    child.stderr?.on('error', () => stop('spawn-error'));
    child.on('close', (code, signal) => finish(stopped ?? 'closed', code, signal));
    const timer = setTimeout(() => stop('deadline'), Math.max(1, Math.min(deadline, WORKFLOW_CODE_VERIFY_LIMITS.childDeadlineMs)));
  });
}
interface Diagnostic { kind: 'SyntaxError' | 'CompileError'; line: number; column: number }
interface SyntaxResult { path: string; outcome: 'pass' | 'fail'; diagnostics: Diagnostic[] }
function decode(data: Buffer): string { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
function syntaxResult(result: ProcessResult, pin: Pin, path: string): SyntaxResult {
  if (result.reason !== 'closed' || result.signal !== null || (result.code !== 0 && result.code !== 1)) reject();
  const stdout = decode(result.stdout).replaceAll('\r\n', '\n');
  const stderr = decode(result.stderr).replaceAll('\r\n', '\n');
  // null mode contains nondeterministic timings: validate the protocol, never retain them.
  if (!/^Compiled \d+ KLOC into \d+ KB bytecode \(read \d+\.\d+s, parse \d+\.\d+s, compile \d+\.\d+s\)\n$/.test(stdout)) reject();
  if (result.code === 0) { if (stderr) reject(); return { path, outcome: 'pass', diagnostics: [] }; }
  const lines = stderr.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length || lines.length > WORKFLOW_CODE_VERIFY_LIMITS.diagnosticsPerFile) reject();
  const diagnostics = lines.map(line => {
    // The official Windows CLI normalizes diagnostic filenames to forward slashes.
    const prefix = (line.startsWith(pin.full + '(') ? pin.full : pin.full.replaceAll('\\', '/')) + '(';
    if (!line.startsWith(prefix)) reject();
    const match = /^(\d+),(\d+)\): (SyntaxError|CompileError): [^\r\n]+$/.exec(line.slice(prefix.length));
    if (!match) reject();
    const row = Number(match[1]), column = Number(match[2]);
    if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column) ||
      row < 1 || column < 1 || row > pin.bytes + 1 || column > pin.bytes + 1) reject();
    return { kind: match[3] as Diagnostic['kind'], line: row, column };
  });
  // Messages can contain source strings/credentials. Only locations and compiler error kinds survive.
  return { path, outcome: 'fail', diagnostics };
}
interface ValidatedRequest {
  request: Readonly<WorkflowVerificationRequest>; artifacts: PinnedWorkflowArtifact[]; scopes: string[];
  subjectHashes: string[]; cacheKey: string; binding: string;
}
function validateRequest(input: Readonly<WorkflowVerificationRequest>, projectPath: string, projectId: string, evidence: string): ValidatedRequest {
  fields(input, ['projectId', 'projectPath', 'workflowId', 'recipeId', 'step', 'subjectDigest', 'inputArtifacts']);
  if (input.projectId !== projectId || !equalPath(absolute(input.projectPath), projectPath) ||
    typeof input.workflowId !== 'string' || !ID.test(input.workflowId) ||
    typeof input.recipeId !== 'string' || !/^workflow-v1-[a-f0-9]{64}$/.test(input.recipeId) ||
    typeof input.subjectDigest !== 'string' || !HASH.test(input.subjectDigest)) reject();
  const s = input.step;
  fields(s, ['key', 'title', 'stage', 'action', 'execution', 'instructions', 'acceptance', 'scope',
    'dependencies', 'subjectSteps', 'capabilities', 'provider', 'studio', 'gates', 'quality', 'retry']);
  fields(s.retry, ['maxAttempts', 'reason']); fields(s.quality, ['roles', 'checks']);
  if (typeof s.key !== 'string' || !ID.test(s.key) || s.action !== 'verify-code' || s.stage !== 'verification' ||
    s.execution !== 'local-verification' || s.provider !== null || s.studio !== null ||
    !Array.isArray(s.gates) || s.gates.length ||
    !Array.isArray(s.capabilities) || s.capabilities.length !== 1 || s.capabilities[0] !== 'local.code.verify' ||
    !Array.isArray(s.subjectSteps) || s.subjectSteps.length !== 1 || s.subjectSteps[0] !== 'implementation' ||
    !s.retry || s.retry.reason !== 'evidence-read-busy' || !Number.isInteger(s.retry.maxAttempts) ||
    s.retry.maxAttempts < 1 || s.retry.maxAttempts > WORKFLOW_CODE_VERIFY_LIMITS.readAttempts ||
    !Array.isArray(s.scope) || !s.scope.length || s.scope.length > WORKFLOW_CODE_VERIFY_LIMITS.scopes ||
    !s.quality || !Array.isArray(s.quality.roles) || s.quality.roles.length !== 1 || s.quality.roles[0] !== 'report' ||
    !Array.isArray(s.quality.checks) || !s.quality.checks.length || s.quality.checks.length > WORKFLOW_CODE_VERIFY_LIMITS.checks) reject();
  const scopes = s.scope.map(safeRelative).sort(order);
  if (new Set(scopes.map(p => p.toLowerCase())).size !== scopes.length || !inScope(evidence, scopes)) reject();
  const checks = s.quality.checks;
  for (const c of checks) {
    fields(c, ['id', 'rule', 'limit']);
    if (typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || !['pass', 'at-most', 'at-least'].includes(c.rule) ||
      (c.rule === 'pass' ? c.limit !== null : typeof c.limit !== 'number' || !Number.isFinite(c.limit) || c.limit < 0)) reject();
  }
  if (new Set(checks.map(c => c.id)).size !== checks.length ||
    !Array.isArray(input.inputArtifacts) || !input.inputArtifacts.length || input.inputArtifacts.length > WORKFLOW_CODE_VERIFY_LIMITS.files) reject();
  let bytes = 0;
  const artifacts = input.inputArtifacts.map(a => {
    fields(a, ['path', 'role', 'sha256', 'bytes', 'stepKey']);
    const path = safeRelative(a.path);
    if (!/\.(?:luau|lua)$/i.test(path) || a.role !== 'patch' || a.stepKey !== 'implementation' ||
      typeof a.sha256 !== 'string' || !HASH.test(a.sha256) || !Number.isSafeInteger(a.bytes) || a.bytes < 1 || a.bytes > WORKFLOW_CODE_VERIFY_LIMITS.fileBytes ||
      !inScope(path, scopes) || inScope(path, [evidence])) reject();
    bytes += a.bytes;
    return { path, role: a.role, sha256: a.sha256, bytes: a.bytes, stepKey: a.stepKey };
  }).sort((a, b) => order(a.path, b.path));
  if (bytes > WORKFLOW_CODE_VERIFY_LIMITS.inputBytes || new Set(artifacts.map(a => a.path.toLowerCase())).size !== artifacts.length) reject();
  const subjectHashes = [...new Set(artifacts.map(a => a.sha256))].sort();
  if (workflowSubjectDigest(subjectHashes) !== input.subjectDigest) reject();
  const cacheKey = input.workflowId + ':' + input.recipeId + ':' + s.key;
  const binding = sha(JSON.stringify({ projectId, cacheKey, subjectDigest: input.subjectDigest,
    scopes, artifacts, checks: [...checks].sort((a, b) => order(a.id, b.id)), retry: s.retry }));
  return { request: input, artifacts, scopes, subjectHashes, cacheKey, binding };
}
function reportChecks(input: ValidatedRequest, results: SyntaxResult[]): { id: string; outcome: WorkflowCheckResult['outcome']; reason: string }[] {
  return input.request.step.quality.checks.map(c => {
    if (c.rule === 'pass' && c.limit === null && c.id === 'artifact-hashes')
      return { id: c.id, outcome: 'pass' as const, reason: 'Every supplied subject was read and hash/byte/identity checked before and after compilation.' };
    if (c.rule === 'pass' && c.limit === null && c.id === 'syntax-types')
      return results.some(r => r.outcome === 'fail')
        ? { id: c.id, outcome: 'fail' as const, reason: 'Syntax compilation failed.' }
        : { id: c.id, outcome: 'unsupported' as const, reason: 'Syntax compilation passed; type analysis is not implemented.' };
    return { id: c.id, outcome: 'unsupported' as const,
      reason: c.id === 'scope-diff' ? 'Input containment was checked; an approved baseline/diff was not verified.'
        : c.id === 'regression' ? 'No project code or regression tests were executed.'
        : c.id === 'security-invariants' ? 'Gameplay/server authority and security invariants were not proven.'
        : 'This quality requirement has no implemented proof.' };
  }).sort((a, b) => order(a.id, b.id));
}

/** Returns capability observations from this factory's actual compiler preflight; never accept route assertions. */
export function workflowCodeVerifierCapabilities(verifier: WorkflowVerifier): readonly Capability[] {
  return observers.get(verifier)?.() ?? Object.freeze([]);
}

/** Host-only factory. Configuration is fixed here, outside WorkflowVerificationRequest/JSON/recipes. */
export async function createWorkflowCodeVerifier(options: WorkflowCodeVerifierOptions): Promise<WorkflowVerifier> {
  let available = false, poisoned = false;
  let projectPath = '', projectId = '', evidence = '', evidenceFull = '', executable = '', compilerDigest = '';
  let rootChain: NodeIdentity[] = [], evidenceChain: NodeIdentity[] = [];
  const cache = new Map<string, { binding: string; attempts: number; result?: WorkflowVerificationResult }>();
  let active = false;
  const stableDirectories = (): void => {
    if (!unchangedChain(rootChain, checkedPath(projectPath, 'directory')) ||
      !unchangedChain(evidenceChain, checkedPath(evidenceFull, 'directory'))) reject();
  };
  const compilerPin = (): Pin => {
    const stat = checkedPath(executable, 'file').at(-1)!.stat;
    if (stat.size < 1n || stat.size > BigInt(WORKFLOW_CODE_VERIFY_LIMITS.compilerBytes)) reject();
    return openPin(executable, Number(stat.size), compilerDigest);
  };
  try {
    fields(options, ['projectPath', 'evidenceDirectory', 'compiler']);
    fields(options.compiler, ['executablePath', 'sha256']);
    projectPath = absolute(options.projectPath);
    rootChain = checkedPath(projectPath, 'directory');
    projectId = sha(process.platform === 'win32' ? projectPath.toLowerCase() : projectPath);
    evidence = safeRelative(options.evidenceDirectory);
    // Reserve room for the generated report component under the recipe's 300-byte path bound.
    if (Buffer.byteLength(evidence) + 55 > WORKFLOW_CODE_VERIFY_LIMITS.pathBytes) reject();
    evidenceFull = resolve(projectPath, evidence); evidenceChain = checkedPath(evidenceFull, 'directory');
    executable = absolute(options.compiler.executablePath); compilerDigest = options.compiler.sha256;
    if (!HASH.test(compilerDigest) || basename(executable).toLowerCase() !== (process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile')) reject();
    const compiler = compilerPin();
    try {
      const result = await runCompiler(executable, ['--help'], evidenceFull, WORKFLOW_CODE_VERIFY_LIMITS.childOutputBytes, WORKFLOW_CODE_VERIFY_LIMITS.childDeadlineMs);
      poisoned = result.reason === 'cleanup-unknown';
      checkPin(compiler); stableDirectories();
      available = result.reason === 'closed' && result.code === 0 && result.signal === null && !result.stderr.length &&
        /Usage: [^\r\n]+ \[--mode\] \[options\] \[file list\]/.test(decode(result.stdout)) &&
        /binary, text, remarks, codegen, codegenir, codegenasm, codegenverbose, codegennull, null/.test(decode(result.stdout)) &&
        decode(result.stdout).includes('-O<n>:') && decode(result.stdout).includes('-g<n>:');
    } finally { closeSync(compiler.fd); }
  } catch { available = false; }

  const verify: WorkflowVerifier['verify'] = async original => {
    if (!available || poisoned) return { status: 'unsupported' };
    let input: ValidatedRequest;
    try {
      // Take one bounded structural snapshot; mutations of the caller's objects cannot alter a running verification.
      input = validateRequest(original, projectPath, projectId, evidence);
      input = { ...input, request: { ...original, step: { ...original.step,
        quality: { roles: ['report'], checks: original.step.quality.checks.map(c => ({ ...c })) } } } };
    } catch { return { status: 'unsupported' }; }
    const prior = cache.get(input.cacheKey);
    if (prior && prior.binding !== input.binding) return { status: 'unsupported' };
    if (prior?.result && prior.result.status !== 'evidence-read-busy') {
      if (prior.result.status === 'evidence') {
        const replayPins: Pin[] = [];
        try {
          stableDirectories();
          for (const a of input.artifacts) replayPins.push(openPin(resolve(projectPath, a.path), a.bytes, a.sha256));
          for (const a of prior.result.submission.artifacts) replayPins.push(openPin(resolve(projectPath, a.path), a.bytes, a.sha256));
          for (const pin of replayPins) checkPin(pin);
        } catch { prior.result = { status: 'unsupported' }; }
        finally { closePins(replayPins); }
      }
      return structuredClone(prior.result);
    }
    if (active) return { status: 'unsupported' }; // Adapter contention is never an evidence-read race.
    if (prior && prior.attempts >= Math.min(input.request.step.retry.maxAttempts, WORKFLOW_CODE_VERIFY_LIMITS.readAttempts))
      return { status: 'unsupported' };
    if (!prior && cache.size >= WORKFLOW_CODE_VERIFY_LIMITS.cachedRequests) return { status: 'unsupported' };
    const entry = prior ?? { binding: input.binding, attempts: 0 };
    entry.attempts++; cache.set(input.cacheKey, entry); active = true;
    const pins: Pin[] = [];
    let compiler: Pin | undefined, spawned = false;
    const checkCompiler = (): void => {
      if (!compiler) reject();
      try { checkPin(compiler); } catch { available = false; reject(); }
    };
    const deadline = performance.now() + WORKFLOW_CODE_VERIFY_LIMITS.requestDeadlineMs;
    try {
      stableDirectories();
      // Compiler races/configuration faults are terminal, never evidence-read-busy.
      try { compiler = compilerPin(); } catch { available = false; reject(); }
      for (const a of input.artifacts) pins.push(openPin(resolve(projectPath, a.path), a.bytes, a.sha256));
      for (const pin of pins) checkPin(pin);
      const results: SyntaxResult[] = [];
      let outputBudget = WORKFLOW_CODE_VERIFY_LIMITS.totalOutputBytes;
      for (let i = 0; i < pins.length; i++) {
        const pin = pins[i]!;
        stableDirectories(); checkPin(pin); checkCompiler();
        if (performance.now() >= deadline || outputBudget < 1) reject();
        spawned = true;
        const result = await runCompiler(executable, [...FLAGS, pin.full], evidenceFull, outputBudget, deadline - performance.now());
        outputBudget -= result.outputBytes;
        if (result.reason !== 'closed' || result.signal !== null || (result.code !== 0 && result.code !== 1)) {
          available = false; poisoned ||= result.reason === 'cleanup-unknown'; reject();
        }
        try { results.push(syntaxResult(result, pin, input.artifacts[i]!.path)); }
        catch { available = false; reject(); }
      }
      for (const pin of pins) checkPin(pin);
      checkCompiler(); stableDirectories();
      if (performance.now() >= deadline) reject();
      const checks = reportChecks(input, results);
      const report = Buffer.from(JSON.stringify({
        schema: 'arcane.workflow-code-verification.v1', projectId,
        workflowId: input.request.workflowId, recipeId: input.request.recipeId, stepKey: input.request.step.key,
        subjectDigest: input.request.subjectDigest, subjectHashes: input.subjectHashes,
        compiler: { sha256: compilerDigest, flags: FLAGS, preflight: 'help-protocol-validated' },
        limits: WORKFLOW_CODE_VERIFY_LIMITS,
        inputs: input.artifacts, inputPins: 'hash-bytes-and-file-identities-checked-before-and-after',
        syntaxCompilation: results.some(r => r.outcome === 'fail') ? 'fail' : 'pass',
        files: results, checks, approval: 'pending',
        limitations: [
          'Compilation does not prove types, gameplay behavior, regression, scope diff, security or production quality.',
          'Direct-file pre/post pins detect observed changes; they are not an OS-enforced immutable snapshot.',
          'The trusted compiler runs at host privilege; this adapter is not an OS sandbox or a hard memory quota.',
          'Synchronous bounded filesystem calls cannot be forcibly interrupted; child deadlines and cleanup waits are bounded.',
          'Compiler provenance is attested and hash-pinned by the host; help output alone does not authenticate an official binary.',
        ],
      }) + '\n');
      if (report.length > WORKFLOW_CODE_VERIFY_LIMITS.reportBytes) reject();
      const reportPath = evidence + '/luau-verify-' + randomUUID() + '.json';
      const full = resolve(projectPath, reportPath);
      // Existing directory only; own a single new file, never overwrite, mkdir, unlink, or clean recursively.
      const fd = openSync(full, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const created = fstatSync(fd, { bigint: true });
        if (!created.isFile() || created.nlink !== 1n) reject();
        let written = 0;
        while (written < report.length) {
          const count = writeSync(fd, report, written, report.length - written, written);
          if (count < 1) reject(); written += count;
        }
        fsyncSync(fd);
        stableDirectories();
        const stat = fstatSync(fd, { bigint: true });
        const pin: Pin = { fd, full, bytes: report.length, digest: sha(report), before: stat, chain: checkedPath(full, 'file') };
        if (!sameIdentity(created, stat)) reject();
        checkPin(pin);
        // Check subjects once more after report I/O; never publish a stale report as evidence.
        for (const subject of pins) checkPin(subject);
        checkCompiler();
        if (performance.now() >= deadline) reject();
        entry.result = { status: 'evidence', submission: {
          key: input.request.step.key,
          artifacts: [{ path: reportPath, role: 'report', sha256: pin.digest, bytes: report.length }],
          subjectHashes: input.subjectHashes,
          checks: checks.map(c => ({ id: c.id, outcome: c.outcome, evidenceSha256: pin.digest, subjectDigest: input.request.subjectDigest })),
        } };
      } finally { closeSync(fd); }
    } catch (error) {
      entry.result = { status: !spawned && error instanceof Rejected && error.readRace
        ? 'evidence-read-busy' : 'unsupported' };
    } finally {
      try { closePins(pins); } finally { if (compiler) closeSync(compiler.fd); active = false; }
    }
    return structuredClone(entry.result!);
  };
  const verifier: WorkflowVerifier = Object.freeze({ action: 'verify-code', verify });
  observers.set(verifier, () => Object.freeze([Object.freeze({
    id: 'local.code.verify', state: available && !poisoned ? 'available' : 'unsupported', safety: 'read-only-deterministic',
  })]));
  return verifier;
}

