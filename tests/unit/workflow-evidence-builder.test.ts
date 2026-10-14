import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import { WORKFLOW_LIMITS, createWorkflowRecipe, evaluateWorkflowEvidence, type ArtifactRole, type WorkflowStep } from '../../packages/core/src/workflow-recipes.js';
import type { PinnedWorkflowArtifact } from '../../apps/daemon/src/workflow-service.js';
import { prepareWorkflowFileEvidence, type WorkflowFileEvidenceOptions } from '../../apps/daemon/src/workflow-evidence-builder.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof ArcaneError && error.code === expected;
function fixture(t: test.TestContext) {
  const root = makeFixtureDirectory('arcane-file-evidence-'), project = join(root, 'project');
  fs.mkdirSync(project); fs.mkdirSync(join(project, 'src'));
  const step = createWorkflowRecipe({ deliverable: 'code-change', engine: 'roblox', title: 'Offline evidence fixture',
    prompt: 'Hash actual bounded local evidence without executing anything.', scope: ['src'], model: null }).steps[0]!;
  const file = (path: string, content: string | Buffer) => {
    const target = resolve(project, path), part = relative(project, target);
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    fs.mkdirSync(join(target, '..'), { recursive: true }); fs.writeFileSync(target, content); return target;
  };
  const main = file('src/brief.txt', 'Actual offline brief bytes.');
  t.after(() => {
    assert.ok(fs.realpathSync(root).startsWith(fixtureTempDirectory() + sep) && !fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options = (): WorkflowFileEvidenceOptions => ({ projectPath: project, step: structuredClone(step), inputArtifacts: [],
    files: [{ path: 'src/brief.txt', role: 'brief' }], excludedRoots: [] });
  return { root, project, main, step, file, options };
}
function readHook(t: test.TestContext, hook: (fd: number, bytes: number, offset: number) => void) {
  const original = fs.readSync;
  const mocked = t.mock.method(fs, 'readSync', (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    const result = original(fd, buffer, offset, length, position); hook(fd, result, position); return result;
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}
function subject(f: ReturnType<typeof fixture>, stepKey = 'prompt', path = 'inputs/source.txt', bytes = 'Actual trusted source bytes.'): PinnedWorkflowArtifact {
  f.file(path, bytes); return { path, role: 'brief', stepKey, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
}

test('native canonical fixture roots preserve rejection of raw Windows TEMP aliases before evidence reads', t => {
  const f = fixture(t), options = f.options();
  assert.equal(f.root, fs.realpathSync.native(f.root));
  assert.equal(fixtureTempDirectory(), fs.realpathSync.native(tmpdir()));
  const expected = prepareWorkflowFileEvidence(options);
  const rawProject = join(tmpdir(), basename(f.root), 'project');
  const samePath = process.platform === 'win32' ? rawProject.toLowerCase() === f.project.toLowerCase() : rawProject === f.project;
  if (!samePath) {
    assert.equal(fs.realpathSync.native(rawProject), f.project);
    const reads = t.mock.method(fs, 'readSync', () => { throw Error('Alias must fail before content reads.'); });
    syncBuiltinESMExports();
    try {
      assert.throws(() => prepareWorkflowFileEvidence({ ...options, projectPath: rawProject }), code('WORKFLOW_EVIDENCE'));
      assert.equal(reads.mock.callCount(), 0);
    } finally { reads.mock.restore(); syncBuiltinESMExports(); }
    t.diagnostic('Actual TEMP canonical alias rejected before evidence reads.');
  } else {
    assert.deepEqual(prepareWorkflowFileEvidence({ ...options, projectPath: rawProject }), expected);
    t.diagnostic('TEMP already has its physical spelling; canonical fixture evidence validated.');
  }
});

test('actual file hashes/counts are detached and deeply immutable; no bytes, writes or process calls escape', t => {
  const f = fixture(t), options = f.options(), before = structuredClone(options), original = fs.openSync;
  const open = t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: number, mode?: fs.Mode) => {
    assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC), 0);
    return original(path, flags, mode);
  });
  const write = t.mock.method(fs, 'writeFileSync', () => { throw new Error('No writes'); });
  const mkdir = t.mock.method(fs, 'mkdirSync', () => { throw new Error('No directories'); });
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('No process'); });
  syncBuiltinESMExports();
  t.after(() => { open.mock.restore(); write.mock.restore(); mkdir.mock.restore(); spawn.mock.restore(); syncBuiltinESMExports(); });
  const output = prepareWorkflowFileEvidence(options);
  assert.deepEqual(output, { key: 'prompt', artifacts: [{ path: 'src/brief.txt', role: 'brief', sha256: hash('Actual offline brief bytes.'), bytes: 27 }], subjectHashes: [], checks: [] });
  assert.deepEqual(options, before); assert.ok(Object.isFrozen(output) && Object.isFrozen(output.artifacts) && Object.isFrozen(output.artifacts[0]) && Object.isFrozen(output.subjectHashes) && Object.isFrozen(output.checks));
  assert.throws(() => output.artifacts.push(output.artifacts[0]!), TypeError); assert.throws(() => { output.artifacts[0]!.bytes = 999; }, TypeError);
  assert.deepEqual(evaluateWorkflowEvidence(options.step, output, []), []);
  assert.ok(!JSON.stringify(output).includes('Actual offline brief bytes.'));
  assert.equal(write.mock.callCount(), 0); assert.equal(mkdir.mock.callCount(), 0); assert.equal(spawn.mock.callCount(), 0);
});

