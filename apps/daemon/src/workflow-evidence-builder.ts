import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { types } from 'node:util';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { WORKFLOW_LIMITS, type ArtifactRole, type WorkflowArtifact, type WorkflowStep, type WorkflowSubmission } from '../../../packages/core/src/workflow-recipes.js';
import type { PinnedWorkflowArtifact } from './workflow-service.js';

export interface WorkflowFileEvidenceOptions {
  projectPath: string;
  step: WorkflowStep;
  inputArtifacts: readonly PinnedWorkflowArtifact[];
  files: readonly { path: string; role: ArtifactRole }[];
  excludedRoots: readonly string[];
}
const PATH_BYTES = 300, ABSOLUTE_BYTES = 4096, PATH_DEPTH = 64, EXCLUDED_ROOTS = 64;
const HASH = /^[a-f0-9]{64}$/;
const ROLES: readonly ArtifactRole[] = ['brief', 'requirements', 'plan', 'diagnosis', 'patch', 'blend-source', 'engine-export',
  'preview', 'hero-preview', 'profile-preview', 'scale-preview', 'reference-comparison', 'report', 'studio-receipt', 'playtest-log', 'reproduction', 'review'];
const PRIVATE = new Set(['.git', '.codex', '.claude', '.claude-code', '.agents', '.aws', '.ssh', '.azure', '.env', '.config',
  '.arcane', '.arcane-private-receipts-v1', 'workflow-human-receipts', 'native-codex', '.gnupg', '.kube', '.npm', '.docker',
  '.pki', '.vscode', '.idea', 'node_modules', 'config', 'credentials', 'secrets', '.credentials', '.secrets']);
