import { makeFixtureDirectory } from './windows-fixture-paths.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import {
  createWorkflowRecipe, evaluateWorkflowEvidence, workflowSubjectDigest, type WorkflowSubmission,
} from '../../packages/core/src/workflow-recipes.js';
import { WorkflowService, type WorkflowVerificationRequest, type WorkflowVerificationResult, type WorkflowHumanRequest } from '../../apps/daemon/src/workflow-service.js';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import {
  createWorkflowCodeVerifier, workflowCodeVerifierCapabilities, WORKFLOW_CODE_VERIFY_LIMITS,
  type WorkflowCodeVerifierOptions,
} from '../../apps/daemon/src/workflow-code-verifier.js';

const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const HELP = 'Usage: luau-compile [--mode] [options] [file list]\n' +
  'binary, text, remarks, codegen, codegenir, codegenasm, codegenverbose, codegennull, null\n-O<n>: compile\n-g<n>: compile\n';
const SUMMARY = 'Compiled 0 KLOC into 0 KB bytecode (read 0.00s, parse 0.00s, compile 0.00s)\n';
const COMPILER_NAME = process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile';
interface Fixture {
  root: string; project: string; evidence: string; options: WorkflowCodeVerifierOptions;
  file: (path: string, content: string | Buffer) => string;
  directory: (path: string) => string;
  track: (full: string) => void;
  request: (paths?: string[], workflowId?: string) => WorkflowVerificationRequest;
}
/** Own exact temporary files and remove each individually. No recursive delete, traversal or shared build output. */
function fixture(t: TestContext): Fixture {
  const root = makeFixtureDirectory('arcane-code-verifier-test-');
  const ownedFiles = new Set<string>(), ownedDirectories = [root];
  const directory = (path: string): string => {
    let current = root;
    for (const component of path.split('/')) {
      current = join(current, component);
      if (!fs.existsSync(current)) { fs.mkdirSync(current); ownedDirectories.push(current); }
    }
    return current;
  };
  const file = (path: string, content: string | Buffer): string => {
    const full = join(root, path);
    directory(dirname(path).replaceAll('\\', '/'));
    fs.writeFileSync(full, content); ownedFiles.add(full); return full;
  };
  const project = directory('project');
  const evidence = directory('project/src/feature/evidence');
  const executable = file('tools/' + COMPILER_NAME, 'TEST COMPILER DOUBLE METADATA; NEVER EXECUTED');
  const options = { projectPath: project, evidenceDirectory: 'src/feature/evidence',
    compiler: { executablePath: executable, sha256: hash(fs.readFileSync(executable)) } };
  file('project/src/feature/Main.luau', '--!strict\nlocal answer: number = 42\nreturn answer\n');
  const request = (paths = ['src/feature/Main.luau'], workflowId = 'fixture-workflow'): WorkflowVerificationRequest => {
    const recipe = createWorkflowRecipe({
      deliverable: 'code-change', engine: 'roblox', title: 'Read-only syntax proof',
      prompt: 'Verify the pinned source without executing it.', scope: ['src/feature'], model: null,
    });
    const artifacts = paths.map(path => {
      const data = fs.readFileSync(resolve(project, path));
      return { path, role: 'patch' as const, sha256: hash(data), bytes: data.length, stepKey: 'implementation' };
    });
    return { projectPath: project,
      projectId: hash(process.platform === 'win32' ? project.toLowerCase() : project),
      workflowId, recipeId: recipe.id, step: recipe.steps.find(s => s.action === 'verify-code')!,
      inputArtifacts: artifacts, subjectDigest: workflowSubjectDigest(artifacts.map(a => a.sha256)) };
  };
  t.after(() => {
    // Reports have exactly one flat owned output directory; never enumerate the project or private directories.
    for (const name of fs.readdirSync(evidence)) if (/^luau-verify-[a-f0-9-]{36}\.json$/.test(name)) ownedFiles.add(join(evidence, name));
    for (const full of [...ownedFiles].reverse()) {
      assert.ok(full.startsWith(root + (process.platform === 'win32' ? '\\' : '/')));
      try { fs.unlinkSync(full); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    for (const full of [...ownedDirectories].reverse()) fs.rmdirSync(full);
  });
  return { root, project, evidence, options, directory, file, request, track: full => ownedFiles.add(full) };
}
type FakeChild = EventEmitter & {
  stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: NodeJS.Signals | null;
  kills: string[]; unrefs: number; kill: (signal: string) => boolean; unref: () => void;
};
function compilerDouble(t: TestContext, act: (child: FakeChild, args: string[]) => void = child => complete(child, 0, SUMMARY)) {
  const calls: { executable: string; args: string[]; options: childProcess.SpawnOptions; child: FakeChild }[] = [];
  t.mock.method(childProcess, 'spawn', (executable: string, args: string[], options: childProcess.SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null, kills: [] as string[], unrefs: 0,
      kill(this: FakeChild, signal: string) {
        this.kills.push(signal);
        queueMicrotask(() => {
          if (this.exitCode === null && this.signalCode === null) {
            this.signalCode = 'SIGKILL'; this.emit('close', null, 'SIGKILL');
          }
        });
        return true;
      },
      unref(this: FakeChild) { this.unrefs++; },
    });
    calls.push({ executable, args: [...args], options, child });
    queueMicrotask(() => args[0] === '--help' ? complete(child, 0, HELP) : act(child, args));
    return child;
  });
  return calls;
}
function complete(child: FakeChild, code: number | null, stdout = '', stderr = '', signal: NodeJS.Signals | null = null): void {
  if (stdout) child.stdout.write(stdout);
  if (stderr) child.stderr.write(stderr);
  child.exitCode = code; child.signalCode = signal;
  child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
}
function submission(result: WorkflowVerificationResult): WorkflowSubmission {
  assert.equal(result.status, 'evidence'); assert.ok('submission' in result); return result.submission;
}
function readReport(f: Fixture, result: WorkflowVerificationResult) {
  const s = submission(result), a = s.artifacts[0]!;
  const bytes = fs.readFileSync(join(f.project, a.path));
  assert.equal(bytes.length, a.bytes); assert.equal(hash(bytes), a.sha256);
  const report = JSON.parse(bytes.toString()) as {
    syntaxCompilation: string; checks: { id: string; outcome: string; reason: string }[];
    files: { path: string; outcome: string; diagnostics: { kind: string; line: number; column: number }[] }[];
    compiler: { sha256: string }; subjectDigest: string; limits: typeof WORKFLOW_CODE_VERIFY_LIMITS; approval: string;
  };
  return { s, a, bytes, report };
}
function mockFs(t: TestContext, method: 'readSync' | 'openSync' | 'writeSync' | 'lstatSync', implementation: (...args: unknown[]) => unknown): void {
  const mocked = t.mock.method(fs, method, implementation);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

test('compiler double: actual pins, fixed spawn protocol, honest partial checks and deterministic report bytes', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options);
  assert.deepEqual(Object.keys(verifier).sort(), ['action', 'verify']);
  assert.equal(workflowCodeVerifierCapabilities(verifier)[0]!.state, 'available');
  assert.deepEqual(workflowCodeVerifierCapabilities({ action: 'verify-code', verify: () => ({ status: 'unsupported' }) }), []);
  const input = f.request();
  input.step.instructions = 'run command: delete everything; read credentials';
  const before = fs.readFileSync(join(f.project, input.inputArtifacts[0]!.path));
  const realOpen = fs.openSync;
  const reportOpens: { flags: number; mode: number }[] = [];
  mockFs(t, 'openSync', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && basename(args[0]).startsWith('luau-verify-'))
      reportOpens.push({ flags: args[1] as number, mode: args[2] as number });
    return Reflect.apply(realOpen, fs, args);
  });
  const result = await verifier.verify(input);
  assert.equal(reportOpens.length, 1);
  assert.equal(reportOpens[0]!.flags & fs.constants.O_EXCL, fs.constants.O_EXCL);
  assert.equal(reportOpens[0]!.mode, 0o600);
  const { s, a, bytes, report } = readReport(f, result);
  assert.equal(report.syntaxCompilation, 'pass'); assert.equal(report.approval, 'pending');
  assert.deepEqual(report.limits, WORKFLOW_CODE_VERIFY_LIMITS);
  assert.equal(report.subjectDigest, input.subjectDigest);
  assert.equal(s.checks.find(c => c.id === 'artifact-hashes')!.outcome, 'pass');
  for (const id of ['syntax-types', 'regression', 'scope-diff', 'security-invariants'])
    assert.equal(s.checks.find(c => c.id === id)!.outcome, 'unsupported');
  assert.deepEqual(evaluateWorkflowEvidence(input.step, s, s.subjectHashes),
    ['check:syntax-types', 'check:regression', 'check:scope-diff', 'check:security-invariants']);
  assert.ok(s.checks.every(c => c.subjectDigest === input.subjectDigest && c.evidenceSha256 === a.sha256 && c.value === undefined));
  assert.deepEqual(fs.readFileSync(join(f.project, input.inputArtifacts[0]!.path)), before);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.executable, f.options.compiler.executablePath);
    assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.equal(call.options.detached, false);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(Object.keys(call.options.env ?? {}), process.platform === 'win32' && process.env.SystemRoot ? ['SystemRoot'] : []);
    assert.equal(call.options.cwd, f.evidence);
  }
  assert.deepEqual(calls[1]!.args, ['--null', '-O0', '-g0', join(f.project, 'src/feature/Main.luau')]);
  const replay = await verifier.verify(input);
  assert.deepEqual(replay, result); assert.equal(calls.length, 2);
  // A separate adapter produces a distinct exclusive file with exactly the same deterministic bytes.
  const second = await createWorkflowCodeVerifier(f.options), other = readReport(f, await second.verify(input));
  assert.notEqual(other.a.path, a.path); assert.deepEqual(other.bytes, bytes);
  assert.ok(fs.existsSync(join(f.project, a.path)));
});