test('roles must match the entire exact required set and metadata is sorted by path', t => {
  const f = fixture(t), options = f.options();
  options.step.quality.roles = ['brief', 'requirements'];
  f.file('src/z.txt', 'Distinct requirements.'); f.file('src/a.txt', 'Distinct brief.');
  options.files = [{ path: 'src/z.txt', role: 'requirements' }, { path: 'src/a.txt', role: 'brief' }];
  const result = prepareWorkflowFileEvidence(options); assert.deepEqual(result.artifacts.map(value => value.path), ['src/a.txt', 'src/z.txt']);
  for (const files of [[{ path: 'src/a.txt', role: 'brief' }], [{ path: 'src/a.txt', role: 'patch' }, { path: 'src/z.txt', role: 'requirements' }]]) {
    assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: files as WorkflowFileEvidenceOptions['files'] }), code('WORKFLOW_EVIDENCE'));
  }
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: [{ path: 'src/a.txt', role: 'invented' as ArtifactRole }] }), code('WORKFLOW_INPUT'));
  const duplicates: WorkflowFileEvidenceOptions = { ...options, files: [{ path: 'src/a.txt', role: 'brief' }, { path: 'src/a.txt', role: 'requirements' }] };
  assert.throws(() => prepareWorkflowFileEvidence(duplicates), code('WORKFLOW_EVIDENCE'));
  f.file('src/z.txt', 'Distinct brief.'); assert.throws(() => prepareWorkflowFileEvidence(options), code('WORKFLOW_EVIDENCE'), 'Core also forbids duplicate actual artifact digests');
});

test('subjects come only from declared subject steps and actual revalidated input hashes', t => {
  const f = fixture(t), options = f.options(), first = subject(f), second = subject(f, 'requirements', 'inputs/second.txt', 'Different subject bytes.');
  options.step.subjectSteps = ['prompt', 'requirements']; options.step.key = 'plan'; options.step.dependencies = ['prompt', 'requirements'];
  options.inputArtifacts = [second, first];
  const output = prepareWorkflowFileEvidence(options);
  assert.deepEqual(output.subjectHashes, [first.sha256, second.sha256].sort()); assert.deepEqual(output.checks, []);
  assert.deepEqual(evaluateWorkflowEvidence(options.step, output, output.subjectHashes), []);
  for (const inputArtifacts of [[], [first], [{ ...first, stepKey: 'foreign' }], [first, { ...first }]]) {
    assert.throws(() => prepareWorkflowFileEvidence({ ...options, inputArtifacts }), code('WORKFLOW_INPUT'));
  }
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, inputArtifacts: [second, { ...first, sha256: 'a'.repeat(64) }] }), code('WORKFLOW_EVIDENCE'));
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, inputArtifacts: [second, { ...first, bytes: first.bytes + 1 }] }), code('WORKFLOW_EVIDENCE'));
  f.file(first.path, 'Changed after host pinning.'); assert.throws(() => prepareWorkflowFileEvidence(options), code('WORKFLOW_EVIDENCE'));
});

