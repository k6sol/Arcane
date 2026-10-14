import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual, types } from 'node:util';
import { z } from 'zod';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { validateStudioImportContextReceipt } from '../../../packages/core/src/studio-policy.js';
import { ConversationWorkStore, type ConversationWorkBinding } from '../../../packages/storage/src/conversation-work-store.js';
import { StudioStore } from '../../../packages/storage/src/studio-store.js';
import { NATIVE_STUDIO_IMPORT_RESPONSE_BYTES, parseNativeStudioImportResponse } from '../../../packages/asset-pipeline/src/studio-import-wire.js';
import type { PreparedStudioImport } from '../../../packages/asset-pipeline/src/studio-import-manifest.js';
import { assertNativeAssetActor, nativeAssetActorScope, type NativeAssetActor, type NativeAssetOperation } from './native-asset-authority.js';

export const STUDIO_IMPORT_PREPARATION_LIMITS = Object.freeze({ records: 64, recordBytes: NATIVE_STUDIO_IMPORT_RESPONSE_BYTES + 4096, totalBytes: 64 * 1024 * 1024 });
/** Trusted host witness only. These identifiers are resolved in the real StudioStore. */
export interface StudioImportPreparationWitness {
  initialContextReceiptId: string; confirmedContextReceiptId: string;
  pluginArtifactHash: string; clientLifetimeId: string; playEpoch: number;
}
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type StudioImportPreparationRecord = Immutable<{
  schemaVersion: 1; kind: 'studio-import-preparation'; projectId: string; jobId: string;
  conversation: { provider: 'codex'; threadId: string; sessionId: string | null };
  engineVerification: 'pending'; recordedAt: string; prepared: PreparedStudioImport;
  witness: StudioImportPreparationWitness;
  contextReads: { method: 'scene.import_context'; mode: 'Edit'; modeProvenance: 'StudioTestService.EditModeActive';
    creatorProvenance: 'game.CreatorType/CreatorId' | 'StudioService:GetUserId';
    initial: { requestId: string; finishedAt: string }; confirmed: { requestId: string; finishedAt: string } };
  recordSha256: string;
}>;
export interface StudioImportPreparationStore {
  save(actor: NativeAssetActor, jobId: string, prepared: PreparedStudioImport, witness: StudioImportPreparationWitness, guard: () => void): Promise<void>;
  get(actor: NativeAssetActor, jobId: string, guard: () => void): Promise<StudioImportPreparationRecord | null>;
  close(): Promise<void>;
}
type Limits = { -readonly [K in keyof typeof STUDIO_IMPORT_PREPARATION_LIMITS]: number };
interface DirectoryPin { path: string; stat: BigIntStats }
interface FilePin { stat: BigIntStats; bytes: Buffer }
type IO = <T>(operation: () => Promise<T>, abandon?: (value: T) => Promise<void>) => Promise<T>;
const owners = new Map<string, object>();
const LOCK = 'preparation-owner.json';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const hashSchema = z.string().regex(HASH);
const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?![\s\S])/)
  .refine(value => !/\b[a-f0-9]{64}\b|\b(?:sk-|gh[pousr]_|github_pat_|AKIA|AIza|password:|token:|secret:|authorization:|credentials:)|^eyJ[^.]+\.[^.]+\.[^.]+$/i.test(value));
const time = z.iso.datetime();
const witnessSchema = z.strictObject({ initialContextReceiptId: z.string().length(36).regex(UUID), confirmedContextReceiptId: z.string().length(36).regex(UUID),
  pluginArtifactHash: hashSchema, clientLifetimeId: opaque, playEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .refine(w => w.initialContextReceiptId !== w.confirmedContextReceiptId);
const readSchema = z.strictObject({ requestId: opaque, finishedAt: time });
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('studio-import-preparation'), projectId: hashSchema,
  jobId: z.string().length(36).regex(UUID), conversation: z.strictObject({ provider: z.literal('codex'), threadId: opaque, sessionId: opaque.nullable() }),
  engineVerification: z.literal('pending'), recordedAt: time, prepared: z.unknown(), witness: witnessSchema,
  contextReads: z.strictObject({ method: z.literal('scene.import_context'), mode: z.literal('Edit'), modeProvenance: z.literal('StudioTestService.EditModeActive'),
    creatorProvenance: z.enum(['game.CreatorType/CreatorId', 'StudioService:GetUserId']), initial: readSchema, confirmed: readSchema }), recordSha256: hashSchema });