test('compiler double: a real compiler diagnostic fails syntax-types without retaining source/secret messages', async t => {
  const f = fixture(t);
  compilerDouble(t, (child, args) => complete(child, 1, SUMMARY,
    args[3]!.replaceAll('\\', '/') + '(2,8): SyntaxError: RAW-PRIVATE-SOURCE-CREDENTIAL\n'));
  const verifier = await createWorkflowCodeVerifier(f.options), input = f.request();
  const { s, bytes, report } = readReport(f, await verifier.verify(input));
  assert.equal(report.syntaxCompilation, 'fail');
  assert.equal(s.checks.find(c => c.id === 'syntax-types')!.outcome, 'fail');
  assert.deepEqual(report.files[0]!.diagnostics, [{ kind: 'SyntaxError', line: 2, column: 8 }]);
  assert.ok(!bytes.toString().includes('RAW-PRIVATE'));
  assert.equal(s.checks.find(c => c.id === 'security-invariants')!.outcome, 'unsupported');
});

test('compiler double: reject hostile request fields, exact scope escapes, unsupported inputs and inconsistent pins before compile', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options);
  const variants: ((r: WorkflowVerificationRequest) => void)[] = [
    r => { Object.assign(r, { command: 'evil.exe', compilerPath: 'from-browser.exe' }); },
    r => { r.projectId = hash('other project'); },
    r => { r.projectPath = dirname(f.project); },
    r => { r.subjectDigest = hash('stale subjects'); },
    r => { r.inputArtifacts[0]!.path = '../private.lua'; },
    r => { r.inputArtifacts[0]!.path = 'src/feature-escape/Main.luau'; },
    r => { r.inputArtifacts[0]!.path = join(f.project, 'src/feature/Main.luau'); },
    r => { r.inputArtifacts[0]!.path = 'src/feature/evil.luau:stream'; },
    r => { r.inputArtifacts[0]!.path = 'src/feature/.env.production'; },
    r => { r.inputArtifacts[0]!.path = 'src/feature/.ssh/credentials.luau'; },
    r => { r.inputArtifacts[0]!.path = 'src/feature/SECRETS/token.lua'; },
    r => { r.inputArtifacts[0]!.path = 'src/feature/evidence/existing.lua'; },
    r => { r.inputArtifacts[0]!.path = 'src/feature/patch.diff'; },
    r => { r.inputArtifacts[0]!.stepKey = 'plan'; },
    r => { r.inputArtifacts[0]!.role = 'report'; },
    r => { r.inputArtifacts[0]!.bytes++; },
    r => { r.inputArtifacts[0]!.sha256 = hash('wrong'); r.subjectDigest = workflowSubjectDigest([r.inputArtifacts[0]!.sha256]); },
    r => { r.inputArtifacts = [...r.inputArtifacts, { ...r.inputArtifacts[0]! }]; },
    r => { r.step.scope = ['src/feature/Main.luau']; },
    r => { r.step.provider = { selection: null, feature: 'coding', route: 'native-client', modalities: ['text'] }; },
    r => { r.step.action = 'verify-asset'; },
    r => { r.step.retry.maxAttempts = 4; },
    r => { r.step.quality.checks[0]!.limit = 0; },
  ];
  for (const [index, mutate] of variants.entries()) {
    const input = f.request(undefined, 'negative-' + index); mutate(input);
    assert.deepEqual(await verifier.verify(input), { status: 'unsupported' }, 'negative ' + index);
  }
  assert.equal(calls.length, 1); assert.deepEqual(fs.readdirSync(f.evidence), []);
});