test('subject hashes deduplicate actual equal content and subject paths need not be in the output step scope', t => {
  const f = fixture(t), options = f.options(), first = subject(f), second = subject(f, 'requirements', 'inputs/second.txt');
  options.step.subjectSteps = ['prompt', 'requirements']; options.step.key = 'plan'; options.inputArtifacts = [first, second];
  const output = prepareWorkflowFileEvidence(options); assert.deepEqual(output.subjectHashes, [first.sha256]);
  assert.ok(output.artifacts.every(value => value.path.startsWith('src/')));
});

test('verification steps and every nonempty quality-check requirement are denied before file reads', t => {
  const f = fixture(t), options = f.options();
  let reads = 0; readHook(t, () => reads++);
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, step: { ...options.step, execution: 'local-verification' } }), code('WORKFLOW_VERIFIER'));
  const checks = [{ id: 'real-check-required', rule: 'pass' as const, limit: null }];
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, step: { ...options.step, quality: { ...options.step.quality, checks } } }), code('WORKFLOW_VERIFIER'));
  assert.equal(reads, 0);
});

test('malformed metadata cannot supply hashes, approvals, callbacks, native actions or alternate step fields', t => {
  const f = fixture(t), options = f.options();
  const bad: unknown[] = [null, [], { ...options, approved: true }, { ...options, authorizeHuman: () => true }, { ...options, command: 'run' },
    { ...options, files: [{ path: 'src/brief.txt', role: 'brief', sha256: 'a'.repeat(64), bytes: 1 }] },
    { ...options, excludedRoots: undefined }, { ...options, inputArtifacts: null }, { ...options, files: [] },
    { ...options, step: { ...options.step, unknown: true } }, { ...options, step: { ...options.step, key: '' } },
    { ...options, step: { ...options.step, execution: 'unknown' } }, { ...options, step: { ...options.step, stage: 'unknown' } },
    { ...options, step: { ...options.step, action: 'run-command' } }, { ...options, step: { ...options.step, title: 42 } },
    { ...options, step: { ...options.step, scope: [] } }, { ...options, step: { ...options.step, quality: { roles: ['brief', 'brief'], checks: [] } } },
    { ...options, step: { ...options.step, dependencies: [options.step.key] } }];
  for (const value of bad) assert.throws(() => prepareWorkflowFileEvidence(value as WorkflowFileEvidenceOptions), code('WORKFLOW_INPUT'));
});

test('getters, proxies, inherited/hidden/symbol fields and array accessors never execute', t => {
  const f = fixture(t), options = f.options(); let evaluated = 0;
  const getter = () => { evaluated++; throw new Error('Private getter contents'); };
  const values: unknown[] = [
    { ...options, get projectPath() { return getter(); } }, { ...options, files: [{ get path() { return getter(); }, role: 'brief' }] },
    { ...options, step: { ...options.step, quality: { roles: ['brief'], get checks() { return getter(); } } } },
    { ...options, step: { ...options.step, provider: new Proxy({}, { getPrototypeOf: getter }) } },
    new Proxy(options, { getPrototypeOf: getter }), { ...options, [Symbol('hidden')]: true }, Object.create(options),
  ];
  const hidden = { ...options }; Object.defineProperty(hidden, 'hidden', { value: 'private' }); values.push(hidden);
  const files: unknown[] = []; Object.defineProperty(files, '0', { get: getter, enumerable: true }); files.length = 1; values.push({ ...options, files });
  const proxied = new Proxy(options.files, { get: getter }); values.push({ ...options, files: proxied });
  for (const value of values) assert.throws(() => prepareWorkflowFileEvidence(value as WorkflowFileEvidenceOptions), code('WORKFLOW_INPUT'));
  assert.equal(evaluated, 0);
});

