/**
 * "Keep this mesh" (docs/build/MESH_KEEP.md). Procedural Blender meshes placed through assets_place_studio_import are
 * MeshParts backed by in-memory EditableMeshes: they vanish on reconnect, Play or reopening. Keeping one uploads its
 * meshes to the signed-in Studio user's OWN Roblox account with Studio's plugin upload API (AssetService:CreateAssetAsync,
 * plugin side, capability-probed) and swaps the session MeshParts for persistent ones.
 *
 * Human desktop bearer only. Every upload needs the person's click AND a single-use consent that only the desktop main
 * process can deliver, over the daemon's private parent IPC channel, after the person confirmed the trusted Arcane dialog
 * (account, asset name, upload quota). The renderer and agents hold no way to mint it; agents are refused outright.
 * A durable intent receipt is written BEFORE the command is queued; outcomes are reconciled from the plugin receipt and
 * never retried automatically. "Finish keeping" swaps parts for already-uploaded IDs and uploads nothing.
 *
 * GET  /v1/mesh-keep/state         candidates (session-only procedural placements in live sessions) + receipts
 * POST /v1/mesh-keep/prepare       {digest, sessionId, name?} -> {prepareId, account, name, meshCount, placeName}
 * POST /v1/mesh-keep/start         {prepareId, consent} (desktop main only: consent arrives over parent IPC first)
 * POST /v1/mesh-keep/finish        {attemptId} swap-only completion of an "uploaded" receipt
 * POST /v1/mesh-keep/acknowledge   {attemptId} the person checked an unknown outcome; allows a new keep
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicAssetJson } from '../../../packages/asset-pipeline/src/atomic-json.js';
import { noLinks, readRegularFile } from '../../../packages/asset-pipeline/src/paths.js';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { studioUploadContextObservation, type StudioCommand, type StudioSession, type Json } from '../../../packages/protocol/src/studio.js';
import { meshKeepName, validateMeshKeepReceipt, snapshotConvertedMeshKeepObservation, type ConvertedMeshKeepObservation, type ConvertedMeshKeepExpected, type MeshKeepReceipt } from '../../../packages/core/src/mesh-keep-policy.js';
import {inspectConvertedStudioImportTransfer} from '../../../packages/asset-pipeline/src/studio-import-transfer.js';
import type { StudioStore } from '../../../packages/storage/src/studio-store.js';

export const MESH_KEEP_PATHS = Object.freeze(['/v1/mesh-keep/state', '/v1/mesh-keep/prepare', '/v1/mesh-keep/start', '/v1/mesh-keep/finish', '/v1/mesh-keep/acknowledge']);
export const MESH_KEEP_CONSENT_MESSAGE = 'arcane-mesh-keep-consent';
export const MESH_KEEP_SERVICE_LIMITS = Object.freeze({ prepareMs: 120_000, consentWaitMs: 3000, contextWaitMs: 15_000, receipts: 8192, receiptBytes: 8 * 1024 * 1024, prepared: 8, bodyBytes: 4096 });
const DIGEST = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, CONSENT = /^[a-f0-9]{64}$/;
const DESCRIPTION = 'Procedural mesh made with Arcane and kept by its owner.';
const safeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)));
const receiptRecord = z.strictObject({
  attemptId: z.string().regex(UUID), digest: z.string().regex(DIGEST), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  placeName: z.string().max(512), name: z.string().refine(value => { try { meshKeepName(value); return true; } catch { return false; } }),
  creatorId: safeId, meshCount: z.number().int().min(1).max(16).nullable(), consentedAt: timestamp,
  commandId: z.union([z.literal(''), z.string().regex(UUID)]), finishCommandId: z.union([z.literal('pending'), z.string().regex(UUID)]).nullable(),
  state: z.enum(['uploading', 'kept', 'uploaded', 'finishing', 'partial', 'failed', 'unknown']),
  assets: z.array(z.strictObject({ index: z.number().int().min(1).max(16), name: z.string().max(100), assetId: safeId.nullable(),
    upload: z.enum(['succeeded', 'failed', 'reconciliation', 'skipped', 'reused']), reason: z.string().regex(/^[A-Za-z0-9_:]{1,64}$/).nullable(), swapped: z.boolean() })).max(16),
  convertedSource:z.strictObject({formatVersion:z.literal(2),projectId:z.string().regex(DIGEST),jobId:z.string().regex(UUID),runId:z.string().regex(UUID),transferDigest:z.string().regex(DIGEST),graphDigest:z.string().regex(DIGEST),conversionRequestDigest:z.string().regex(DIGEST)}).optional(),
  converted: z.unknown().optional(),
  uploadsStarted: z.number().int().min(0).max(16).nullable(), message: z.string().max(4000), acknowledged: z.boolean(), updatedAt: timestamp,
}).refine(row => row.assets.every((asset, index) => asset.index === index + 1 && (!asset.swapped || asset.assetId !== null)
  && ((asset.upload === 'succeeded' || asset.upload === 'reused') === (asset.assetId !== null)))
  && (row.convertedSource===undefined||row.convertedSource.transferDigest===row.digest)
  && (row.converted===undefined||row.state==='kept'&&(()=>{try{const pin=row.convertedSource;if(!pin)return false;const observation=snapshotConvertedMeshKeepObservation(row.converted,row.assets);return observation.graphDigest===pin.graphDigest&&observation.conversionRequestDigest===pin.conversionRequestDigest;}catch{return false;}})()));
const receiptFile = z.strictObject({ version: z.literal(1), receipts: z.array(receiptRecord).max(MESH_KEEP_SERVICE_LIMITS.receipts) })
  .refine(value => new Set(value.receipts.map(row => row.attemptId)).size === value.receipts.length);

export type MeshKeepReceiptState = 'uploading' | 'kept' | 'uploaded' | 'finishing' | 'partial' | 'failed' | 'unknown';
export interface ConvertedMeshKeepSourcePin {readonly formatVersion:2;readonly projectId:string;readonly jobId:string;readonly runId:string;readonly transferDigest:string;readonly graphDigest:string;readonly conversionRequestDigest:string}
export interface MeshKeepRecord {
  attemptId: string; digest: string; sessionId: string; placeName: string; name: string; creatorId: number; meshCount: number | null;
  consentedAt: string; commandId: string; finishCommandId: string | null; state: MeshKeepReceiptState;
  assets: { index: number; name: string; assetId: number | null; upload: string; reason: string | null; swapped: boolean }[];
  convertedSource?:ConvertedMeshKeepSourcePin;
  converted?:ConvertedMeshKeepObservation;
  uploadsStarted: number | null; message: string; acknowledged: boolean; updatedAt: string;
}
export interface MeshKeepCandidate {
  digest: string; sessionId: string; placeName: string; name: string; jobId: string | null; meshCount: number | null; placedAt: string | null;
  live: boolean; capable: boolean; action: 'keep' | 'finish' | 'none'; receipt: MeshKeepRecord | null;
}
interface Prepared { prepareId: string; digest: string; sessionId: string; name: string; creatorId: number; meshCount: number | null; placeName: string; expires: number; consent: Buffer | null }

export interface MeshKeepOptions {
  store: StudioStore; stateDirectory: string;
  now?: () => number; sleep?: (ms: number) => Promise<void>; uuid?: () => string;
}

const sha = (value: string) => createHash('sha256').update(value).digest();
const clip = (value: string, max = 400) => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, max);

/** Short plain status for the card. Roblox reasons are the engine's own CreateAssetResult names, never guessed. */
export function meshKeepMessage(state: MeshKeepReceiptState, receipt: Pick<MeshKeepRecord, 'assets' | 'meshCount'>, error?: string | null): string {
  const ids = receipt.assets.filter(a => a.assetId !== null).map(a => a.assetId).join(', ');
  const reasons = receipt.assets.map(a => a.reason ?? '').join(' ');
  const engine = /ENGINE_REJECTED:([A-Za-z]+)/.exec(reasons)?.[1] ?? null;
  switch (state) {
    case 'uploading': return 'Uploading to your Roblox account…';
    case 'finishing': return 'Swapping in the uploaded meshes…';
    case 'kept': return `Kept. Saved to your Roblox account (asset ${ids}). The model now uses these meshes and stays after reconnecting, Play and reopening once you save the place.`;
    case 'uploaded': return `Uploaded to your account (asset ${ids}), but Studio could not load the new mesh yet. Roblox may still be processing or moderating it. Try Finish keeping in a few minutes; nothing is uploaded again.`;
    case 'partial': return `Only some meshes uploaded (asset ${ids}). The model still uses session meshes. Check Creator Hub before trying again; Arcane never re-uploads automatically.`;
    case 'unknown': return 'The upload outcome is unknown (Studio disconnected or did not answer). Check your Roblox inventory (Creator Hub, Development Items, Meshes) before keeping it again.' + (ids ? ` Known asset: ${ids}.` : '');
    case 'failed':
      if (engine && /quota|limit|throttl|toomany|exceed/i.test(engine)) return `Roblox refused the upload: upload quota or limit reached (${engine}). Nothing was kept; try again later.`;
      if (engine && /moderat/i.test(engine)) return `Roblox refused the mesh in moderation (${engine}). Nothing was kept.`;
      if (engine) return `Roblox refused the upload (${engine}). This is often the upload quota or an account limit; check Creator Hub. Nothing was kept.`;
      return 'Not kept. ' + (error ? clip(error, 300) : 'Nothing was uploaded.');
  }
}