test('compiler double: file/count/aggregate/path/quality bounds reject without execution', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options);
  for (const [id, mutate] of [
    ['file', (r: WorkflowVerificationRequest) => { r.inputArtifacts[0]!.bytes = WORKFLOW_CODE_VERIFY_LIMITS.fileBytes + 1; }],
    ['count', (r: WorkflowVerificationRequest) => { r.inputArtifacts = Array.from({ length: 17 }, (_, i) =>
      ({ ...r.inputArtifacts[0]!, path: 'src/feature/file-' + i + '.lua' })); }],
    ['aggregate', (r: WorkflowVerificationRequest) => { r.inputArtifacts = Array.from({ length: 5 }, (_, i) =>
      ({ ...r.inputArtifacts[0]!, path: 'src/feature/file-' + i + '.lua', bytes: WORKFLOW_CODE_VERIFY_LIMITS.fileBytes })); }],
    ['path', (r: WorkflowVerificationRequest) => { r.inputArtifacts[0]!.path = 'src/feature/' + 'a'.repeat(300) + '.lua'; }],
    ['quality', (r: WorkflowVerificationRequest) => { r.step.quality.checks = Array.from({ length: 21 }, (_, i) =>
      ({ id: 'check-' + i, rule: 'pass' as const, limit: null })); }],
  ] as const) {
    const r = f.request(undefined, id); mutate(r); assert.deepEqual(await verifier.verify(r), { status: 'unsupported' });
  }
  assert.equal(calls.length, 1);
});