function fail(code: string): never { throw new ArcaneError('STUDIO_IMPORT_PREPARATION_' + code, 'Studio import preparation storage is refused, changed or unavailable.'); }
function errno(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : null; }
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail('INPUT');
  const prototype: unknown = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null) || keys.length > required.length + optional.length ||
    keys.some(k => typeof k !== 'string' || ![...required, ...optional].includes(k))) fail('INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value), out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of [...required, ...optional]) {
    const d = descriptors[key]; if (!d) { if (required.includes(key)) fail('INPUT'); continue; }
    if (!Object.hasOwn(d, 'value') || !d.enumerable) fail('INPUT'); out[key] = d.value as unknown;
  }
  return out;
}
function jobId(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) fail('INPUT'); return value; }
function directPath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || /^(?:\\\\|\/\/)/.test(value)) fail('PATH');
  const root = parse(value).root, parts = value.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//);
  if (parts.some(p => !p || p === '.' || p === '..' || ['.git', '.codex', '.claude', '.agents', '.aws', '.ssh', '.azure', '.gnupg', 'node_modules'].includes(p.toLowerCase()) || /^\.env(?:\.|$)/i.test(p)) ||
    (process.platform === 'win32' && (!/^[a-z]:[\\/]$/i.test(root) || parts.some(p => /[<>:"|?*]|[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))))) fail('PATH');
  const full = resolve(value); if (full === root) fail('PATH'); return full;
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a: BigIntStats, b: BigIntStats) => identity(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function freeze<T>(value: T): Immutable<T> { if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value as Immutable<T>; }
async function closeResource(resource: { close(): Promise<void> }, io: IO): Promise<void> {
  try { await io(() => resource.close()); }
  catch (error) {
    // Release our descriptor even after revocation; cleanup cannot disclose data
    // or resume the operation, and the original fencing failure still propagates.
    await resource.close().catch(() => {}); throw error;
  }
}
async function directories(full: string, create: boolean, io: IO): Promise<DirectoryPin[]> {
  let cursor = parse(full).root; const pins: DirectoryPin[] = [];
  for (const part of [null, ...relative(cursor, full).split(sep).filter(Boolean)]) {
    if (part !== null) cursor = join(cursor, part);
    let stat: BigIntStats;
    try { stat = await io(() => lstat(cursor, { bigint: true })); }
    catch (error) { if (!create || errno(error) !== 'ENOENT') throw error; await io(() => mkdir(cursor)); stat = await io(() => lstat(cursor, { bigint: true })); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await io(() => realpath(cursor)), cursor)) fail('PATH');
    pins.push({ path: cursor, stat });
  }
  return pins;
}
async function readPinned(path: string, limit: number, io: IO, optional = false): Promise<FilePin | null> {
  let before: BigIntStats;
  try { before = await io(() => lstat(path, { bigint: true })); }
  catch (error) { if (optional && errno(error) === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n) fail('CORRUPT');
  if (before.size > BigInt(limit)) fail('LIMIT');
  const handle = await io(() => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), h => h.close());
  try {
    const opened = await io(() => handle.stat({ bigint: true })); if (!sameFile(before, opened)) fail('PATH');
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) { const n = await io(() => handle.read(bytes, offset, bytes.length - offset, offset)); if (!n.bytesRead) fail('CORRUPT'); offset += n.bytesRead; }
    const extra = await io(() => handle.read(Buffer.alloc(1), 0, 1, offset)), after = await io(() => handle.stat({ bigint: true }));
    const named = await io(() => lstat(path, { bigint: true }));
    if (extra.bytesRead || !sameFile(opened, after) || !sameFile(opened, named)) fail('PATH'); return { stat: named, bytes };
  } finally { await closeResource(handle, io); }
}

/** Durable metadata only. Records cannot be used as upload/import consent or an
 * observed engine baseline. Exclusive creation never replaces a prior record;
 * failed writes and unknown locks remain for explicit inspection. Physical path
 * checks and the lock coordinate local writers; they are not an OS sandbox. */
export async function createStudioImportPreparationStore(options: {
  projectPath: string; directory: string; workAssociations: ConversationWorkStore; studio: StudioStore;
  limits?: Partial<Limits>; now?: () => number;
}): Promise<StudioImportPreparationStore> {
  const input = fields(options, ['projectPath', 'directory', 'workAssociations', 'studio'], ['limits', 'now']);
  const projectPath = directPath(input.projectPath), directory = directPath(input.directory), store = input.workAssociations, studio = input.studio;
  if (!(store instanceof ConversationWorkStore) || types.isProxy(store) || store.projectPath !== projectPath || !(studio instanceof StudioStore) || types.isProxy(studio)) fail('SCOPE');
  const now = input.now === undefined ? Date.now : input.now; if (typeof now !== 'function') fail('INPUT');
  const associations: ConversationWorkStore = store, receipts: StudioStore = studio, clockSource = now;
  const limits: Limits = { ...STUDIO_IMPORT_PREPARATION_LIMITS };
  if (input.limits !== undefined) for (const [key, value] of Object.entries(fields(input.limits, [], Object.keys(limits)))) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > limits[key as keyof Limits]) fail('INPUT'); limits[key as keyof Limits] = value;
  }
  const startupIO: IO = async operation => operation();
  const projectPins = await directories(projectPath, false, startupIO), pins = await directories(directory, true, startupIO);
  const uniquePins = new Map<string, DirectoryPin>();
  for (const pin of [...projectPins, ...pins]) {
    const previous = uniquePins.get(pin.path); if (previous && !identity(previous.stat, pin.stat)) fail('PATH');
    if (!previous) uniquePins.set(pin.path, pin);
  }
  const physicalPins = [...uniquePins.values()];
  const key = process.platform === 'win32' ? directory.toLowerCase() : directory, owner = {};
  if (owners.has(key)) fail('LOCKED'); owners.set(key, owner);
  let closed = false, poisoned = false, busy = false, lockPin: FilePin | null = null, lockAttempted = false;
  let idle = Promise.resolve(), releaseIdle: (() => void) | undefined;
  const projectId = associations.projectId, lockPath = join(directory, LOCK);
  function clock(): number { const value: unknown = clockSource(); if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('INPUT'); return value; }
  function paths(): void {
    // Bounded synchronous pin checks introduce no queue wait or async authority
    // gap. Avoid multiplying SQLite/target guards once per physical ancestor.
    for (const pin of physicalPins) {
      try {
        const current = lstatSync(pin.path, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || !identity(pin.stat, current) || !samePath(realpathSync(pin.path), pin.path)) fail('PATH');
      } catch { fail('PATH'); }
    }
    if (lockPin) {
      try { const current = lstatSync(lockPath, { bigint: true }); if (!current.isFile() || current.isSymbolicLink() || !sameFile(lockPin.stat, current)) fail('LOCKED'); }
      catch { fail('LOCKED'); }
    }
  }
  function decode(bytes: Buffer, id: string): StudioImportPreparationRecord {
    if (bytes.length > limits.recordBytes) fail('LIMIT'); let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('CORRUPT'); }
    const parsed = recordSchema.safeParse(value); if (!parsed.success) fail('CORRUPT');
    const { recordSha256, ...content } = parsed.data;
    if (content.projectId !== projectId || content.jobId !== id || recordSha256 !== digest(content) ||
      Date.parse(content.contextReads.initial.finishedAt) > Date.parse(content.contextReads.confirmed.finishedAt) ||
      Date.parse(content.contextReads.confirmed.finishedAt) > Date.parse(content.recordedAt)) fail('CORRUPT');
    let prepared: PreparedStudioImport;
    try { prepared = parseNativeStudioImportResponse({ prepared: content.prepared }, id, projectId).prepared; } catch { return fail('CORRUPT'); }
    return freeze({ ...content, prepared, recordSha256 });
  }
  async function inventory(io: IO, check: () => void = () => {}): Promise<Map<string, { record: StudioImportPreparationRecord; pin: FilePin }>> {
    check(); paths(); const result = new Map<string, { record: StudioImportPreparationRecord; pin: FilePin }>();
    const entries = await io(() => opendir(directory), d => d.close()); let bytes = 0, files = 0;
    try {
      while (true) {
        const entry = await io(() => entries.read()); if (!entry) break;
        if (++files > limits.records + 1) fail('LIMIT'); if (entry.name === LOCK) { if (!lockPin) fail('LOCKED'); continue; }
        const id = entry.name.slice(0, -5); if (entry.name !== id + '.json' || !UUID.test(id) || !entry.isFile()) fail('CORRUPT');
        if (result.size >= limits.records) fail('LIMIT');
        const pin = await readPinned(join(directory, entry.name), limits.recordBytes, io); if (!pin) fail('CORRUPT');
        bytes += pin.bytes.length; if (bytes > limits.totalBytes) fail('LIMIT'); result.set(id, { pin, record: decode(pin.bytes, id) });
      }
    } finally { await closeResource(entries, io); }
    check(); paths(); return result;
  }
  function capture(actor: NativeAssetActor, id: string, operation: NativeAssetOperation): ConversationWorkBinding {
    assertNativeAssetActor(actor, operation); const scope = nativeAssetActorScope(actor), binding = associations.binding('asset-job', id);
    if (scope.projectPath !== projectPath || scope.projectId !== projectId) fail('SCOPE');
    if (!binding || binding.id !== id || binding.kind !== 'asset-job' || binding.projectId !== projectId || !isDeepStrictEqual(binding.conversation, scope.conversation)) throw new ArcaneError('NOT_FOUND', 'No asset job is bound to this exact native conversation.');
    return binding;
  }
  function verifyWitness(prepared: PreparedStudioImport, witness: StudioImportPreparationWitness): StudioImportPreparationRecord['contextReads'] {
    const target = prepared.manifest.target, session = receipts.session(target.sessionId), proof = session.proof, at = clock();
    const candidates = receipts.activeSessions().filter(s => Number.isFinite(Date.parse(s.lastSeenAt)) && Date.parse(s.lastSeenAt) <= at && at - Date.parse(s.lastSeenAt) <= 30_000);
    if (candidates.length !== 1 || candidates[0]!.id !== session.id || !proof || proof.sessionId !== session.id || proof.clientLifetimeId !== session.clientSessionId ||
      proof.clientLifetimeId !== witness.clientLifetimeId || proof.pluginArtifactHash !== witness.pluginArtifactHash || proof.playEpoch !== witness.playEpoch || proof.mode !== 'Edit' ||
      !proof.connected || !proof.continuitySupported || proof.placeId !== session.placeId || proof.universeId !== session.universeId ||
      !Number.isFinite(Date.parse(proof.observedAt)) || Date.parse(proof.observedAt) > at || !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= at) fail('WITNESS');
    const initial = receipts.command(witness.initialContextReceiptId), confirmed = receipts.command(witness.confirmedContextReceiptId);
    const first = validateStudioImportContextReceipt(initial, session), second = validateStudioImportContextReceipt(confirmed, session);
    if (!isDeepStrictEqual(first, second) || first.mode !== 'Edit' || second.parentRef.instanceId !== target.parentRef ||
      second.placeId !== target.placeId || second.universeId !== target.universeId || initial.finishedAt === null || confirmed.finishedAt === null ||
      !time.safeParse(initial.finishedAt).success || !time.safeParse(confirmed.finishedAt).success ||
      Date.parse(initial.finishedAt) > Date.parse(confirmed.createdAt) || Date.parse(confirmed.finishedAt) > at || at - Date.parse(initial.finishedAt) > 30_000) fail('WITNESS');
    let creator: { kind: 'user' | 'group'; id: string }, provenance: StudioImportPreparationRecord['contextReads']['creatorProvenance'];
    if (second.creator.status === 'available') { creator = { kind: second.creator.kind, id: String(second.creator.id) }; provenance = 'game.CreatorType/CreatorId'; }
    else if (second.placeId === 0 && second.universeId === 0 && second.creator.id === 0 && second.studioUser.status === 'available') {
      creator = { kind: 'user', id: String(second.studioUser.id) }; provenance = 'StudioService:GetUserId';
    } else return fail('WITNESS');
    if (!isDeepStrictEqual(creator, target.creator)) fail('WITNESS');
    return { method: 'scene.import_context', mode: 'Edit', modeProvenance: 'StudioTestService.EditModeActive', creatorProvenance: provenance,
      initial: { requestId: initial.requestId, finishedAt: initial.finishedAt }, confirmed: { requestId: confirmed.requestId, finishedAt: confirmed.finishedAt } };
  }
  async function operation<T>(actor: NativeAssetActor, inputId: string, permission: NativeAssetOperation, guard: () => void,
    work: (id: string, binding: ConversationWorkBinding, io: IO, check: () => void, markWrite: () => void) => Promise<T>): Promise<T> {
    if (closed) fail('CLOSED'); if (poisoned) fail('WRITE_UNKNOWN'); if (busy) fail('BUSY');
    const id = jobId(inputId); if (typeof guard !== 'function' || types.isProxy(guard)) fail('INPUT');
    const binding = capture(actor, id, permission); let wrote = false;
    const check = () => { if (closed) fail('CLOSED'); if (guard() !== undefined) fail('GUARD'); if (!isDeepStrictEqual(capture(actor, id, permission), binding)) fail('SCOPE'); paths(); };
    check(); busy = true; idle = new Promise<void>(accept => { releaseIdle = accept; });
    const io: IO = async (run, abandon) => {
      check(); let value;
      try { value = await run(); } catch (error) { check(); throw error; }
      try { check(); } catch (error) { if (abandon) await abandon(value); throw error; } return value;
    };
    try { const result = await work(id, binding, io, check, () => { wrote = true; }); check(); return result; }
    catch (error) {
      if (wrote || (error instanceof ArcaneError && ['STUDIO_IMPORT_PREPARATION_PATH', 'STUDIO_IMPORT_PREPARATION_LOCKED', 'STUDIO_IMPORT_PREPARATION_CORRUPT'].includes(error.code))) poisoned = true;
      if (error instanceof ArcaneError) throw error; return fail(wrote ? 'WRITE_UNKNOWN' : 'UNAVAILABLE');
    } finally { busy = false; releaseIdle?.(); releaseIdle = undefined; }
  }
  try {
    await inventory(startupIO); paths(); lockAttempted = true;
    const handle = await open(lockPath, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, projectId, writerId: randomUUID() })); await handle.sync(); } finally { await handle.close(); }
    lockPin = await readPinned(lockPath, 1024, startupIO); if (!lockPin) fail('LOCKED'); await inventory(startupIO);
  } catch (error) { if (owners.get(key) === owner) owners.delete(key); if (error instanceof ArcaneError) throw error; fail(lockAttempted && errno(error) === 'EEXIST' ? 'LOCKED' : 'UNAVAILABLE'); }
  return Object.freeze({
    save(actor: NativeAssetActor, inputId: string, value: PreparedStudioImport, inputWitness: StudioImportPreparationWitness, guard: () => void): Promise<void> {
      return operation(actor, inputId, 'mutate', guard, async (id, binding, io, check, markWrite) => {
        const prepared = freeze(parseNativeStudioImportResponse({ prepared: value }, id, projectId).prepared);
        const parsed = witnessSchema.safeParse(fields(inputWitness, ['initialContextReceiptId', 'confirmedContextReceiptId', 'pluginArtifactHash', 'clientLifetimeId', 'playEpoch']));
        if (!parsed.success) fail('INPUT'); const witness = freeze(parsed.data), contextReads = verifyWitness(prepared, witness); check();
        const records = await inventory(io, check), prior = records.get(id);
        if (prior) {
          if (prior.record.projectId !== projectId || prior.record.jobId !== id || !isDeepStrictEqual(prior.record.conversation, binding.conversation) ||
            !isDeepStrictEqual(prior.record.prepared, prepared)) fail('CONFLICT');
          // A fresh host read may have new immutable receipt IDs. Validate it
          // independently, then retain the first record as pending metadata only.
          verifyWitness(prepared, witness); check(); return;
        }
        const content = { schemaVersion: 1 as const, kind: 'studio-import-preparation' as const, projectId, jobId: id,
          conversation: { ...binding.conversation, provider: 'codex' as const }, engineVerification: 'pending' as const,
          recordedAt: new Date(clock()).toISOString(), prepared, witness, contextReads };
        const record = { ...content, recordSha256: digest(content) }, text = JSON.stringify(record), bytes = Buffer.byteLength(text);
        if (bytes > limits.recordBytes || [...records.values()].reduce((n, r) => n + r.pin.bytes.length, 0) + bytes > limits.totalBytes) fail('LIMIT');
        decode(Buffer.from(text), id);
        if (records.size >= limits.records) fail('LIMIT'); check(); verifyWitness(prepared, witness); check();
        let handle: FileHandle | undefined;
        try {
          handle = await io(() => { markWrite(); return open(join(directory, id + '.json'), 'wx', 0o600); }, h => h.close());
          await io(() => handle!.writeFile(text, 'utf8')); await io(() => handle!.sync());
        } finally { if (handle) await closeResource(handle, io); }
        check(); const written = await readPinned(join(directory, id + '.json'), limits.recordBytes, io);
        if (!written || !written.bytes.equals(Buffer.from(text))) fail('CORRUPT'); verifyWitness(prepared, witness); check();
      });
    },
    get(actor: NativeAssetActor, id: string, guard: () => void): Promise<StudioImportPreparationRecord | null> {
      return operation(actor, id, 'read', guard, async (requested, binding, io, check) => {
        const record = (await inventory(io, check)).get(requested)?.record ?? null;
        if (record && !isDeepStrictEqual(record.conversation, binding.conversation)) fail('SCOPE'); return record;
      });
    },
    async close(): Promise<void> {
      if (closed) return; closed = true; await idle;
      try { if (!poisoned) { paths(); await unlink(lockPath); } }
      finally { if (owners.get(key) === owner) owners.delete(key); }
    },
  });
}