test('exact scope component boundaries reject foreign/old scopes and accept a direct file scope', t => {
  const f = fixture(t), options = f.options(); f.file('src-old/brief.txt', 'Foreign old scope.'); f.file('other/brief.txt', 'Other scope.');
  for (const path of ['src-old/brief.txt', 'other/brief.txt']) assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: [{ path, role: 'brief' }] }), code('WORKFLOW_EVIDENCE'));
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, step: { ...options.step, scope: ['old-scope'] } }), code('WORKFLOW_EVIDENCE'));
  const exact = prepareWorkflowFileEvidence({ ...options, step: { ...options.step, scope: ['src/brief.txt'] } }); assert.equal(exact.artifacts[0]!.path, 'src/brief.txt');
  const backslash = prepareWorkflowFileEvidence({ ...options, files: [{ path: 'src\\brief.txt', role: 'brief' }] }); assert.equal(backslash.artifacts[0]!.path, 'src/brief.txt');
  if (process.platform === 'win32') assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: [{ path: 'src/brief.txt', role: 'brief' }, { path: 'SRC/BRIEF.TXT', role: 'brief' }] }), code('WORKFLOW_EVIDENCE'));
});

test('private/config/provider/state paths, traversal, roots, UNC, ADS and devices fail before contents are read', t => {
  const f = fixture(t), options = f.options(); let reads = 0; readHook(t, () => reads++);
  const paths = ['../brief.txt', '/brief.txt', 'C:/brief.txt', '\\\\server\\share\\file.txt', 'src//brief.txt', 'src/./brief.txt', 'src/../brief.txt',
    'src/file.txt:stream', 'src/NUL.txt', 'src/CON', 'src/LPT1.txt', 'src/trailing.', 'src/trailing ', ' src/brief.txt', 'src/brief.txt\n',
    'src/ｂrief.txt', 'src/.codex/auth.json', 'src/.claude/settings.json', 'src/.aws/credentials', 'src/.arcane/key-v1', 'src/.env', 'src/.env.local',
    'src/.git/config', 'src/.agents/a.txt', 'src/.config/settings.json', 'src/config/settings.json', 'src/.npmrc', 'src/.netrc', 'src/auth.json',
    'src/token.json', 'src/id_rsa', 'src/source.key', 'src/identity.pem', 'src/store.sqlite-wal', 'src/node_modules/source.txt',
    'src/.arcane-private-receipts-v1/key-v1', 'src/workflow-human-receipts/key-v1'];
  for (const path of paths) assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: [{ path, role: 'brief' }] }), code('WORKFLOW_EVIDENCE'), path);
  assert.equal(reads, 0);
  for (const projectPath of ['relative', fs.realpathSync(f.project) + sep + '..' + sep + 'project', fs.realpathSync(f.project) + sep,
    fs.realpathSync(f.project) + ':stream', resolve(f.project, '..', '.codex'), resolve(f.project).slice(0, process.platform === 'win32' ? 3 : 1)]) {
    assert.throws(() => prepareWorkflowFileEvidence({ ...options, projectPath }), code('WORKFLOW_EVIDENCE'));
  }
});