test('compiler double: hardlinks and Windows junction/symlink ancestors never compile', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options);
  const original = join(f.project, 'src/feature/Main.luau');
  const hardlink = join(f.project, 'src/feature/Linked.lua');
  fs.linkSync(original, hardlink); f.track(hardlink);
  assert.deepEqual(await verifier.verify(f.request(['src/feature/Linked.lua'], 'hardlink')), { status: 'unsupported' });
  fs.unlinkSync(hardlink);
  const outside = f.directory('outside');
  f.file('outside/Other.lua', 'return 7\n');
  const redirect = join(f.project, 'src/feature/redirect');
  fs.symlinkSync(outside, redirect, process.platform === 'win32' ? 'junction' : 'dir'); f.track(redirect);
  // Build the pin via the link only in this negative fixture, then verify must reject it before reading bytes.
  const linked = f.request(['src/feature/redirect/Other.lua'], 'junction');
  assert.deepEqual(await verifier.verify(linked), { status: 'unsupported' });
  assert.equal(calls.length, 1); assert.deepEqual(fs.readdirSync(f.evidence), []);
});

test('compiler double: nonexistent/mismatched/private host configuration and compiler preflight fail closed', async t => {
  const f = fixture(t), calls = compilerDouble(t);
  for (const options of [
    { ...f.options, evidenceDirectory: 'missing' },
    { ...f.options, evidenceDirectory: '../outside' },
    { ...f.options, evidenceDirectory: 'src/feature/.aws' },
    { ...f.options, compiler: { ...f.options.compiler, sha256: hash('different executable') } },
    { ...f.options, compiler: { ...f.options.compiler, executablePath: 'luau-compile.exe' } },
    { ...f.options, command: 'prompt-derived argument' },
  ]) {
    const verifier = await createWorkflowCodeVerifier(options);
    assert.equal(workflowCodeVerifierCapabilities(verifier)[0]!.state, 'unsupported');
    assert.deepEqual(await verifier.verify(f.request()), { status: 'unsupported' });
  }
  assert.equal(calls.length, 0);
});

test('compiler double: a compiler changed after preflight cannot be executed or granted read-busy', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options);
  fs.writeFileSync(f.options.compiler.executablePath, 'REPLACED COMPILER');
  assert.deepEqual(await verifier.verify(f.request()), { status: 'unsupported' });
  assert.equal(calls.length, 1);
  assert.equal(workflowCodeVerifierCapabilities(verifier)[0]!.state, 'unsupported');
});

test('compiler double: stable wrong input hashes and missing-at-entry files are terminal, never read-busy', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options);
  const r = f.request(), file = join(f.project, r.inputArtifacts[0]!.path);
  fs.writeFileSync(file, Buffer.alloc(r.inputArtifacts[0]!.bytes, 32));
  assert.deepEqual(await verifier.verify(r), { status: 'unsupported' });
  const missing = f.request(undefined, 'missing');
  fs.unlinkSync(file);
  assert.deepEqual(await verifier.verify(missing), { status: 'unsupported' });
  assert.equal(calls.length, 1);
});

test('compiler double: only a validated pre-execution input read race is busy; bounded unchanged retries do not execute automatically', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options), input = f.request();
  const originalOpen = fs.openSync;
  let busy = true, inputOpens = 0;
  mockFs(t, 'openSync', (...args: unknown[]) => {
    if (args[0] === join(f.project, 'src/feature/Main.luau')) {
      inputOpens++;
      if (busy) throw Object.assign(new Error('sharing race'), { code: 'EBUSY' });
    }
    return Reflect.apply(originalOpen, fs, args);
  });
  assert.deepEqual(await verifier.verify(input), { status: 'evidence-read-busy' });
  assert.equal(calls.length, 1);
  const changed = structuredClone(input); changed.subjectDigest = hash('changed subjects');
  assert.deepEqual(await verifier.verify(changed), { status: 'unsupported' });
  busy = false;
  readReport(f, await verifier.verify(input)); assert.equal(calls.length, 2);
  assert.equal(inputOpens, 2);

  busy = true;
  const exhausted = structuredClone(input); exhausted.workflowId = 'busy-exhausted';
  assert.deepEqual(await verifier.verify(exhausted), { status: 'evidence-read-busy' });
  assert.deepEqual(await verifier.verify(exhausted), { status: 'evidence-read-busy' });
  const opens = inputOpens;
  assert.deepEqual(await verifier.verify(exhausted), { status: 'unsupported' });
  assert.equal(inputOpens, opens); assert.equal(calls.length, 2);
});