export function createMeshKeep(options: MeshKeepOptions) {
  const store = options.store, now = options.now ?? Date.now, uuid = options.uuid ?? randomUUID;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const directory = join(options.stateDirectory, 'mesh-keep'), file = join(directory, 'receipts.json');
  const prepared = new Map<string, Prepared>();
  let receipts: MeshKeepRecord[] | null = null, loading: Promise<MeshKeepRecord[]> | null = null;
  let consentChannel = false, writing: Promise<void> = Promise.resolve(), loadFailed = false;
  const iso = () => new Date(now()).toISOString();

  async function load(): Promise<MeshKeepRecord[]> {
    if (receipts) return receipts;
    if (!loading) loading = (async ():Promise<MeshKeepRecord[]> => {
      try {
        await noLinks(options.stateDirectory);
        // Only an initially absent directory/file is fresh state. Losing a file during a checked read is an error.
        let missing = false;
        try { await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true; else throw error; }
        if (!missing) {
          await noLinks(directory);
          try { await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true; else throw error; }
        }
        if (missing) { const fresh:MeshKeepRecord[]=[];receipts = fresh; loadFailed = false; return fresh; }
        const parsed = receiptFile.parse(JSON.parse((await readRegularFile(file, MESH_KEEP_SERVICE_LIMITS.receiptBytes)).toString('utf8')));
        const restored=parsed.receipts.map((row):MeshKeepRecord=>{
          const {convertedSource,converted,...common}=row;
          return {...common,
            ...(convertedSource===undefined?{}:{convertedSource:Object.freeze({...convertedSource})}),
            ...(converted===undefined?{}:{converted:snapshotConvertedMeshKeepObservation(converted,row.assets)})};
        });
        receipts = restored; loadFailed = false;return restored;
      } catch {
        loadFailed = true;
        throw new ArcaneError('MESH_KEEP_RECEIPTS', 'Keep-mesh receipts could not be read; they were left untouched. Nothing new is uploaded until they are repaired.');
      }
    })().finally(() => { loading = null; });
    return loading;
  }
  /** Durable before any queueing: exclusive temporary file, fsync, atomic rename. */
  async function persist(): Promise<void> {
    const list = await load();
    const run = writing.then(async () => {
      const text = JSON.stringify({ version: 1, receipts: list }, null, 1) + '\n';
      if (list.length > MESH_KEEP_SERVICE_LIMITS.receipts || Buffer.byteLength(text) > MESH_KEEP_SERVICE_LIMITS.receiptBytes)
        throw new ArcaneError('MESH_KEEP_RECEIPTS', 'Keep-mesh history exceeds its storage bound. Existing receipts are retained; review the mesh card before trying again.');
      await noLinks(options.stateDirectory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await atomicAssetJson(directory, 'receipts.json', text);
    });
    writing = run.catch(() => undefined);
    await run;
  }

  function command(id: string): StudioCommand | null { try { return store.command(id); } catch { return null; } }
  function apply(record: MeshKeepRecord, receipt: MeshKeepReceipt | null, state: MeshKeepReceiptState, error: string | null): void {
    if (receipt) {
      record.assets = receipt.meshes.map(m => ({ ...m }));
      if('converted'in receipt)record.converted=snapshotConvertedMeshKeepObservation(receipt.converted,receipt.meshes);
      if (record.finishCommandId === null) record.uploadsStarted = receipt.uploadsStarted;
    }
    record.state = state; record.message = meshKeepMessage(state, record, error); record.updatedAt = iso();
  }
  /** Read exact host-owned stage/reconstruction history; observations confer no live authority. */
  function convertedExpected(record:Pick<MeshKeepRecord,'digest'|'sessionId'|'convertedSource'>):{expected:ConvertedMeshKeepExpected;pin:ConvertedMeshKeepSourcePin}|null {
    const source=store.readStageKeepSource(record.sessionId,record.digest);
    if(!source){if(record.convertedSource)throw new ArcaneError('RECEIPT','Pinned converted keep source is unavailable.');return null;}
    const {run,reconstruction}=source;
    if(reconstruction.command.args.formatVersion!==2){if(record.convertedSource)throw new ArcaneError('RECEIPT','Pinned converted keep cannot use legacy reconstruction.');return null;}
    if(run.phase!=='cpu-staged')throw new ArcaneError('RECEIPT','Converted keep lacks completed original stage custody.');
    const first=run.commands[0]?.command.args.packet;
    if(typeof first!=='string')throw new ArcaneError('RECEIPT','Converted keep lacks its original staged begin packet.');
    const begin=JSON.parse(first) as Record<string,unknown>;
    const packets=run.commands.map(row=>{
      const c=row.command;if(c.state!=='succeeded'||typeof c.args.packet!=='string')throw new ArcaneError('RECEIPT','Converted stage is incomplete.');
      const body=JSON.parse(c.args.packet) as Record<string,unknown>;
      return {ordinal:row.ordinal,kind:body.kind,json:c.args.packet,byteLength:Buffer.byteLength(c.args.packet),sha256:createHash('sha256').update(c.args.packet).digest('hex')};
    });
    const graph=begin.graph as Record<string,unknown>;
    const checked=inspectConvertedStudioImportTransfer({formatVersion:2,engineVerification:'pending',preparedDigest:run.intent.preparedDigest,payloadDigest:run.intent.payloadDigest,digest:record.digest,
      packets,byteLength:packets.reduce((total,p)=>total+p.byteLength,0),graphDigest:graph.digest,nodeCount:graph.nodeCount,conversionRequestDigest:begin.conversionRequestDigest});
    const nodes=packets.filter(p=>p.kind==='node').map(p=>(JSON.parse(p.json) as {node:{nodeKey:string;parentKey:string|null}}).node);
    const rows=checked.payload.objects as readonly {object:{sourceObjectId:string};association:{sourceObjectId:string;nodeKey:string|null}}[];
    const pin:ConvertedMeshKeepSourcePin=Object.freeze({formatVersion:2,projectId:run.intent.projectId,jobId:run.intent.jobId,runId:run.runId,transferDigest:record.digest,graphDigest:checked.graph.digest,conversionRequestDigest:checked.conversionRequestDigest});
    const prior=record.convertedSource;
    if(prior&&(prior.formatVersion!==pin.formatVersion||prior.projectId!==pin.projectId||prior.jobId!==pin.jobId||prior.runId!==pin.runId||prior.transferDigest!==pin.transferDigest||prior.graphDigest!==pin.graphDigest||prior.conversionRequestDigest!==pin.conversionRequestDigest))throw new ArcaneError('RECEIPT','Pinned converted keep source changed.');
    return {pin,expected:{transferDigest:record.digest,graphDigest:checked.graph.digest,conversionRequestDigest:checked.conversionRequestDigest,nodes,meshes:rows.map(row=>row.association)}};
  }

  /** Reconcile one receipt from its recorded command(s). Unknown stays unknown; nothing is replayed. */
  function reconcile(record: MeshKeepRecord): boolean {
    const finishing = record.state === 'finishing';
    if (record.state !== 'uploading' && !finishing) return false;
    const c = command(finishing ? record.finishCommandId ?? '' : record.commandId);
    if (!c) { apply(record, null, finishing ? 'uploaded' : 'unknown', null); return true; }
    if (c.state === 'queued' || c.state === 'dispatched') return false;
    if (c.state === 'cancelled') { apply(record, null, finishing ? 'uploaded' : 'failed', 'The Studio connection ended before the request was delivered. Nothing was uploaded.'); return true; }
    if (c.state === 'needs_reconciliation') { apply(record, null, finishing ? 'uploaded' : 'unknown', null); return true; }
    if (c.state === 'failed') { apply(record, null, finishing ? 'uploaded' : 'unknown', c.error); if (finishing) record.message = 'Could not swap in the uploaded meshes: ' + clip(c.error ?? 'Studio refused.', 300) + ' The assets stay in your inventory.'; return true; }
    let receipt: MeshKeepReceipt;
    try {
      receipt=validateMeshKeepReceipt(c.args,c.result);
      const expected=convertedExpected(record);
      if(expected){if(receipt.state==='kept')receipt=validateMeshKeepReceipt(c.args,c.result,expected.expected);}
      else if('converted'in receipt)throw new ArcaneError('RECEIPT','Converted keep lacks original graph custody.');
    } catch {
      // Keep genuine returned IDs even when graph observations cannot be admitted;
      // unresolved history never schedules another upload or invents saved custody.
      try {const common=validateMeshKeepReceipt(c.args,c.result);apply(record,common,'unknown','Converted keep observations could not be verified. Review the original Studio outcome.');delete record.converted;}
      catch {apply(record,null,'unknown',null);}return true;
    }
    const unknown = receipt.meshes.some(m => m.upload === 'reconciliation');
    apply(record, receipt, unknown ? 'unknown' : receipt.state, null);
    return true;
  }
  async function refreshed(): Promise<MeshKeepRecord[]> {
    const list = await load();
    let changed = false;
    for (const record of list) changed = reconcile(record) || changed;
    if (changed) await persist();
    return list;
  }

  function live(session: StudioSession): boolean {
    const proof = session.proof;
    return session.revokedAt === null && !!proof && proof.mode === 'Edit' && proof.connected && Date.parse(proof.expiresAt) > now();
  }
  function placements(): { session: StudioSession; digest: string; name: string; placedAt: string | null; jobId: string | null; meshCount: number | null }[] {
    const out: ReturnType<typeof placements> = [];
    for (const session of store.activeSessions()) {
      const commands = store.commands(session.id);
      const reconstructions = new Map<string, StudioCommand>();
      for (const c of commands) if (c.method === 'asset.reconstruct' && c.state === 'succeeded' && c.result && typeof c.result === 'object' && !Array.isArray(c.result)
        && typeof (c.result as Record<string, Json>).transferDigest === 'string') reconstructions.set((c.result as Record<string, Json>).transferDigest as string, c);
      const seen = new Set<string>();
      for (const c of commands) {
        const watch = c.method === 'scene.place_asset' && c.state === 'succeeded' ? c.args.watch : null;
        if (typeof watch !== 'string' || !watch.startsWith('editable-') || !DIGEST.test(watch.slice(9))) continue;
        const digest = watch.slice(9); if (seen.has(digest)) continue; seen.add(digest);
        const r = reconstructions.get(digest), objects = r ? (r.result as Record<string, Json>).objects : null;
        out.push({ session, digest, name: typeof c.args.name === 'string' ? c.args.name : 'Procedural mesh', placedAt: c.finishedAt,
          jobId: r ? store.stageJobForReconstruction(r.id) : null, meshCount: Array.isArray(objects) ? objects.length : null });
      }
    }
    return out;
  }
  function latest(list: MeshKeepRecord[], digest: string, sessionId: string): MeshKeepRecord | null {
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.digest === digest && list[i]!.sessionId === sessionId) return list[i]!;
    return null;
  }
  /** A new keep is allowed only when nothing is in flight or unresolved for this placement. */
  function blocked(record: MeshKeepRecord | null): string | null {
    if (!record) return null;
    if (record.state === 'kept') return 'This mesh is already kept.';
    if (record.state === 'uploading' || record.state === 'finishing') return 'This mesh is already being kept.';
    if (record.state === 'uploaded') return 'This mesh is already uploaded; use Finish keeping (no new upload).';
    if ((record.state === 'unknown' || record.state === 'partial') && !record.acknowledged) return 'A previous upload outcome is unresolved. Check your Roblox inventory, then confirm you checked it.';
    return null;
  }

  async function state() {
    const list = await refreshed();
    const candidates: MeshKeepCandidate[] = placements().map(p => {
      const receipt = latest(list, p.digest, p.session.id), isLive = live(p.session), capable = p.session.capabilities.includes('asset.keep_mesh');
      const action = !isLive || !capable ? 'none' : receipt?.state === 'uploaded' ? 'finish' : blocked(receipt) ? 'none' : 'keep';
      return { digest: p.digest, sessionId: p.session.id, placeName: p.session.name, name: p.name, jobId: p.jobId, meshCount: p.meshCount, placedAt: p.placedAt, live: isLive, capable, action, receipt };
    });
    return { available: !loadFailed, consentChannel, candidates, receipts: list.slice(-50).reverse() };
  }

  async function waitFor(id: string): Promise<StudioCommand> {
    const deadline = now() + MESH_KEEP_SERVICE_LIMITS.contextWaitMs;
    for (;;) {
      const c = store.command(id);
      if (!['queued', 'dispatched'].includes(c.state)) return c;
      if (now() >= deadline) throw new ArcaneError('STUDIO_TIMEOUT', 'Roblox Studio did not answer in time. Check that Studio is open in Edit mode, then try again. Nothing was uploaded.');
      await sleep(100);
    }
  }
  function session(id: string): StudioSession {
    const s = store.session(id);
    if (!live(s)) throw new ArcaneError('SESSION_OFFLINE', 'Open this place in Roblox Studio (Edit mode, Arcane plugin connected) to keep its mesh. Nothing was uploaded.');
    if (!s.capabilities.includes('asset.keep_mesh')) throw new ArcaneError('PLUGIN_UPDATE_REQUIRED', 'This Studio connection cannot upload meshes: update Roblox Studio and the Arcane plugin, then reconnect. Nothing was uploaded.');
    if (!s.allowWrites || !s.allowedRoots.includes('Workspace')) throw new ArcaneError('SCOPE', 'Keeping a mesh needs a writable Studio connection with Workspace access.');
    return s;
  }

  async function prepare(input: Record<string, unknown>) {
    if (Object.keys(input).some(k => !['digest', 'sessionId', 'name'].includes(k))) throw new ArcaneError('INPUT', 'Unexpected keep-mesh field.');
    if (typeof input.digest !== 'string' || !DIGEST.test(input.digest) || typeof input.sessionId !== 'string' || input.sessionId.length > 128) throw new ArcaneError('INPUT', 'Choose one placed procedural mesh.');
    if (!consentChannel) throw new ArcaneError('MESH_KEEP_DESKTOP', 'Keep this mesh needs the Arcane desktop app, which asks you to confirm every upload.');
    const list = await refreshed(), placement = placements().find(p => p.digest === input.digest && p.session.id === input.sessionId);
    if (!placement) throw new ArcaneError('NOT_FOUND', 'This mesh is not placed in a connected Studio session any more. Generate and place it again.');
    const reason = blocked(latest(list, placement.digest, placement.session.id)); if (reason) throw new ArcaneError('MESH_KEEP_STATE', reason);
    const s = session(placement.session.id);
    const name = meshKeepName(input.name === undefined ? placement.name : input.name);
    // Fresh observation of the signed-in Studio user: the account the upload will go to (re-checked by the plugin).
    const read = store.enqueue({ sessionId: s.id, requestId: 'keep-context-' + uuid(), method: 'scene.upload_context', args: {} });
    const done = await waitFor(read.id);
    if (done.state !== 'succeeded') throw new ArcaneError('STUDIO_CONTEXT', 'Studio could not report the signed-in account: ' + clip(done.error ?? 'no answer', 200) + ' Nothing was uploaded.');
    const context = studioUploadContextObservation(done.result);
    if (context.mode !== 'Edit') throw new ArcaneError('PLAY', 'Stop the playtest first; meshes are kept in Edit mode.');
    if (context.uploader.status !== 'available') throw new ArcaneError('STUDIO_ACCOUNT', 'Sign in to Roblox Studio first: the mesh is uploaded to the account signed in to Studio.');
    for (const [key, entry] of prepared) if (entry.expires <= now()) prepared.delete(key);
    if (prepared.size >= MESH_KEEP_SERVICE_LIMITS.prepared) throw new ArcaneError('BUSY', 'Too many keep confirmations are open. Answer or cancel them first.');
    const entry: Prepared = { prepareId: uuid(), digest: placement.digest, sessionId: s.id, name, creatorId: context.uploader.id, meshCount: placement.meshCount, placeName: s.name, expires: now() + MESH_KEEP_SERVICE_LIMITS.prepareMs, consent: null };
    prepared.set(entry.prepareId, entry);
    return { prepareId: entry.prepareId, account: { kind: 'user', userId: entry.creatorId }, name, meshCount: entry.meshCount, placeName: entry.placeName, expiresAt: new Date(entry.expires).toISOString() };
  }

  /** Parent-IPC only (product-main). Returns whether the consent was recorded for a live prepared request. */
  function acceptConsent(message: unknown): boolean {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    const m = message as Record<string, unknown>;
    if (Object.keys(m).length !== 4 || m.type !== MESH_KEEP_CONSENT_MESSAGE || m.protocolVersion !== 1 || typeof m.prepareId !== 'string' || typeof m.consent !== 'string' || !CONSENT.test(m.consent)) return false;
    const entry = prepared.get(m.prepareId);
    if (!entry || entry.expires <= now() || entry.consent) return false;
    entry.consent = sha(m.consent); return true;
  }

  async function start(input: Record<string, unknown>) {
    if (Object.keys(input).length !== 2 || typeof input.prepareId !== 'string' || typeof input.consent !== 'string' || !CONSENT.test(input.consent)) throw new ArcaneError('INPUT', 'Expected one confirmed keep request.');
    const entry = prepared.get(input.prepareId);
    if (!entry || entry.expires <= now()) throw new ArcaneError('MESH_KEEP_CONSENT', 'This confirmation expired. Click Keep this mesh again. Nothing was uploaded.');
    const deadline = now() + MESH_KEEP_SERVICE_LIMITS.consentWaitMs;
    while (!entry.consent && now() < deadline) await sleep(25);
    const supplied = sha(input.consent), recorded = entry.consent;
    prepared.delete(entry.prepareId); // single use: any start attempt consumes the confirmation, right or wrong
    if (!recorded || !timingSafeEqual(recorded, supplied)) throw new ArcaneError('MESH_KEEP_CONSENT', 'Uploads need your confirmation in the Arcane dialog. Nothing was uploaded.');
    const assertConsent = () => {
      if (entry.expires <= now()) throw new ArcaneError('MESH_KEEP_CONSENT', 'This confirmation expired. Click Keep this mesh again. Nothing was uploaded.');
    };
    const list = await refreshed();
    assertConsent();
    const reason = blocked(latest(list, entry.digest, entry.sessionId)); if (reason) throw new ArcaneError('MESH_KEEP_STATE', reason);
    const s = session(entry.sessionId), proof = s.proof!;
    const convertedSource=convertedExpected({digest:entry.digest,sessionId:s.id})?.pin;
    const attemptId = uuid();
    const record: MeshKeepRecord = { attemptId, digest: entry.digest, sessionId: s.id, placeName: entry.placeName, name: entry.name, creatorId: entry.creatorId,
      ...(convertedSource?{convertedSource}:{}),meshCount: entry.meshCount, consentedAt: iso(), commandId: '', finishCommandId: null, state: 'uploading', assets: [], uploadsStarted: null,
      message: meshKeepMessage('uploading', { assets: [], meshCount: entry.meshCount }), acknowledged: false, updatedAt: iso() };
    list.push(record);
    await persist(); // intent is durable before anything can reach Studio
    let queued: StudioCommand;
    try {
      queued = store.enqueueMeshKeep({ sessionId: s.id, requestId: 'keep-' + attemptId, method: 'asset.keep_mesh', args: {
        source: 'editable-' + entry.digest, attemptId, name: entry.name, description: DESCRIPTION, creatorId: entry.creatorId,
        continuity: { clientLifetimeId: proof.clientLifetimeId, pluginArtifactHash: proof.pluginArtifactHash, playEpoch: proof.playEpoch }, finish: false } }, assertConsent);
    } catch (error) {
      apply(record, null, 'failed', error instanceof Error ? error.message : 'Could not queue the request.'); await persist(); throw error;
    }
    record.commandId = queued.id; record.updatedAt = iso(); await persist();
    return { receipt: record };
  }

  async function finish(input: Record<string, unknown>) {
    if (Object.keys(input).length !== 1 || typeof input.attemptId !== 'string' || !UUID.test(input.attemptId)) throw new ArcaneError('INPUT', 'Choose one uploaded mesh.');
    const list = await refreshed(), record = list.find(r => r.attemptId === input.attemptId);
    if (!record || record.state !== 'uploaded' || record.assets.length === 0 || record.assets.some(a => a.assetId === null)) throw new ArcaneError('MESH_KEEP_STATE', 'Only an uploaded mesh waiting for its swap can be finished.');
    if(record.convertedSource)convertedExpected(record);
    const s = session(record.sessionId), proof = s.proof!;
    record.finishCommandId = 'pending'; record.state = 'finishing'; record.message = meshKeepMessage('finishing', record); record.updatedAt = iso();
    await persist();
    try {
      const queued = store.enqueueMeshKeep({ sessionId: s.id, requestId: 'keep-finish-' + uuid(), method: 'asset.keep_mesh', args: {
        source: 'editable-' + record.digest, attemptId: uuid(), name: record.name, description: DESCRIPTION, creatorId: record.creatorId,
        continuity: { clientLifetimeId: proof.clientLifetimeId, pluginArtifactHash: proof.pluginArtifactHash, playEpoch: proof.playEpoch },
        finish: true, assetIds: record.assets.map(a => a.assetId as number) } }, () => {});
      record.finishCommandId = queued.id;
    } catch (error) { record.state = 'uploaded'; record.finishCommandId = null; record.message = 'Could not swap: ' + clip(error instanceof Error ? error.message : 'Studio refused.', 300); }
    record.updatedAt = iso(); await persist();
    return { receipt: record };
  }

  async function acknowledge(input: Record<string, unknown>) {
    if (Object.keys(input).length !== 1 || typeof input.attemptId !== 'string' || !UUID.test(input.attemptId)) throw new ArcaneError('INPUT', 'Choose one receipt.');
    const list = await refreshed(), record = list.find(r => r.attemptId === input.attemptId);
    if (!record || (record.state !== 'unknown' && record.state !== 'partial')) throw new ArcaneError('MESH_KEEP_STATE', 'Only an unresolved upload can be confirmed as checked.');
    record.acknowledged = true; record.updatedAt = iso(); await persist();
    return { receipt: record };
  }

  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  };
  async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new ArcaneError('CONTENT_TYPE', 'Expected application/json.');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of request) { const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string); bytes += chunk.length; if (bytes > MESH_KEEP_SERVICE_LIMITS.bodyBytes) throw new ArcaneError('BODY_LIMIT', 'Request is too large.'); chunks.push(chunk); }
    let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ArcaneError('JSON', 'Invalid JSON request.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new ArcaneError('INPUT', 'Expected a JSON object.');
    return value as Record<string, unknown>;
  }
  let serial: Promise<unknown> = Promise.resolve();
  const one = <T>(work: () => Promise<T>): Promise<T> => { const next = serial.then(work, work); serial = next.catch(() => undefined); return next; };

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL, controlToken: string, origin: string): Promise<boolean> {
    if (!MESH_KEEP_PATHS.includes(url.pathname)) return false;
    try {
      const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      if (!controlToken || Buffer.byteLength(supplied) !== Buffer.byteLength(controlToken) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(controlToken)))
        throw new ArcaneError('SCOPE', 'Keep this mesh is available to the person in the Arcane desktop app only.');
      if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new ArcaneError('ORIGIN', 'Cross-origin access refused.');
      if (url.search) throw new ArcaneError('INPUT', 'Unexpected query.');
      if (url.pathname === '/v1/mesh-keep/state') { if (request.method !== 'GET') throw new ArcaneError('METHOD', 'Expected GET.'); send(response, 200, await one(state)); return true; }
      if (request.method !== 'POST') throw new ArcaneError('METHOD', 'Expected POST.');
      const input = await body(request);
      const work: () => Promise<unknown> = url.pathname === '/v1/mesh-keep/prepare' ? () => prepare(input) : url.pathname === '/v1/mesh-keep/start' ? () => start(input)
        : url.pathname === '/v1/mesh-keep/finish' ? () => finish(input) : () => acknowledge(input);
      // prepare waits on Studio; it runs outside the receipt queue so state reads stay responsive.
      send(response, 200, url.pathname === '/v1/mesh-keep/prepare' ? await work() : await one(work));
    } catch (error) {
      const known = error instanceof ArcaneError, code = known ? error.code : 'INTERNAL';
      const status = code === 'SCOPE' || code === 'ORIGIN' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'METHOD' ? 405 : ['MESH_KEEP_STATE', 'MESH_KEEP_CONSENT', 'SESSION_OFFLINE', 'BUSY', 'RECONCILIATION'].includes(code) ? 409 : known ? 400 : 500;
      if (!response.headersSent && !response.destroyed) send(response, status, { error: code, message: known ? error.message : 'Keep this mesh could not finish locally. Review the mesh card before trying again.' });
    }
    return true;
  }

  return Object.freeze({
    handle, acceptConsent, state, prepare, start, finish, acknowledge,
    /** product-main enables this only when a desktop parent IPC channel exists. */
    enableConsentChannel(): void { consentChannel = true; },
  });
}
export type MeshKeep = ReturnType<typeof createMeshKeep>;