test('excluded roots block selected and subject files; malformed or linked exclusions are refused', t => {
  const f = fixture(t), options = f.options(), excluded = join(f.project, 'src');
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, excludedRoots: [excluded] }), code('WORKFLOW_EVIDENCE'));
  const outside = join(f.root, 'outside'); fs.mkdirSync(outside);
  assert.equal(prepareWorkflowFileEvidence({ ...options, excludedRoots: [outside, join(f.project, 'not-created-state')] }).artifacts.length, 1);
  assert.equal(fs.existsSync(join(f.project, 'not-created-state')), false);
  for (const root of ['relative', excluded + sep + '..' + sep + 'src', f.main]) assert.throws(() => prepareWorkflowFileEvidence({ ...options, excludedRoots: [root] }), code('WORKFLOW_EVIDENCE'));
  const source = subject(f); options.step.key = 'plan'; options.step.subjectSteps = ['prompt']; options.inputArtifacts = [source];
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, excludedRoots: [join(f.project, 'inputs')] }), code('WORKFLOW_EVIDENCE'));
  const linked = join(f.root, 'excluded-link'); fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, excludedRoots: [linked] }), code('WORKFLOW_EVIDENCE'));
});

test('project/ancestor junctions, file hard links and directory artifacts are rejected', t => {
  const f = fixture(t), options = f.options(), linked = join(f.root, 'project-link');
  fs.symlinkSync(f.project, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, projectPath: linked }), code('WORKFLOW_EVIDENCE'));
  fs.symlinkSync(join(f.project, 'src'), join(f.project, 'src-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, step: { ...options.step, scope: ['src-link'] }, files: [{ path: 'src-link/brief.txt', role: 'brief' }] }), code('WORKFLOW_EVIDENCE'));
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: [{ path: 'src', role: 'brief' }] }), code('WORKFLOW_EVIDENCE'));
  fs.linkSync(f.main, join(f.root, 'hard-alias')); assert.throws(() => prepareWorkflowFileEvidence(options), code('WORKFLOW_EVIDENCE'));
});

test('native physical equality of every ancestor is required, even for apparently ordinary directories', t => {
  const f = fixture(t), options = f.options(), native = fs.realpathSync.native;
  const redirect = t.mock.method(fs.realpathSync, 'native', (path: fs.PathLike) => path === join(f.project, 'src') ? join(f.root, 'foreign') : native(path));
  t.after(() => redirect.mock.restore());
  assert.throws(() => prepareWorkflowFileEvidence(options), code('WORKFLOW_EVIDENCE'));
});

test('20 output files and exact output aggregate 16 MiB are accepted; overflow cannot read unbounded bytes', t => {
  const f = fixture(t), options = f.options();
  const files = Array.from({ length: WORKFLOW_LIMITS.artifacts }, (_, i) => { const path = 'src/file-' + i + '.txt'; f.file(path, 'Unique file ' + i); return { path, role: 'brief' as const }; });
  assert.equal(prepareWorkflowFileEvidence({ ...options, files }).artifacts.length, 20);
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: [...files, { path: 'src/extra.txt', role: 'brief' }] }), code('WORKFLOW_INPUT'));
  const pinned = subject(f); const step = { ...options.step, key: 'plan', subjectSteps: ['prompt'] };
  assert.equal(prepareWorkflowFileEvidence({ ...options, step, inputArtifacts: [pinned], files }).artifacts.length, 20);
  f.file('src/large.bin', Buffer.alloc(WORKFLOW_LIMITS.artifactBytes, 0x31));
  const max = prepareWorkflowFileEvidence({ ...options, files: [{ path: 'src/large.bin', role: 'brief' }] }); assert.equal(max.artifacts[0]!.bytes, WORKFLOW_LIMITS.artifactBytes);
  fs.truncateSync(join(f.project, 'src/large.bin'), WORKFLOW_LIMITS.artifactBytes + 1);
  let reads = 0; readHook(t, () => reads++);
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: [{ path: 'src/large.bin', role: 'brief' }] }), code('WORKFLOW_EVIDENCE')); assert.equal(reads, 0);
});