test('compiler double: identity/timestamp mutation during a pinned read is a legitimate pre-spawn race', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options), input = f.request();
  const originalRead = fs.readSync;
  let changed = false;
  mockFs(t, 'readSync', (...args: unknown[]) => {
    const count = Reflect.apply(originalRead, fs, args) as number;
    const buffer = args[1] as Buffer;
    if (!changed && count > 0 && buffer.subarray(0, count).toString().startsWith('--!strict')) {
      changed = true; fs.writeFileSync(join(f.project, 'src/feature/Main.luau'), 'return 8\n');
    }
    return count;
  });
  assert.deepEqual(await verifier.verify(input), { status: 'evidence-read-busy' });
  assert.equal(calls.length, 1);
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' }); // Now stable but wrong pin.
});

test('compiler double: input replacement during compilation is terminal unsupported and cannot rerun', async t => {
  const f = fixture(t), input = f.request();
  const calls = compilerDouble(t, (child, args) => {
    fs.writeFileSync(args[3]!, 'return 99\n');
    complete(child, 0, SUMMARY);
  });
  const verifier = await createWorkflowCodeVerifier(f.options);
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.equal(calls.length, 2); assert.deepEqual(fs.readdirSync(f.evidence), []);
});

test('compiler double: output bound kills only its own child; terminal outcome never becomes busy or retries', async t => {
  const f = fixture(t);
  const calls = compilerDouble(t, child => {
    child.stdout.write(Buffer.alloc(WORKFLOW_CODE_VERIFY_LIMITS.childOutputBytes + 1, 65));
  });
  const verifier = await createWorkflowCodeVerifier(f.options), input = f.request();
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.deepEqual(calls[1]!.child.kills, ['SIGKILL']); assert.deepEqual(calls[0]!.child.kills, []);
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.equal(calls.length, 2); assert.deepEqual(fs.readdirSync(f.evidence), []);
});

test('compiler double: deadline bounds hung child, confirms exact cleanup, and never retries', async t => {
  const f = fixture(t), calls = compilerDouble(t, () => {});
  const verifier = await createWorkflowCodeVerifier(f.options), input = f.request(), start = performance.now();
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.ok(performance.now() - start < WORKFLOW_CODE_VERIFY_LIMITS.childDeadlineMs + WORKFLOW_CODE_VERIFY_LIMITS.cleanupDeadlineMs + 1500);
  assert.deepEqual(calls[1]!.child.kills, ['SIGKILL']);
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' }); assert.equal(calls.length, 2);
});

test('compiler double: unconfirmed cleanup poisons adapter and bounds its own wait', async t => {
  const f = fixture(t), calls = compilerDouble(t, child => {
    child.kill = signal => { child.kills.push(signal); return false; };
    child.stdout.write(Buffer.alloc(WORKFLOW_CODE_VERIFY_LIMITS.childOutputBytes + 1));
  });
  const verifier = await createWorkflowCodeVerifier(f.options), input = f.request(), start = performance.now();
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.ok(performance.now() - start < WORKFLOW_CODE_VERIFY_LIMITS.cleanupDeadlineMs + 1500);
  assert.equal(calls[1]!.child.unrefs, 1); assert.deepEqual(calls[1]!.child.kills, ['SIGKILL']);
  assert.equal(calls[1]!.child.stdout.destroyed, true);
  assert.equal(workflowCodeVerifierCapabilities(verifier)[0]!.state, 'unsupported');
  assert.deepEqual(await verifier.verify(f.request(undefined, 'other')), { status: 'unsupported' }); assert.equal(calls.length, 2);
});