const PRIVATE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.gitconfig|\.git-credentials|\.claude\.json|\.codexrc|auth\.json|credentials(?:\.json)?|secrets(?:\.json)?|tokens?\.json|key-v1|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|config\.toml)$/i;
const PRIVATE_EXTENSION = /\.(?:pem|key|p12|pfx|jks|kdbx|sqlite(?:3)?(?:-wal|-shm|-journal)?)$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ud800-\udfff]/u;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);
function fail(code: 'WORKFLOW_INPUT' | 'WORKFLOW_EVIDENCE' | 'WORKFLOW_VERIFIER', message: string): never { throw new ArcaneError(code, message); }
function input(): never { return fail('WORKFLOW_INPUT', 'Expected bounded own workflow evidence metadata.'); }
function evidence(): never { return fail('WORKFLOW_EVIDENCE', 'Project files or pins are unsafe, changed, or outside the evidence bounds.'); }
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) input();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) input();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) input();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) input();
    result[name] = d.value as unknown;
  }
  return result;
}
function array(value: unknown, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) input();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < min || length > max || Reflect.ownKeys(value).length !== length + 1) input();
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) input();
    result.push(d.value as unknown);
  }
  return result;
}
/** Detach the trusted step's JSON metadata without invoking accessors anywhere in it. */
function data(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 4096 || depth > 16) input();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { if (Buffer.byteLength(value) > WORKFLOW_LIMITS.textBytes) input(); return value; }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return array(value, WORKFLOW_LIMITS.steps * WORKFLOW_LIMITS.artifacts).map(item => data(item, depth + 1, budget));
  if (!value || typeof value !== 'object' || types.isProxy(value)) input();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some(key => typeof key !== 'string')) input();
  const result = fields(value, keys as string[]);
  for (const key of keys as string[]) result[key] = data(result[key], depth + 1, budget);
  return result;
}
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) input(); return value; }
function role(value: unknown): ArtifactRole { if (!ROLES.includes(value as ArtifactRole)) input(); return value as ArtifactRole; }
function safeParts(parts: readonly string[], privatePaths: boolean): void {
  if (parts.length > PATH_DEPTH || parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
      (privatePaths && (PRIVATE.has(part.toLowerCase()) || PRIVATE_FILE.test(part) || PRIVATE_EXTENSION.test(part))))) evidence();
}
function safeRelative(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > PATH_BYTES || value !== value.trim() || value !== value.normalize('NFKC') || CONTROL.test(value)) evidence();
  const path = value.replaceAll('\\', '/');
  if (isAbsolute(path) || path.startsWith('/')) evidence();
  safeParts(path.split('/'), true); return path;
}
function absolute(value: unknown, privatePaths = false): string {
  if (typeof value !== 'string' || !isAbsolute(value) || Buffer.byteLength(value) > ABSOLUTE_BYTES || value !== value.trim() || value !== value.normalize('NFKC') ||
      CONTROL.test(value) || /^(?:\\\\|\/\/)/.test(value) || value !== resolve(value)) evidence();
  const root = parse(value).root;
  if (value === root || (process.platform === 'win32' && !/^[a-z]:\\$/i.test(root))) evidence();
  safeParts(value.slice(root.length).split(sep), privatePaths); return value;
}
function within(root: string, full: string): boolean {
  const rel = relative(root, full);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
interface NodeIdentity { path: string; stat: BigIntStats }
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink; }
function sameFile(a: BigIntStats, b: BigIntStats): boolean { return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function sameChain(a: readonly NodeIdentity[], b: readonly NodeIdentity[]): boolean {
  return a.length === b.length && a.every((node, i) => samePath(node.path, b[i]!.path) && sameIdentity(node.stat, b[i]!.stat));
}
/** No discovered link is followed. Native physical equality is checked for every ancestor. */
function chain(full: string, kind: 'file' | 'directory' | 'either', missing = false): NodeIdentity[] {
  absolute(full);
  const root = parse(full).root, parts = full.slice(root.length).split(sep);
  let current = root;
  const nodes: NodeIdentity[] = [];
  for (const part of [null, ...parts]) {
    if (part !== null) current = join(current, part);
    let stat: BigIntStats;
    try { stat = lstatSync(current, { bigint: true }); }
    catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return nodes; throw error; }
    const last = samePath(current, full);
    if (stat.isSymbolicLink() || (!last && !stat.isDirectory()) ||
        (last && (kind === 'directory' ? !stat.isDirectory() : kind === 'file' ? !stat.isFile() : (!stat.isFile() && !stat.isDirectory()))) ||
        (stat.isFile() && stat.nlink !== 1n) || !samePath(realpathSync.native(current), current)) evidence();
    nodes.push({ path: current, stat });
  }
  return nodes;
}
interface FilePin { full: string; fd: number; chain: NodeIdentity[]; stat: BigIntStats; bytes: number; sha256: string | null }
function digestFile(pin: FilePin): string {
  if (!sameFile(pin.stat, fstatSync(pin.fd, { bigint: true }))) evidence();
  const digest = createHash('sha256'), buffer = Buffer.alloc(Math.min(64 * 1024, pin.bytes));
  try {
    let offset = 0;
    while (offset < pin.bytes) {
      const count = readSync(pin.fd, buffer, 0, Math.min(buffer.length, pin.bytes - offset), offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > Math.min(buffer.length, pin.bytes - offset)) evidence();
      digest.update(buffer.subarray(0, count)); offset += count;
    }
    if (readSync(pin.fd, buffer, 0, 1, pin.bytes) !== 0) evidence();
    const after = fstatSync(pin.fd, { bigint: true }), named = chain(pin.full, 'file');
    if (!sameFile(pin.stat, after) || !sameFile(after, named.at(-1)!.stat) || !sameChain(pin.chain, named)) evidence();
    return digest.digest('hex');
  } finally { buffer.fill(0); }
}

/** Host-only, read-only metadata builder. Authorization, current recipe/inputs, review and execution remain host-owned.
 * Filesystem checks are cooperative protection, not an OS sandbox against malicious local processes.
 */