test('empty, missing and aggregate oversized files fail without creating or padding evidence', t => {
  const f = fixture(t), options = f.options(); f.file('src/empty.txt', '');
  for (const path of ['src/empty.txt', 'src/missing.txt']) assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: [{ path, role: 'brief' }] }), code('WORKFLOW_EVIDENCE'));
  f.file('src/one.bin', 'x'); f.file('src/two.bin', 'y'); fs.truncateSync(join(f.project, 'src/one.bin'), 8 * 1024 * 1024); fs.truncateSync(join(f.project, 'src/two.bin'), 8 * 1024 * 1024 + 1);
  let reads = 0; readHook(t, () => reads++);
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: [{ path: 'src/one.bin', role: 'brief' }, { path: 'src/two.bin', role: 'brief' }] }), code('WORKFLOW_EVIDENCE')); assert.equal(reads, 0);
  assert.equal(fs.existsSync(join(f.project, 'src/missing.txt')), false);
});

test('file replacement between path check and open is detected before content reads, and descriptors close', t => {
  const f = fixture(t), options = f.options(), original = fs.openSync; let fd = -1, swapped = false, reads = 0;
  const open = t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: number, mode?: fs.Mode) => {
    if (path === f.main && !swapped) { swapped = true; fs.renameSync(f.main, join(f.project, 'src/moved.txt')); fs.writeFileSync(f.main, 'Actual offline brief bytes.'); }
    fd = original(path, flags, mode); return fd;
  });
  syncBuiltinESMExports(); t.after(() => { open.mock.restore(); syncBuiltinESMExports(); }); readHook(t, () => reads++);
  assert.throws(() => prepareWorkflowFileEvidence(options), code('WORKFLOW_EVIDENCE')); assert.equal(reads, 0);
  assert.throws(() => fs.fstatSync(fd), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF');
});

test('actual read shrink/growth/same-size mutations are rejected rather than producing mixed pins', t => {
  for (const changed of ['x', 'A'.repeat(128), 'Z'.repeat(27)]) {
    const f = fixture(t), options = f.options(); let modified = false;
    const original = fs.readSync, mocked = t.mock.method(fs, 'readSync', (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const count = original(fd, buffer, offset, length, position);
      if (!modified && count > 0) { modified = true; fs.writeFileSync(f.main, changed); }
      return count;
    });
    syncBuiltinESMExports();
    try { assert.throws(() => prepareWorkflowFileEvidence(options), code('WORKFLOW_EVIDENCE')); }
    finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
});

test('an earlier file changing while a later file is read fails the final whole-set validation', t => {
  const f = fixture(t), options = f.options(), first = f.file('src/a.txt', 'First exact file.'), second = f.file('src/b.txt', 'Second exact file.');
  const original = fs.openSync; let secondFd = -1;
  const open = t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: number, mode?: fs.Mode) => { const fd = original(path, flags, mode); if (path === second) secondFd = fd; return fd; });
  syncBuiltinESMExports(); t.after(() => { open.mock.restore(); syncBuiltinESMExports(); });
  let modified = false; readHook(t, (fd, bytes) => { if (fd === secondFd && bytes && !modified) { modified = true; fs.writeFileSync(first, 'Changed earlier file.'); } });
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, files: [{ path: 'src/a.txt', role: 'brief' }, { path: 'src/b.txt', role: 'brief' }] }), code('WORKFLOW_EVIDENCE'));
});