test('compiler double: signals, unknown exits, malformed diagnostics and spawn errors are unsupported', async t => {
  for (const mode of ['signal', 'exit', 'protocol', 'diagnostic', 'error'] as const) {
    await t.test(mode, async sub => {
      const f = fixture(sub), calls = compilerDouble(sub, (child, args) => {
        if (mode === 'signal') complete(child, null, '', '', 'SIGTERM');
        else if (mode === 'exit') complete(child, 27, SUMMARY);
        else if (mode === 'protocol') complete(child, 0, 'unrecognized stdout');
        else if (mode === 'diagnostic') complete(child, 1, SUMMARY, args[3] + '(0,0): SyntaxError: invalid location\n');
        else child.emit('error', Object.assign(new Error('private process error'), { code: 'EBUSY' }));
      });
      const verifier = await createWorkflowCodeVerifier(f.options), input = f.request();
      assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
      assert.deepEqual(await verifier.verify(input), { status: 'unsupported' }); assert.equal(calls.length, 2);
    });
  }
});

test('compiler double: report failure preserves existing files and no process retry is permitted', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options), input = f.request();
  const existing = f.file('project/src/feature/evidence/keep.json', 'EXISTING-REPORT-MUST-STAY');
  const originalOpen = fs.openSync;
  mockFs(t, 'openSync', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && basename(args[0]).startsWith('luau-verify-'))
      throw Object.assign(new Error('output sharing failure'), { code: 'EBUSY' });
    return Reflect.apply(originalOpen, fs, args);
  });
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.equal(fs.readFileSync(existing, 'utf8'), 'EXISTING-REPORT-MUST-STAY');
  assert.equal(calls.length, 2);
});

test('compiler double: bounded terminal cache never evicts entries to allow execution retries', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options);
  for (let i = 0; i < WORKFLOW_CODE_VERIFY_LIMITS.cachedRequests; i++) {
    const input = f.request(undefined, 'cached-' + i);
    input.inputArtifacts[0]!.sha256 = hash('wrong-' + i);
    input.subjectDigest = workflowSubjectDigest([input.inputArtifacts[0]!.sha256]);
    assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  }
  assert.deepEqual(await verifier.verify(f.request(undefined, 'capacity')), { status: 'unsupported' });
  assert.equal(calls.length, 1);
});

test('compiler double: contention is unsupported and caller mutation cannot alter already pinned invocation/report', async t => {
  const f = fixture(t);
  let finish: (() => void) | undefined;
  const calls = compilerDouble(t, child => { finish = () => complete(child, 0, SUMMARY); });
  const verifier = await createWorkflowCodeVerifier(f.options), input = f.request();
  const running = verifier.verify(input);
  await new Promise<void>(r => setImmediate(r));
  assert.ok(finish);
  assert.deepEqual(await verifier.verify(f.request(undefined, 'concurrent')), { status: 'unsupported' });
  input.subjectDigest = hash('mutation'); input.inputArtifacts[0]!.path = 'outside.lua';
  input.step.quality.checks[0]!.id = 'forged'; finish!();
  const { report, s } = readReport(f, await running);
  assert.notEqual(report.subjectDigest, input.subjectDigest);
  assert.equal(s.checks.find(c => c.id === 'artifact-hashes')!.outcome, 'pass'); assert.equal(calls.length, 2);
});


test('compiler double: cached evidence is re-pinned and tampered reports cannot replay or execute again', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options), input = f.request();
  const report = readReport(f, await verifier.verify(input));
  fs.writeFileSync(join(f.project, report.a.path), 'tampered report');
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.equal(calls.length, 2);
});

test('compiler double: all subjects must be pinned before the first compile; .lua is supported', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options);
  f.file('project/src/feature/Second.lua', 'return 2\n');
  const input = f.request(['src/feature/Main.luau', 'src/feature/Second.lua']);
  input.inputArtifacts[1]!.sha256 = hash('wrong second pin');
  input.subjectDigest = workflowSubjectDigest(input.inputArtifacts.map(a => a.sha256));
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' }); assert.equal(calls.length, 1);
  const valid = f.request(['src/feature/Second.lua'], 'lua-valid');
  assert.equal(readReport(f, await verifier.verify(valid)).report.syntaxCompilation, 'pass');
  assert.equal(calls.length, 2);
});

test('compiler double: non-data descriptors cannot choose filesystem paths or compiler commands', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createWorkflowCodeVerifier(f.options);
  let getterCalls = 0;
  const input = f.request();
  Object.defineProperty(input, 'projectPath', { enumerable: true, get: () => { getterCalls++; return f.project; } });
  assert.deepEqual(await verifier.verify(input), { status: 'unsupported' });
  assert.equal(getterCalls, 0); assert.equal(calls.length, 1);
  const unknownRetry = f.request(); Object.assign(unknownRetry.step.retry, { args: ['untrusted'] });
  assert.deepEqual(await verifier.verify(unknownRetry), { status: 'unsupported' });
  assert.equal(calls.length, 1);
});