export function prepareWorkflowFileEvidence(options: WorkflowFileEvidenceOptions): WorkflowSubmission {
  const a = fields(options, ['projectPath', 'step', 'inputArtifacts', 'files', 'excludedRoots']);
  const s = fields(data(a.step), ['key', 'title', 'stage', 'action', 'execution', 'instructions', 'acceptance', 'scope', 'dependencies',
    'subjectSteps', 'capabilities', 'provider', 'studio', 'gates', 'quality', 'retry']);
  const key = id(s.key), quality = fields(s.quality, ['roles', 'checks']);
  if (!['prompt', 'requirements', 'plan', 'implementation', 'verification', 'review'].includes(s.stage as string) ||
      !['capture-request', 'requirements', 'plan', 'diagnose-playtest', 'accept-plan', 'draft-code', 'author-asset', 'render-preview',
        'verify-code', 'verify-asset', 'apply-studio-patch', 'playtest', 'verify-playtest', 'accept-preview', 'review-analysis', 'accept-review'].includes(s.action as string) ||
      ['title', 'instructions', 'acceptance'].some(name => typeof s[name] !== 'string' || !(s[name] as string).trim())) input();
  const dependencies = array(s.dependencies, WORKFLOW_LIMITS.steps).map(id);
  if (new Set(dependencies).size !== dependencies.length || dependencies.includes(key)) input();
  const capabilities = array(s.capabilities, 32);
  if (capabilities.some(value => typeof value !== 'string' || !value || Buffer.byteLength(value) > 160)) input();
  const gates = array(s.gates, 8);
  if (gates.some(value => !['model-handoff', 'plan-acceptance', 'local-write', 'studio-write', 'studio-playtest', 'preview-acceptance', 'final-review'].includes(value as string)) || new Set(gates).size !== gates.length) input();
  const retry = fields(s.retry, ['maxAttempts', 'reason']);
  if (!Number.isSafeInteger(retry.maxAttempts) || Number(retry.maxAttempts) < 1 || Number(retry.maxAttempts) > WORKFLOW_LIMITS.attempts ||
      (retry.reason !== null && retry.reason !== 'evidence-read-busy') ||
      (s.provider !== null && (!s.provider || typeof s.provider !== 'object' || Array.isArray(s.provider))) ||
      (s.studio !== null && (!s.studio || typeof s.studio !== 'object' || Array.isArray(s.studio)))) input();
  if (!['human', 'native-handoff', 'local-authoring', 'local-verification', 'studio-handoff'].includes(s.execution as string)) input();
  if (s.execution === 'local-verification' || array(quality.checks, 20).length) fail('WORKFLOW_VERIFIER', 'File metadata cannot supply verifier execution or quality checks.');
  const requiredRoles = array(quality.roles, WORKFLOW_LIMITS.artifacts, 1).map(role);
  if (new Set(requiredRoles).size !== requiredRoles.length) input();
  const scopes = array(s.scope, WORKFLOW_LIMITS.scopes, 1).map(safeRelative);
  const subjects = array(s.subjectSteps, WORKFLOW_LIMITS.steps).map(id);
  if (new Set(subjects).size !== subjects.length || subjects.includes(key)) input();
  const files = array(a.files, WORKFLOW_LIMITS.artifacts, 1).map(value => {
    const f = fields(value, ['path', 'role']); return { path: safeRelative(f.path), role: role(f.role) };
  });
  if (new Set(files.map(file => pathKey(file.path))).size !== files.length ||
      files.some(file => !requiredRoles.includes(file.role)) || requiredRoles.some(required => !files.some(file => file.role === required))) evidence();
  if (files.some(file => !scopes.some(scope => pathKey(file.path) === pathKey(scope) || pathKey(file.path).startsWith(pathKey(scope) + '/')))) evidence();
  const inputArtifacts = array(a.inputArtifacts, WORKFLOW_LIMITS.steps * WORKFLOW_LIMITS.artifacts).map(value => {
    const f = fields(value, ['path', 'role', 'sha256', 'bytes', 'stepKey']);
    const result: PinnedWorkflowArtifact = { path: safeRelative(f.path), role: role(f.role), sha256: f.sha256 as string, bytes: f.bytes as number, stepKey: id(f.stepKey) };
    if (typeof result.sha256 !== 'string' || !HASH.test(result.sha256) || !Number.isSafeInteger(result.bytes) || result.bytes < 1 || result.bytes > WORKFLOW_LIMITS.artifactBytes || !subjects.includes(result.stepKey)) input();
    return result;
  });
  const inputPins = new Map<string, PinnedWorkflowArtifact>(), subjectPaths = new Set<string>();
  const subjectBudgets = new Map<string, { files: number; bytes: number }>();
  for (const file of inputArtifacts) {
    const identity = pathKey(file.path), subjectPath = file.stepKey + '\0' + identity;
    if (subjectPaths.has(subjectPath)) input();
    subjectPaths.add(subjectPath);
    const previous = inputPins.get(identity);
    if (previous && (previous.sha256 !== file.sha256 || previous.bytes !== file.bytes)) evidence();
    inputPins.set(identity, file);
    const budget = subjectBudgets.get(file.stepKey) ?? { files: 0, bytes: 0 };
    budget.files++; budget.bytes += file.bytes; subjectBudgets.set(file.stepKey, budget);
    if (budget.files > WORKFLOW_LIMITS.artifacts || budget.bytes > WORKFLOW_LIMITS.artifactBytes) evidence();
  }
  if (subjects.some(subject => !subjectBudgets.has(subject))) input();
  const root = absolute(a.projectPath, true), excluded = array(a.excludedRoots, EXCLUDED_ROOTS).map(value => absolute(value));
  const paths = new Map<string, string>();
  for (const file of [...inputArtifacts, ...files]) paths.set(pathKey(file.path), file.path);
  if (paths.size > (WORKFLOW_LIMITS.steps + 1) * WORKFLOW_LIMITS.artifacts) evidence();
  const outputPaths = new Set(files.map(file => pathKey(file.path)));
  const pins = new Map<string, FilePin>();
  try {
    const projectChain = chain(root, 'directory');
    for (const scope of scopes) chain(resolve(root, scope), 'either', true);
    const excludedChains = excluded.map(path => chain(path, 'directory', true));
    let total = 0, outputBytes = 0;
    // Open all bounded regular files before reading; reject excluded/private paths before any content access.
    for (const [identity, path] of paths) {
      const full = absolute(resolve(root, path));
      if (!within(root, full) || excluded.some(exclusion => within(exclusion, full))) evidence();
      const initial = chain(full, 'file'), stat = initial.at(-1)!.stat;
      if (stat.size < 1n || stat.size > BigInt(WORKFLOW_LIMITS.artifactBytes)) evidence();
      const bytes = Number(stat.size), expected = inputPins.get(identity);
      if (expected && expected.bytes !== bytes) evidence();
      total += bytes;
      if (outputPaths.has(identity)) outputBytes += bytes;
      if (outputBytes > WORKFLOW_LIMITS.artifactBytes || total > (subjects.length + 1) * WORKFLOW_LIMITS.artifactBytes) evidence();
      const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const pin: FilePin = { full, fd, chain: initial, stat, bytes: Number(stat.size), sha256: null };
      pins.set(identity, pin);
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameFile(stat, opened)) evidence();
    }
    for (const pin of pins.values()) pin.sha256 = digestFile(pin);
    for (const file of inputArtifacts) {
      const actual = pins.get(pathKey(file.path))!;
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) evidence();
    }
    const artifacts: WorkflowArtifact[] = files.map(file => {
      const pin = pins.get(pathKey(file.path))!; return { path: file.path, role: file.role, sha256: pin.sha256!, bytes: pin.bytes };
    }).sort((a, b) => order(a.path, b.path));
    if (new Set(artifacts.map(artifact => artifact.sha256)).size !== artifacts.length) evidence();
    // An earlier file can change while a later file is read. Rehash/recheck every still-open pin.
    for (const pin of pins.values()) if (digestFile(pin) !== pin.sha256) evidence();
    if (!sameChain(projectChain, chain(root, 'directory'))) evidence();
    for (let i = 0; i < excluded.length; i++) {
      const current = chain(excluded[i]!, 'directory', true), previous = excludedChains[i]!;
      if (!sameChain(previous, current)) evidence();
    }
    const subjectHashes = [...new Set(inputArtifacts.map(file => pins.get(pathKey(file.path))!.sha256!))].sort(order);
    for (const artifact of artifacts) Object.freeze(artifact);
    return Object.freeze({ key, artifacts: Object.freeze(artifacts) as unknown as WorkflowArtifact[],
      subjectHashes: Object.freeze(subjectHashes) as unknown as string[], checks: Object.freeze([]) as unknown as WorkflowSubmission['checks'] });
  } catch (error) {
    if (error instanceof ArcaneError) throw error;
    return evidence(); // Never echo a path, file contents or raw filesystem error.
  } finally {
    let closeFailed = false;
    for (const pin of pins.values()) { try { closeSync(pin.fd); } catch { closeFailed = true; } }
    if (closeFailed) evidence();
  }
}