test('allowed public file contents remain private bytes; raw errors and credential text never return', t => {
  const f = fixture(t), options = f.options(), secret = 'Synthetic confidential fixture text, never returned.';
  f.file('src/brief.txt', secret); const output = prepareWorkflowFileEvidence(options);
  assert.equal(output.artifacts[0]!.sha256, hash(secret)); assert.ok(!JSON.stringify(output).includes(secret));
  const original = fs.openSync, failure = t.mock.method(fs, 'openSync', () => { throw new Error('PRIVATE-FILESYSTEM-' + secret + f.project); });
  syncBuiltinESMExports(); t.after(() => { failure.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => prepareWorkflowFileEvidence(options), (error: unknown) => code('WORKFLOW_EVIDENCE')(error) && !(error as Error).message.includes(secret) && !(error as Error).message.includes(f.project));
  assert.ok(original);
});

test('multiple subject steps each retain their own 20-artifact budget plus 20 scoped outputs', t => {
  const f = fixture(t), options = f.options(), inputArtifacts: PinnedWorkflowArtifact[] = [];
  for (const stepKey of ['prompt', 'requirements']) {
    for (let i = 0; i < WORKFLOW_LIMITS.artifacts; i++) inputArtifacts.push(subject(f, stepKey, 'inputs/' + stepKey + '-' + i + '.txt', 'Actual ' + stepKey + ' input ' + i));
  }
  const files = Array.from({ length: 20 }, (_, i) => { const path = 'src/output-' + i + '.txt'; f.file(path, 'Actual new output ' + i); return { path, role: 'brief' as const }; });
  const step = { ...options.step, key: 'plan', subjectSteps: ['prompt', 'requirements'] };
  const output = prepareWorkflowFileEvidence({ ...options, step, inputArtifacts, files });
  assert.equal(output.artifacts.length, 20); assert.equal(output.subjectHashes.length, 40); assert.deepEqual(output.checks, []);
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, step, inputArtifacts: [...inputArtifacts, subject(f, 'prompt', 'inputs/extra.txt')], files }), code('WORKFLOW_EVIDENCE'));
});

test('identical input paths across distinct subject steps coalesce only matching actual pins; conflicting pins fail', t => {
  const f = fixture(t), options = f.options(), first = subject(f), second = { ...first, stepKey: 'requirements', role: 'requirements' as const };
  const step = { ...options.step, key: 'plan', subjectSteps: ['prompt', 'requirements'] };
  const original = fs.openSync; let inputOpens = 0;
  const open = t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: number, mode?: fs.Mode) => {
    if (path === resolve(f.project, first.path)) inputOpens++; return original(path, flags, mode);
  });
  syncBuiltinESMExports(); t.after(() => { open.mock.restore(); syncBuiltinESMExports(); });
  const output = prepareWorkflowFileEvidence({ ...options, step, inputArtifacts: [first, second] });
  assert.equal(inputOpens, 1); assert.deepEqual(output.subjectHashes, [first.sha256]);
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, step, inputArtifacts: [first, { ...second, sha256: 'f'.repeat(64) }] }), code('WORKFLOW_EVIDENCE'));
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, step, inputArtifacts: [first, { ...second, bytes: second.bytes + 1 }] }), code('WORKFLOW_EVIDENCE'));
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, step, inputArtifacts: [first, { ...first, role: 'requirements' }] }), code('WORKFLOW_INPUT'));
});

test('two subject byte budgets may exceed one submission budget; each subject and new output limit still hold', t => {
  const f = fixture(t), options = f.options(), size = 8 * 1024 * 1024 + 1;
  const firstBytes = Buffer.alloc(size, 0x31), secondBytes = Buffer.alloc(size, 0x32);
  f.file('inputs/first.bin', firstBytes); f.file('inputs/second.bin', secondBytes);
  const first: PinnedWorkflowArtifact = { path: 'inputs/first.bin', role: 'brief', stepKey: 'prompt', sha256: hash(firstBytes), bytes: size };
  const second: PinnedWorkflowArtifact = { path: 'inputs/second.bin', role: 'requirements', stepKey: 'requirements', sha256: hash(secondBytes), bytes: size };
  const step = { ...options.step, key: 'plan', subjectSteps: ['prompt', 'requirements'] };
  assert.deepEqual(prepareWorkflowFileEvidence({ ...options, step, inputArtifacts: [first, second] }).subjectHashes, [first.sha256, second.sha256].sort());
  const sameStep = { ...step, subjectSteps: ['prompt'] };
  assert.throws(() => prepareWorkflowFileEvidence({ ...options, step: sameStep, inputArtifacts: [first, { ...second, stepKey: 'prompt' }] }), code('WORKFLOW_EVIDENCE'));
});