test('compiler double: an executable mutation during compilation invalidates capability and never permits a read-busy retry', async t => {
  const f = fixture(t), calls = compilerDouble(t, child => {
    fs.writeFileSync(f.options.compiler.executablePath, 'replaced installed executable');
    complete(child, 0, SUMMARY);
  });
  const verifier = await createWorkflowCodeVerifier(f.options);
  assert.deepEqual(await verifier.verify(f.request()), { status: 'unsupported' });
  assert.equal(workflowCodeVerifierCapabilities(verifier)[0]!.state, 'unsupported');
  assert.equal(calls.length, 2);
});

test('compiler double: a sibling directory added after preflight invalidates POSIX ancestor link-count pins', async t => {
  const f = fixture(t), calls = compilerDouble(t), originalStat = fs.lstatSync;
  let added = false;
  // Windows directory link counts stay constant. Model the POSIX transition
  // there too, so the fixture ordering regression is covered on either runner.
  mockFs(t, 'lstatSync', (...args: unknown[]) => {
    const stat = Reflect.apply(originalStat, fs, args) as fs.BigIntStats;
    if (args[0] === f.root && typeof stat.nlink === 'bigint' && added) stat.nlink++;
    return stat;
  });
  const verifier = await createWorkflowCodeVerifier(f.options);
  assert.equal(workflowCodeVerifierCapabilities(verifier)[0]!.state, 'available');
  f.directory('state'); added = true;
  assert.deepEqual(await verifier.verify(f.request()), { status: 'unsupported' });
  assert.equal(calls.length, 1); assert.deepEqual(fs.readdirSync(f.evidence), []);
});

test('compiler double: WorkflowService accepts the genuine bounded adapter report and blocks human release on unsupported quality', async t => {
  const f = fixture(t), state = f.directory('state'), calls = compilerDouble(t);
  // Adding a sibling directory changes the POSIX ancestor link count. Finish
  // the fixture topology before the verifier captures its directory identities.
  const verifier = await createWorkflowCodeVerifier(f.options);
  for (const name of ['work.sqlite', 'workflow.sqlite'])
    for (const suffix of ['', '-wal', '-shm']) f.track(join(state, name + suffix));
  const selected = { provider: 'codex', model: 'offline-fixture', effort: 'high', connectionRevision: 'offline-v1' } as const;
  const receipts = new Map<string, string>();
  let counter = 0;
  const next = () => 'integration-' + ++counter;
  const issue = (prepared: WorkflowHumanRequest) => {
    const receipt = hash('test-only explicit human:' + prepared.binding);
    receipts.set(receipt, prepared.binding); return receipt;
  };
  const service = new WorkflowService({
    directory: state, projectPath: f.project, verifiers: [verifier],
    authorizeHuman: command => receipts.get(command.receiptHash) === command.binding,
    policyContext: () => ({
      connections: [{ provider: 'codex', installed: true, version: 'offline', auth: 'subscription', plan: null,
        revision: selected.connectionRevision, warnings: [], observedAt: '2026-10-12T00:00:00Z',
        models: [{ id: selected.model, label: 'Offline test fixture', efforts: ['high'], defaultEffort: 'high',
          source: 'runtime-catalogue', entitlement: 'unverified', inputModalities: ['text'] }],
        features: [{ id: 'coding', label: 'Synthetic handoff', state: 'native-handoff', route: 'native-client', reason: 'Fixture only.' }] }],
      capabilities: [{ id: 'local.patch', state: 'available', safety: 'human-handoff' }, ...workflowCodeVerifierCapabilities(verifier)],
    }),
  });
  try {
    const request = { deliverable: 'code-change' as const, engine: 'roblox' as const, title: 'Adapter integration fixture',
      prompt: 'Verify pinned source and preserve unsupported checks.', scope: ['src/feature'], model: selected };
    const created = service.create({ request, idempotencyKey: next(), receiptHash: issue(service.prepareCreation(request)) });
    const id = created.workflow.id;
    for (const key of ['prompt', 'requirements', 'plan', 'plan_acceptance', 'implementation']) {
      const record = service.get(id).workflow, step = record.recipe.steps.find(s => s.key === key)!;
      for (const gate of step.gates) {
        const prepared = service.prepareGate(id, key, gate, 'approved');
        service.recordDecision({ workflowId: id, idempotencyKey: next(),
          decision: { stepKey: key, gate, decision: 'approved', binding: prepared.recipeGate!.binding, receiptHash: issue(prepared) } });
      }
      const subjectHashes = [...new Set(step.subjectSteps.flatMap(subject =>
        record.submissions.find(s => s.key === subject)?.artifacts.map(a => a.sha256) ?? []))].sort();
      let path: string;
      if (key === 'implementation') path = 'src/feature/Main.luau';
      else {
        path = 'src/feature/' + key + '.txt';
        f.file('project/' + path, 'actual offline human evidence for ' + key);
      }
      const bytes = fs.readFileSync(join(f.project, path));
      const evidence: WorkflowSubmission = { key, subjectHashes, checks: [],
        artifacts: [{ path, role: step.quality.roles[0]!, bytes: bytes.length, sha256: hash(bytes) }] };
      service.submitHandoff({ workflowId: id, idempotencyKey: next(), submission: evidence,
        receiptHash: issue(service.prepareSubmission(id, evidence)) });
      service.review({ workflowId: id, stepKey: key, idempotencyKey: next(), decision: 'approved',
        receiptHash: issue(service.prepareReview(id, key, 'approved')) });
    }
    const input = { workflowId: id, stepKey: 'verification', idempotencyKey: next() };
    const verified = await service.verify(input);
    assert.equal(verified.result, 'submitted');
    assert.equal(verified.workflow.attempts[0]!.state, 'submitted');
    assert.equal(verified.workflow.taskStates.verification, 'needs_review');
    const assessment = verified.assessment!.steps.find(s => s.key === 'verification')!;
    assert.equal(assessment.state, 'pending'); assert.equal(assessment.disposition, 'pending');
    assert.ok(assessment.blockers.some(b => b.requirement === 'check:syntax-types'));
    assert.ok(assessment.blockers.some(b => b.requirement === 'check:security-invariants'));
    const prepared = service.prepareReview(id, 'verification', 'approved');
    assert.throws(() => service.review({ workflowId: id, stepKey: 'verification', idempotencyKey: next(), decision: 'approved',
      receiptHash: issue(prepared) }), (error: unknown) => error instanceof ArcaneError && error.code === 'WORKFLOW_BLOCKED');
    await service.verify(input); assert.equal(calls.length, 2);
    const proof = verified.workflow.submissions.find(s => s.key === 'verification')!;
    const a = proof.artifacts[0]!, report = fs.readFileSync(join(f.project, a.path));
    assert.equal(report.length, a.bytes); assert.equal(hash(report), a.sha256);
  } finally { service.close(); }
});

test('REAL OFFICIAL COMPILER: scoped installed Luau compiles pinned .luau/.lua, rejects invalid syntax, never runs source', async t => {
  // This opt-in is a test-runner/host environment input, never accepted by the adapter or browser.
  const executable = process.env.ARCANE_TEST_OFFICIAL_LUAU_COMPILER;
  if (!executable) { t.skip('Set ARCANE_TEST_OFFICIAL_LUAU_COMPILER to the host-installed official luau-compile binary.'); return; }
  assert.equal(basename(executable).toLowerCase(), COMPILER_NAME);
  const f = fixture(t), source = '--!strict\nerror("MUST-NEVER-EXECUTE")\nwhile true do end\nreturn 1\n';
  f.file('project/src/feature/Main.luau', source);
  f.file('project/src/feature/Module.lua', '--!strict\nlocal x: number = 7\nreturn x\n');
  f.file('project/src/feature/Broken.luau', '--!strict\nlocal value = \n');
  const options = { ...f.options, compiler: { executablePath: fs.realpathSync(executable), sha256: hash(fs.readFileSync(executable)) } };
  const before = hash(fs.readFileSync(executable));
  const verifier = await createWorkflowCodeVerifier(options);
  assert.equal(workflowCodeVerifierCapabilities(verifier)[0]!.state, 'available', 'Real installed compiler help preflight');
  const valid = f.request(['src/feature/Main.luau', 'src/feature/Module.lua'], 'official-valid');
  const { report, s } = readReport(f, await verifier.verify(valid));
  assert.equal(report.syntaxCompilation, 'pass'); assert.equal(report.files.length, 2);
  assert.ok(report.files.every(file => file.outcome === 'pass'));
  assert.equal(report.compiler.sha256, before);
  assert.equal(s.checks.find(c => c.id === 'syntax-types')!.outcome, 'unsupported');
  assert.ok(evaluateWorkflowEvidence(valid.step, s, s.subjectHashes).length > 0);
  const invalid = f.request(['src/feature/Broken.luau'], 'official-invalid');
  const failed = readReport(f, await verifier.verify(invalid));
  assert.equal(failed.report.syntaxCompilation, 'fail');
  assert.equal(failed.s.checks.find(c => c.id === 'syntax-types')!.outcome, 'fail');
  assert.ok(failed.report.files[0]!.diagnostics.some(d => d.kind === 'SyntaxError'));
  assert.equal(fs.readFileSync(join(f.project, 'src/feature/Main.luau'), 'utf8'), source);
  assert.equal(hash(fs.readFileSync(executable)), before);
  assert.deepEqual(fs.readdirSync(f.evidence).sort(), [s.artifacts[0]!.path.split('/').at(-1)!, failed.a.path.split('/').at(-1)!].sort());
  t.diagnostic('Official executable SHA-256: ' + before);
});

