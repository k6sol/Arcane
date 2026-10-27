import { DatabaseSync } from 'node:sqlite';
import { sqliteTransportPath } from './sqlite-path.js';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import { z } from 'zod';
import { ArcaneError } from '../../protocol/src/providers.js';
import { STUDIO_ASSET_TRANSFER_LIMITS, isWrite, instanceRef, jsonObject, methodField, object, roots, textField, ROOTS, STUDIO_PROTOCOL, STUDIO_FEATURE_CAPABILITIES, STUDIO_PAIRING_CAPABILITY_LIMIT, SCENE_BUILD_LIMITS, type InstanceRef, type Json, type PairingGrant, type PairResult, type StudioCommand, type StudioSession } from '../../protocol/src/studio.js';
import { parseStudioImportRevisionArgs, parseStudioImportObservationArgs, validateStudioImportObservationReceipt, validateStudioImportRevisionReceipt, canonical, validateCommandArgs, sceneBuildInstanceCount, isGuiClass } from '../../core/src/studio-policy.js';
import { isAssetMethod, validateAssetReceipt } from '../../core/src/studio-asset-policy.js';
import { terrainVoxelCount } from '../../core/src/terrain-policy.js';
import { validateMeshKeepReceipt } from '../../core/src/mesh-keep-policy.js';
import { nativePropertiesMatch } from '../../core/src/native-property-outcomes.js';
import { guiEditReceiptMatches } from '../../core/src/gui-property-outcomes.js';
import type { ScriptSourceVerifier, ScriptSourceVerification } from '../../core/src/script-source-verifier.js';
import type { StudioAssetStageArgs, StudioAssetStageReceipt, StudioAssetReconstructArgs, StudioAssetReconstructReceipt } from '../../protocol/src/studio.js';
import type { StudioImportObservationArgs, StudioImportObservationReceipt, StudioImportObservationSource, StudioImportObservationWitness, StudioImportRevisionArgs, StudioImportRevisionReceipt } from '../../protocol/src/studio.js';
import type { NativeConversation } from './conversation-work-store.js';
import {inspectConvertedStudioImportTransfer,parseConvertedStudioImportTransferPacket} from '../../asset-pipeline/src/studio-import-transfer.js';
import {studioImportObservationReceiptDigest} from '../../asset-pipeline/src/studio-import-manifest.js';
import { ASSET_CONVERSATION_PROVIDERS } from '../../protocol/src/asset-conversation.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
interface Options { directory: string; now?: () => number }
export type StudioNativeCustodyOperation = 'playtest-prepare'|'viewport'|'playtest-revalidate'|'asset-search'|'asset-insert'|'asset-job';
export type StudioNativeCustodyEvidence = 'native'|'fixture';
export type StudioNativeCustodyReason = 'close-unconfirmed'|'scope-lost'|'storage-unavailable';
/** Original process-local identity only; its serialized spelling is never a permit. */
export interface StudioNativeCustodyTicket {readonly kind:'studio-native-custody-ticket'}
export interface StudioNativeCustodyPort {
  readonly projectId:string;readonly ownerEpoch:string;
  assertReady():void;
  reserve(operation:StudioNativeCustodyOperation,evidence:StudioNativeCustodyEvidence):StudioNativeCustodyTicket;
  quarantine(ticket:StudioNativeCustodyTicket,reason:StudioNativeCustodyReason):void;
  settleNoStart(ticket:StudioNativeCustodyTicket):void;
  settleNativeClosed(ticket:StudioNativeCustodyTicket):void;
  settleFixtureClosed(ticket:StudioNativeCustodyTicket):void;
  retireAdmissions():void;
}
export interface ArcaneKeySummary {keyId:string;allowedRoots:StudioSession['allowedRoots'];allowWrites:boolean;issuedAt:string;revokedAt:string|null;lastUsedAt:string|null}
export type ArcaneKeyIssue = ArcaneKeySummary & { apiKey: string };
export interface AssetUploadIntent {
  projectId: string; jobId: string; sourceId: string; sourceSha256: string; assetType: 'Mesh' | 'Image';
  sessionId: string; clientLifetimeId: string; pluginArtifactHash: string; playEpoch: number;
  placeId: number; universeId: number; creator: {kind: 'user' | 'group'; id: number}; uploaderId: number;
  rightsGrantId: string; name: string; description: string;
}
export interface AssetUploadJournalRecord {
  attemptId: string; resourceKey: string; intent: AssetUploadIntent; intentSha256: string;
  state: 'intent' | 'succeeded' | 'needs_reconciliation'; assetId: number | null; createdAt: string; updatedAt: string;
}
/** Opaque host fact-recording handle. It is NOT permission to upload. */
export interface AssetUploadJournalTicket {readonly kind: 'asset-upload-journal-ticket'}
/** Original queue-time continuity facts, not upload permission or current proof. */
export interface AssetUploadContextPin {
  readonly sessionId:string;readonly clientLifetimeId:string;readonly pluginArtifactHash:string;
  readonly playEpoch:number;readonly placeId:number;readonly universeId:number;
}
/** A paired plugin polls every 2 s. Its longest healthy silence is one 10 s HTTP timeout plus the
 * 30 s maximum network backoff (plugin/src/Transport.luau); unloading sends no disconnect, so a
 * session unseen for longer than this is a dead Studio lifetime, not a substitute target. */
export const STUDIO_SESSION_LIVE_MS = 60_000;
export type ListedStudioSession = StudioSession & { live: boolean };
/** Before/after source of one succeeded script.update receipt (display path only; never authority). */
export interface StudioScriptChange { commandId: string; path: string; className: string | null; before: string; after: string }
/** Studio pairing (docs/studio-pairing.md). A human click in Arcane mints one in-memory, single-use offer with a 10 minute
 * expiry, bound to this daemon's loopback port and project. Its 6-digit code is shown only in Arcane and typed into the
 * plugin. Two-sided: Arcane proves it knows the code first (so a process squatting the discovery port cannot pass as
 * Arcane), the plugin proves it second, and the key is issued only after the user approves the named place in Arcane. */
export const STUDIO_PAIRING_OFFER_MS = 10 * 60_000;
export interface StudioPairingClaim { placeName: string; placeId: number; universeId: number; sessionId: string; keyId: string; claimedAt: string }
/** The place waiting for the user's Approve in Arcane (display data only). */
export interface StudioPairingRequest { placeName: string; placeId: number; universeId: number; requestedAt: string; approved: boolean }
export interface StudioPairingOfferView {
  offerId: string; code: string; issuedAt: string; expiresAt: string; state: 'pending' | 'awaiting-approval' | 'claimed' | 'expired' | 'cancelled' | 'failed';
  allowedRoots: StudioSession['allowedRoots']; allowWrites: boolean; claim: StudioPairingClaim | null; request: StudioPairingRequest | null;
}
/** Discovery never carries the code: a process that reads it still cannot pass either proof. */
export interface StudioPairingDiscovery { protocolVersion: 1; port: number; ticket: string; expiresAt: string }
export type StudioPairingClaimResult = (PairResult & { apiKey: string }) | { state: 'awaiting-approval'; expiresAt: string };
/** HMAC-SHA256 keyed by the 6-digit code over a role-separated transcript; the plugin computes the same (Transport.luau). */
export function studioPairingProof(code: string, role: 'arcane' | 'plugin', ticket: string, clientNonce: string): string {
  return createHmac('sha256', code).update('arcane-pair-v2|' + role + '|' + ticket + '|' + clientNonce).digest('hex');
}
const PAIRING_NONCE = /^[a-f0-9]{32}$/;
type PairingOfferRecord = { view: StudioPairingOfferView; ticket: string | null; ticketHash: string; port: number; projectId: string; expires: number;
  clientNonce: string | null; request: { identity: Record<string, unknown>; proof: string } | null };
const PAIRING_PROOF = /^[a-f0-9]{64}$/;
const PAIRING_TICKET = /^arcane_pair_v1_([1-9][0-9]{0,4})_([a-f0-9]{48})$/;
/** Non-method capability: the plugin reports bounded Studio output errors/warnings on its poll. */
export const STUDIO_DIAGNOSTICS_CAPABILITY = 'studio.diagnostics';
/** In-memory only. Diagnostics are display data for the human dock, never command authority. */
export const STUDIO_DIAGNOSTIC_LIMITS = Object.freeze({entries:100,perReport:10,reportBytes:96*1024,sessions:16,messageChars:2048,stackChars:2048,sourceChars:512,idChars:64,maxCount:1_000_000_000});
export interface StudioDiagnostic {
  id:string;kind:'error'|'warning';message:string;source:string|null;line:number|null;stack:string|null;
  count:number;firstAt:string;lastAt:string;
}
export interface StudioDiagnosticGroup {sessionId:string;placeName:string;placeId:number;live:boolean;entries:StudioDiagnostic[]}
export const STUDIO_STAGE_RUN_LIMITS = Object.freeze({packets:STUDIO_ASSET_TRANSFER_LIMITS.packets,rawBytes:STUDIO_ASSET_TRANSFER_LIMITS.rawBytes,envelopeBytes:STUDIO_ASSET_TRANSFER_LIMITS.envelopeBytes,argumentBytes:STUDIO_ASSET_TRANSFER_LIMITS.packetBytes,runs:64});
export interface StageRunHandle {readonly kind:'studio-stage-run-handle'}
export interface StageRunIntent {
  projectId:string;jobId:string;conversation:Readonly<NativeConversation>;
  transferDigest:string;payloadDigest:string;manifestDigest:string;preparedDigest:string;
  target:StudioAssetStageArgs['target'];continuity:StudioAssetStageArgs['continuity'];
  preparationAttemptId?:string;
  /** Absent only in historical runs created before model review enforcement. */
  modelReview?:Readonly<{reviewId:string;subjectDigest:string;revision:number}>;
  plan:readonly {ordinal:number;argsSha256:string;packetByteLength:number;envelopeByteLength:number;expectedReceipt:StudioAssetStageReceipt}[];
}
export interface StageRunCommandAssociation {
  ordinal:number;commandId:string;requestId:string;leaseEpoch:number;fingerprint:string;command:StudioCommand;
}
export interface StageRunRecord {
  attempt:number;previousRunId:string|null;
  runId:string;intent:StageRunIntent;intentSha256:string;createdAt:string;updatedAt:string;closedAt:string|null;
  phase:'running'|'cpu-staged'|'stopped'|'needs_reconciliation';
  commands:StageRunCommandAssociation[];receipt:StudioAssetStageReceipt|null;
}
export type StageRunBeginResult =
  | {created:true;runId:string;handle:StageRunHandle;record:StageRunRecord}
  | {created:false;runId:string;handle:null;record:StageRunRecord};
export interface ConvertedImportSourcePin {
  readonly runId:string;readonly intentSha256:string;readonly source:StudioImportObservationSource;
  readonly target:StudioAssetStageArgs['target'];readonly continuity:StudioAssetStageArgs['continuity'];
  readonly placementId:string;readonly placementSha256:string;readonly keeps:readonly {readonly id:string;readonly sha256:string}[];
}
export interface ConvertedImportSourceRecord {
  readonly run:StageRunRecord;readonly reconstruction:StageReconstructionRecord;readonly placement:StudioCommand;
  readonly source:StudioImportObservationSource;readonly keeps:readonly StudioCommand[];
}
export interface StageReconstructionRecord {runId:string;command:StudioCommand;receipt:StudioAssetReconstructReceipt|null}
/** Process-local host authority. Neither its JSON spelling nor a job ID is a permit. */
export interface StudioTestReservation {readonly kind:'studio-test-reservation'}
export interface StudioTestTemporaryEdit {id:string;ref:InstanceRef;expected:Record<string,Json>;properties:Record<string,Json>}
export const STUDIO_TEST_RESERVATION_LIMITS=Object.freeze({edits:4,liveOwners:64,reservations:64,commands:512,argumentBytes:32*1024});
interface TestReservationEdit {id:string;args:Record<string,Json>;setupRequestId:string;restoreRequestId:string}
interface TestReservationRecord {
  id:string;sessionId:string;jobId:string;sessionIdentity:string;
  proof:{pluginArtifactHash:string;markerName:string;playEpoch:number}|null;
  setup:TestReservationEdit[];
}
interface TestCommandAdmission {reservation:TestReservationRecord;edit:TestReservationEdit;role:'setup'|'restore'}
const testSessionIdentity=(s:StudioSession)=>canonical({id:s.id,clientSessionId:s.clientSessionId,placeId:s.placeId,universeId:s.universeId,
  pluginVersion:s.pluginVersion,allowedRoots:s.allowedRoots,allowWrites:s.allowWrites,capabilities:s.capabilities,revokedAt:s.revokedAt});
/** Bound the copy before JSON serialization, and never invoke caller code. */
function testSetupSnapshot(value:unknown):unknown {
  let nodes=0,bytes=0;
  const charge=(text:string)=>{if(text.length>STUDIO_TEST_RESERVATION_LIMITS.argumentBytes||(bytes+=Buffer.byteLength(text)+2)>STUDIO_TEST_RESERVATION_LIMITS.argumentBytes)throw new ArcaneError('TEST_BUDGET','Temporary setup exceeds its argument bound.');};
  const copy=(v:unknown,depth:number):unknown=>{
    if(++nodes>1024||depth>8)throw new ArcaneError('TEST_BUDGET','Temporary setup exceeds its structure bound.');
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
    if(typeof v==='string'){charge(v);return v;}
    if(!v||typeof v!=='object'||types.isProxy(v))throw new ArcaneError('TEST_SETUP','Expected plain temporary setup data.');
    const array=Array.isArray(v),prototype=Object.getPrototypeOf(v),keys=Reflect.ownKeys(v);
    if((array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)||keys.length>(array?65:64))throw new ArcaneError('TEST_SETUP','Temporary setup requires bounded plain data.');
    const out:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
    for(const key of keys){
      if(array&&key==='length')continue;
      const descriptor=typeof key==='string'?Object.getOwnPropertyDescriptor(v,key):undefined;
      if(typeof key!=='string'||!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable||key==='__proto__')throw new ArcaneError('TEST_SETUP','Temporary setup requires data properties.');
      charge(key);out[key]=copy(descriptor.value,depth+1);
    }
    if(array){if(keys.length!==(v as unknown[]).length+1||Object.keys(out).some((key,i)=>key!==String(i)))throw new ArcaneError('TEST_SETUP','Temporary setup requires dense bounded arrays.');return Object.values(out);}
    return out;
  };
  return copy(value,0);
}
type StageRunStored = Omit<StageRunRecord,'phase'|'commands'|'receipt'|'attempt'|'previousRunId'>;
const stageHash=z.string().length(64).regex(/^[a-f0-9]{64}(?![\s\S])/);
const stageJob=z.string().length(36).regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/);
const stageId=z.string().min(1).max(256).refine(v=>!/[\x00-\x1f\x7f]/.test(v));
const stageNumber=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uploadText=(max:number,min=1)=>z.string().min(min).max(max).refine(value=>!value.includes('\0'));
const uploadJournalSchema=z.strictObject({attemptId:stageJob,resourceKey:stageHash,intentSha256:stageHash,
  intent:z.strictObject({projectId:stageHash,jobId:stageJob,sourceId:uploadText(256),sourceSha256:stageHash,assetType:z.enum(['Mesh','Image']),
    sessionId:uploadText(256),clientLifetimeId:uploadText(256),pluginArtifactHash:stageHash,playEpoch:stageNumber,placeId:stageNumber,universeId:stageNumber,
    creator:z.strictObject({kind:z.enum(['user','group']),id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}),
    uploaderId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),rightsGrantId:uploadText(256),name:uploadText(100),description:uploadText(1000,0)}),
  state:z.enum(['intent','succeeded','needs_reconciliation']),assetId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()}).refine(record=>record.state==='succeeded'?record.assetId!==null:record.assetId===null);
const uploadContextPinSchema=z.strictObject({sessionId:stageId,clientLifetimeId:stageId,pluginArtifactHash:stageHash,
  playEpoch:stageNumber,placeId:stageNumber,universeId:stageNumber});
const stageReceiptSchema=z.strictObject({transferDigest:stageHash,packetCount:z.number().int().min(1).max(512),
  byteLength:z.number().int().min(1).max(STUDIO_ASSET_TRANSFER_LIMITS.rawBytes),state:z.enum(['receiving','sealed']),engineVerification:z.literal('pending')});
const stageIntentSchema=z.strictObject({projectId:stageHash,jobId:stageJob,
  preparationAttemptId:stageJob.optional(),
  modelReview:z.strictObject({reviewId:stageJob,subjectDigest:stageHash,revision:z.number().int().min(1).max(4096)}).optional(),
  conversation:z.strictObject({provider:z.enum(ASSET_CONVERSATION_PROVIDERS),threadId:stageId,sessionId:stageId.nullable()}),
  transferDigest:stageHash,payloadDigest:stageHash,manifestDigest:stageHash,preparedDigest:stageHash,
  target:z.strictObject({sessionId:stageId,placeId:stageNumber,universeId:stageNumber,root:z.literal('Workspace'),parentRef:stageId,
    creator:z.strictObject({kind:z.enum(['user','group']),id:z.string().regex(/^[1-9][0-9]{0,15}(?![\s\S])/).refine(v=>Number.isSafeInteger(Number(v)))})}),
  continuity:z.strictObject({clientLifetimeId:stageId,pluginArtifactHash:stageHash,playEpoch:stageNumber}),
  plan:z.array(z.strictObject({ordinal:z.number().int().min(0).max(511),argsSha256:stageHash,
    packetByteLength:z.number().int().min(1).max(256*1024),envelopeByteLength:z.number().int().min(1).max(256*1024),expectedReceipt:stageReceiptSchema})).min(1).max(512),
});
/** Reject accessors/proxies before serializing host facts; never invoke caller code. */
function stageSnapshot(value:unknown):unknown {
  let nodes=0;
  const copy=(v:unknown,depth:number):unknown=>{
    if(++nodes>20000||depth>12)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage journal exceeds its bounded structure.');
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
    if(typeof v==='string'){if(Buffer.byteLength(v)>8*1024*1024)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage field exceeds its bound.');return v;}
    if(!v||typeof v!=='object'||types.isProxy(v))throw new ArcaneError('STUDIO_STAGE_INPUT','Expected plain stage facts.');
    const array=Array.isArray(v),prototype=Object.getPrototypeOf(v),keys=Reflect.ownKeys(v);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw new ArcaneError('STUDIO_STAGE_INPUT','Expected plain stage facts.');
    const descriptors=Object.getOwnPropertyDescriptors(v),out:Record<string,unknown>={};
    if(keys.length>513)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage structure exceeds its bound.');
    for(const key of keys){
      if(array&&key==='length')continue;
      const d=typeof key==='string'?descriptors[key]:undefined;
      if(!d||!Object.hasOwn(d,'value')||!d.enumerable||key==='__proto__')throw new ArcaneError('STUDIO_STAGE_INPUT','Expected data-only stage facts.');
      out[key as string]=copy(d.value,depth+1);
    }
    if(array){if(keys.length!==(v as unknown[]).length+1||Object.keys(out).some((key,i)=>key!==String(i)))throw new ArcaneError('STUDIO_STAGE_INPUT','Expected dense stage arrays.');return Object.values(out);}
    return out;
  };
  return copy(value,0);
}
function stageIntent(value:unknown):StageRunIntent {
  const parsed=stageIntentSchema.safeParse(stageSnapshot(value));
  if(!parsed.success)throw new ArcaneError('STUDIO_STAGE_INPUT','Invalid bounded stage intent.');
  const {preparationAttemptId,modelReview,...rest}=parsed.data;
  const intent:StageRunIntent={...rest,...(preparationAttemptId===undefined?{}:{preparationAttemptId}),...(modelReview===undefined?{}:{modelReview})};let packets=0,envelopes=0;
  for(const [ordinal,p]of intent.plan.entries()){
    packets+=p.packetByteLength;envelopes+=p.envelopeByteLength;
    if(p.ordinal!==ordinal||p.envelopeByteLength<p.packetByteLength||p.expectedReceipt.transferDigest!==intent.transferDigest
      ||p.expectedReceipt.packetCount!==ordinal+1||p.expectedReceipt.byteLength!==packets
      ||p.expectedReceipt.state!==(ordinal===intent.plan.length-1?'sealed':'receiving'))throw new ArcaneError('STUDIO_STAGE_INPUT','Stage accounting is inconsistent.');
  }
  if(packets>STUDIO_STAGE_RUN_LIMITS.rawBytes||envelopes>STUDIO_STAGE_RUN_LIMITS.envelopeBytes)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage exceeds its raw-transfer or complete-envelope byte bound.');
  return intent;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stageContinuityKey = (intent:StageRunIntent) => hash(canonical({sessionId:intent.target.sessionId,clientLifetimeId:intent.continuity.clientLifetimeId,playEpoch:intent.continuity.playEpoch}));
const nativeCustodyOperations=['playtest-prepare','viewport','playtest-revalidate','asset-search','asset-insert','asset-job'] as const;
const nativeCustodyReasons=['close-unconfirmed','scope-lost','storage-unavailable'] as const;
const nativeCustodySchema=z.strictObject({schemaVersion:z.literal(1),slot:z.number().int().min(1).max(64),custodyId:stageJob,
  projectId:stageHash,ownerEpoch:stageJob,operation:z.enum(nativeCustodyOperations),evidence:z.enum(['native','fixture']),
  state:z.enum(['pending','quarantined','settled']),createdAt:z.iso.datetime(),settledAt:z.iso.datetime().nullable(),
  settlement:z.enum(['no-start','native-close','fixture-close']).nullable(),reason:z.enum(nativeCustodyReasons).nullable()});
type NativeCustodyRecord=z.infer<typeof nativeCustodySchema>;
type NativePhysicalIdentity={path:string;physical:string;dev:bigint;ino:bigint};
const nativeCustodyMessage='Studio native operations are paused because Arcane could not confirm that an owned SDK connection closed. Saved playtest reports remain available. Edit-mode record repair cannot settle this connection. Do not retry native work or delete the retained records.';
function nativeCustodyFailure():never {throw new ArcaneError('SDK_CUSTODY_UNCONFIRMED',nativeCustodyMessage);}
const sameNativePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const sameNativeIdentity=(a:Pick<BigIntStats,'dev'|'ino'>,b:Pick<BigIntStats,'dev'|'ino'>)=>a.dev===b.dev&&a.ino===b.ino;
function nativeFile(path:string,fd?:number):BigIntStats {
  const named=lstatSync(path,{bigint:true});
  if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1n||named.ino===0n)nativeCustodyFailure();
  if(fd!==undefined){const opened=fstatSync(fd,{bigint:true});if(!opened.isFile()||opened.nlink!==1n||!sameNativeIdentity(named,opened))nativeCustodyFailure();}
  return named;
}
function nativeIdentity(path:string,stat:BigIntStats):NativePhysicalIdentity {return {path,physical:realpathSync(path),dev:stat.dev,ino:stat.ino};}
function nativeDirectoryPins(path:string):NativePhysicalIdentity[] {
  const pins:NativePhysicalIdentity[]=[];
  for(let current=resolve(path);;current=dirname(current)){
    const stat=lstatSync(current,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino===0n)nativeCustodyFailure();
    pins.push(nativeIdentity(current,stat));if(dirname(current)===current)return pins;
  }
}
function nativeCheckDirectories(pins:readonly NativePhysicalIdentity[]):void {
  for(const pin of pins){const stat=lstatSync(pin.path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!sameNativeIdentity(pin,stat)||!sameNativePath(realpathSync(pin.path),pin.physical))nativeCustodyFailure();}
}
function nativeLockBytes(path:string,originalFd:number,pin:NativePhysicalIdentity):Buffer {
  const before=nativeFile(path,originalFd);
  if(!sameNativeIdentity(pin,before)||!sameNativePath(realpathSync(path),pin.physical)||before.size>1024n)nativeCustodyFailure();
  const fd=openSync(path,'r');
  try{const stat=nativeFile(path,fd);if(!sameNativeIdentity(pin,stat))nativeCustodyFailure();
    const bytes=Buffer.alloc(Number(stat.size));if(readSync(fd,bytes,0,bytes.length,0)!==bytes.length)nativeCustodyFailure();
    const after=nativeFile(path,fd);if(!sameNativeIdentity(pin,after)||after.size!==stat.size)nativeCustodyFailure();return bytes;
  }finally{closeSync(fd);}
}
function readNativeCustody(db:DatabaseSync,fail:()=>never):NativeCustodyRecord[] {
  const budget=db.prepare('SELECT count(*) AS n,coalesce(max(length(CAST(payload AS BLOB))),0) AS largest FROM studio_native_custody').get() as Row;
  if(Number(budget.n)>64||Number(budget.largest)>2048)fail();
  // Bound the projection too: a concurrent foreign writer or disabled SQL
  // constraints must not turn the inventory check into an unbounded JS read.
  const records=db.prepare('SELECT slot,substr(custody_id,1,37) AS custody_id,substr(project_id,1,65) AS project_id,substr(owner_epoch,1,37) AS owner_epoch,substr(state,1,12) AS state,substr(payload,1,2049) AS payload,length(CAST(payload AS BLOB)) AS payload_bytes FROM studio_native_custody ORDER BY slot LIMIT 65').all() as Row[];
  if(records.length>64||records.length!==Number(budget.n))fail();
  return records.map(row=>{
    if(typeof row.payload!=='string'||Number(row.payload_bytes)>2048||Buffer.byteLength(row.payload)>2048)fail();
    try{
      // The new payload is flat. Inspect its original key tokens as well as its
      // parsed shape so duplicate keys cannot disappear through JSON.parse.
      const value:unknown=JSON.parse(row.payload),seen=new Set<string>();let depth=0;
      for(let i=0;i<row.payload.length;i++){
        const c=row.payload[i];if(c==='{'||c==='['){depth++;continue;}if(c==='}'||c===']'){depth--;continue;}
        if(c!=='"')continue;const start=i++;for(;i<row.payload.length;i++){if(row.payload[i]==='\\'){i++;continue;}if(row.payload[i]==='"')break;}
        let next=i+1;while(/\s/.test(row.payload[next]??'x'))next++;
        if(depth===1&&row.payload[next]===':'){const key:unknown=JSON.parse(row.payload.slice(start,i+1));if(typeof key!=='string'||seen.has(key))fail();seen.add(key);}
      }
      const parsed=nativeCustodySchema.safeParse(value);if(!parsed.success)fail();const record=parsed.data;
      if(record.slot!==row.slot||record.custodyId!==row.custody_id||record.projectId!==row.project_id||record.ownerEpoch!==row.owner_epoch||record.state!==row.state)fail();
      if(record.state==='pending'&&(record.settlement!==null||record.settledAt!==null||record.reason!==null)||
        record.state==='quarantined'&&(record.settlement!==null||record.settledAt!==null||record.reason===null)||
        record.state==='settled'&&(record.settlement===null||record.settledAt===null||record.reason!==null)||
        record.settlement==='native-close'&&record.evidence!=='native'||record.settlement==='fixture-close'&&record.evidence!=='fixture')fail();
      return record;
    }catch{fail();}
  });
}
const STUDIO_DATABASE_VERSION=8,STUDIO_APPLICATION_ID=0x41525354;
// Exact source-backed v2..v6 shapes. Version2 existed both before and after
// asset_uploads was introduced; populated v0/v1 has no supported provenance.
const STUDIO_SCHEMA=[
 'CREATE TABLE grants (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0) STRICT',
 'CREATE TABLE sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, token_hash TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, key_id TEXT) STRICT',
 'CREATE TABLE commands (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), fingerprint TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL) STRICT',
 'CREATE INDEX commands_session ON commands(session_id,created)',
 'CREATE TABLE events (sequence INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT NOT NULL) STRICT',
 'CREATE TABLE api_keys (id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,payload TEXT NOT NULL) STRICT',
 'CREATE TABLE asset_uploads (attempt_id TEXT PRIMARY KEY,resource_key TEXT NOT NULL UNIQUE,payload TEXT NOT NULL) STRICT',
 'CREATE TABLE asset_upload_context_pins (command_id TEXT PRIMARY KEY REFERENCES commands(id),request_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL) STRICT',
 'CREATE TABLE asset_stage_runs (run_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,job_id TEXT NOT NULL,intent_sha256 TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(project_id,job_id)) STRICT',
 'CREATE TABLE asset_stage_commands (run_id TEXT NOT NULL REFERENCES asset_stage_runs(run_id),ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<512),command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),request_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(run_id,ordinal)) STRICT',
 'CREATE TABLE asset_stage_attempts (run_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,job_id TEXT NOT NULL,intent_sha256 TEXT NOT NULL,payload TEXT NOT NULL,attempt_no INTEGER NOT NULL CHECK(attempt_no>0),previous_run_id TEXT REFERENCES asset_stage_attempts(run_id),continuity_key TEXT NOT NULL,UNIQUE(project_id,job_id,attempt_no),UNIQUE(project_id,job_id,continuity_key)) STRICT',
 'CREATE TABLE asset_stage_attempt_commands (run_id TEXT NOT NULL REFERENCES asset_stage_attempts(run_id),ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<512),command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),request_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(run_id,ordinal)) STRICT',
 'CREATE TABLE asset_stage_reconstructions (run_id TEXT PRIMARY KEY REFERENCES asset_stage_attempts(run_id),command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),request_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL) STRICT',
 "CREATE TABLE studio_test_reservations (id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),job_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','released')),setup_closed INTEGER NOT NULL DEFAULT 0 CHECK(setup_closed IN (0,1)),payload TEXT NOT NULL) STRICT",
 'CREATE INDEX studio_test_reservations_state ON studio_test_reservations(state)',
 "CREATE TABLE studio_test_commands (reservation_id TEXT NOT NULL REFERENCES studio_test_reservations(id),edit_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('setup','restore')),command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),request_id TEXT NOT NULL UNIQUE,lease_epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(reservation_id,edit_id,role)) STRICT",
 "CREATE TABLE studio_native_custody (slot INTEGER PRIMARY KEY CHECK(slot>=1 AND slot<=64),custody_id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,owner_epoch TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','quarantined','settled')),payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=2048)) STRICT",
] as const;
const schemaSql=(sql:string)=>sql.replace(/\bIF NOT EXISTS\s+/g,'').replace(/\s+/g,' ').replace(/\s*([(),=<>])\s*/g,'$1').trim();
function verifyStudioSchema(db:DatabaseSync,version:number):Set<string>{
 function fail():never {throw new ArcaneError('MIGRATION','Studio database schema or journal is not a supported Arcane version.');}
 if(version>STUDIO_DATABASE_VERSION)throw new ArcaneError('MIGRATION','Studio database is newer than this Arcane build.');
 const application=Number(db.prepare('PRAGMA application_id').get()?.application_id);
 if(!Number.isSafeInteger(version)||version<0||version===1||version>STUDIO_DATABASE_VERSION||application!==((version===7||version===8)?STUDIO_APPLICATION_ID:0))fail();
 if(db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')fail();
 const size=db.prepare("SELECT count(*) AS n,coalesce(max(length(CAST(sql AS BLOB))),0) AS largest FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get() as Row;
 if(Number(size.n)>STUDIO_SCHEMA.length||Number(size.largest)>8192)fail();
 const rows=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all() as Row[];
 if(version===0){if(rows.length)fail();return new Set();}
 const count=version===2?6:version===3?10:version===4?12:version===5?13:version===8?17:16;
 const expected=new Set<string>(STUDIO_SCHEMA.slice(0,count).map(schemaSql));
 const actual=new Set<string>();const names=new Set<string>();
 for(const row of rows){if(!['table','index'].includes(String(row.type))||typeof row.sql!=='string')fail();actual.add(schemaSql(row.sql));names.add(String(row.name));}
 if(version===2&&actual.has(schemaSql(STUDIO_SCHEMA[6])))expected.add(schemaSql(STUDIO_SCHEMA[6]));
 if(actual.size!==rows.length||actual.size!==expected.size||[...expected].some(sql=>!actual.has(sql)))fail();
 if(db.prepare('PRAGMA foreign_key_check').get())fail();
 if(names.has('studio_native_custody'))readNativeCustody(db,fail);
 for(const table of ['asset_stage_runs','asset_stage_attempts'])if(names.has(table)){
   const budget=db.prepare(`SELECT count(*) AS n,coalesce(max(length(CAST(payload AS BLOB))),0) AS largest FROM ${table}`).get() as Row;
   if(Number(budget.n)>STUDIO_STAGE_RUN_LIMITS.runs||Number(budget.largest)>4*1024*1024)fail();
   for(const row of db.prepare(`SELECT * FROM ${table}`).iterate()){
     if(typeof row.payload!=='string')fail();let record:StageRunStored;
     try{record=JSON.parse(row.payload) as StageRunStored;const intent=stageIntent(record.intent);
       if(record.runId!==row.run_id||intent.projectId!==row.project_id||intent.jobId!==row.job_id||record.intentSha256!==row.intent_sha256||hash(canonical(intent))!==record.intentSha256||version<7&&intent.conversation.provider!=='codex')fail();
     }catch{fail();}
   }
 }
 if(names.has('asset_uploads')){
   const budget=db.prepare('SELECT count(*) AS n,coalesce(max(length(CAST(payload AS BLOB))),0) AS largest FROM asset_uploads').get() as Row;
   if(Number(budget.n)>8192||Number(budget.largest)>16384)fail();
   for(const row of db.prepare('SELECT * FROM asset_uploads').iterate()){
     if(typeof row.payload!=='string')fail();try{const parsed=uploadJournalSchema.safeParse(JSON.parse(row.payload));
       if(!parsed.success)fail();
       const record=parsed.data,intent=record.intent;
       if(record.attemptId!==row.attempt_id||record.resourceKey!==row.resource_key||hash(canonical(intent))!==record.intentSha256||
         hash(canonical({projectId:intent.projectId,jobId:intent.jobId,sourceId:intent.sourceId,sourceSha256:intent.sourceSha256,assetType:intent.assetType}))!==record.resourceKey)fail();
     }catch{fail();}
   }
 }
 return names;
}
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Paths are display metadata: a rename is not a different opaque Instance.
// Both references still require valid bounded paths and exact scope/class/ID.
const sameReceiptRef = (a: unknown, b: unknown): boolean => {
  const x=instanceRef(a), y=instanceRef(b);
  return x.instanceId===y.instanceId && x.sessionId===y.sessionId && x.root===y.root && x.className===y.className;
};

/** Durable queue. Exactly-once outcomes cannot be promised across process/engine crashes.
 * Unknown outcomes are preserved for reconciliation, never automatically replayed. */
export class StudioStore {
  private db!: DatabaseSync;
  private lockPath: string;
  private readonly workspaceDirectory: string;
  private lockFd: number;
  private now: () => number;
  private closed = false;
  #nativeCustodyFault=false;
  #nativeDirectories:readonly NativePhysicalIdentity[]=[];
  #nativeLock:NativePhysicalIdentity|null=null;
  #nativeLockContents:Buffer|null=null;
  #nativeDatabase:NativePhysicalIdentity|null=null;
  #nativeDatabaseFd:number|null=null;
  // Only trusted host verification can mint this one-use authority. JSON claims
  // (including those in a restoration receipt) never authorize execution.
  #activationAdmissions = new WeakMap<object, ScriptSourceVerification>();
  #assetStageAdmissions = new WeakSet<object>();
  // "Keep this mesh" uploads: minted only inside enqueueMeshKeep, which only the host mesh-keep service calls after it
  // holds a human trusted-dialog consent. Routes, MCP and restore never reach it.
  #meshKeepAdmissions = new WeakSet<object>();
  #uploadTickets = new WeakMap<object, string>();
  #stageRunHandles = new WeakMap<object,string>();
  #reconstructionClaims = new Set<string>();
  #testOwners = new Map<string, string>();
  #testReservations = new WeakMap<object,TestReservationRecord>();
  #testReservationRecords = new Map<string,TestReservationRecord>();
  #testCommandAdmissions = new WeakMap<object,TestCommandAdmission>();
  #diagnostics = new Map<string,{placeName:string;placeId:number;entries:Map<string,StudioDiagnostic>}>();
  #pairingOffer: PairingOfferRecord | null = null;
  #modelSourcePolicy: ((sessionId:string)=>boolean)|null = null;
  #assetModelReview:((intent:StageRunIntent)=>void)|null=null;
  #assetDispatchGuards=new Map<string,()=>void>();
  #commandResultWaiters=new Map<string,Set<()=>void>>();
  #commandResultWaiterCount=0;
  #importObservationClaims=new Set<string>();
  #importRevisionClaims=new Set<string>();
  #importRevisionGuards=new Map<string,()=>void>();
  #stageHashRun:string|null=null;
  #stageHashBytes=0;
  #stageHashes=new Map<string,{raw:string;key:string;fingerprint:string;argsSha256:string;bytes:number;packetHeader?:{formatVersion:number;ordinal:unknown;payloadDigest:unknown;manifestDigest:unknown;kind:unknown}}>();
  #convertedStageInspections=new Map<string,Pick<ReturnType<typeof inspectConvertedStudioImportTransfer>,'graph'>>();
  private clearStageContentHashes():void {this.#stageHashRun=null;this.#stageHashBytes=0;this.#stageHashes.clear();}
  private rememberStageContentHashes(id:string,raw:string,key:string,fingerprint:string,argsSha256:string):void {
    // UTF16 string storage plus a conservative fixed per-entry header charge.
    // One hot run only. Eviction is a cold verification path, never a refusal.
    const bytes=2*(id.length+raw.length+key.length+fingerprint.length+argsSha256.length)+1024,limit=64*1024*1024;
    const prior=this.#stageHashes.get(id);if(prior){this.#stageHashBytes-=prior.bytes;this.#stageHashes.delete(id);}
    if(bytes>limit)return;
    while(this.#stageHashes.size>=512||this.#stageHashBytes+bytes>limit){
      const oldest=this.#stageHashes.keys().next().value;if(oldest===undefined)break;
      this.#stageHashBytes-=this.#stageHashes.get(oldest)!.bytes;this.#stageHashes.delete(oldest);
    }
    this.#stageHashes.set(id,{raw,key,fingerprint,argsSha256,bytes});this.#stageHashBytes+=bytes;
  }
  /** Trusted product composition; a serialized review reference grants no authority. */
  bindAssetModelReview(read:(intent:StageRunIntent)=>void):()=>void {
    if(typeof read!=='function'||this.#assetModelReview)throw new ArcaneError('ASSET_REVIEW_CONFIGURATION','Model review is already bound or invalid.');
    this.#assetModelReview=read;return ()=>{if(this.#assetModelReview===read)this.#assetModelReview=null;};
  }
  private assertRunModelReview(intent:StageRunIntent):void {
    if(!intent.modelReview||!this.#assetModelReview)throw new ArcaneError('ASSET_REVIEW_REQUIRED','Review this exact model before importing it.');
    if(this.#assetModelReview(intent)!==undefined)throw new ArcaneError('ASSET_REVIEW_CONFIGURATION','Model review must complete synchronously.');
  }
  private assertEditableModelReview(sessionId:string,args:Record<string,Json>):void {
    if(typeof args.watch!=='string'||!/^editable-[a-f0-9]{64}$/.test(args.watch))return;
    const session=this.session(sessionId),proof=session.proof;
    if(!proof||proof.mode!=='Edit'||!proof.connected)throw new ArcaneError('ASSET_REVIEW_REQUIRED','The reviewed model requires its original connected Edit session.');
    const rows=this.db.prepare("SELECT run_id FROM asset_stage_attempts WHERE json_extract(payload,'$.intent.transferDigest')=? AND json_extract(payload,'$.intent.target.sessionId')=? ORDER BY attempt_no DESC LIMIT 64").all(args.watch.slice(9),sessionId) as Row[];
    const runs=rows.map(row=>this.stageRunById(row.run_id as string)).filter(run=>run.intent.continuity.clientLifetimeId===session.clientSessionId&&run.intent.continuity.playEpoch===proof.playEpoch);
    if(runs.length!==1)throw new ArcaneError('ASSET_REVIEW_REQUIRED','The exact reviewed reconstruction is unavailable.');
    const run=runs[0]!,reconstruction=this.readStageReconstruction(run.intent.projectId,run.intent.jobId,run.runId);
    if(!reconstruction||reconstruction.command.state!=='succeeded'||!reconstruction.receipt)throw new ArcaneError('ASSET_REVIEW_REQUIRED','Review and reconstruct this exact model before placing it.');
    try{this.stageTarget(run.intent);}catch{throw new ArcaneError('ASSET_REVIEW_TARGET','The original model target or continuity changed.');}
    this.assertRunModelReview(run.intent);
  }
  private assertCommandModelReview(command:StudioCommand):void {
    if(command.method==='scene.observe_import'||command.method==='asset.apply_revision'){
      const guard=this.#importRevisionGuards.get(command.id);
      if(!guard)throw new ArcaneError('ASSET_STAGE_AUTHORITY','Original native observation authority is unavailable.');
      this.stageGuard(guard);return;
    }
    if(command.method==='scene.place_asset')this.assertEditableModelReview(command.sessionId,command.args);
    if(command.method==='asset.stage_packet'||command.method==='asset.reconstruct'){
      const live=this.#assetDispatchGuards.get(command.id);
      if(!live)throw new ArcaneError('ASSET_REVIEW_AUTHORITY','The original native import authority is unavailable.');
      try{this.stageGuard(live);}catch{throw new ArcaneError('ASSET_REVIEW_AUTHORITY','The original native import authority changed.');}
      const table=command.method==='asset.stage_packet'?'asset_stage_attempt_commands':'asset_stage_reconstructions';
      const row=this.db.prepare('SELECT run_id FROM '+table+' WHERE command_id=?').get(command.id) as Row|undefined;
      if(!row)throw new ArcaneError('ASSET_REVIEW_REQUIRED','Original model review association is unavailable.');
      const intent=this.stageRunById(row.run_id as string).intent;
      try{this.stageTarget(intent);}catch{throw new ArcaneError('ASSET_REVIEW_TARGET','The original import target or continuity changed.');}
      this.assertRunModelReview(intent);
    }
  }
  /** Trusted daemon composition only; no JSON route can install or invoke a policy callback. */
  bindModelSourcePolicy(read:(sessionId:string)=>boolean):()=>void {
    if(typeof read!=='function'||this.#modelSourcePolicy)throw new ArcaneError('POLICY','A model-source policy is already bound or invalid.');
    this.#modelSourcePolicy=read;
    return ()=>{if(this.#modelSourcePolicy===read)this.#modelSourcePolicy=null;};
  }
  private assertTemplateSources(sessionId:string,args:Record<string,Json>):void {
    const templates=args.templates as InstanceRef[]|undefined;
    if(!templates?.length)return;
    let externalAllowed=false;
    try{externalAllowed=this.#modelSourcePolicy?.(sessionId)===true;}catch{/* An unavailable choice never enables external models. */}
    const current=this.session(sessionId);
    for(const ref of templates){
      // Only an authenticated placement receipt for a retained original reconstruction
      // attests a default template. Search results, names and agent claims do not.
      const row=this.db.prepare("SELECT payload FROM commands WHERE session_id=? AND state='succeeded' AND json_extract(payload,'$.method')='scene.place_asset' AND json_extract(payload,'$.result.mutation.ref.instanceId')=? ORDER BY created DESC,rowid DESC LIMIT 1").get(sessionId,ref.instanceId) as Row|undefined;
      const command=row?JSON.parse(row.payload as string) as StudioCommand:null;
      if(externalAllowed&&(!command||typeof command.args.watch!=='string'||!/^editable-[a-f0-9]{64}$/.test(command.args.watch)))continue;
      const mutation=(command?.result as {mutation?:{kind?:string;ref?:InstanceRef}}|null)?.mutation;
      const source=mutation?.ref;
      if(!command||command.clientSessionId!==current.clientSessionId||typeof command.args.watch!=='string'||!/^editable-[a-f0-9]{64}$/.test(command.args.watch)
        ||mutation?.kind!=='scene.place_asset'||!source||source.sessionId!==ref.sessionId||source.instanceId!==ref.instanceId||source.root!==ref.root||source.className!==ref.className)
        throw new ArcaneError('TEMPLATE_SOURCE','This scene template is not recorded as an original Blender reconstruction. Create an original model with assets_procedural, inspect assets_preview, then prepare, stage, reconstruct and place it before scattering. Existing Toolbox or external templates require the user to enable them in Settings > Tools.');
      this.assertEditableModelReview(sessionId,command.args);
    }
  }
  constructor(options: Options) {
    this.now = options.now ?? Date.now;
    mkdirSync(options.directory, { recursive: true });
    this.workspaceDirectory = resolve(options.directory);
    this.#nativeDirectories=nativeDirectoryPins(this.workspaceDirectory);
    this.lockPath = join(this.workspaceDirectory, 'studio.lock');
    // workspaceInUse marks only a lock whose owner process is alive (another open Arcane runtime), so the launcher can
    // say so precisely. A live owner's lock is never signalled, taken over or removed.
    const inUse = (message: string) => Object.assign(new ArcaneError('LOCKED', message), { workspaceInUse: true as const });
    if (existsSync(this.lockPath)) {
      let stale = false, live = false;
      try {
        const prior = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid: number };
        if (!Number.isInteger(prior.pid) || prior.pid < 1) throw new Error('Invalid lock');
        try { process.kill(prior.pid, 0); live = true; }
        catch (e) { const code = (e as NodeJS.ErrnoException).code; stale = code === 'ESRCH'; live = code === 'EPERM'; }
      } catch { /* Unknown lock state is not safe to remove automatically. */ }
      if (live) throw inUse('This workspace daemon is already running.');
      if (!stale) throw new ArcaneError('LOCKED', 'This workspace daemon is already running, or its lock needs manual inspection.');
      unlinkSync(this.lockPath);
    }
    try { this.lockFd = openSync(this.lockPath, 'wx', 0o600); }
    catch { throw new ArcaneError('LOCKED', 'Another daemon acquired this workspace.'); }
    try {
      this.#nativeLock=nativeIdentity(this.lockPath,nativeFile(this.lockPath,this.lockFd));
      this.#nativeLockContents=Buffer.from(JSON.stringify({ pid: process.pid, openedAt: this.iso() }));
      writeFileSync(this.lockFd,this.#nativeLockContents);
      nativeCheckDirectories(this.#nativeDirectories);
      const database=join(this.workspaceDirectory,'studio.sqlite');
      if(!existsSync(database)){this.#nativeDatabaseFd=openSync(database,'wx',0o600);}
      else {nativeFile(database);this.#nativeDatabaseFd=openSync(database,'r');}
      this.#nativeDatabase=nativeIdentity(database,nativeFile(database,this.#nativeDatabaseFd));
      this.db = new DatabaseSync(sqliteTransportPath(database), { timeout: 2000, allowExtension: false });
      this.#assertNativeOwnership();
      // FULL must already govern migration commits, not only later WAL work.
      this.#nativeFullSync();
      this.transaction(() => {
        const version=Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
        const present=verifyStudioSchema(this.db,version);
        // No DDL/version adoption precedes full known-schema and journal validation.
        // New tables, old-stage copying, application identity and version publish
        // commit together, with rollback on every validation/write failure.
        for(const sql of STUDIO_SCHEMA){const name=/^CREATE (?:TABLE|INDEX) ([a-z_]+)/.exec(sql)![1]!;if(!present.has(name))this.db.exec(sql);}
        if (version > 0 && version < 4) {
          const old = this.db.prepare('SELECT * FROM asset_stage_runs LIMIT 65').all() as Row[];
          if (old.length > STUDIO_STAGE_RUN_LIMITS.runs) throw new ArcaneError('STUDIO_STAGE_BUDGET','Retained stage history exceeds its cap.');
          for (const row of old) {
            const stored = JSON.parse(row.payload as string) as StageRunStored, intent = stageIntent(stored.intent);
            if (stored.runId !== row.run_id || intent.projectId !== row.project_id || intent.jobId !== row.job_id || stored.intentSha256 !== row.intent_sha256 || hash(canonical(intent)) !== stored.intentSha256) throw new ArcaneError('STUDIO_STAGE_RECEIPT','Legacy stage identity differs.');
            this.db.prepare('INSERT INTO asset_stage_attempts VALUES(?,?,?,?,?,1,NULL,?)').run(row.run_id!,row.project_id!,row.job_id!,row.intent_sha256!,row.payload!,stageContinuityKey(intent));
          }
          this.db.exec('INSERT INTO asset_stage_attempt_commands SELECT * FROM asset_stage_commands;');
        }
        this.db.exec(`PRAGMA application_id=${STUDIO_APPLICATION_ID}; PRAGMA user_version=${STUDIO_DATABASE_VERSION};`);
        verifyStudioSchema(this.db,STUDIO_DATABASE_VERSION);
        // Recovery consumes the original session/command journals too. Keep it
        // in the migration transaction so malformed retained JSON or a failed
        // recovery write cannot adopt the new version or partially revoke data.
        for (const row of this.db.prepare('SELECT payload FROM sessions').all() as Row[]) { const session=JSON.parse(row.payload as string) as StudioSession; if (!session.revokedAt) this.revoke(session.id, 'daemon_restart'); }
        this.db.prepare('DELETE FROM grants').run();
        for (const row of this.db.prepare('SELECT payload FROM asset_uploads').all() as Row[]) {
          const record = JSON.parse(row.payload as string) as AssetUploadJournalRecord;
          if (record.state === 'intent') {
            record.state = 'needs_reconciliation'; record.updatedAt = this.iso();
            this.db.prepare('UPDATE asset_uploads SET payload=? WHERE attempt_id=?').run(JSON.stringify(record), record.attemptId);
          }
        }
        for(const row of this.db.prepare('SELECT payload FROM asset_stage_attempts').all() as Row[]){
          const run=JSON.parse(row.payload as string) as StageRunStored;
          if(run.closedAt===null){run.closedAt=this.iso();run.updatedAt=run.closedAt;this.saveStageRun(run);}
        }
        this.event('daemon_started', 'local', { protocolVersion: STUDIO_PROTOCOL });
      });
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.#assertNativeOwnership();this.#nativeFullSync();
    } catch (error) {
      for(const cleanup of [()=>this.db!.close(),()=>this.#closeNativeDatabasePin(),()=>this.#releaseNativeLock()])try{cleanup();}catch{/* Preserve the original startup failure while attempting every owned cleanup. */}
      throw error;
    }
  }
  #checkNativeLock():void {
    nativeCheckDirectories(this.#nativeDirectories);
    if(!this.#nativeLock||!this.#nativeLockContents||!nativeLockBytes(this.lockPath,this.lockFd,this.#nativeLock).equals(this.#nativeLockContents))nativeCustodyFailure();
  }
  #assertNativeOwnership():void {
    this.#checkNativeLock();
    const pin=this.#nativeDatabase,fd=this.#nativeDatabaseFd;
    if(!pin||fd===null)nativeCustodyFailure();
    const stat=nativeFile(pin.path,fd);
    if(!sameNativeIdentity(pin,stat)||!sameNativePath(realpathSync(pin.path),pin.physical))nativeCustodyFailure();
    // Fixed sidecar inventory only. Sizes/mtimes legitimately change with WAL;
    // neither is used as identity, and no sidecar contents are read.
    for(const suffix of ['-wal','-shm','-journal']){
      const path=pin.path+suffix;
      try {nativeFile(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
  }
  #nativeFullSync():void {
    this.db.exec('PRAGMA synchronous=FULL;');
    if(Number(this.db.prepare('PRAGMA synchronous').get()?.synchronous)!==2)nativeCustodyFailure();
  }
  #closeNativeDatabasePin():void {if(this.#nativeDatabaseFd!==null){const fd=this.#nativeDatabaseFd;this.#nativeDatabaseFd=null;closeSync(fd);}}
  #releaseNativeLock():void {
    let owned=false;try{this.#checkNativeLock();owned=true;}catch{/* Never unlink a replacement or unknown lock. */}
    const errors:unknown[]=[];try{closeSync(this.lockFd);}catch(error){errors.push(error);}
    try{if(owned)unlinkSync(this.lockPath);}catch(error){errors.push(error);}
    if(errors.length)throw errors[0];
  }
  /** Fixed-project host port. Tickets and a live port epoch cannot be reconstructed from records. */
  bindNativeCustody(projectId:string,workspaceDirectory:string):StudioNativeCustodyPort {
    if(typeof projectId!=='string'||!stageHash.safeParse(projectId).success||typeof workspaceDirectory!=='string'||!this.holdsWorkspaceLock(workspaceDirectory))nativeCustodyFailure();
    const ownerEpoch=randomUUID(),tickets=new WeakMap<StudioNativeCustodyTicket,{slot:number;custodyId:string;evidence:StudioNativeCustodyEvidence}>();
    const pending=new Map<string,number>();let retired=false,fenced=false;
    const physical=()=>{
      try{if(this.closed||this.#nativeCustodyFault)nativeCustodyFailure();this.#assertNativeOwnership();}
      catch{this.#nativeCustodyFault=true;nativeCustodyFailure();}
    };
    const rows=()=>{try{return readNativeCustody(this.db,nativeCustodyFailure);}catch{this.#nativeCustodyFault=true;nativeCustodyFailure();}};
    const ready=(records:readonly NativeCustodyRecord[])=>{
      if(retired||fenced||records.some(row=>row.state!=='settled'&&(row.state!=='pending'||row.projectId!==projectId||row.ownerEpoch!==ownerEpoch||pending.get(row.custodyId)!==row.slot)))nativeCustodyFailure();
    };
    const commit=<T>(work:()=>T):T=>{
      physical();
      try{
        this.#nativeFullSync();
        const value=this.transaction(()=>{physical();const value=work();physical();if(Number(this.db.prepare('PRAGMA synchronous').get()?.synchronous)!==2)nativeCustodyFailure();return value;});
        physical();return value;
      }catch{this.#nativeCustodyFault=true;nativeCustodyFailure();}
    };
    const write=(record:NativeCustodyRecord)=>{
      const payload=JSON.stringify(record);if(!nativeCustodySchema.safeParse(record).success||Buffer.byteLength(payload)>2048)nativeCustodyFailure();
      this.db.prepare('INSERT INTO studio_native_custody(slot,custody_id,project_id,owner_epoch,state,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET custody_id=excluded.custody_id,project_id=excluded.project_id,owner_epoch=excluded.owner_epoch,state=excluded.state,payload=excluded.payload')
        .run(record.slot,record.custodyId,record.projectId,record.ownerEpoch,record.state,payload);
    };
    const original=(ticket:StudioNativeCustodyTicket,records:readonly NativeCustodyRecord[])=>{
      const identity=tickets.get(ticket);if(!identity)nativeCustodyFailure();
      const record=records.find(row=>row.slot===identity.slot&&row.custodyId===identity.custodyId&&row.projectId===projectId&&row.ownerEpoch===ownerEpoch&&row.evidence===identity.evidence);
      if(!record)nativeCustodyFailure();return record;
    };
    const settle=(ticket:StudioNativeCustodyTicket,settlement:NonNullable<NativeCustodyRecord['settlement']>)=>{
      const identity=tickets.get(ticket);if(!identity||settlement==='native-close'&&identity.evidence!=='native'||settlement==='fixture-close'&&identity.evidence!=='fixture')nativeCustodyFailure();
      physical();original(ticket,rows());
      commit(()=>{
        const record=original(ticket,rows());
        if(record.state==='settled'){if(record.settlement!==settlement)nativeCustodyFailure();return;}
        write({...record,state:'settled',settledAt:this.iso(),settlement,reason:null});
      });
      pending.delete(identity.custodyId);
    };
    physical();
    return Object.freeze({projectId,ownerEpoch,
      assertReady:()=>{physical();ready(rows());physical();},
      reserve:(operation:StudioNativeCustodyOperation,evidence:StudioNativeCustodyEvidence)=>{
        if(!nativeCustodyOperations.includes(operation)||evidence!=='native'&&evidence!=='fixture')nativeCustodyFailure();
        physical();const records=rows();ready(records);
        if(records.length===64&&!records.some(row=>row.state==='settled'))nativeCustodyFailure();
        const custodyId=randomUUID();
        const ticket=Object.freeze({kind:'studio-native-custody-ticket' as const});
        const selected=commit(()=>{const current=rows();ready(current);const used=new Set(current.map(row=>row.slot));
          let slot=Array.from({length:64},(_,i)=>i+1).find(value=>!used.has(value));
          if(slot===undefined)slot=current.filter(row=>row.state==='settled').sort((a,b)=>Date.parse(a.settledAt!)-Date.parse(b.settledAt!)||a.custodyId.localeCompare(b.custodyId))[0]?.slot;
          if(slot===undefined)nativeCustodyFailure();
          write({schemaVersion:1,slot,custodyId,projectId,ownerEpoch,operation,evidence,state:'pending',createdAt:this.iso(),settledAt:null,settlement:null,reason:null});return slot;});
        tickets.set(ticket,{slot:selected,custodyId,evidence});pending.set(custodyId,selected);return ticket;
      },
      quarantine:(ticket:StudioNativeCustodyTicket,reason:StudioNativeCustodyReason)=>{
        if(!nativeCustodyReasons.includes(reason)||!tickets.has(ticket))nativeCustodyFailure();physical();original(ticket,rows());fenced=true;
        commit(()=>{const record=original(ticket,rows());if(record.state==='pending')write({...record,state:'quarantined',reason});});
      },
      settleNoStart:(ticket:StudioNativeCustodyTicket)=>settle(ticket,'no-start'),
      settleNativeClosed:(ticket:StudioNativeCustodyTicket)=>settle(ticket,'native-close'),
      settleFixtureClosed:(ticket:StudioNativeCustodyTicket)=>settle(ticket,'fixture-close'),
      retireAdmissions:()=>{retired=true;},
    });
  }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.clearStageContentHashes();this.db.exec('ROLLBACK'); throw error; }
  }
  private event(kind: string, entityId: string, detail: unknown): void {
    this.db.prepare('INSERT INTO events(occurred_at,kind,entity_id,detail) VALUES(?,?,?,?)').run(this.iso(), kind, entityId, JSON.stringify(detail));
  }
  private saveSession(s: StudioSession): void { this.db.prepare('UPDATE sessions SET payload=? WHERE id=?').run(JSON.stringify(s), s.id); }
  private saveCommand(c: StudioCommand): void { this.db.prepare('UPDATE commands SET state=?,payload=? WHERE id=?').run(c.state, JSON.stringify(c), c.id); if(c.state!=='queued'){this.#assetDispatchGuards.delete(c.id);this.#importRevisionGuards.delete(c.id);} if(c.state==='needs_reconciliation')this.clearStageContentHashes(); }
  sessions(): ListedStudioSession[] { return (this.db.prepare('SELECT payload FROM sessions ORDER BY rowid DESC LIMIT 100').all() as Row[]).map(r => { const s = JSON.parse(r.payload as string) as StudioSession; return { ...s, live: this.live(s) }; }); }
  /** Unrevoked and heard from recently. The single plugin worker does not poll while it executes a
   * delivered command, so an unexpired dispatched lease also counts as a heartbeat. */
  private live(s: StudioSession): boolean {
    if (s.revokedAt) return false;
    if (this.now() - Date.parse(s.lastSeenAt) <= STUDIO_SESSION_LIVE_MS) return true;
    // Only the lease expiry is needed: never re-parse a dispatched command's (up to 256 KiB) payload here.
    return (this.db.prepare("SELECT json_extract(payload,'$.expiresAt') AS expires_at FROM commands WHERE session_id=? AND state='dispatched'").all(s.id) as Row[])
      .some(r => Date.parse(String(r.expires_at)) > this.now());
  }
  /** Leases expire by time even when the owning plugin never polls again; mirrors poll() expiry
   * exactly. Joins an enclosing transaction, otherwise opens its own. */
  private expired(c: StudioCommand): StudioCommand {
    if ((c.state !== 'queued' && c.state !== 'dispatched') || Date.parse(c.expiresAt) > this.now()) return c;
    if (!this.db.isTransaction) return this.transaction(() => this.expired(this.command(c.id)));
    if (c.state === 'dispatched') { c.state = 'needs_reconciliation'; c.error = 'Delivery expired with unknown engine outcome. No automatic replay.'; c.finishedAt = this.iso(); this.saveCommand(c); this.event('command_unknown', c.id, {}); }
    else { c.state = 'cancelled'; c.error = 'Undelivered command expired.'; c.finishedAt = this.iso(); this.saveCommand(c); }
    return c;
  }
  /** Host selection must inspect every live pairing, never a display-limited page. */
  activeSessions(): StudioSession[] {
    return (this.db.prepare("SELECT payload FROM sessions WHERE json_extract(payload,'$.revokedAt') IS NULL ORDER BY rowid DESC").all() as Row[])
      .map(row => JSON.parse(row.payload as string) as StudioSession);
  }
  session(id: string, live = true): StudioSession {
    const row = this.db.prepare('SELECT payload FROM sessions WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new ArcaneError('SESSION', 'Unknown Studio session.');
    const s = JSON.parse(row.payload as string) as StudioSession;
    if (live && s.revokedAt) throw new ArcaneError('REVOKED', 'Studio session has been revoked. Re-pair explicitly.');
    return s;
  }
  createGrant(input: unknown): PairingGrant {
    const a = object(input); const allowedRoots = roots(a.allowedRoots);
    if (typeof a.allowWrites !== 'boolean') throw new ArcaneError('INPUT', 'Explicit write permission flag required.');
    const code = randomBytes(12).toString('hex'); const expires = this.now() + 120000;
    const grant: PairingGrant = { code, allowedRoots, allowWrites: a.allowWrites, expiresAt: new Date(expires).toISOString(), protocolVersion: 1 };
    this.db.prepare('DELETE FROM grants WHERE expires<? OR used=1').run(this.now());
    if (Number((this.db.prepare('SELECT count(*) AS n FROM grants').get() as Row).n) > 32) throw new ArcaneError('BUSY', 'Too many active pairing grants. Wait for expiry.');
    this.db.prepare('INSERT INTO grants(hash,payload,expires) VALUES(?,?,?)').run(hash(code), JSON.stringify({ allowedRoots, allowWrites: a.allowWrites }), expires);
    this.event('pairing_granted', 'local', { allowedRoots, allowWrites: a.allowWrites }); return grant;
  }
  pair(input: unknown, apiKeyId: string | null = null): PairResult {
    const a = object(input); const code = textField(a.code, 'pairing code', 100);
    if (a.protocolVersion !== 1) throw new ArcaneError('PROTOCOL', 'Plugin protocol mismatch.');
    const identity = object(a.identity);
    const clientSessionId = textField(identity.clientSessionId, 'client session', 100);
    const name = textField(identity.name, 'Studio name', 200); const pluginVersion = textField(identity.pluginVersion, 'plugin version', 80);
    for (const f of ['placeId', 'universeId']) if (typeof identity[f] !== 'number' || !Number.isSafeInteger(identity[f]) || (identity[f] as number) < 0) throw new ArcaneError('IDENTITY', 'Invalid place/universe identity.');
    if (!Array.isArray(a.capabilities) || a.capabilities.length > STUDIO_PAIRING_CAPABILITY_LIMIT || a.capabilities.some(c => typeof c !== 'string')) throw new ArcaneError('CAPABILITY', 'Invalid plugin capabilities.');
    const capabilities: string[] = [...new Set(a.capabilities)].map(c => c === STUDIO_DIAGNOSTICS_CAPABILITY || STUDIO_FEATURE_CAPABILITIES.includes(c) ? c : methodField(c));
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM grants WHERE hash=?').get(hash(code)) as Row | undefined;
      if (!row || row.used || Number(row.expires) <= this.now()) throw new ArcaneError('PAIRING', 'Pairing code is invalid, expired or already used.');
      const scope = JSON.parse(row.payload as string) as Pick<StudioSession, 'allowedRoots' | 'allowWrites'>;
      // One plugin lifetime cannot acquire overlapping identities without revoking the prior pairing.
      for (const oldRow of this.db.prepare('SELECT payload FROM sessions').all() as Row[]) {const old=JSON.parse(oldRow.payload as string) as StudioSession;if(old.clientSessionId===clientSessionId&&!old.revokedAt)this.revoke(old.id,'repaired');}
      if(Number((this.db.prepare("SELECT count(*) AS n FROM sessions WHERE json_extract(payload,'$.revokedAt') IS NULL").get() as Row).n)>=128)throw new ArcaneError('BUSY','Too many active Studio sessions; revoke an unused connection first.');
      const session: StudioSession = { id: randomUUID(), clientSessionId, placeId: identity.placeId as number, universeId: identity.universeId as number, name, pluginVersion, capabilities, ...scope, connectedAt: this.iso(), lastSeenAt: this.iso(), revokedAt: null, protocolVersion: 1 };
      const token = randomBytes(32).toString('hex');
      this.db.prepare('UPDATE grants SET used=1 WHERE hash=?').run(hash(code));
      this.db.prepare('INSERT INTO sessions(id,payload,token_hash,key_id) VALUES(?,?,?,?)').run(session.id, JSON.stringify(session), hash(token), apiKeyId);
      this.event('studio_paired', session.id, { clientSessionId, placeId: session.placeId, universeId: session.universeId, ...scope });
      return { sessionId: session.id, token, protocolVersion: 1, ...scope };
    });
  }
  keys(): ArcaneKeySummary[] {
    return (this.db.prepare("SELECT payload FROM api_keys ORDER BY (json_extract(payload,'$.revokedAt') IS NOT NULL),rowid DESC LIMIT 100").all() as Row[]).map(r=>JSON.parse(r.payload as string) as ArcaneKeySummary);
  }
  issueKey(input: unknown, port: number): ArcaneKeyIssue {
    return this.transaction(() => this.insertKey(input, port));
  }
  rotateKey(input: unknown, port: number): ArcaneKeyIssue {
    const a = object(input);
    if (Object.keys(a).length) throw new ArcaneError('INPUT', 'Key rotation requires an empty object.');
    return this.transaction(() => {
      // Do not use keys(): its display limit must never leave an old key active.
      const active = this.db.prepare("SELECT id FROM api_keys WHERE json_extract(payload,'$.revokedAt') IS NULL").all() as Row[];
      for (const row of active) this.revokeKeyInTransaction(row.id as string);
      // The plaintext replacement is returned only after the durable COMMIT.
      return this.insertKey({ allowedRoots: [...ROOTS], allowWrites: true }, port);
    });
  }
  private insertKey(input: unknown, port: number): ArcaneKeyIssue {
    const a=object(input); const allowedRoots=roots(a.allowedRoots);
    if(typeof a.allowWrites!=='boolean'||!Number.isInteger(port)||port<1||port>65535)throw new ArcaneError('INPUT','Explicit key grants and a valid local port are required.');
    if(Number((this.db.prepare("SELECT count(*) AS n FROM api_keys WHERE json_extract(payload,'$.revokedAt') IS NULL").get() as Row).n)>=32)throw new ArcaneError('BUSY','Revoke an unused key before issuing more than 32 active keys.');
    const key:ArcaneKeySummary={keyId:randomUUID(),allowedRoots,allowWrites:a.allowWrites,issuedAt:this.iso(),revokedAt:null,lastUsedAt:null};
    const apiKey='arcane_local_v1_'+port+'_'+randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO api_keys(id,hash,payload) VALUES(?,?,?)').run(key.keyId,hash(apiKey),JSON.stringify(key));
    this.event('arcane_key_issued',key.keyId,{allowedRoots,allowWrites:key.allowWrites});
    return {...key,apiKey};
  }
  revokeKey(keyId: string): void {
    this.transaction(() => this.revokeKeyInTransaction(keyId));
  }
  private revokeKeyInTransaction(keyId: string): void {
    const row=this.db.prepare('SELECT payload FROM api_keys WHERE id=?').get(keyId) as Row|undefined;
    if(!row)throw new ArcaneError('KEY','Unknown Arcane key.');
    const key=JSON.parse(row.payload as string) as ArcaneKeySummary;
    if(key.revokedAt)return;key.revokedAt=this.iso();this.db.prepare('UPDATE api_keys SET payload=? WHERE id=?').run(JSON.stringify(key),keyId);
    for(const r of this.db.prepare('SELECT id FROM sessions WHERE key_id=?').all(keyId) as Row[])this.revoke(r.id as string,'arcane_key_revoked');
    this.event('arcane_key_revoked',keyId,{});
  }
  connectWithKey(input: unknown, port: number): PairResult {
    const a=object(input); const apiKey=textField(a.apiKey,'Arcane API key',160);
    const match=/^arcane_local_v1_([1-9][0-9]{0,4})_([a-f0-9]{64})$/.exec(apiKey);
    if(!match||Number(match[1])!==port||port>65535)throw new ArcaneError('AUTH','Arcane API key is invalid, revoked or belongs to another local endpoint.');
    const row=this.db.prepare('SELECT id,payload FROM api_keys WHERE hash=?').get(hash(apiKey)) as Row|undefined;
    if(!row)throw new ArcaneError('AUTH','Arcane API key is invalid, revoked or belongs to another local endpoint.');
    const key=JSON.parse(row.payload as string) as ArcaneKeySummary;
    if(key.revokedAt)throw new ArcaneError('AUTH','Arcane API key is invalid, revoked or belongs to another local endpoint.');
    // Synchronous exchange: no asynchronous gap in which a key revocation can race this grant.
    const grant=this.createGrant({allowedRoots:key.allowedRoots,allowWrites:key.allowWrites});
    const result=this.pair({code:grant.code,protocolVersion:a.protocolVersion,identity:a.identity,capabilities:a.capabilities},key.keyId);
    key.lastUsedAt=this.iso();this.db.prepare('UPDATE api_keys SET payload=? WHERE id=?').run(JSON.stringify(key),key.keyId);
    this.event('arcane_key_connected',key.keyId,{sessionId:result.sessionId});return result;
  }
  /** Key-authenticated metadata only. It cannot pair, renew a lease, return a
   * bearer, clear unknown effects or dispatch/replay a command. */
  connectionStatusWithKey(input:unknown,port:number): {protocolVersion:1;identity:Record<string,unknown>;state:'absent'|'active'|'lost'|'reconciliation';sessionId?:string} {
    const a=object(input);
    if(Object.keys(a).some(k=>!['protocolVersion','apiKey','identity','sessionId'].includes(k))||a.protocolVersion!==1)throw new ArcaneError('INPUT','Invalid plugin status envelope.');
    const apiKey=textField(a.apiKey,'Arcane API key',160),match=/^arcane_local_v1_([1-9][0-9]{0,4})_([a-f0-9]{64})$/.exec(apiKey);
    if(!match||Number(match[1])!==port||port>65535)throw new ArcaneError('KEY_REJECTED','Arcane API key is invalid, revoked or belongs to another local endpoint.');
    const keyRow=this.db.prepare('SELECT id,payload FROM api_keys WHERE hash=?').get(hash(apiKey)) as Row|undefined;
    if(!keyRow||(JSON.parse(keyRow.payload as string) as ArcaneKeySummary).revokedAt)throw new ArcaneError('KEY_REJECTED','Arcane API key is invalid, revoked or belongs to another local endpoint.');
    const identity=object(a.identity),fields=['clientSessionId','placeId','universeId','name','pluginVersion'];
    if(Object.keys(identity).length!==fields.length||Object.keys(identity).some(k=>!fields.includes(k)))throw new ArcaneError('IDENTITY','Invalid exact plugin identity.');
    const clientSessionId=textField(identity.clientSessionId,'client session',100);
    textField(identity.name,'Studio name',200);textField(identity.pluginVersion,'plugin version',80);
    for(const k of ['placeId','universeId'])if(!Number.isSafeInteger(identity[k])||(identity[k] as number)<0)throw new ArcaneError('IDENTITY','Invalid place/universe identity.');
    const requested=a.sessionId===undefined?null:textField(a.sessionId,'session ID',256);
    const rows=this.db.prepare("SELECT id,payload FROM sessions WHERE key_id=? AND json_extract(payload,'$.clientSessionId')=? ORDER BY rowid DESC").all(keyRow.id as string,clientSessionId) as Row[];
    if(requested&&!rows.some(row=>row.id===requested))throw new ArcaneError('AUTH','Requested status is not owned by this key and client lifetime.');
    const scoped=rows.filter(row=>!requested||row.id===requested);
    for(const row of scoped){const s=JSON.parse(row.payload as string) as StudioSession;
      if(fields.some(k=>s[k as keyof StudioSession]!==identity[k]))throw new ArcaneError('IDENTITY','The recorded session has another exact place identity.');
    }
    const base={protocolVersion:1 as const,identity:{...identity}};
    if(!scoped.length)return {...base,state:'absent'};
    // Do not use the display-limited commands()/sessions() catalogues here.
    for(const row of scoped)if(this.hasTestSetupFence()||this.#testOwners.has(row.id as string)||this.db.prepare("SELECT 1 FROM commands WHERE session_id=? AND state IN ('queued','dispatched','needs_reconciliation') LIMIT 1").get(row.id as string))return {...base,state:'reconciliation',sessionId:row.id as string};
    const active=scoped.find(row=>!(JSON.parse(row.payload as string) as StudioSession).revokedAt);
    if(active)return {...base,state:'active',sessionId:active.id as string};
    return {...base,state:'lost',sessionId:scoped[0]!.id as string};
  }
  /** Human-only (enforced by the route). A newer offer cancels any older pending one. Nothing is persisted:
   * a daemon restart drops every offer, and the claim compares only a hash of the ticket. */
  createPairingOffer(input: unknown, port: number, projectId: string): StudioPairingOfferView {
    const a = object(input);
    if (Object.keys(a).some(key => key !== 'allowedRoots' && key !== 'allowWrites')) throw new ArcaneError('INPUT', 'Invalid pairing offer request.');
    const allowedRoots = roots(a.allowedRoots);
    if (typeof a.allowWrites !== 'boolean' || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(projectId)) throw new ArcaneError('INPUT', 'Explicit grants, a local port and a project are required.');
    this.cancelPairingOffer();
    const now = this.now(), ticket = 'arcane_pair_v1_' + port + '_' + randomBytes(24).toString('hex');
    const view: StudioPairingOfferView = { offerId: randomUUID(), code: String(randomInt(0, 1_000_000)).padStart(6, '0'), issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + STUDIO_PAIRING_OFFER_MS).toISOString(), state: 'pending', allowedRoots, allowWrites: a.allowWrites, claim: null, request: null };
    this.#pairingOffer = { view, ticket, ticketHash: hash(ticket), port, projectId, expires: now + STUDIO_PAIRING_OFFER_MS, clientNonce: null, request: null };
    this.event('studio_pairing_offered', view.offerId, { allowedRoots, allowWrites: a.allowWrites, expiresAt: view.expiresAt });
    return structuredClone(view);
  }
  /** Metadata for the human panel. Never contains the ticket. */
  pairingOffer(): StudioPairingOfferView | null {
    const offer = this.#pairingOffer;
    if (!offer) return null;
    if ((offer.view.state === 'pending' || offer.view.state === 'awaiting-approval') && this.now() >= offer.expires) { offer.view.state = 'expired'; offer.ticket = null; offer.request = null; }
    return structuredClone(offer.view);
  }
  /** The loopback discovery answer, only while a fresh offer for this exact daemon port is pending. */
  pairingDiscovery(port: number): StudioPairingDiscovery | null {
    const view = this.pairingOffer(), offer = this.#pairingOffer;
    if (!view || !offer || view.state !== 'pending' || !offer.ticket || offer.port !== port) return null;
    if (offer.clientNonce) return null; // Already challenged: discovery closes for everyone else.
    return { protocolVersion: 1, port: offer.port, ticket: offer.ticket, expiresAt: view.expiresAt };
  }
  cancelPairingOffer(): boolean {
    const offer = this.#pairingOffer, state = this.pairingOffer()?.state;
    if (!offer || (state !== 'pending' && state !== 'awaiting-approval')) return false;
    offer.view.state = 'cancelled'; offer.ticket = null; offer.request = null; offer.view.request = null;
    this.event('studio_pairing_cancelled', offer.view.offerId, {});
    return true;
  }
  /** The live offer for this exact ticket, port and project; anything else is rejected without detail. */
  #pairingFor(ticket: string, port: number, projectId: string) {
    const match = PAIRING_TICKET.exec(ticket);
    const view = this.pairingOffer(), offer = this.#pairingOffer;
    if (!match || Number(match[1]) !== port || !view || !offer || (view.state !== 'pending' && view.state !== 'awaiting-approval') || !offer.ticket
      || offer.port !== port || offer.projectId !== projectId || !equal(offer.ticketHash, hash(ticket))) return null;
    return offer;
  }
  #burnPairing(offer: PairingOfferRecord, event: string): void {
    offer.ticket = null; offer.request = null; offer.view.state = 'failed'; offer.view.request = null;
    this.event(event, offer.view.offerId, {});
  }
  /** Step 1 (plugin -> Arcane): the plugin sends a fresh nonce; Arcane answers with proof that it knows the code the user
   * typed into the plugin. Exactly one challenge per offer: a second one (another process racing the plugin) burns it. */
  challengePairingOffer(input: unknown, port: number, projectId: string): { protocolVersion: 1; proof: string } {
    const a = object(input);
    if (Object.keys(a).some(key => !['protocolVersion', 'ticket', 'clientNonce'].includes(key)) || a.protocolVersion !== 1) throw new ArcaneError('INPUT', 'Invalid pairing challenge.');
    const rejected = () => new ArcaneError('PAIRING', 'This Arcane pairing offer is invalid, expired or already used. Click Connect Studio in Arcane again.');
    const ticket = textField(a.ticket, 'pairing ticket', 100), clientNonce = textField(a.clientNonce, 'pairing nonce', 32);
    const offer = this.#pairingFor(ticket, port, projectId);
    if (!offer || !PAIRING_NONCE.test(clientNonce)) throw rejected();
    if (offer.clientNonce !== null || offer.view.state !== 'pending') { this.#burnPairing(offer, 'studio_pairing_contested'); throw rejected(); }
    offer.clientNonce = clientNonce;
    this.event('studio_pairing_challenged', offer.view.offerId, {});
    return { protocolVersion: 1, proof: studioPairingProof(offer.view.code, 'arcane', ticket, clientNonce) };
  }
  /** Step 2 (plugin -> Arcane): the plugin proves the code over the same nonce. A wrong proof burns the offer (one guess).
   * The first valid claim records the place and waits for the user's Approve in Arcane; the plugin repeats the same claim
   * until then. Only after approval is the ticket burned and a long-lived key plus a live session issued, exactly once. */
  claimPairingOffer(input: unknown, port: number, projectId: string): StudioPairingClaimResult {
    const a = object(input);
    if (Object.keys(a).some(key => !['protocolVersion', 'ticket', 'clientNonce', 'proof', 'identity', 'capabilities'].includes(key))) throw new ArcaneError('INPUT', 'Invalid pairing claim.');
    const rejected = () => new ArcaneError('PAIRING', 'This Arcane pairing offer is invalid, expired or already used. Click Connect Studio in Arcane again.');
    const ticket = textField(a.ticket, 'pairing ticket', 100);
    const offer = this.#pairingFor(ticket, port, projectId);
    if (!offer) throw rejected();
    const clientNonce = typeof a.clientNonce === 'string' ? a.clientNonce : '', proof = typeof a.proof === 'string' ? a.proof : '';
    if (!offer.clientNonce || !equal(offer.clientNonce, clientNonce) || !PAIRING_PROOF.test(proof) || !equal(proof, studioPairingProof(offer.view.code, 'plugin', ticket, clientNonce))) {
      this.#burnPairing(offer, 'studio_pairing_failed'); throw rejected();
    }
    const identity = object(a.identity);
    if (!offer.request) {
      if (typeof identity.name !== 'string' || !Number.isSafeInteger(identity.placeId) || !Number.isSafeInteger(identity.universeId)) { this.#burnPairing(offer, 'studio_pairing_failed'); throw rejected(); }
      offer.request = { identity: structuredClone(identity), proof };
      offer.view.state = 'awaiting-approval';
      offer.view.request = { placeName: textField(identity.name, 'place name', 200), placeId: identity.placeId as number, universeId: identity.universeId as number, requestedAt: this.iso(), approved: false };
      this.event('studio_pairing_requested', offer.view.offerId, { placeId: identity.placeId, universeId: identity.universeId });
      return { state: 'awaiting-approval', expiresAt: offer.view.expiresAt };
    }
    // The same plugin, same place, repeating its claim while the user decides.
    if (!equal(offer.request.proof, proof) || JSON.stringify(offer.request.identity) !== JSON.stringify(identity)) { this.#burnPairing(offer, 'studio_pairing_failed'); throw rejected(); }
    if (!offer.view.request?.approved) return { state: 'awaiting-approval', expiresAt: offer.view.expiresAt };
    offer.ticket = null; offer.view.state = 'failed';
    const key = this.issueKey({ allowedRoots: offer.view.allowedRoots, allowWrites: offer.view.allowWrites }, port);
    let result: PairResult;
    try { result = this.connectWithKey({ apiKey: key.apiKey, protocolVersion: a.protocolVersion, identity: a.identity, capabilities: a.capabilities }, port); }
    catch (error) {
      try { this.revokeKey(key.keyId); } catch { /* The unused key stays listed for manual revocation. */ }
      offer.request = null; offer.view.request = null;
      this.event('studio_pairing_failed', offer.view.offerId, {});
      throw error;
    }
    offer.request = null; offer.view.state = 'claimed';
    offer.view.claim = { placeName: identity.name as string, placeId: identity.placeId as number, universeId: identity.universeId as number,
      sessionId: result.sessionId, keyId: key.keyId, claimedAt: this.iso() };
    this.event('studio_pairing_claimed', offer.view.offerId, { keyId: key.keyId, sessionId: result.sessionId, placeId: identity.placeId, universeId: identity.universeId });
    return { ...result, apiKey: key.apiKey };
  }
  /** Human-only (enforced by the route): Approve or Deny the place waiting on this exact offer. Deny burns the offer. */
  decidePairingOffer(input: unknown): StudioPairingOfferView {
    const a = object(input);
    if (Object.keys(a).sort().join() !== 'approve,offerId' || typeof a.approve !== 'boolean') throw new ArcaneError('INPUT', 'Invalid pairing decision.');
    const view = this.pairingOffer(), offer = this.#pairingOffer;
    if (!view || !offer || view.offerId !== a.offerId || view.state !== 'awaiting-approval' || !offer.view.request || offer.view.request.approved) throw new ArcaneError('PAIRING', 'No Studio connection is waiting for approval.');
    if (a.approve) { offer.view.request.approved = true; this.event('studio_pairing_approved', offer.view.offerId, {}); }
    else { offer.ticket = null; offer.request = null; offer.view.state = 'cancelled'; offer.view.request = null; this.event('studio_pairing_denied', offer.view.offerId, {}); }
    return structuredClone(offer.view);
  }
  authenticate(sessionId: string, token: string): StudioSession {
    const row = this.db.prepare('SELECT token_hash FROM sessions WHERE id=?').get(sessionId) as Row | undefined;
    if (!row || !equal(row.token_hash as string, hash(token))) throw new ArcaneError('AUTH', 'Invalid plugin session bearer.');
    return this.session(sessionId);
  }
  revoke(id: string, reason = 'user_revoked'): void {
    const s = this.session(id, false); if (s.revokedAt) return;
    s.revokedAt = this.iso(); this.saveSession(s);
    const active = this.db.prepare("SELECT payload FROM commands WHERE session_id=? AND state IN ('queued','dispatched')").all(id) as Row[];
    for (const row of active) {
      const c = JSON.parse(row.payload as string) as StudioCommand;
      if (c.state === 'queued' || c.state === 'dispatched') {
        c.state = c.state === 'dispatched' ? 'needs_reconciliation' : 'cancelled';
        c.error = 'Session ended: ' + reason + '. No automatic replay.'; c.finishedAt = this.iso(); this.saveCommand(c);
      }
    }
    this.event('studio_revoked', id, { reason });
  }
  enqueue(input: unknown, internalRestore = false, admission?: object): StudioCommand {
    const a = object(input); const sessionId = textField(a.sessionId, 'session ID');
    const requestId = textField(a.requestId, 'request ID', 128);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw new ArcaneError('INPUT', 'Request ID must be 8..128 safe characters.');
    const method = methodField(a.method);
    this.checkTestQueueAuthority(sessionId,requestId,admission);
    // Before idempotent lookup: a model cannot read/reuse a host staging receipt
    // by guessing its request ID, even if its JSON is structurally identical.
    if ((method === 'asset.stage_packet'||method==='asset.reconstruct'||method==='scene.observe_import'||method==='asset.apply_revision') && (!admission || !this.#assetStageAdmissions.has(admission))) throw new ArcaneError('ASSET_STAGE_AUTHORITY', 'Asset intake and reconstruction require the trusted native import controller.');
    if (method === 'asset.keep_mesh' && (!admission || !this.#meshKeepAdmissions.has(admission))) throw new ArcaneError('MESH_KEEP_AUTHORITY', 'Keep this mesh uploads to the user\'s Roblox account; only the person can start it, with the Keep this mesh button and its Arcane confirmation.');
    const fingerprint = hash(canonical({ sessionId, method, args: a.args }));
    return this.transaction(() => this.enqueueInTransaction(a,sessionId,requestId,method,fingerprint,internalRestore,admission));
  }
  /** Already inside a transaction. No callback, await or second commit here. */
  private enqueueInTransaction(a:ReturnType<typeof object>,sessionId:string,requestId:string,method:StudioCommand['method'],fingerprint:string,internalRestore:boolean,admission?:object):StudioCommand {
      this.checkTestQueueAuthority(sessionId,requestId,admission);
      if((method==='asset.stage_packet'||method==='asset.reconstruct'||method==='scene.observe_import'||method==='asset.apply_revision')&&(!admission||!this.#assetStageAdmissions.has(admission)))throw new ArcaneError('ASSET_STAGE_AUTHORITY','Asset intake and reconstruction require trusted host admission.');
      if(method==='asset.keep_mesh'&&(!admission||!this.#meshKeepAdmissions.has(admission)))throw new ArcaneError('MESH_KEEP_AUTHORITY','Keep this mesh requires the person\'s confirmed host admission.');
      const old = this.db.prepare('SELECT fingerprint,payload FROM commands WHERE request_id=?').get(requestId) as Row | undefined;
      if (old) {
        if (!equal(old.fingerprint as string, fingerprint)) throw new ArcaneError('IDEMPOTENCY', 'Request ID was already used with different input.');
        return JSON.parse(old.payload as string) as StudioCommand;
      }
      const s = this.session(sessionId);
      if (!this.live(s)) throw new ArcaneError('SESSION_OFFLINE', 'Studio session is not live: its plugin has not polled within ' + STUDIO_SESSION_LIVE_MS / 1000 + ' s. No command was queued. List sessions and choose a live one; do not retry against this session.');
      const args = validateCommandArgs(method, a.args, s, internalRestore);
      if(method==='scene.place_asset')this.assertEditableModelReview(sessionId,args);
      if(method==='scene.build')this.assertTemplateSources(sessionId,args);
      const activating = this.activationSource(method, args);
      const verification = admission ? this.#activationAdmissions.get(admission) : undefined;
      if (activating !== null && (!verification || verification.sourceSha256 !== hash(activating)))
        throw new ArcaneError('SOURCE_VERIFICATION', 'Activating a script requires the trusted host syntax verifier. No command was queued.');
      if (admission) this.#activationAdmissions.delete(admission);
      const pending = this.db.prepare("SELECT count(*) AS n FROM commands WHERE session_id=? AND state IN ('queued','dispatched')").get(sessionId) as Row;
      if (Number(pending.n) >= 100) throw new ArcaneError('BUSY', 'Studio queue is full.');
      if (this.db.prepare("SELECT id FROM commands WHERE session_id=? AND state='needs_reconciliation' LIMIT 1").get(sessionId)) throw new ArcaneError('RECONCILIATION', 'Unknown previous outcome blocks new commands. Inspect receipts and re-pair; do not retry the mutation blindly.');
      const row = this.db.prepare('UPDATE sessions SET epoch=epoch+1 WHERE id=? RETURNING epoch').get(sessionId) as Row;
      const c: StudioCommand = { protocolVersion: 1, id: randomUUID(), requestId, sessionId, clientSessionId: s.clientSessionId, method, args, allowedRoots: s.allowedRoots, allowWrites: s.allowWrites, leaseEpoch: Number(row.epoch), expiresAt: new Date(this.now() + 180000).toISOString(), state: 'queued', createdAt: this.iso(), finishedAt: null, result: null, error: null };
      this.db.prepare('INSERT INTO commands(id,request_id,session_id,fingerprint,state,payload,created) VALUES(?,?,?,?,?,?,?)').run(c.id, requestId, sessionId, fingerprint, c.state, JSON.stringify(c), this.now());
      if(method==='scene.upload_context'){
        const p=s.proof;
        // Missing/stale legacy proof remains a plain read; it gains no synthetic pin.
        if(p&&p.sessionId===s.id&&p.clientLifetimeId===s.clientSessionId&&p.placeId===s.placeId&&p.universeId===s.universeId
          &&p.mode==='Edit'&&p.connected&&p.continuitySupported&&Number.isFinite(Date.parse(p.observedAt))&&Date.parse(p.observedAt)<=this.now()
          &&Number.isFinite(Date.parse(p.expiresAt))&&Date.parse(p.expiresAt)>this.now()){
          const pin=uploadContextPinSchema.safeParse({sessionId:s.id,clientLifetimeId:p.clientLifetimeId,pluginArtifactHash:p.pluginArtifactHash,
            playEpoch:p.playEpoch,placeId:p.placeId,universeId:p.universeId});
          if(!pin.success)throw new ArcaneError('UPLOAD_CONTEXT_PIN','Actual upload context continuity is invalid.');
          this.db.prepare('INSERT INTO asset_upload_context_pins(command_id,request_id,lease_epoch,fingerprint,payload) VALUES(?,?,?,?,?)')
            .run(c.id,c.requestId,c.leaseEpoch,fingerprint,JSON.stringify(pin.data));
        }
      }
      if (verification) this.event('script_syntax_verified', c.id, { ...verification });
      this.event('command_queued', c.id, { sessionId, method, leaseEpoch: c.leaseEpoch }); return c;
  }
  private activationSource(method: StudioCommand['method'], args: Record<string, Json>): string | null {
    if (method === 'script.set_enabled' && args.enabled === true) return args.expectedSource as string;
    if (method === 'scene.restore') {
      const mutation = object(args.mutation);
      if (mutation.kind === 'script.set_enabled' && object(mutation.before).enabled === true) {
        const source = object(mutation.before).source;
        if (typeof source !== 'string') throw new ArcaneError('RECEIPT', 'Activation restoration has no exact source baseline.');
        return source;
      }
    }
    return null;
  }
  /** Normal command entry point. Awaited compilation never holds a SQLite
   * transaction; caller authority and the exact session are fenced afterwards. */
  async enqueueVerified(input: unknown, verifier: ScriptSourceVerifier | null, guard: () => void = () => {}, internalRestore = false): Promise<StudioCommand> {
    guard();
    const a = jsonObject(input, 600 * 1024);
    const sessionId = textField(a.sessionId, 'session ID');
    const requestId = textField(a.requestId, 'request ID', 128);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw new ArcaneError('INPUT', 'Request ID must be 8..128 safe characters.');
    const method = methodField(a.method);
    this.checkTestQueueAuthority(sessionId,requestId);
    if(method==='asset.stage_packet'||method==='asset.reconstruct'||method==='scene.observe_import'||method==='asset.apply_revision')throw new ArcaneError('ASSET_STAGE_AUTHORITY','Asset intake and reconstruction require private host admission, including idempotent lookup.');
    if(method==='asset.keep_mesh')throw new ArcaneError('MESH_KEEP_AUTHORITY','Keep this mesh uploads to the user\'s Roblox account; only the person can start it, with the Keep this mesh button and its Arcane confirmation.');
    const fingerprint = hash(canonical({ sessionId, method, args: a.args }));
    const old = this.db.prepare('SELECT fingerprint,payload FROM commands WHERE request_id=?').get(requestId) as Row | undefined;
    if (old) {
      if (!equal(old.fingerprint as string, fingerprint)) throw new ArcaneError('IDEMPOTENCY', 'Request ID was already used with different input.');
      return JSON.parse(old.payload as string) as StudioCommand;
    }
    const session = this.session(sessionId);
    const args = validateCommandArgs(method, a.args, session, internalRestore);
    const source = this.activationSource(method, args);
    if (source === null) return this.enqueue(a, internalRestore);
    if (!verifier) throw new ArcaneError('SOURCE_VERIFICATION', 'The trusted Luau syntax verifier is unavailable. No script was activated.');
    const identity = (s: StudioSession) => canonical({id:s.id,clientSessionId:s.clientSessionId,placeId:s.placeId,universeId:s.universeId,allowedRoots:s.allowedRoots,allowWrites:s.allowWrites,capabilities:s.capabilities,pluginVersion:s.pluginVersion,revokedAt:s.revokedAt});
    let proof: ScriptSourceVerification;
    try { proof = await verifier.verify(source); }
    catch { throw new ArcaneError('SOURCE_VERIFICATION', 'Script syntax verification failed. Correct the source or repair the trusted compiler; no activation was queued.'); }
    guard();
    if (this.closed || identity(this.session(sessionId)) !== identity(session)) throw new ArcaneError('SCOPE', 'Studio authority changed during verification.');
    if (!proof || proof.syntaxVerified !== true || proof.sourceSha256 !== hash(source) || !/^[a-f0-9]{64}$/.test(proof.compilerSha256) || !Number.isFinite(proof.elapsedMs) || proof.elapsedMs < 0)
      throw new ArcaneError('SOURCE_VERIFICATION', 'The trusted verifier did not attest this exact source.');
    const admission = Object.freeze({});
    this.#activationAdmissions.set(admission, Object.freeze({...proof}));
    try { return this.enqueue(a, internalRestore, admission); }
    finally { this.#activationAdmissions.delete(admission); }
  }
  command(id: string): StudioCommand {
    const row = this.db.prepare('SELECT payload FROM commands WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new ArcaneError('COMMAND', 'Unknown command receipt.'); return this.expired(JSON.parse(row.payload as string) as StudioCommand);
  }
  private stageCommandSnapshot(id:string):{command:StudioCommand;raw:string;cacheable:boolean} {
    const row=this.db.prepare('SELECT payload FROM commands WHERE id=?').get(id) as Row|undefined;
    if(!row)throw new ArcaneError('COMMAND','Unknown command receipt.');
    const raw=row.payload as string,parsed=JSON.parse(raw) as StudioCommand,state=parsed.state,command=this.expired(parsed);
    // Expiry can mutate the parsed record or re-read it in a transaction. Only
    // the unchanged object actually parsed from THIS raw string may be memoized.
    return {command,raw,cacheable:command===parsed&&command.state===state};
  }
  /** Process-local wake hint only. Callers must re-read the command and all
   * current authority after every wake. The original <=25ms timer remains the
   * fallback for cancellation, expiry and non-result state changes. */
  waitForCommandResult(commandId:string,ms:number):Promise<void> {
    if(this.closed)throw new ArcaneError('STUDIO_STAGE_CLOSED','Command journal is closed.');
    if(!stageJob.safeParse(commandId).success||!Number.isFinite(ms)||ms<1||ms>25)throw new ArcaneError('INPUT','Expected an exact command ID and a 1..25ms receipt wait.');
    const existing=this.#commandResultWaiters.get(commandId);
    if(this.#commandResultWaiterCount>=128||(existing?.size??0)>=8)throw new ArcaneError('BUSY','Command receipt wait capacity is full.');
    return new Promise<void>((resolve,reject)=>{
      let done=false,timer:ReturnType<typeof setTimeout>|undefined;
      const cleanup=()=>{
        if(done)return false;done=true;
        if(timer!==undefined)clearTimeout(timer);
        const waiters=this.#commandResultWaiters.get(commandId);waiters?.delete(finish);
        if(waiters?.size===0)this.#commandResultWaiters.delete(commandId);
        this.#commandResultWaiterCount--;return true;
      };
      const finish=()=>{if(cleanup())resolve();};
      const waiters=existing??new Set<()=>void>();waiters.add(finish);
      this.#commandResultWaiters.set(commandId,waiters);this.#commandResultWaiterCount++;
      try{
        timer=setTimeout(finish,ms);
        // Subscribe BEFORE the fresh terminal recheck. This read is a hint,
        // never a substitute for command()/receipt/dispatch validation.
        const row=this.db.prepare("SELECT state,CASE WHEN state IN ('succeeded','failed','cancelled','needs_reconciliation') THEN json_extract(payload,'$.state') END AS payload_state FROM commands WHERE id=?").get(commandId) as Row|undefined;
        if(!row)throw new ArcaneError('COMMAND','Unknown command receipt.');
        if(['succeeded','failed','cancelled','needs_reconciliation'].includes(String(row.state))&&row.payload_state===row.state)finish();
      }catch(error){cleanup();reject(error);}
    });
  }
  /** Read-only: the exact before/after source of one succeeded script.update receipt, for the human "View changes" diff.
   * Both sources were validated against the request when the receipt completed (each at most 100 KiB). */
  scriptChange(id: string): StudioScriptChange {
    const c = this.command(id);
    if (c.method !== 'script.update' || c.state !== 'succeeded') throw new ArcaneError('COMMAND', 'Only a succeeded script edit receipt has a source change.');
    const mutation = object(object(c.result).mutation), before = object(mutation.before).source, after = object(mutation.after).source, r = object(mutation.ref);
    if (typeof before !== 'string' || typeof after !== 'string' || typeof r.root !== 'string') throw new ArcaneError('RECEIPT', 'Script receipt has no recorded sources.');
    const segments = Array.isArray(r.pathSegments) ? r.pathSegments.filter((s): s is string => typeof s === 'string').slice(0, 64).map(s => s.slice(0, 100)) : [];
    return { commandId: c.id, path: [r.root, ...segments].join('.'), className: typeof r.className === 'string' ? r.className : null, before, after };
  }
  /** Durable intent before an irreversible engine call. Admission/rights are
   * checked by the trusted native controller, never inferred from these fields.
   * Only a FRESH insertion receives an opaque, process-owned outcome ticket. */
  beginAssetUpload(attemptId: string, value: AssetUploadIntent, guard: () => void): {fresh: boolean; record: AssetUploadJournalRecord; ticket: AssetUploadJournalTicket | null} {
    guard();
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(attemptId)) throw new ArcaneError('INPUT', 'Expected a fixed upload attempt UUID.');
    const input = jsonObject(value, 8192);
    const fields = ['projectId', 'jobId', 'sourceId', 'sourceSha256', 'assetType', 'sessionId', 'clientLifetimeId', 'pluginArtifactHash', 'playEpoch', 'placeId', 'universeId', 'creator', 'uploaderId', 'rightsGrantId', 'name', 'description'];
    if (Object.keys(input).length !== fields.length || Object.keys(input).some(k => !fields.includes(k))) throw new ArcaneError('INPUT', 'Expected exact upload intent fields.');
    for (const field of ['projectId', 'sourceSha256', 'pluginArtifactHash']) if (typeof input[field] !== 'string' || !/^[a-f0-9]{64}$/.test(input[field])) throw new ArcaneError('INPUT', 'Expected upload intent SHA-256 fields.');
    if (typeof input.jobId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.jobId)
      || input.assetType !== 'Mesh' && input.assetType !== 'Image') throw new ArcaneError('INPUT', 'Invalid upload job or resource type.');
    for (const field of ['sourceId', 'sessionId', 'clientLifetimeId', 'rightsGrantId']) textField(input[field], field, 256);
    textField(input.name, 'asset name', 100);
    if (typeof input.description !== 'string' || input.description.length > 1000 || input.description.includes('\0')) throw new ArcaneError('INPUT', 'Invalid asset description.');
    for (const field of ['placeId', 'universeId', 'playEpoch', 'uploaderId']) if (!Number.isSafeInteger(input[field]) || (input[field] as number) < (field === 'uploaderId' ? 1 : 0)) throw new ArcaneError('INPUT', 'Invalid upload identity.');
    const creator = object(input.creator);
    if (Object.keys(creator).length !== 2 || Object.keys(creator).some(k => !['kind', 'id'].includes(k)) || creator.kind !== 'user' && creator.kind !== 'group'
      || !Number.isSafeInteger(creator.id) || (creator.id as number) < 1) throw new ArcaneError('INPUT', 'Invalid observed upload creator.');
    // Detached snapshot before callback boundaries. Changing target/account
    // cannot hide an unknown prior upload of this same job/source resource.
    const intent = JSON.parse(JSON.stringify(input)) as AssetUploadIntent;
    const resourceKey = hash(canonical({projectId: intent.projectId, jobId: intent.jobId, sourceId: intent.sourceId, sourceSha256: intent.sourceSha256, assetType: intent.assetType}));
    const intentSha256 = hash(canonical(intent));
    let fresh = false;
    const record = this.transaction(() => {
      guard();
      const prior = this.db.prepare('SELECT payload FROM asset_uploads WHERE attempt_id=? OR resource_key=?').get(attemptId, resourceKey) as Row | undefined;
      if (prior) {
        const record = JSON.parse(prior.payload as string) as AssetUploadJournalRecord;
        if (record.attemptId !== attemptId || record.resourceKey !== resourceKey || record.intentSha256 !== intentSha256) throw new ArcaneError('UPLOAD_CONFLICT', 'This resource already has an upload outcome to inspect; do not create another attempt.');
        return record;
      }
      const time = this.iso();
      const record: AssetUploadJournalRecord = {attemptId, resourceKey, intent, intentSha256, state: 'intent', assetId: null, createdAt: time, updatedAt: time};
      this.db.prepare('INSERT INTO asset_uploads(attempt_id,resource_key,payload) VALUES(?,?,?)').run(attemptId, resourceKey, JSON.stringify(record));
      this.event('asset_upload_intent', attemptId, {resourceKey, intentSha256}); guard(); fresh = true; return record;
    });
    if (!fresh) return {fresh: false, record, ticket: null};
    const ticket = Object.freeze({kind: 'asset-upload-journal-ticket' as const}); this.#uploadTickets.set(ticket, attemptId);
    return {fresh: true, record, ticket};
  }
  /** Record only the outcome of a host-owned ticket. This logging may retain a
   * known asset ID after native authority retires; it authorizes no new effect. */
  finishAssetUpload(ticket: AssetUploadJournalTicket, outcome: {state: 'succeeded'; assetId: number} | {state: 'needs_reconciliation'; assetId: null}): AssetUploadJournalRecord {
    const attemptId = this.#uploadTickets.get(ticket);
    if (!attemptId) throw new ArcaneError('UPLOAD_TICKET', 'Upload outcome requires the original host-owned recording handle.');
    if (!outcome || Object.keys(outcome).length !== 2 || Object.keys(outcome).some(k => !['state', 'assetId'].includes(k))
      || !(outcome.state === 'succeeded' && Number.isSafeInteger(outcome.assetId) && outcome.assetId > 0 || outcome.state === 'needs_reconciliation' && outcome.assetId === null)) throw new ArcaneError('INPUT', 'Invalid observed upload outcome.');
    return this.transaction(() => {
      const record = this.assetUpload(attemptId);
      if (record.state !== 'intent') {
        if (record.state !== outcome.state || record.assetId !== outcome.assetId) throw new ArcaneError('UPLOAD_CONFLICT', 'Observed upload outcomes are immutable.');
        return record;
      }
      record.state = outcome.state; record.assetId = outcome.assetId; record.updatedAt = this.iso();
      this.db.prepare('UPDATE asset_uploads SET payload=? WHERE attempt_id=?').run(JSON.stringify(record), attemptId);
      this.event('asset_upload_' + outcome.state, attemptId, {assetId: record.assetId}); return record;
    });
  }
  assetUpload(attemptId: string): AssetUploadJournalRecord {
    const row = this.db.prepare('SELECT payload FROM asset_uploads WHERE attempt_id=?').get(attemptId) as Row | undefined;
    if (!row) throw new ArcaneError('UPLOAD_NOT_FOUND', 'Unknown upload attempt.');
    return JSON.parse(row.payload as string) as AssetUploadJournalRecord;
  }
  /** Detached historical pin. Never rebind it to a newer poll proof/epoch. */
  assetUploadContextPin(commandId:string):AssetUploadContextPin|null {
    if(this.closed||!stageJob.safeParse(commandId).success)throw new ArcaneError('UPLOAD_CONTEXT_PIN','Upload context pin lookup is unavailable or invalid.');
    const row=this.db.prepare('SELECT p.*,c.payload AS command_payload,c.session_id AS command_session_id,c.fingerprint AS command_fingerprint FROM asset_upload_context_pins p LEFT JOIN commands c ON c.id=p.command_id WHERE p.command_id=?').get(commandId) as Row|undefined;
    if(!row)return null;
    if(typeof row.payload!=='string'||Buffer.byteLength(row.payload)>2048||typeof row.command_payload!=='string')throw new ArcaneError('UPLOAD_CONTEXT_PIN','Original upload context command is unavailable.');
    let pin:AssetUploadContextPin,command:StudioCommand;
    try{pin=uploadContextPinSchema.parse(JSON.parse(row.payload));command=JSON.parse(row.command_payload) as StudioCommand;}
    catch{throw new ArcaneError('UPLOAD_CONTEXT_PIN','Stored upload context pin is invalid.');}
    const session=this.session(pin.sessionId,false);
    if(command.id!==commandId||command.method!=='scene.upload_context'||command.sessionId!==pin.sessionId||row.command_session_id!==pin.sessionId
      ||command.clientSessionId!==pin.clientLifetimeId||session.clientSessionId!==pin.clientLifetimeId||session.placeId!==pin.placeId||session.universeId!==pin.universeId
      ||command.requestId!==row.request_id||command.leaseEpoch!==row.lease_epoch||row.command_fingerprint!==row.fingerprint
      ||hash(canonical({sessionId:command.sessionId,method:command.method,args:command.args}))!==row.fingerprint
      ||!command.args||typeof command.args!=='object'||Array.isArray(command.args)||Reflect.ownKeys(command.args).length!==0)
      throw new ArcaneError('UPLOAD_CONTEXT_PIN','Pin does not name the original upload context role, session and lifetime.');
    return {...pin};
  }
  private saveStageRun(run:StageRunStored):void {
    this.db.prepare('UPDATE asset_stage_attempts SET payload=? WHERE run_id=?').run(JSON.stringify(run),run.runId);
  }
  private stageGuard(guard:()=>void):void {
    if(this.closed)throw new ArcaneError('STUDIO_STAGE_CLOSED','Stage journal is closed.');
    if(typeof guard!=='function'||types.isProxy(guard)||types.isAsyncFunction(guard)||types.isGeneratorFunction(guard))throw new ArcaneError('STUDIO_STAGE_GUARD','Expected a synchronous host scope guard.');
    const result:unknown=guard();
    // Never await inside a transaction. Observe an unexpected native Promise's
    // rejection, then refuse it; it cannot become deferred admission.
    if(types.isPromise(result))void Promise.prototype.then.call(result,()=>undefined,()=>undefined);
    if(result!==undefined)throw new ArcaneError('STUDIO_STAGE_GUARD','Expected a synchronous host scope guard.');
  }
  private stageTarget(intent:StageRunIntent):void {
    const session=this.session(intent.target.sessionId);
    // Legacy-shaped scope probe only, never retained/transferred source data.
    // Actual packets are version-checked at queue and durable read boundaries.
    validateCommandArgs('asset.stage_packet',{expected:{digest:intent.transferDigest,payloadDigest:intent.payloadDigest,manifestDigest:intent.manifestDigest},
      packet:JSON.stringify({formatVersion:1,ordinal:0,kind:'begin',payloadDigest:intent.payloadDigest,manifestDigest:intent.manifestDigest}),
      target:intent.target,continuity:intent.continuity},session);
    if(!session.proof||!Number.isFinite(Date.parse(session.proof.expiresAt))||Date.parse(session.proof.expiresAt)<=this.now())throw new ArcaneError('STUDIO_STAGE_SCOPE','Stage continuity has expired.');
  }
  /** Host-only facts. The trusted guard owns actual actor/job attribution. */
  beginStageRun(input:StageRunIntent,guard:()=>void):StageRunBeginResult {
    this.stageGuard(guard);const intent=stageIntent(input),intentSha256=hash(canonical(intent));
    let fresh=false;
    const record=this.transaction(()=>{
      this.stageGuard(guard);
      const prior=this.readStageRun(intent.projectId,intent.jobId);
      if(prior){if(prior.intentSha256!==intentSha256)throw new ArcaneError('STUDIO_STAGE_CONFLICT','This job already has a pinned stage run.');return prior;}
      this.stageTarget(intent);
      if(Number((this.db.prepare('SELECT count(*) AS n FROM asset_stage_attempts').get() as Row).n)>=STUDIO_STAGE_RUN_LIMITS.runs)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage journal capacity is full; no history was evicted.');
      const at=this.iso(),run:StageRunStored={runId:randomUUID(),intent,intentSha256,createdAt:at,updatedAt:at,closedAt:null};
      this.db.prepare('INSERT INTO asset_stage_attempts VALUES(?,?,?,?,?,1,NULL,?)').run(run.runId,intent.projectId,intent.jobId,intentSha256,JSON.stringify(run),stageContinuityKey(intent));
      this.event('asset_stage_started',run.runId,{projectId:intent.projectId,jobId:intent.jobId});this.stageGuard(guard);fresh=true;
      return this.stageRunById(run.runId);
    });
    if(!fresh)return {created:false,runId:record.runId,handle:null,record};
    const handle=Object.freeze({kind:'studio-stage-run-handle' as const});this.#stageRunHandles.set(handle,record.runId);
    return {created:true,runId:record.runId,handle,record};
  }
  /** A new CPU attempt, never a replay of old command or upload authority. */
  beginStageAttempt(input:StageRunIntent,previousRunId:string,guard:()=>void):StageRunBeginResult {
    this.stageGuard(guard);const intent=stageIntent(input),intentSha256=hash(canonical(intent));
    if(!stageJob.safeParse(previousRunId).success||!intent.preparationAttemptId)throw new ArcaneError('STUDIO_STAGE_INPUT','A fresh witnessed preparation attempt is required.');
    const record=this.transaction(()=>{
      this.stageGuard(guard);this.stageTarget(intent);
      const prior=this.readStageRun(intent.projectId,intent.jobId);
      if(!prior||prior.runId!==previousRunId||prior.closedAt===null)throw new ArcaneError('STUDIO_STAGE_STATE','The exact preceding attempt must be closed.');
      if(canonical(prior.intent.conversation)!==canonical(intent.conversation))throw new ArcaneError('STUDIO_STAGE_CONFLICT','Native conversation changed.');
      if(prior.intent.target.sessionId===intent.target.sessionId&&prior.intent.continuity.clientLifetimeId===intent.continuity.clientLifetimeId&&intent.continuity.playEpoch<=prior.intent.continuity.playEpoch)throw new ArcaneError('STUDIO_STAGE_EXISTS','This live continuity cannot repeat its attempt.');
      for(const row of this.db.prepare('SELECT payload FROM asset_stage_attempts WHERE project_id=? AND job_id=? LIMIT 65').iterate(intent.projectId,intent.jobId)){
        const old=JSON.parse(row.payload as string) as StageRunStored;
        if(old.intent.preparationAttemptId===intent.preparationAttemptId)throw new ArcaneError('STUDIO_STAGE_CONFLICT','A historical preparation cannot be upgraded into a new attempt.');
      }
      if(this.db.prepare('SELECT run_id FROM asset_stage_attempts WHERE project_id=? AND job_id=? AND continuity_key=?').get(intent.projectId,intent.jobId,stageContinuityKey(intent)))throw new ArcaneError('STUDIO_STAGE_EXISTS','This continuity already has retained evidence.');
      if(Number((this.db.prepare('SELECT count(*) AS n FROM asset_stage_attempts').get() as Row).n)>=STUDIO_STAGE_RUN_LIMITS.runs)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage journal capacity is full; no history was evicted.');
      const at=this.iso(),run:StageRunStored={runId:randomUUID(),intent,intentSha256,createdAt:at,updatedAt:at,closedAt:null};
      this.db.prepare('INSERT INTO asset_stage_attempts VALUES(?,?,?,?,?,?,?,?)').run(run.runId,intent.projectId,intent.jobId,intentSha256,JSON.stringify(run),prior.attempt+1,prior.runId,stageContinuityKey(intent));
      this.event('asset_stage_started',run.runId,{projectId:intent.projectId,jobId:intent.jobId,previousRunId:prior.runId});this.stageGuard(guard);
      return this.stageRunById(run.runId);
    });
    const handle=Object.freeze({kind:'studio-stage-run-handle' as const});this.#stageRunHandles.set(handle,record.runId);
    return {created:true,runId:record.runId,handle,record};
  }
  private stageHandle(handle:StageRunHandle):string {
    if(this.closed)throw new ArcaneError('STUDIO_STAGE_CLOSED','Stage journal is closed.');
    const id=handle&&typeof handle==='object'?this.#stageRunHandles.get(handle):undefined;
    if(!id)throw new ArcaneError('STUDIO_STAGE_HANDLE','Stage entry requires the original process-owned handle.');return id;
  }
  enqueueStagePacket(handle:StageRunHandle,ordinal:number,input:StudioAssetStageArgs,guard:()=>void):StudioCommand {
    const runId=this.stageHandle(handle);this.stageGuard(guard);
    const args=stageSnapshot(input) as unknown as StudioAssetStageArgs,text=JSON.stringify(args);
    if(Buffer.byteLength(text)>STUDIO_STAGE_RUN_LIMITS.argumentBytes)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage arguments exceed 256 KiB.');
    const admission=Object.freeze({});this.#assetStageAdmissions.add(admission);
    try{return this.transaction(()=>{
      this.stageGuard(guard);const run=this.stageRunById(runId),intent=run.intent,plan=intent.plan[ordinal];
      if(run.closedAt!==null||!Number.isInteger(ordinal)||!plan||plan.ordinal!==ordinal)throw new ArcaneError('STUDIO_STAGE_STATE','Stage run is closed or ordinal is invalid.');
      this.stageTarget(intent);
      if(hash(text)!==plan.argsSha256||Buffer.byteLength(text)!==plan.envelopeByteLength
        ||canonical(args.target)!==canonical(intent.target)||canonical(args.continuity)!==canonical(intent.continuity)
        ||canonical(args.expected)!==canonical({digest:intent.transferDigest,payloadDigest:intent.payloadDigest,manifestDigest:intent.manifestDigest})
        ||typeof args.packet!=='string'||Buffer.byteLength(args.packet)!==plan.packetByteLength)throw new ArcaneError('STUDIO_STAGE_CONFLICT','Stage arguments differ from the pinned plan.');
      const packet=object(JSON.parse(args.packet));
      if(packet.ordinal!==ordinal||plan.expectedReceipt.state!==(packet.kind==='seal'?'sealed':'receiving'))throw new ArcaneError('STUDIO_STAGE_CONFLICT','Stage packet accounting differs from its plan.');
      const associated=run.commands.find(c=>c.ordinal===ordinal);
      if(associated)return associated.command; // Exact original command only; never replay.
      if(run.phase==='needs_reconciliation'||ordinal!==run.commands.length||run.commands.some(c=>c.command.state!=='succeeded'))throw new ArcaneError('STUDIO_STAGE_STATE','Finish the preceding original packet before enqueueing the next.');
      const requestId='assetstage_'+hash(canonical({runId,ordinal,intentSha256:run.intentSha256}));
      if(this.db.prepare('SELECT id FROM commands WHERE request_id=?').get(requestId))throw new ArcaneError('STUDIO_STAGE_CONFLICT','An unassociated command cannot be adopted.');
      const sessionId=intent.target.sessionId,method='asset.stage_packet' as const,a=object({sessionId,requestId,method,args});
      const fingerprint=hash(canonical({sessionId,method,args}));
      const command=this.enqueueInTransaction(a,sessionId,requestId,method,fingerprint,false,admission);
      this.db.prepare('INSERT INTO asset_stage_attempt_commands(run_id,ordinal,command_id,request_id,lease_epoch,fingerprint) VALUES(?,?,?,?,?,?)').run(runId,ordinal,command.id,command.requestId,command.leaseEpoch,fingerprint);
      const stored:StageRunStored={runId,intent,intentSha256:run.intentSha256,createdAt:run.createdAt,updatedAt:this.iso(),closedAt:null};this.saveStageRun(stored);
      this.stageGuard(guard);this.#assetDispatchGuards.set(command.id,guard);return command;
    });}finally{this.#assetStageAdmissions.delete(admission);}
  }
  /** Outcome recording survives actor retirement; this handle permits no new effect. */
  closeStageRun(handle:StageRunHandle):StageRunRecord {
    const runId=this.stageHandle(handle);
    try{return this.transaction(()=>{
      const run=this.stageRunById(runId);
      if(run.closedAt===null){
        for(const {command}of run.commands){
          if(command.state!=='queued'&&command.state!=='dispatched')continue;
          command.state=command.state==='queued'?'cancelled':'needs_reconciliation';command.error='Native stage run stopped. No automatic replay.';
          command.finishedAt=this.iso();this.saveCommand(command);this.event('command_'+command.state,command.id,{sessionId:command.sessionId,method:command.method});
        }
        const at=this.iso();this.saveStageRun({runId,intent:run.intent,intentSha256:run.intentSha256,createdAt:run.createdAt,updatedAt:at,closedAt:at});
      }
      return this.stageRunById(runId);
    });}finally{this.clearStageContentHashes();}
  }
  /** Local historical evidence only. Caller scope must be checked by the host. */
  readStageRun(projectId:string,jobId:string,runId?:string):StageRunRecord|null {
    if(this.closed)throw new ArcaneError('STUDIO_STAGE_CLOSED','Stage journal is closed.');
    if(!stageHash.safeParse(projectId).success||!stageJob.safeParse(jobId).success)throw new ArcaneError('STUDIO_STAGE_INPUT','Invalid stage lookup.');
    if(runId!==undefined&&!stageJob.safeParse(runId).success)throw new ArcaneError('STUDIO_STAGE_INPUT','Invalid run identity.');
    const row=(runId===undefined?this.db.prepare('SELECT run_id FROM asset_stage_attempts WHERE project_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(projectId,jobId)
      :this.db.prepare('SELECT run_id FROM asset_stage_attempts WHERE project_id=? AND job_id=? AND run_id=?').get(projectId,jobId,runId)) as Row|undefined;
    return row?this.stageRunById(row.run_id as string):null;
  }
  private stageRunById(runId:string):StageRunRecord {
    try{
    const row=this.db.prepare('SELECT * FROM asset_stage_attempts WHERE run_id=?').get(runId) as Row|undefined;
    if(!row)throw new ArcaneError('STUDIO_STAGE_NOT_FOUND','Unknown stage run.');
    const run=JSON.parse(row.payload as string) as StageRunStored,intent=stageIntent(run.intent);
    if(run.runId!==runId||intent.projectId!==row.project_id||intent.jobId!==row.job_id||run.intentSha256!==row.intent_sha256||hash(canonical(intent))!==run.intentSha256)throw new ArcaneError('STUDIO_STAGE_RECEIPT','Stage journal identity differs.');
    if(!Number.isSafeInteger(row.attempt_no)||Number(row.attempt_no)<1||Number(row.attempt_no)>64||row.continuity_key!==stageContinuityKey(intent)
      ||(row.attempt_no===1?row.previous_run_id!==null:typeof row.previous_run_id!=='string'||!stageJob.safeParse(row.previous_run_id).success
        ||!this.db.prepare('SELECT 1 FROM asset_stage_attempts WHERE run_id=? AND project_id=? AND job_id=? AND attempt_no=?').get(row.previous_run_id,intent.projectId,intent.jobId,Number(row.attempt_no)-1)))throw new ArcaneError('STUDIO_STAGE_RECEIPT','Stage attempt metadata differs.');
    const rows=this.db.prepare('SELECT * FROM asset_stage_attempt_commands WHERE run_id=? ORDER BY ordinal LIMIT 513').all(runId) as Row[];
    if(rows.length>intent.plan.length)throw new ArcaneError('STUDIO_STAGE_RECEIPT','Stage association exceeds its plan.');
    if(this.#stageHashRun!==runId){this.clearStageContentHashes();this.#stageHashRun=runId;}
    let invalidReceipt=false,packetVersion:number|undefined;
    const commands:StageRunCommandAssociation[]=rows.map((member,ordinal)=>{
      const {command,raw,cacheable}=this.stageCommandSnapshot(member.command_id as string),plan=intent.plan[ordinal]!;
      const original=this.db.prepare('SELECT fingerprint,state FROM commands WHERE id=?').get(command.id) as Row;
      if(member.ordinal!==ordinal||command.id!==member.command_id||command.requestId!==member.request_id||command.leaseEpoch!==member.lease_epoch
        ||command.method!=='asset.stage_packet'||command.sessionId!==intent.target.sessionId||command.clientSessionId!==intent.continuity.clientLifetimeId
        ||!original||original.fingerprint!==member.fingerprint||original.state!==command.state)throw new ArcaneError('STUDIO_STAGE_RECEIPT','Original stage command differs from the pinned association.');
      const key=JSON.stringify([runId,run.intentSha256,ordinal,member.ordinal,member.command_id,member.request_id,member.lease_epoch,member.fingerprint,original.fingerprint,original.state,plan.argsSha256]);
      const saved=cacheable?this.#stageHashes.get(command.id):undefined,hit=saved?.raw===raw&&saved.key===key;
      const fingerprint=hit?saved.fingerprint:hash(canonical({sessionId:command.sessionId,method:command.method,args:command.args}));
      const argsSha256=hit?saved.argsSha256:hash(JSON.stringify(command.args));
      if(fingerprint!==member.fingerprint||argsSha256!==plan.argsSha256)throw new ArcaneError('STUDIO_STAGE_RECEIPT','Original stage command differs from the pinned association.');
      if(cacheable&&!hit)this.rememberStageContentHashes(command.id,raw,key,fingerprint,argsSha256);
      const content=cacheable?this.#stageHashes.get(command.id):undefined;
      let packet=content?.raw===raw?content.packetHeader:undefined;
      if(!packet){
        const body=object(JSON.parse(command.args.packet as string));
        if(body.formatVersion===2)parseConvertedStudioImportTransferPacket(command.args.packet);
        else if(body.formatVersion!==1)throw new ArcaneError('STUDIO_STAGE_RECEIPT','Original packet version is unsupported.');
        packet={formatVersion:body.formatVersion as number,ordinal:body.ordinal,payloadDigest:body.payloadDigest,manifestDigest:body.manifestDigest,kind:body.kind};
        if(content?.raw===raw)content.packetHeader=packet;
      }
      if(packet.formatVersion===2&&(packet.ordinal!==ordinal||packet.payloadDigest!==intent.payloadDigest||packet.manifestDigest!==intent.manifestDigest||plan.expectedReceipt.state!==(packet.kind==='seal'?'sealed':'receiving')))throw new ArcaneError('STUDIO_STAGE_RECEIPT','Converted original packet accounting changed.');
      if(packetVersion!==undefined&&packet.formatVersion!==packetVersion)throw new ArcaneError('STUDIO_STAGE_RECEIPT','Original transfer mixed packet versions.');packetVersion=packet.formatVersion;
      if(command.state==='succeeded'&&canonical(command.result)!==canonical(plan.expectedReceipt))invalidReceipt=true;
      return {ordinal,commandId:command.id,requestId:command.requestId,leaseEpoch:command.leaseEpoch,fingerprint,command};
    });
    const complete=!invalidReceipt&&commands.length===intent.plan.length&&commands.every(c=>c.command.state==='succeeded');
    if(complete)this.convertedStageInspection(intent,commands);
    const unresolved=invalidReceipt||commands.some(c=>c.command.state==='needs_reconciliation'||run.closedAt!==null&&(c.command.state==='dispatched'||c.command.state==='succeeded'));
    const phase=complete?'cpu-staged':unresolved?'needs_reconciliation':run.closedAt!==null||commands.some(c=>['failed','cancelled'].includes(c.command.state))?'stopped':'running';
    if(phase==='needs_reconciliation'||commands.some(c=>!['queued','dispatched','succeeded','failed','cancelled'].includes(c.command.state)))this.clearStageContentHashes();
    return {...run,intent,attempt:Number(row.attempt_no),previousRunId:row.previous_run_id as string|null,phase,commands,receipt:complete?structuredClone(intent.plan.at(-1)!.expectedReceipt):null};
    }catch(error){this.clearStageContentHashes();throw error;}
  }
  /** Host-only archival pin for one exact project/job (no actor, model or HTTP exposure).
   * True unless EVERY retained stage attempt is provably ended and every upload for the job has a
   * known successful outcome:
   * - a stage attempt pins unless it is closed AND its derived phase is 'stopped' (running, cpu-staged
   *   awaiting engine completion, needs_reconciliation, or any reconstruction association all pin);
   * - an upload pins in 'intent' (effect unknown) or 'needs_reconciliation'.
   * Invalid ids, closed storage, corrupt or over-bound journals refuse (throw) rather than imply absence.
   * Read-only: one deferred read transaction; no write, pruning, migration, queueing or engine effect. */
  hasPendingStageWork(projectId:string,jobId:string):boolean {
    if(this.closed)throw new ArcaneError('STUDIO_STAGE_CLOSED','Stage journal is closed.');
    if(!stageHash.safeParse(projectId).success||!stageJob.safeParse(jobId).success)throw new ArcaneError('STUDIO_STAGE_INPUT','Invalid stage lookup.');
    this.db.exec('BEGIN DEFERRED');
    try{
      const attempts=this.db.prepare('SELECT run_id FROM asset_stage_attempts WHERE project_id=? AND job_id=? ORDER BY attempt_no LIMIT ?').all(projectId,jobId,STUDIO_STAGE_RUN_LIMITS.runs+1) as Row[];
      if(attempts.length>STUDIO_STAGE_RUN_LIMITS.runs)throw new ArcaneError('STUDIO_STAGE_BUDGET','Stage history exceeds its bound; refusing to infer absence.');
      for(const {run_id}of attempts){
        const run=this.stageRunById(run_id as string); // Validates identity, chain and every original command association.
        if(run.closedAt===null||run.phase!=='stopped')return true;
        if(this.db.prepare('SELECT 1 FROM asset_stage_reconstructions WHERE run_id=?').get(run.runId))return true;
      }
      const limit=8192,uploads=this.db.prepare('SELECT attempt_id,resource_key,payload FROM asset_uploads LIMIT ?').all(limit+1) as Row[];
      if(uploads.length>limit)throw new ArcaneError('UPLOAD_JOURNAL','Upload journal exceeds its bound; refusing to infer absence.');
      for(const row of uploads){
        let record:AssetUploadJournalRecord;
        try{
          if(typeof row.payload!=='string'||Buffer.byteLength(row.payload)>16*1024)throw new Error('Oversized journal.');
          record=uploadJournalSchema.parse(JSON.parse(row.payload));
          const intent=record.intent,resourceKey=hash(canonical({projectId:intent.projectId,jobId:intent.jobId,sourceId:intent.sourceId,sourceSha256:intent.sourceSha256,assetType:intent.assetType}));
          if(record.attemptId!==row.attempt_id||record.resourceKey!==row.resource_key||record.resourceKey!==resourceKey||record.intentSha256!==hash(canonical(intent)))throw new Error('Journal identity differs.');
        }catch{throw new ArcaneError('UPLOAD_JOURNAL','Stored upload journal is invalid.');}
        if(record.intent.projectId===projectId&&record.intent.jobId===jobId&&record.state!=='succeeded')return true;
      }
      return false;
    }finally{this.db.exec('COMMIT');}
  }
  /** Derives complete metadata only from associated original packet bytes.
   * This never restores decoded-data authority or a stage-run handle. */
  private convertedStageInspection(intent:StageRunIntent,commands:readonly StageRunCommandAssociation[]):Pick<ReturnType<typeof inspectConvertedStudioImportTransfer>,'graph'>|null {
    if(!commands.length)return null;
    const first=object(JSON.parse(commands[0]!.command.args.packet as string));
    if(first.formatVersion!==2)return null;
    if(commands.length!==intent.plan.length)throw new ArcaneError('STUDIO_RECONSTRUCT_SOURCE','Converted packet closure is incomplete.');
    // Every caller has already checked actual original command bytes against
    // these plan hashes. Cache metadata only, never live scope or permissions.
    const key=hash(canonical(intent));const cached=this.#convertedStageInspections.get(key);if(cached)return cached;
    const packets=commands.map(({command},ordinal)=>{
      const json=command.args.packet;if(typeof json!=='string')throw new ArcaneError('STUDIO_STAGE_RECEIPT','Original packet bytes are absent.');
      const body=parseConvertedStudioImportTransferPacket(json);
      if(body.ordinal!==ordinal||body.payloadDigest!==intent.payloadDigest||body.manifestDigest!==intent.manifestDigest)throw new ArcaneError('STUDIO_STAGE_RECEIPT','Converted packet identity changed.');
      return {ordinal,kind:body.kind,json,byteLength:Buffer.byteLength(json),sha256:hash(json)};
    });
    const header=object(first.graph),inspection=inspectConvertedStudioImportTransfer({formatVersion:2,engineVerification:'pending',preparedDigest:intent.preparedDigest,
      payloadDigest:intent.payloadDigest,digest:intent.transferDigest,packets,byteLength:packets.reduce((sum,p)=>sum+p.byteLength,0),
      graphDigest:header.digest,nodeCount:header.nodeCount,conversionRequestDigest:first.conversionRequestDigest});
    if(inspection.begin.projectId!==intent.projectId||inspection.begin.revisionId!==intent.jobId||canonical(inspection.begin.target)!==canonical(intent.target))throw new ArcaneError('STUDIO_STAGE_RECEIPT','Converted original packet target or project differs from its journal.');
    const metadata=Object.freeze({graph:inspection.graph});
    if(this.#convertedStageInspections.size>=STUDIO_STAGE_RUN_LIMITS.runs)this.#convertedStageInspections.clear();this.#convertedStageInspections.set(key,metadata);return metadata;
  }
  /** Derive a reconstruction from ORIGINAL associated packet bytes, never a
   * caller's source list. Only the plugin owns the actual sealed receiver. */
  private stageReconstructionArgs(run:StageRunRecord):StudioAssetReconstructArgs {
    if(run.closedAt===null||run.phase!=='cpu-staged'||!run.receipt)throw new ArcaneError('STUDIO_RECONSTRUCT_STATE','Only a closed, fully sealed original stage run may reconstruct.');
    const objects:StudioAssetReconstructArgs['objects']=[];
    for(const {command}of run.commands){
      const packet=object(JSON.parse(command.args.packet as string));
      if(packet.kind!=='object')continue;
      const source=object(packet.object),primitives=packet.primitives;
      if(!Array.isArray(primitives))throw new ArcaneError('STUDIO_RECONSTRUCT_SOURCE','Original source primitives are unavailable.');
      objects.push({sourceObjectId:source.sourceObjectId as string,meshExportSha256:source.meshExportSha256 as string,
        vertexCount:primitives.reduce((n,p)=>n+Number(object(p).vertexCount),0),triangleCount:primitives.reduce((n,p)=>n+Number(object(p).triangleCount),0)});
    }
    const converted=this.convertedStageInspection(run.intent,run.commands);
    const args:StudioAssetReconstructArgs={runId:run.runId,expected:{digest:run.intent.transferDigest,payloadDigest:run.intent.payloadDigest,manifestDigest:run.intent.manifestDigest},
      packetCount:run.receipt.packetCount,byteLength:run.receipt.byteLength,target:run.intent.target,continuity:run.intent.continuity,objects,
      ...(converted?{formatVersion:2 as const,graphDigest:converted.graph.digest,nodeCount:converted.graph.nodes.length,
        nodes:run.commands.map(({command})=>object(JSON.parse(command.args.packet as string))).filter(packet=>packet.kind==='node').map(packet=>{
          const node=object(packet.node),mesh=converted.graph.meshes.find(row=>row.nodeKey===node.nodeKey);
          return {nodeKey:node.nodeKey as string,parentKey:node.parentKey as string|null,sourceObjectId:mesh?.sourceObjectId??null};
        })}:{})};
    return args;
  }
  /** Private host admission with one durable command association per original
   * stage run. Repetition only reads the original command, never dispatches anew. */
  enqueueStageReconstruction(projectId:string,jobId:string,runId:string,guard:()=>void):StudioCommand {
    this.stageGuard(guard);
    const run=this.readStageRun(projectId,jobId,runId);
    if(!run)throw new ArcaneError('STUDIO_STAGE_NOT_FOUND','Original stage run is unavailable.');
    const args=this.stageReconstructionArgs(run);
    validateCommandArgs('asset.reconstruct',args,this.session(run.intent.target.sessionId));this.stageTarget(run.intent);
    const prior=this.readStageReconstruction(projectId,jobId,runId);
    if(prior)return prior.command;
    if(this.#reconstructionClaims.has(runId))throw new ArcaneError('STUDIO_RECONSTRUCT_EXISTS','This original reconstruction has an uncertain admission; never replay.');
    this.stageGuard(guard);this.#reconstructionClaims.add(runId); // BEFORE any uncertain transaction.
    const admission=Object.freeze({});this.#assetStageAdmissions.add(admission);
    try{return this.transaction(()=>{
      this.stageGuard(guard);const current=this.readStageRun(projectId,jobId,runId);
      if(!current||canonical(this.stageReconstructionArgs(current))!==canonical(args))throw new ArcaneError('STUDIO_RECONSTRUCT_SOURCE','Original stage association changed.');
      this.stageTarget(current.intent);
      const sessionId=current.intent.target.sessionId,method='asset.reconstruct' as const;
      const requestId='assetreconstruct_'+hash(canonical({runId,intentSha256:current.intentSha256}));
      if(this.db.prepare('SELECT id FROM commands WHERE request_id=?').get(requestId))throw new ArcaneError('STUDIO_RECONSTRUCT_CONFLICT','An unassociated command cannot be adopted.');
      const fingerprint=hash(canonical({sessionId,method,args}));
      const command=this.enqueueInTransaction(object({sessionId,requestId,method,args}),sessionId,requestId,method,fingerprint,false,admission);
      this.db.prepare('INSERT INTO asset_stage_reconstructions VALUES(?,?,?,?,?)').run(runId,command.id,command.requestId,command.leaseEpoch,fingerprint);
      this.stageGuard(guard);this.#assetDispatchGuards.set(command.id,guard);return command;
    });}finally{this.#assetStageAdmissions.delete(admission);}
  }
  /** Historical facts only; this cannot observe current plugin resource life. */
  readStageReconstruction(projectId:string,jobId:string,runId:string):StageReconstructionRecord|null {
    const run=this.readStageRun(projectId,jobId,runId);if(!run)return null;
    const row=this.db.prepare('SELECT * FROM asset_stage_reconstructions WHERE run_id=?').get(runId) as Row|undefined;
    if(!row)return null;
    const command=this.command(row.command_id as string),args=this.stageReconstructionArgs(run);
    const fingerprint=hash(canonical({sessionId:command.sessionId,method:command.method,args:command.args}));
    const actual=this.db.prepare('SELECT fingerprint,state FROM commands WHERE id=?').get(command.id) as Row;
    if(command.method!=='asset.reconstruct'||command.sessionId!==run.intent.target.sessionId||command.clientSessionId!==run.intent.continuity.clientLifetimeId
      ||command.requestId!==row.request_id||command.leaseEpoch!==row.lease_epoch||canonical(command.args)!==canonical(args)
      ||fingerprint!==row.fingerprint||actual.fingerprint!==fingerprint||actual.state!==command.state)throw new ArcaneError('STUDIO_RECONSTRUCT_RECEIPT','Original reconstruction command differs.');
    const expected:StudioAssetReconstructReceipt={runId,transferDigest:run.intent.transferDigest,state:'reconstructed',objects:args.objects,imported:false,engineVerification:'pending',...('formatVersion'in args&&args.formatVersion===2?{formatVersion:2 as const,graphDigest:args.graphDigest,nodeCount:args.nodeCount,nodes:args.nodes}:{})};
    if(command.state==='succeeded'&&canonical(command.result)!==canonical(expected))throw new ArcaneError('STUDIO_RECONSTRUCT_RECEIPT','Original reconstruction receipt differs.');
    return {runId,command,receipt:command.state==='succeeded'?structuredClone(expected):null};
  }
  /** Retire a request without authorizing another allocation or erasing facts. */
  abandonStageReconstruction(projectId:string,jobId:string,runId:string):void {
    this.transaction(()=>{
      const record=this.readStageReconstruction(projectId,jobId,runId);if(!record)return;
      const command=record.command;if(command.state!=='queued'&&command.state!=='dispatched')return;
      command.state=command.state==='queued'?'cancelled':'needs_reconciliation';command.finishedAt=this.iso();
      command.error='Native reconstruction stopped. Inspect the original receipt; never replay.';this.saveCommand(command);
      this.event('command_'+command.state,command.id,{sessionId:command.sessionId,method:command.method});
    });
  }
  /** Host-only queue entry. Routes and generic MCP commands use enqueue(), which
   * cannot mint this capability. The controller owns SAME-actor/job checks. */
  enqueueAssetStage(input: unknown, guard: () => void): StudioCommand {
    guard();
    const a = object(input);
    if (a.method !== 'asset.stage_packet') throw new ArcaneError('METHOD', 'Expected the fixed asset staging method.');
    const admission = Object.freeze({}); this.#assetStageAdmissions.add(admission);
    try { return this.enqueue(a, false, admission); }
    finally { this.#assetStageAdmissions.delete(admission); }
  }
  /** Host-only queue entry for "Keep this mesh" (apps/daemon/src/mesh-keep-routes.ts). The caller must already hold
   * the person's single-use trusted-dialog consent and a durable intent receipt; this only mints the queue admission. */
  enqueueMeshKeep(input: unknown, guard: () => void): StudioCommand {
    guard();
    const a = object(input);
    if (a.method !== 'asset.keep_mesh') throw new ArcaneError('METHOD', 'Expected the fixed keep-mesh method.');
    const admission = Object.freeze({}); this.#meshKeepAdmissions.add(admission);
    try { return this.enqueue(a, false, admission); }
    finally { this.#meshKeepAdmissions.delete(admission); }
  }
  /** Exact historical source of a placed editable transfer. No resource life,
   * consent, upload permission or replay handle can be inferred from this read. */
  readStageKeepSource(sessionId:string,transferDigest:string):{run:StageRunRecord;reconstruction:StageReconstructionRecord}|null {
    if(this.closed)throw new ArcaneError('STUDIO_STAGE_CLOSED','Stage journal is closed.');
    if(typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)||!stageHash.safeParse(transferDigest).success)throw new ArcaneError('STUDIO_STAGE_INPUT','Invalid historical keep source.');
    this.db.exec('BEGIN DEFERRED');
    try{
      const rows=this.db.prepare("SELECT a.project_id,a.job_id,a.run_id,r.command_id FROM asset_stage_reconstructions r JOIN asset_stage_attempts a ON a.run_id=r.run_id JOIN commands c ON c.id=r.command_id WHERE c.session_id=? AND (json_extract(a.payload,'$.intent.transferDigest')=? OR json_extract(c.payload,'$.args.expected.digest')=?) LIMIT 2").all(sessionId,transferDigest,transferDigest) as Row[];
      if(rows.length===0){this.db.exec('COMMIT');return null;}
      if(rows.length!==1)throw new ArcaneError('STUDIO_RECONSTRUCT_RECEIPT','Historical keep source is ambiguous.');
      const row=rows[0]!,run=this.readStageRun(row.project_id as string,row.job_id as string,row.run_id as string),reconstruction=this.readStageReconstruction(row.project_id as string,row.job_id as string,row.run_id as string);
      if(!run||!reconstruction||reconstruction.command.id!==row.command_id||reconstruction.command.sessionId!==sessionId||run.intent.target.sessionId!==sessionId||run.intent.transferDigest!==transferDigest||reconstruction.command.state!=='succeeded'||!reconstruction.receipt)throw new ArcaneError('STUDIO_RECONSTRUCT_RECEIPT','Original keep source is not a completed reconstruction.');
      this.db.exec('COMMIT');return {run,reconstruction};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  private importCommand(id:string):StudioCommand {
    const command=this.command(id),row=this.db.prepare('SELECT fingerprint,state FROM commands WHERE id=?').get(id) as Row|undefined;
    if(!row||row.state!==command.state||row.fingerprint!==hash(canonical({sessionId:command.sessionId,method:command.method,args:command.args})))throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Original command identity differs.');return command;
  }
  /** Exact bounded historical lineage, never a live engine observation or replay admission. */
  readConvertedImportSource(projectId:string,conversation:Readonly<NativeConversation>,assetId:string,target:StudioAssetStageArgs['target']):ConvertedImportSourceRecord|null {
    if(this.closed)throw new ArcaneError('STUDIO_STAGE_CLOSED','Stage journal is closed.');
    if(!stageHash.safeParse(projectId).success||typeof assetId!=='string'||!/^arcane_[a-f0-9]{64}$/.test(assetId))throw new ArcaneError('STUDIO_STAGE_INPUT','Invalid converted source lookup.');
    this.db.exec('BEGIN DEFERRED');
    try{
      // Join the ORIGINAL begin packet and actual placements/revisions. A display
      // history window is neither complete discovery nor source authority.
      const rows=this.db.prepare(`SELECT a.run_id,p.id AS placement_id FROM asset_stage_attempts a
        JOIN asset_stage_attempt_commands b ON b.run_id=a.run_id AND b.ordinal=0
        JOIN commands c ON c.id=b.command_id
        JOIN commands p ON p.session_id=json_extract(a.payload,'$.intent.target.sessionId') AND p.state='succeeded'
          AND ((json_extract(p.payload,'$.method')='scene.place_asset' AND json_extract(p.payload,'$.args.watch')='editable-'||json_extract(a.payload,'$.intent.transferDigest'))
            OR (json_extract(p.payload,'$.method')='asset.apply_revision' AND json_extract(p.payload,'$.args.runId')=a.run_id))
        WHERE a.project_id=? AND json_extract(a.payload,'$.intent.conversation.provider')=?
          AND json_extract(a.payload,'$.intent.conversation.threadId')=? AND json_extract(a.payload,'$.intent.conversation.sessionId') IS ?
          AND json_extract(a.payload,'$.intent.target.sessionId')=?
          AND json_extract(json_extract(c.payload,'$.args.packet'),'$.assetId')=? LIMIT ?`).all(
            projectId,conversation.provider,conversation.threadId,conversation.sessionId,target.sessionId,assetId,STUDIO_STAGE_RUN_LIMITS.runs+1) as Row[];
      if(rows.length>STUDIO_STAGE_RUN_LIMITS.runs)throw new ArcaneError('STUDIO_STAGE_BUDGET','Converted source history exceeds its bound.');
      const candidates:ConvertedImportSourceRecord[]=[],consumed=new Set<string>(),successors=new Set<string>();
      for(const row of rows){
        const run=this.stageRunById(row.run_id as string),intent=run.intent;
        if(intent.projectId!==projectId||canonical(intent.conversation)!==canonical(conversation)||canonical(intent.target)!==canonical(target))throw new ArcaneError('STUDIO_IMPORT_SOURCE','Original converted scope differs.');
        const reconstruction=this.readStageReconstruction(projectId,intent.jobId,run.runId),placement=this.importCommand(row.placement_id as string);
        if(!intent.modelReview||run.phase!=='cpu-staged'||run.closedAt===null||!reconstruction?.receipt||reconstruction.command.state!=='succeeded'||reconstruction.command.args.formatVersion!==2
          ||placement.state!=='succeeded'||placement.sessionId!==target.sessionId||placement.clientSessionId!==intent.continuity.clientLifetimeId)throw new ArcaneError('STUDIO_IMPORT_SOURCE','Original converted source is incomplete.');
        const source=this.convertedImportSource(run),keeps:StudioCommand[]=[];
        if(source.assetId!==assetId)throw new ArcaneError('STUDIO_IMPORT_SOURCE','Original converted asset differs.');
        if(placement.method==='asset.apply_revision'){
          const receipt=validateStudioImportRevisionReceipt(placement.args,placement.result);
          if(canonical(receipt.source)!==canonical(source)||canonical(receipt.target)!==canonical(target)||canonical(receipt.continuity)!==canonical(intent.continuity))throw new ArcaneError('STUDIO_IMPORT_SOURCE','Applied source differs.');
          const old=object(object(object(placement.args.observation).observation).source).transferDigest;
          if(typeof old!=='string'||successors.has(old))throw new ArcaneError('STUDIO_IMPORT_SOURCE','Converted revision lineage branches.');
          successors.add(old);consumed.add(old);
        }else{
          const result=object(placement.result),mutation=object(result.mutation),ref=object(mutation.ref);
          if(placement.method!=='scene.place_asset'||placement.args.watch!=='editable-'+intent.transferDigest||mutation.kind!=='scene.place_asset'
            ||ref.sessionId!==target.sessionId||ref.root!=='Workspace'||ref.className!=='Model'||!result.converted)throw new ArcaneError('STUDIO_IMPORT_SOURCE','Original placement differs.');
        }
        const uploads=this.db.prepare("SELECT id FROM commands WHERE session_id=? AND state='succeeded' AND json_extract(payload,'$.method')='asset.keep_mesh' AND json_extract(payload,'$.args.source')=? LIMIT 65").all(target.sessionId,'editable-'+intent.transferDigest) as Row[];
        if(uploads.length>STUDIO_STAGE_RUN_LIMITS.runs)throw new ArcaneError('STUDIO_IMPORT_SOURCE','Keep history exceeds its bound.');
        for(const upload of uploads){const command=this.importCommand(upload.id as string);if(command.clientSessionId!==intent.continuity.clientLifetimeId)throw new ArcaneError('STUDIO_IMPORT_SOURCE','Keep lifetime differs.');validateMeshKeepReceipt(command.args,command.result);keeps.push(command);}
        candidates.push({run,reconstruction,placement,source,keeps});
      }
      const tips=candidates.filter(value=>!consumed.has(value.source.transferDigest));
      if(candidates.length&&tips.length!==1)throw new ArcaneError('STUDIO_IMPORT_SOURCE','Converted source is ambiguous.');
      this.db.exec('COMMIT');return tips[0]??null;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Compact original identifiers/hashes, not retained transfer copies or authority. */
  captureConvertedImportSource(record:ConvertedImportSourceRecord):ConvertedImportSourcePin {
    const intent=record.run.intent;
    const pin:ConvertedImportSourcePin=Object.freeze({runId:record.run.runId,intentSha256:record.run.intentSha256,source:Object.freeze({...record.source}),
      target:Object.freeze({...intent.target,creator:Object.freeze({...intent.target.creator})}),continuity:Object.freeze({...intent.continuity}),
      placementId:record.placement.id,placementSha256:hash(canonical(record.placement)),keeps:Object.freeze(record.keeps.map(command=>Object.freeze({id:command.id,sha256:hash(canonical(command))})))});
    this.assertConvertedImportSource(pin);return pin;
  }
  /** Re-read actual source packets at each boundary; a pin is never admission. */
  assertConvertedImportSource(pin:ConvertedImportSourcePin):void {
    const source=pin.source,run=this.readStageRun(source.projectId,source.jobId,pin.runId),placement=this.importCommand(pin.placementId);
    if(!run||run.intentSha256!==pin.intentSha256||run.phase!=='cpu-staged'||run.closedAt===null||canonical(this.convertedImportSource(run))!==canonical(source)
      ||canonical(run.intent.target)!==canonical(pin.target)||canonical(run.intent.continuity)!==canonical(pin.continuity)
      ||hash(canonical(placement))!==pin.placementSha256||!this.readStageReconstruction(source.projectId,source.jobId,pin.runId)?.receipt)throw new ArcaneError('STUDIO_IMPORT_SOURCE','Original converted source changed.');
    for(const command of pin.keeps)if(hash(canonical(this.importCommand(command.id)))!==command.sha256)throw new ArcaneError('STUDIO_IMPORT_SOURCE','Original keep receipt changed.');
  }
  convertedImportKeepObjects(pin:ConvertedImportSourcePin):readonly {sourceObjectId:string;instanceRef:string;meshAssetId:string}[] {
    this.assertConvertedImportSource(pin);const out:{sourceObjectId:string;instanceRef:string;meshAssetId:string}[]=[];
    // A genuine ID may survive a prior in-place revision without another upload.
    // Its actual applied command was admitted against the previous fresh read;
    // the sealed delta independently refuses carrying it across geometry change.
    const placement=this.importCommand(pin.placementId);
    if(placement.method==='asset.apply_revision'){
      const receipt=validateStudioImportRevisionReceipt(placement.args,placement.result);this.assertConvertedReceiptInventory(receipt);
      for(const row of receipt.objects)if(row.meshAssetId!==null)out.push({sourceObjectId:row.sourceObjectId,instanceRef:row.instanceRef,meshAssetId:row.meshAssetId});
    }
    for(const original of pin.keeps){const command=this.importCommand(original.id),receipt=validateMeshKeepReceipt(command.args,command.result);
      if(receipt.state!=='kept'||!('converted'in receipt)||receipt.converted.graphDigest!==pin.source.graphDigest||receipt.converted.conversionRequestDigest!==pin.source.conversionRequestDigest)continue;
      for(const row of receipt.converted.objects)out.push({sourceObjectId:row.sourceObjectId,instanceRef:row.instanceRef,meshAssetId:row.meshAssetId});
    }return out;
  }
  /** Derived exclusively from complete, already authenticated original packets. */
  private convertedImportSource(run:StageRunRecord):StudioImportObservationSource {
    const checked=this.convertedStageInspection(run.intent,run.commands);
    if(!checked||run.phase!=='cpu-staged'||!run.receipt)throw new ArcaneError('STUDIO_IMPORT_SOURCE','Original converted transfer is unavailable.');
    const begin=object(JSON.parse(run.commands[0]!.command.args.packet as string));
    const source:StudioImportObservationSource={projectId:run.intent.projectId,jobId:run.intent.jobId,
      assetId:textField(begin.assetId,'converted asset ID',80),sourceSha256:textField(begin.sourceSha256,'source hash',64),
      preparedDigest:run.intent.preparedDigest,manifestDigest:run.intent.manifestDigest,payloadDigest:run.intent.payloadDigest,
      transferDigest:run.intent.transferDigest,graphDigest:checked.graph.digest,conversionRequestDigest:textField(begin.conversionRequestDigest,'request digest',64)};
    return Object.freeze(source);
  }
  private assertConvertedReceiptInventory(receipt:StudioImportObservationReceipt|StudioImportRevisionReceipt):void {
    const source=receipt.source,run=this.readStageRun(source.projectId,source.jobId);
    if(!run||canonical(this.convertedImportSource(run))!==canonical(source))throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Observed source is not the original sealed run.');
    const checked=this.convertedStageInspection(run.intent,run.commands);
    if(!checked||receipt.nodes.length!==checked.graph.nodes.length||receipt.objects.length!==checked.graph.meshes.length
      ||checked.graph.nodes.some(node=>!receipt.nodes.some(row=>row.nodeKey===node.nodeKey)))throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Observed graph inventory differs.');
    const actual=new Map(receipt.objects.map(row=>[row.sourceObjectId,row]));
    if('runId'in receipt){
      const begin=object(JSON.parse(run.commands[0]!.command.args.packet as string)),delta=object(begin.delta);
      if(!Array.isArray(delta.objects)||!Array.isArray(delta.nodes))throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Sealed revision actions are unavailable.');
      for(const row of receipt.objects){
        const raw=delta.objects.find(value=>object(value).sourceObjectId===row.sourceObjectId);if(!raw)throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Sealed mesh action is unavailable.');
        const action=object(raw);if(!Array.isArray(action.changed))throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Sealed mesh changes are unavailable.');
        const expectedId=action.action==='create'||action.changed.includes('geometry')?null:action.meshAssetId;
        if(row.meshAssetId!==expectedId||action.action!=='create'&&row.instanceRef!==action.instanceRef)throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Applied mesh identity or persistence differs.');
      }
      for(const row of receipt.nodes){
        const raw=delta.nodes.find(value=>object(value).nodeKey===row.nodeKey);if(!raw)throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Sealed node action is unavailable.');
        const action=object(raw);if(action.action!=='create'&&row.instanceRef!==action.instanceRef)throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Applied node identity differs.');
      }
    }
    for(const mesh of checked.graph.meshes){const row=actual.get(mesh.sourceObjectId);if(!row)throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Observed mesh inventory differs.');
      if(mesh.nodeKey!==null){const node=receipt.nodes.find(node=>node.nodeKey===mesh.nodeKey);
        if(!node||node.instanceRef!==row.instanceRef||node.ownedStateSha256!==row.ownedStateSha256||canonical(node.authoredChildren)!==canonical(row.authoredChildren))throw new ArcaneError('STUDIO_IMPORT_RECEIPT','Observed mesh-bearing node differs.');}
    }
  }
  /** Fixed host-only read. Original dispatch guard is retained separately from JSON. */
  enqueueImportObservation(input:StudioImportObservationArgs,guard:()=>void):StudioCommand {
    this.stageGuard(guard);const args=parseStudioImportObservationArgs(input);validateCommandArgs('scene.observe_import',args,this.session(args.target.sessionId));
    const requestId='importobserve_'+args.observationId.replaceAll('-','');
    if(this.#importObservationClaims.size>=128||this.#importObservationClaims.has(args.observationId)||this.db.prepare('SELECT id FROM commands WHERE request_id=?').get(requestId))throw new ArcaneError('STUDIO_IMPORT_OBSERVATION_EXISTS','Original observation was already attempted.');
    this.#importObservationClaims.add(args.observationId);
    const admission=Object.freeze({});this.#assetStageAdmissions.add(admission);
    try{const command=this.enqueue({sessionId:args.target.sessionId,requestId,method:'scene.observe_import',args},false,admission);
      this.#importRevisionGuards.set(command.id,guard);this.#importObservationClaims.delete(args.observationId);return command;
    }finally{this.#assetStageAdmissions.delete(admission);}
  }
  /** Read only the one deterministic original revision command, without minting admission. */
  readStageRevision(projectId:string,jobId:string,runId:string):{command:StudioCommand;receipt:StudioImportRevisionReceipt|null}|null {
    const run=this.readStageRun(projectId,jobId,runId);if(!run)return null;
    const requestId='assetrevision_'+hash(canonical({runId,intentSha256:run.intentSha256}));
    const row=this.db.prepare('SELECT id FROM commands WHERE request_id=?').get(requestId) as Row|undefined;if(!row)return null;
    if(!run.receipt)throw new ArcaneError('STUDIO_REVISE_STATE','Original stage receipt is unavailable.');
    const command=this.command(row.id as string),source=this.convertedImportSource(run);
    const begin=object(JSON.parse(run.commands[0]!.command.args.packet as string)),delta=object(begin.delta);
    if(command.method!=='asset.apply_revision'||command.sessionId!==run.intent.target.sessionId||command.clientSessionId!==run.intent.continuity.clientLifetimeId
      ||command.args.runId!==runId||canonical(command.args.source)!==canonical(source)||canonical(command.args.target)!==canonical(run.intent.target)
      ||canonical(command.args.continuity)!==canonical(run.intent.continuity)||canonical(command.args.expected)!==canonical({digest:run.intent.transferDigest,payloadDigest:run.intent.payloadDigest,manifestDigest:run.intent.manifestDigest})
      ||command.args.packetCount!==run.receipt?.packetCount||command.args.byteLength!==run.receipt.byteLength||canonical(command.args.observation)!==canonical(delta.observation))throw new ArcaneError('STUDIO_REVISE_RECEIPT','Original revision association differs.');
    const stored=this.db.prepare('SELECT fingerprint,state FROM commands WHERE id=?').get(command.id) as Row|undefined;
    if(!stored||stored.state!==command.state||stored.fingerprint!==hash(canonical({sessionId:command.sessionId,method:command.method,args:command.args})))throw new ArcaneError('STUDIO_REVISE_RECEIPT','Original revision command differs.');
    return{command,receipt:command.state==='succeeded'?validateStudioImportRevisionReceipt(command.args,command.result):null};
  }
  /** Stop only the owned queue entry; delivered ambiguity is retained, never replayed. */
  abandonImportCommand(commandId:string):void {
    this.transaction(()=>{const command=this.command(commandId);
      if(command.method!=='scene.observe_import'&&command.method!=='asset.apply_revision')throw new ArcaneError('METHOD','Expected a fixed import operation.');
      if(command.state!=='queued'&&command.state!=='dispatched')return;
      command.state=command.state==='queued'?'cancelled':'needs_reconciliation';command.finishedAt=this.iso();
      command.error='Original native import operation stopped. Inspect its original outcome; never replay.';this.saveCommand(command);
    });
  }
  /** One attempt per original next run; a lost ACK or restart never refunds it. */
  enqueueStageRevision(projectId:string,jobId:string,runId:string,observation:StudioImportObservationWitness,currentObservation:StudioImportObservationWitness,guard:()=>void):StudioCommand {
    this.stageGuard(guard);const run=this.readStageRun(projectId,jobId,runId);
    if(!run||!this.readStageReconstruction(projectId,jobId,runId)?.receipt)throw new ArcaneError('STUDIO_REVISE_STATE','Original next reconstruction is unavailable.');
    const begin=object(JSON.parse(run.commands[0]!.command.args.packet as string)),delta=object(begin.delta);
    if(canonical(delta.observation)!==canonical(observation))throw new ArcaneError('STUDIO_REVISE_SOURCE','Sealed original observation differs.');
    const args:StudioImportRevisionArgs={formatVersion:2,runId,expected:{digest:run.intent.transferDigest,payloadDigest:run.intent.payloadDigest,manifestDigest:run.intent.manifestDigest},
      packetCount:run.receipt!.packetCount,byteLength:run.receipt!.byteLength,source:this.convertedImportSource(run),target:run.intent.target,continuity:run.intent.continuity,observation,currentObservation};
    parseStudioImportRevisionArgs(args);
    for(const witness of [observation,currentObservation]){
      const read=this.command(witness.commandId);
      if(read.method!=='scene.observe_import'||read.state!=='succeeded'||read.clientSessionId!==run.intent.continuity.clientLifetimeId
        ||canonical(validateStudioImportObservationReceipt(read.args,read.result))!==canonical(witness.observation)||studioImportObservationReceiptDigest(witness.observation)!==witness.receiptSha256)throw new ArcaneError('STUDIO_REVISE_RECEIPT','Actual original observation receipt differs.');
    }
    validateCommandArgs('asset.apply_revision',args,this.session(run.intent.target.sessionId));this.stageTarget(run.intent);this.assertRunModelReview(run.intent);
    const requestId='assetrevision_'+hash(canonical({runId,intentSha256:run.intentSha256}));
    if(this.#importRevisionClaims.has(runId)||this.db.prepare('SELECT id FROM commands WHERE request_id=?').get(requestId))throw new ArcaneError('STUDIO_REVISE_EXISTS','Revision was already attempted; never replay.');
    this.#importRevisionClaims.add(runId);this.stageGuard(guard);
    const admission=Object.freeze({});this.#assetStageAdmissions.add(admission);
    try{const command=this.enqueue({sessionId:run.intent.target.sessionId,requestId,method:'asset.apply_revision',args},false,admission);
      this.#importRevisionGuards.set(command.id,guard);return command;
    }finally{this.#assetStageAdmissions.delete(admission);}
  }

  /** The original asset job of a recorded reconstruction command, for display correlation only (never authority). */
  stageJobForReconstruction(commandId: string): string | null {
    const row = this.db.prepare('SELECT a.job_id AS job FROM asset_stage_reconstructions r JOIN asset_stage_attempts a ON a.run_id=r.run_id WHERE r.command_id=?').get(commandId) as Row | undefined;
    return row && typeof row.job === 'string' ? row.job : null;
  }
  /** Retiring a native caller never replays a delivered packet. Preserve unknown
   * plugin outcomes; a queued packet can be cancelled before delivery. */
  abandonAssetStage(commandId: string): void {
    this.transaction(() => {
      const command = this.command(commandId);
      if (command.method !== 'asset.stage_packet') throw new ArcaneError('METHOD', 'Expected an owned asset staging receipt.');
      if (command.state !== 'queued' && command.state !== 'dispatched') return;
      command.state = command.state === 'queued' ? 'cancelled' : 'needs_reconciliation';
      command.error = 'Native asset staging stopped. No automatic replay.';
      command.finishedAt = this.iso(); this.saveCommand(command);
      this.event('command_' + command.state, command.id, {sessionId: command.sessionId, method: command.method});
    });
  }
  private hasTestSetupFence():boolean {
    return !!this.db.prepare("SELECT 1 FROM studio_test_reservations WHERE state='active' LIMIT 1").get();
  }
  private checkTestQueueAuthority(sessionId:string,requestId:string,admission?:object):void {
    const permit=admission?this.#testCommandAdmissions.get(admission):undefined;
    if(permit){
      this.checkTestReservation(permit.reservation,permit.role);
      if(sessionId!==permit.reservation.sessionId||requestId!==(permit.role==='setup'?permit.edit.setupRequestId:permit.edit.restoreRequestId))
        throw new ArcaneError('TEST_RESERVATION','Test command identity differs from its private reservation.');
      return;
    }
    // Apply before idempotency: knowing a private request ID is not authority to
    // reuse its receipt, even after that reservation was safely released.
    if(this.#testOwners.has(sessionId)||this.hasTestSetupFence()
      ||this.db.prepare('SELECT 1 FROM studio_test_commands WHERE request_id=?').get(requestId))
      throw new ArcaneError('BUSY','A playtest is running in Studio, so edits wait until it stops. Check playtest_status until it finishes, or stop it with playtest_cancel, then retry this command; nothing was changed.');
  }
  private checkTestReservation(record:TestReservationRecord,role:'setup'|'restore'):StudioSession {
    if(this.closed||this.#testOwners.get(record.sessionId)!==record.jobId||this.#testReservationRecords.get(record.sessionId)!==record)throw new ArcaneError('TEST_RESERVATION','The original test reservation is no longer active.');
    if(record.setup.length){
      const row=this.db.prepare("SELECT payload,setup_closed FROM studio_test_reservations WHERE id=? AND state='active'").get(record.id) as Row|undefined;
      if(!row||row.payload!==JSON.stringify(record))throw new ArcaneError('TEST_RESERVATION','The durable original test reservation differs.');
      if(role==='setup'&&row.setup_closed!==0)throw new ArcaneError('TEST_RESERVATION','Temporary setup was stopped by its original owner.');
    }
    const s=this.session(record.sessionId);
    if(testSessionIdentity(s)!==record.sessionIdentity)throw new ArcaneError('SCOPE','The original test grant or client lifetime changed.');
    if(record.setup.length){
      const p=s.proof,original=record.proof;
      if(!p||!original||p.sessionId!==s.id||p.clientLifetimeId!==s.clientSessionId||p.placeId!==s.placeId||p.universeId!==s.universeId
        ||!p.connected||!p.continuitySupported||p.mode!=='Edit'||p.pluginArtifactHash!==original.pluginArtifactHash||p.markerName!==original.markerName
        ||!Number.isSafeInteger(p.playEpoch)||p.playEpoch<original.playEpoch||role==='setup'&&p.playEpoch!==original.playEpoch
        ||!Number.isFinite(Date.parse(p.observedAt))||Date.parse(p.observedAt)>this.now()
        ||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=this.now())
        throw new ArcaneError('SCOPE','Temporary edits require fresh exact plugin Edit continuity.');
    }
    return s;
  }
  private testReservation(owner:StudioTestReservation):TestReservationRecord {
    const record=owner&&typeof owner==='object'?this.#testReservations.get(owner):undefined;
    if(!record)throw new ArcaneError('TEST_RESERVATION','Only the original private host reservation may coordinate temporary edits.');
    return record;
  }
  /** Seal the approved finite setup before any command can be dispatched. */
  reserveTest(sessionId:string,jobId:string,setup:readonly StudioTestTemporaryEdit[]=[]):StudioTestReservation {
    const s=this.session(sessionId);
    if(!s.allowWrites)throw new ArcaneError('READ_ONLY','Playtesting requires a writable paired target and separate human test consent.');
    if(typeof jobId!=='string'||!/^[a-zA-Z0-9_-]{1,128}(?![\s\S])/.test(jobId)||this.#testOwners.size>=STUDIO_TEST_RESERVATION_LIMITS.liveOwners||this.#testOwners.has(sessionId)||this.hasTestSetupFence()
      ||this.db.prepare("SELECT id FROM commands WHERE session_id=? AND state IN ('queued','dispatched','needs_reconciliation') LIMIT 1").get(sessionId))
      throw new ArcaneError('BUSY','Finish or reconcile existing Studio work before starting a playtest.');
    const snapshot=object(testSetupSnapshot({setup}));
    jsonObject(snapshot,STUDIO_TEST_RESERVATION_LIMITS.argumentBytes);
    if(!Array.isArray(snapshot.setup)||snapshot.setup.length>STUDIO_TEST_RESERVATION_LIMITS.edits)throw new ArcaneError('TEST_SETUP','At most four approved temporary edits are allowed.');
    if(snapshot.setup.length&&(Number((this.db.prepare('SELECT count(*) AS n FROM studio_test_reservations').get() as Row).n)>=STUDIO_TEST_RESERVATION_LIMITS.reservations
      ||Number((this.db.prepare('SELECT count(*) AS n FROM studio_test_commands').get() as Row).n)+snapshot.setup.length*2>STUDIO_TEST_RESERVATION_LIMITS.commands))
      throw new ArcaneError('TEST_BUDGET','Retained temporary setup history is full; existing evidence was preserved.');
    const ids=new Set<string>();
    const edits:TestReservationEdit[]=snapshot.setup.map(value=>{
      const edit=object(value);
      if(Object.keys(edit).length!==4||Object.keys(edit).some(k=>!['id','ref','expected','properties'].includes(k))
        ||typeof edit.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}(?![\s\S])/.test(edit.id)||ids.has(edit.id))throw new ArcaneError('TEST_SETUP','Temporary edits require unique bounded IDs and closed property scope.');
      ids.add(edit.id);
      const r=object(edit.ref);
      if(Object.keys(r).length!==5||Object.keys(r).some(k=>!['instanceId','sessionId','root','pathSegments','className'].includes(k)))throw new ArcaneError('TEST_SETUP','Temporary edits require an exact opaque Instance reference.');
      const args=validateCommandArgs('scene.update',{ref:edit.ref,expected:edit.expected,properties:edit.properties},s);
      validateCommandArgs('scene.restore',{receiptCommandId:'private-test-reservation',mutation:{ref:edit.ref}},s,true);
      return {id:edit.id,args,setupRequestId:'test_setup_'+randomUUID(),restoreRequestId:'test_restore_'+randomUUID()};
    });
    if(edits.length&&(this.#testOwners.size>0||this.db.prepare("SELECT 1 FROM commands WHERE state IN ('queued','dispatched','needs_reconciliation') LIMIT 1").get()))
      throw new ArcaneError('BUSY','Finish or reconcile all project Studio work before temporary setup.');
    const p=s.proof;
    const record:TestReservationRecord={id:randomUUID(),sessionId,jobId,sessionIdentity:testSessionIdentity(s),
      proof:p?{pluginArtifactHash:p.pluginArtifactHash,markerName:p.markerName,playEpoch:p.playEpoch}:null,setup:edits};
    const owner:StudioTestReservation=Object.freeze({kind:'studio-test-reservation'});
    try{this.transaction(()=>{
      if(edits.length)this.db.prepare("INSERT INTO studio_test_reservations(id,session_id,job_id,state,payload) VALUES(?,?,?,'active',?)").run(record.id,sessionId,jobId,JSON.stringify(record));
      this.#testOwners.set(sessionId,jobId);this.#testReservationRecords.set(sessionId,record);
      this.checkTestReservation(record,'setup');if(edits.length)this.event('test_reserved',record.id,{sessionId,jobId,setupDigest:hash(canonical(edits.map(e=>({id:e.id,args:e.args}))))});
    });}catch(error){this.#testOwners.delete(sessionId);this.#testReservationRecords.delete(sessionId);throw error;}
    this.#testReservations.set(owner,record);return owner;
  }
  private testCommand(record:TestReservationRecord,edit:TestReservationEdit,role:'setup'|'restore',args:Record<string,Json>):StudioCommand {
    const method=role==='setup'?'scene.update':'scene.restore',requestId=role==='setup'?edit.setupRequestId:edit.restoreRequestId;
    const input={sessionId:record.sessionId,requestId,method,args};
    const fingerprint=hash(canonical({sessionId:record.sessionId,method,args}));
    const admission=Object.freeze({});this.#testCommandAdmissions.set(admission,{reservation:record,edit,role});
    try{
      const prior=this.db.prepare('SELECT * FROM studio_test_commands WHERE reservation_id=? AND edit_id=? AND role=?').get(record.id,edit.id,role) as Row|undefined;
      if(!prior&&Number((this.db.prepare('SELECT count(*) AS n FROM studio_test_commands').get() as Row).n)>=STUDIO_TEST_RESERVATION_LIMITS.commands)
        throw new ArcaneError('TEST_BUDGET','Retained temporary command history is full; no command was allocated.');
      const command=this.enqueueInTransaction(input,record.sessionId,requestId,method,fingerprint,role==='restore',admission);
      if(prior){if(prior.command_id!==command.id||prior.request_id!==requestId||prior.lease_epoch!==command.leaseEpoch||prior.fingerprint!==fingerprint)throw new ArcaneError('TEST_RESERVATION','Original temporary command association differs.');}
      else this.db.prepare('INSERT INTO studio_test_commands VALUES(?,?,?,?,?,?,?)').run(record.id,edit.id,role,command.id,requestId,command.leaseEpoch,fingerprint);
      return command;
    }finally{this.#testCommandAdmissions.delete(admission);}
  }
  enqueueTestSetup(owner:StudioTestReservation,editId:string):StudioCommand {
    const record=this.testReservation(owner),edit=record.setup.find(e=>e.id===editId);
    if(!edit)throw new ArcaneError('TEST_SETUP','That temporary edit was not approved in this reservation.');
    return this.transaction(()=>{this.checkTestReservation(record,'setup');return this.testCommand(record,edit,'setup',edit.args);});
  }
  /** Stop is always available to the original owner, including after scope loss.
   * It closes future setup before cancelling only still-undelivered commands. */
  cancelTestSetup(owner:StudioTestReservation):void {
    const record=this.testReservation(owner);
    this.transaction(()=>{
      if(this.#testOwners.get(record.sessionId)!==record.jobId||this.#testReservationRecords.get(record.sessionId)!==record)throw new ArcaneError('TEST_RESERVATION','Original test ownership is absent.');
      if(!record.setup.length)return;
      const row=this.db.prepare("SELECT payload,setup_closed FROM studio_test_reservations WHERE id=? AND state='active'").get(record.id) as Row|undefined;
      if(!row||row.payload!==JSON.stringify(record))throw new ArcaneError('TEST_RESERVATION','The durable original test reservation differs.');
      if(row.setup_closed===1)return;
      const changed=this.db.prepare("UPDATE studio_test_reservations SET setup_closed=1 WHERE id=? AND state='active' AND setup_closed=0 AND payload=?").run(record.id,JSON.stringify(record));
      if(changed.changes!==1)throw new ArcaneError('TEST_RESERVATION','The durable original test reservation differs.');
      for(const entry of this.db.prepare("SELECT command_id FROM studio_test_commands WHERE reservation_id=? AND role='setup'").all(record.id) as Row[]){
        const command=this.command(entry.command_id as string);
        if(command.state==='queued'){command.state='cancelled';command.finishedAt=this.iso();command.error='Original test owner stopped undelivered temporary setup.';this.saveCommand(command);}
      }
      this.event('test_setup_stopped',record.id,{sessionId:record.sessionId,jobId:record.jobId});
    });
  }
  enqueueTestRestore(owner:StudioTestReservation,commandId:string):StudioCommand {
    const record=this.testReservation(owner);
    return this.transaction(()=>{
      this.checkTestReservation(record,'restore');
      const association=this.db.prepare("SELECT * FROM studio_test_commands WHERE reservation_id=? AND command_id=? AND role='setup'").get(record.id,commandId) as Row|undefined;
      const edit=association?record.setup.find(e=>e.id===association.edit_id):undefined;
      if(!association||!edit)throw new ArcaneError('RESTORE','Only a setup receipt issued by this original reservation can be restored.');
      const prior=this.command(commandId),fingerprint=hash(canonical({sessionId:prior.sessionId,method:prior.method,args:prior.args}));
      if(prior.state!=='succeeded'||prior.method!=='scene.update'||prior.sessionId!==record.sessionId||prior.requestId!==edit.setupRequestId
        ||prior.clientSessionId!==this.session(record.sessionId).clientSessionId||prior.leaseEpoch!==association.lease_epoch||fingerprint!==association.fingerprint
        ||canonical(prior.args)!==canonical(edit.args))throw new ArcaneError('RESTORE','The exact succeeded setup receipt is unavailable.');
      const mutation=jsonObject(object(prior.result).mutation);
      if(mutation.kind!=='scene.update'||!sameReceiptRef(mutation.ref,edit.args.ref)
        ||canonical(object(mutation.before).properties)!==canonical(edit.args.expected)
        ||!nativePropertiesMatch(edit.args.properties as Record<string,Json>,object(mutation.after).properties,instanceRef(edit.args.ref).className))
        throw new ArcaneError('RESTORE','The immutable setup receipt differs from the approved baseline and result.');
      return this.testCommand(record,edit,'restore',{receiptCommandId:prior.id,mutation});
    });
  }
  releaseTestReservation(owner:StudioTestReservation):void {
    const record=this.testReservation(owner);
    this.transaction(()=>{
      if(this.#testOwners.get(record.sessionId)!==record.jobId||this.#testReservationRecords.get(record.sessionId)!==record)throw new ArcaneError('TEST_RESERVATION','Original test ownership is absent.');
      for(const row of this.db.prepare("SELECT command_id,edit_id FROM studio_test_commands WHERE reservation_id=? AND role='setup'").all(record.id) as Row[]){
        const setup=this.command(row.command_id as string);
        if(setup.state==='queued'||setup.state==='cancelled'){
          if(setup.state==='queued'){setup.state='cancelled';setup.finishedAt=this.iso();setup.error='Undelivered temporary setup cancelled by its original owner.';this.saveCommand(setup);}
          continue;
        }
        const restored=this.db.prepare("SELECT command_id FROM studio_test_commands WHERE reservation_id=? AND edit_id=? AND role='restore'").get(record.id,row.edit_id!) as Row|undefined;
        if(setup.state!=='succeeded'||!restored||this.command(restored.command_id as string).state!=='succeeded')
          throw new ArcaneError('RECONCILIATION','Dispatched temporary edits require verified original restoration before release.');
      }
      if(record.setup.length){
        const changed=this.db.prepare("UPDATE studio_test_reservations SET state='released' WHERE id=? AND state='active' AND payload=?").run(record.id,JSON.stringify(record));
        if(changed.changes!==1)throw new ArcaneError('TEST_RESERVATION','The durable original test reservation differs.');
      }
      if(record.setup.length)this.event('test_released',record.id,{sessionId:record.sessionId,jobId:record.jobId});
    });
    this.#testOwners.delete(record.sessionId);this.#testReservationRecords.delete(record.sessionId);this.#testReservations.delete(owner);
  }
  /** Legacy smoke coordination cannot clear a setup-bearing reservation. */
  releaseTest(sessionId:string,jobId:string):void {
    if(this.db.prepare("SELECT 1 FROM studio_test_reservations WHERE session_id=? AND job_id=? AND state='active'").get(sessionId,jobId))
      throw new ArcaneError('TEST_RESERVATION','Temporary setup requires its original private restoration owner.');
    if(this.#testOwners.get(sessionId)===jobId){this.#testOwners.delete(sessionId);this.#testReservationRecords.delete(sessionId);}
  }
  private guardTestDispatch(command:StudioCommand):boolean {
    const row=this.db.prepare('SELECT * FROM studio_test_commands WHERE command_id=?').get(command.id) as Row|undefined;
    if(!row){if(this.hasTestSetupFence())throw new ArcaneError('BUSY','Temporary setup fences other project Studio commands.');return true;}
    const record=this.#testReservationRecords.get(command.sessionId),role=row.role as 'setup'|'restore';
    const edit=record?.setup.find(e=>e.id===row.edit_id);
    if(!record||!edit||record.id!==row.reservation_id||command.requestId!==row.request_id||command.leaseEpoch!==row.lease_epoch
      ||hash(canonical({sessionId:command.sessionId,method:command.method,args:command.args}))!==row.fingerprint
      ||command.method!==(role==='setup'?'scene.update':'scene.restore'))throw new ArcaneError('TEST_RESERVATION','Original temporary command owner or association is absent.');
    let session:StudioSession;
    try{session=this.checkTestReservation(record,role);}
    catch(error){
      // Preserve a newly observed Play transition (or stale proof) while
      // withholding dispatch. Throwing here would roll that observation back
      // and could leave an older Edit proof apparently usable on the next poll.
      if(error instanceof ArcaneError&&error.code==='SCOPE')return false;
      throw error;
    }
    validateCommandArgs(command.method,command.args,session,role==='restore');
    return true;
  }
  commands(sessionId?: string): StudioCommand[] {
    const q = sessionId ? this.db.prepare('SELECT payload FROM commands WHERE session_id=? ORDER BY created DESC,rowid DESC LIMIT 100').all(sessionId) : this.db.prepare('SELECT payload FROM commands ORDER BY created DESC,rowid DESC LIMIT 100').all();
    return (q as Row[]).map(r => this.expired(JSON.parse(r.payload as string) as StudioCommand));
  }
  poll(sessionId: string, observation?: unknown, executingCommand?:unknown): StudioCommand[] {
    return this.transaction(() => {
      const s = this.session(sessionId); s.lastSeenAt = this.iso(); this.saveSession(s);
      if(executingCommand!==undefined){
        // No-new-work progress: validate the ORIGINAL admitted allocation before
        // refreshing proof. Wrong/expired/terminal commands cannot revive it.
        const progress=jsonObject(executingCommand,1024);
        if(Object.keys(progress).length!==2||Object.keys(progress).some(k=>!['commandId','leaseEpoch'].includes(k)))throw new ArcaneError('COMMAND_STATE','Expected exact executing reconstruction identity.');
        const command=this.command(textField(progress.commandId,'executing command ID'));
        const association=this.db.prepare('SELECT run_id FROM asset_stage_reconstructions WHERE command_id=?').get(command.id) as Row|undefined;
        const proof=s.proof,continuity=object(command.args.continuity);
        if(!association||command.method!=='asset.reconstruct'||command.state!=='dispatched'||command.sessionId!==sessionId||command.clientSessionId!==s.clientSessionId
          ||progress.leaseEpoch!==command.leaseEpoch||!Number.isFinite(Date.parse(command.expiresAt))||Date.parse(command.expiresAt)<=this.now()
          ||!proof||!Number.isFinite(Date.parse(proof.expiresAt))||Date.parse(proof.expiresAt)<=this.now()
          ||proof.mode!=='Edit'||!proof.connected||!proof.continuitySupported||proof.clientLifetimeId!==continuity.clientLifetimeId
          ||proof.pluginArtifactHash!==continuity.pluginArtifactHash||proof.playEpoch!==continuity.playEpoch)throw new ArcaneError('COMMAND_STATE','Executing reconstruction is absent, stale or requires reconciliation.');
        const row=this.db.prepare('SELECT project_id,job_id FROM asset_stage_attempts WHERE run_id=?').get(association.run_id!) as Row|undefined;
        if(!row||this.readStageReconstruction(row.project_id as string,row.job_id as string,association.run_id as string)?.command.id!==command.id)throw new ArcaneError('COMMAND_STATE','Original reconstruction association differs.');
        validateCommandArgs('asset.reconstruct',command.args,s);
        const observed=jsonObject(observation,4096);
        if(observed.mode!=='Edit'||observed.connected!==true||observed.continuitySupported!==true||observed.clientLifetimeId!==continuity.clientLifetimeId
          ||observed.pluginArtifactHash!==continuity.pluginArtifactHash||observed.playEpoch!==continuity.playEpoch)throw new ArcaneError('IDENTITY','Executing reconstruction Edit continuity changed.');
      }
      if (observation !== undefined) {
        if (!s.allowWrites || !s.allowedRoots.includes('ServerStorage')) throw new ArcaneError('SCOPE','A continuity marker requires explicit writable ServerStorage scope.');
        const p = jsonObject(observation, 4096);
        const fields = ['sessionId','clientLifetimeId','pluginArtifactHash','markerName','placeId','universeId','placeName','mode','playEpoch','continuitySupported','connected'];
        if (Object.keys(p).length !== fields.length || Object.keys(p).some(k=>!fields.includes(k)) || p.sessionId !== s.id || p.clientLifetimeId !== s.clientSessionId || p.placeId !== s.placeId || p.universeId !== s.universeId || p.placeName !== s.name || typeof p.pluginArtifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.pluginArtifactHash) || typeof p.markerName !== 'string' || !/^ArcaneTestProof_[A-Za-z0-9_-]{1,128}$/.test(p.markerName) || !['Edit','Play'].includes(p.mode as string) || !Number.isSafeInteger(p.playEpoch) || (p.playEpoch as number)<0 || typeof p.continuitySupported !== 'boolean' || typeof p.connected !== 'boolean') throw new ArcaneError('IDENTITY','Plugin continuity proof does not match this exact authenticated lifetime.');
        if (s.proof && (p.playEpoch as number)<s.proof.playEpoch) throw new ArcaneError('IDENTITY','Plugin play epoch moved backwards; inspect and reconnect.');
        if (s.proof && p.pluginArtifactHash !== s.proof.pluginArtifactHash) throw new ArcaneError('IDENTITY','Loaded plugin source changed inside this lifetime.');
        if (s.proof && (p.markerName !== s.proof.markerName || p.mode !== s.proof.mode && (p.playEpoch as number)<=s.proof.playEpoch)) throw new ArcaneError('IDENTITY','Marker or mode continuity changed without a latched play transition.');
        // Both ends belong to one observation; a second clock read would change its fixed lifetime.
        const observedAt=this.now();
        s.proof={sessionId:s.id,clientLifetimeId:s.clientSessionId,pluginArtifactHash:p.pluginArtifactHash,markerName:p.markerName,placeId:s.placeId,universeId:s.universeId,placeName:s.name,mode:p.mode as 'Edit'|'Play',playEpoch:p.playEpoch as number,continuitySupported:p.continuitySupported,connected:p.connected,observedAt:new Date(observedAt).toISOString(),expiresAt:new Date(observedAt+6000).toISOString()};
        this.saveSession(s);
      }
      if(executingCommand!==undefined)return []; // Never dispatch, renew a lease or adopt new work.
      const active = this.db.prepare("SELECT payload FROM commands WHERE session_id=? AND state IN ('dispatched','needs_reconciliation') ORDER BY created,rowid LIMIT 1").get(sessionId) as Row | undefined;
      if (active) {
        const c = JSON.parse(active.payload as string) as StudioCommand;
        if (c.state === 'dispatched' && Date.parse(c.expiresAt) <= this.now()) { c.state = 'needs_reconciliation'; c.error = 'Delivery expired with unknown engine outcome. No automatic replay.'; c.finishedAt = this.iso(); this.saveCommand(c); this.event('command_unknown', c.id, {}); }
        return [];
      }
      for (;;) {
        const row = this.db.prepare("SELECT payload FROM commands WHERE session_id=? AND state='queued' ORDER BY created,rowid LIMIT 1").get(sessionId) as Row | undefined;
        if (!row) return [];
        const c = JSON.parse(row.payload as string) as StudioCommand;
        if (Date.parse(c.expiresAt) <= this.now()) { c.state = 'cancelled'; c.error = 'Undelivered command expired.'; c.finishedAt = this.iso(); this.saveCommand(c); continue; }
        try{this.assertCommandModelReview(c);if(c.method==='scene.build')this.assertTemplateSources(sessionId,c.args);}
        catch(error){if(!(error instanceof ArcaneError)||error.code!=='TEMPLATE_SOURCE'&&!error.code.startsWith('ASSET_REVIEW_'))throw error;
          this.#assetDispatchGuards.delete(c.id);c.state='cancelled';c.error='Import authority, model approval or source permission changed. This operation was not sent.';c.finishedAt=this.iso();this.saveCommand(c);this.event('command_cancelled',c.id,{sessionId});continue;}
        if(!this.guardTestDispatch(c))return [];
        this.#assetDispatchGuards.delete(c.id);
        c.state = 'dispatched'; this.saveCommand(c); this.event('command_dispatched', c.id, { sessionId }); return [c];
      }
    });
  }
  /** Bounded, idempotent upsert of the plugin's absolute counts. Malformed or unadvertised reports are
   * dropped whole and never fail the poll that carried them. Returns the number of entries accepted. */
  recordDiagnostics(sessionId: string, input: unknown): number {
    const L = STUDIO_DIAGNOSTIC_LIMITS;
    const s = this.session(sessionId);
    if (!s.capabilities.includes(STUDIO_DIAGNOSTICS_CAPABILITY) || !Array.isArray(input) || input.length < 1 || input.length > L.perReport) return 0;
    let serialized: string; try { serialized = JSON.stringify(input); } catch { return 0; }
    if (Buffer.byteLength(serialized) > L.reportBytes) return 0;
    const text = (value: unknown, max: number): string | null | undefined => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string' || value.length < 1 || value.includes('\0')) return undefined;
      return value.length > max ? value.slice(0, max) : value;
    };
    const parsed: Omit<StudioDiagnostic,'firstAt'|'lastAt'>[] = [];
    for (const raw of input) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
      const r = raw as Record<string, unknown>;
      if (Object.keys(r).some(k => !['id','kind','message','source','line','stack','count'].includes(k))) return 0;
      const id = text(r.id, L.idChars), message = text(r.message, L.messageChars), source = text(r.source, L.sourceChars), stack = text(r.stack, L.stackChars);
      if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || !message || source === undefined || stack === undefined || (r.kind !== 'error' && r.kind !== 'warning')) return 0;
      if (r.line !== undefined && r.line !== null && (!Number.isSafeInteger(r.line) || (r.line as number) < 1 || (r.line as number) > 1_000_000)) return 0;
      if (!Number.isSafeInteger(r.count) || (r.count as number) < 1 || (r.count as number) > L.maxCount) return 0;
      parsed.push({ id, kind: r.kind, message, source, stack, line: (r.line as number | undefined) ?? null, count: r.count as number });
    }
    let group = this.#diagnostics.get(sessionId);
    if (!group) {
      group = { placeName: s.name, placeId: s.placeId, entries: new Map() };
      this.#diagnostics.set(sessionId, group);
      while (this.#diagnostics.size > L.sessions) this.#diagnostics.delete(this.#diagnostics.keys().next().value!);
    } else { this.#diagnostics.delete(sessionId); this.#diagnostics.set(sessionId, group); }
    const at = this.iso();
    for (const d of parsed) {
      const prior = group.entries.get(d.id);
      if (prior && d.count <= prior.count && prior.kind === d.kind && prior.message === d.message) continue; // Replayed report.
      group.entries.delete(d.id);
      group.entries.set(d.id, { ...d, count: prior ? Math.max(prior.count, d.count) : d.count, stack: d.stack ?? prior?.stack ?? null, firstAt: prior?.firstAt ?? at, lastAt: at });
      while (group.entries.size > L.entries) group.entries.delete(group.entries.keys().next().value!);
    }
    return parsed.length;
  }
  /** Newest first, per session; read only by the human panel. */
  diagnostics(): StudioDiagnosticGroup[] {
    const groups: StudioDiagnosticGroup[] = [];
    for (const [sessionId, group] of this.#diagnostics) {
      let live = false; try { live = this.live(this.session(sessionId, false)); } catch { /* Unknown session stays listed as offline. */ }
      groups.push({ sessionId, placeName: group.placeName, placeId: group.placeId, live, entries: [...group.entries.values()].reverse().map(e => ({ ...e })) });
    }
    return groups.reverse();
  }
  clearDiagnostics(sessionId?: string): number {
    if (sessionId === undefined) { const n = this.#diagnostics.size; this.#diagnostics.clear(); return n; }
    return this.#diagnostics.delete(sessionId) ? 1 : 0;
  }
  result(input: unknown): void {
    const a = object(input); const sessionId = textField(a.sessionId, 'session ID'); const commandId = textField(a.commandId, 'command ID');
    if (a.state !== 'succeeded' && a.state !== 'failed') throw new ArcaneError('INPUT', 'Invalid completion state.');
    const completedState = a.state;
    // The validation wrapper is exactly ten bytes; the actual result limit below
    // remains 512 KiB, including JSON escaping. It must not reject a legal ACK.
    const result = a.result === undefined ? null : jsonObject({ value: a.result }, 512 * 1024 + 10).value ?? null;
    const error = a.state === 'failed' ? textField(a.error ?? 'Plugin operation failed.', 'plugin error', 2000) : null;
    if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw new ArcaneError('BODY_LIMIT', 'Plugin result exceeds 512 KiB.');
    this.transaction(() => {
      const c = this.command(commandId);
      if (c.sessionId !== sessionId) throw new ArcaneError('SCOPE', 'Receipt belongs to another Studio session.');
      if (['succeeded', 'failed'].includes(c.state)) {
        if (c.state !== a.state || canonical(c.result) !== canonical(result) || c.error !== error) throw new ArcaneError('RECEIPT_CONFLICT', 'Completed receipt is immutable.'); return;
      }
      if (c.state !== 'dispatched' && c.state !== 'needs_reconciliation') throw new ArcaneError('COMMAND_STATE', 'Command was not delivered.');
      if(a.state==='succeeded'&&c.method==='scene.restore'&&this.db.prepare("SELECT 1 FROM studio_test_commands WHERE command_id=? AND role='restore'").get(c.id)){
        const restored=object(result);
        if(Object.keys(restored).length!==2||Object.keys(restored).some(k=>!['restored','ref'].includes(k))||restored.restored!==true
          ||!sameReceiptRef(restored.ref,object(c.args.mutation).ref))throw new ArcaneError('RECEIPT','Temporary restoration requires its exact original opaque receipt acknowledgement.');
      }
      if (a.state === 'succeeded' && c.method === 'asset.stage_packet') {
        const receipt = object(result), packet = object(JSON.parse(c.args.packet as string));
        if (Object.keys(receipt).length !== 5 || Object.keys(receipt).some(k => !['transferDigest', 'packetCount', 'byteLength', 'state', 'engineVerification'].includes(k))
          || receipt.transferDigest !== object(c.args.expected).digest || receipt.packetCount !== Number(packet.ordinal) + 1
          || !Number.isSafeInteger(receipt.byteLength) || (receipt.byteLength as number) < Buffer.byteLength(c.args.packet as string) || (receipt.byteLength as number) > 48 * 1024 * 1024
          || receipt.state !== (packet.kind === 'seal' ? 'sealed' : 'receiving') || receipt.engineVerification !== 'pending') throw new ArcaneError('RECEIPT', 'Asset staging receipt differs from its exact packet.');
      }
      if(a.state==='succeeded'&&c.method==='asset.reconstruct'){
        const args=c.args as unknown as StudioAssetReconstructArgs;
        const expected:StudioAssetReconstructReceipt={runId:args.runId,transferDigest:args.expected.digest,state:'reconstructed',objects:args.objects,imported:false,engineVerification:'pending',...('formatVersion'in args&&args.formatVersion===2?{formatVersion:2 as const,graphDigest:args.graphDigest,nodeCount:args.nodeCount,nodes:args.nodes}:{})};
        if(canonical(result)!==canonical(expected))throw new ArcaneError('RECEIPT','Reconstruction receipt differs from the exact original sources.');
      }
      if (a.state === 'succeeded' && c.method === 'asset.keep_mesh') validateMeshKeepReceipt(c.args, result);
      if(a.state==='succeeded'&&c.method==='scene.observe_import'){const receipt=validateStudioImportObservationReceipt(c.args,result);this.assertConvertedReceiptInventory(receipt);}
      if(a.state==='succeeded'&&c.method==='asset.apply_revision'){const receipt=validateStudioImportRevisionReceipt(c.args,result);this.assertConvertedReceiptInventory(receipt);}
      if (a.state === 'succeeded' && isWrite(c.method) && c.method !== 'scene.restore' && c.method !== 'asset.stage_packet' && c.method !== 'asset.reconstruct' && c.method !== 'asset.keep_mesh' && c.method !== 'asset.apply_revision') {
        const mutation = object(object(result).mutation, 'mutation receipt');
        if (mutation.kind !== c.method) throw new ArcaneError('RECEIPT', 'Mutation receipt kind mismatch.');
        const r = object(mutation.ref);
        if (r.sessionId !== sessionId || !c.allowedRoots.includes(r.root as StudioSession['allowedRoots'][number])) throw new ArcaneError('RECEIPT', 'Mutation receipt reference out of scope.');
        const after = jsonObject(mutation.after);
        if ((c.method === 'script.update' || c.method === 'scene.update') && !sameReceiptRef(mutation.ref, c.args.ref)) throw new ArcaneError('RECEIPT', 'Mutation receipt does not name the exact changed reference.');
        if (c.method === 'script.update' && (after.source !== c.args.source || object(mutation.before).source !== c.args.expectedSource)) throw new ArcaneError('RECEIPT', 'Script receipt does not match the intended baseline/change.');
        if (c.method === 'scene.update' && !(isGuiClass(r.className)
          ? guiEditReceiptMatches(r.className, c.args, mutation)
          : nativePropertiesMatch(object(c.args.properties) as Record<string, Json>, after.properties, r.className as string) && canonical(object(mutation.before).properties) === canonical(c.args.expected))) throw new ArcaneError('RECEIPT', 'Property receipt does not match the intended change.');
        if (c.method === 'script.set_enabled' && (!sameReceiptRef(mutation.ref,c.args.ref) || canonical(mutation.before) !== canonical({ source:c.args.expectedSource,enabled:c.args.expectedEnabled }) || canonical(after) !== canonical({source:c.args.expectedSource,enabled:c.args.enabled}))) throw new ArcaneError('RECEIPT', 'Execution-state receipt does not match the exact source/state baseline.');
        if(c.method==='scene.remove'){
          const before=object(mutation.before);const workspace=c.args.mode==='workspace';
          if(!Number.isSafeInteger(after.removed)||(after.removed as number)<0||(after.removed as number)>10000||!Number.isSafeInteger(after.descendants)||(after.descendants as number)<(after.removed as number)||(after.descendants as number)>100000
            ||after.undo!=='studio'||after.terrainCleared!==workspace||before.targetCount!==after.removed||before.descendants!==after.descendants||!Array.isArray(r.pathSegments)||r.pathSegments.length!==0
            ||workspace&&r.root!=='Workspace'||!workspace&&after.removed!==(c.args.refs as Json[]).length)
            throw new ArcaneError('RECEIPT','Removal receipt does not match its bounded targets and restoration contract.');
        }
        if (c.method === 'scene.create' && mutation.before !== null) throw new ArcaneError('RECEIPT', 'Creation receipt must have a null baseline.');
        // Clone items copy a template's whole subtree, so a build with clones creates at least the planned count.
        const cloned = c.method === 'scene.build' && (c.args.items as {kind?:unknown}[]).some(item => item.kind === 'clone');
        if (c.method === 'scene.build' && (mutation.before !== null || (cloned
          ? !Number.isInteger(after.count) || (after.count as number) < sceneBuildInstanceCount(c.args) || (after.count as number) > SCENE_BUILD_LIMITS.instances
          : after.count !== sceneBuildInstanceCount(c.args))
          || r.className !== object(c.args.container).className)) throw new ArcaneError('RECEIPT', 'Build receipt does not match the exact requested hierarchy.');
        if (isAssetMethod(c.method)) validateAssetReceipt(c.method, c.args, mutation);
        if (c.method === 'terrain.generate' && (mutation.before !== null || r.className !== 'Terrain' || after.voxels !== terrainVoxelCount(c.args))) throw new ArcaneError('RECEIPT', 'Terrain receipt does not match the requested region.');
      }
      c.state = completedState === 'failed' && result && typeof result === 'object' && !Array.isArray(result) && result.partial === true ? 'needs_reconciliation' : completedState;
      c.result = result; c.error = error; c.finishedAt = this.iso(); this.saveCommand(c);
      this.event('command_' + c.state, c.id, { sessionId, method: c.method });
    });
    // result() and its COMMIT have completed. Resolving only internal promises
    // schedules fresh controller reads before the next plugin I/O turn. A
    // rejected ACK or rolled-back transaction never reaches this notification.
    for(const finish of this.#commandResultWaiters.get(commandId)??[])finish();
  }
  restore(input: unknown): StudioCommand {
    return this.enqueue(this.restoreInput(input), true);
  }
  async restoreVerified(input: unknown, verifier: ScriptSourceVerifier | null, guard: () => void = () => {}): Promise<StudioCommand> {
    return this.enqueueVerified(this.restoreInput(input), verifier, guard, true);
  }
  private restoreInput(input: unknown): Record<string, Json> {
    const a = object(input); const prior = this.command(textField(a.commandId, 'command ID'));
    if(this.db.prepare('SELECT 1 FROM studio_test_commands WHERE command_id=?').get(prior.id))throw new ArcaneError('TEST_RESERVATION','Temporary setup receipts require their original private restoration owner.');
    if (prior.method === 'environment.apply') throw new ArcaneError('RESTORE', 'Terrain and lighting changes are reverted with Studio Undo (one recording); the receipt lists the prior lighting values.');
    if (prior.method === 'scene.remove') throw new ArcaneError('RESTORE','Scene removal is reverted with Studio Undo (one recording); receipt_restore cannot reconstruct deleted instances or terrain.');
    if (prior.method === 'terrain.generate') throw new ArcaneError('RESTORE', 'Generated terrain is reverted with Studio Undo (one recording); receipt_restore is refused.');
    if (prior.method === 'asset.keep_mesh') throw new ArcaneError('RESTORE', 'An upload to your Roblox account cannot be undone from Arcane. The part swap is one Studio Undo step; the uploaded asset stays in your inventory.');
    if (prior.state !== 'succeeded' || !isWrite(prior.method) || prior.method === 'scene.restore' || prior.method === 'asset.stage_packet'||prior.method==='asset.reconstruct') throw new ArcaneError('RESTORE', 'This receipt does not contain a succeeded reversible mutation.');
    const mutation = jsonObject(object(prior.result).mutation);
    return { sessionId: prior.sessionId, requestId: textField(a.requestId, 'request ID'), method: 'scene.restore', args: { receiptCommandId: prior.id, mutation } };
  }
  counts(): Record<string, number> { return Object.fromEntries((this.db.prepare('SELECT state,count(*) AS n FROM commands GROUP BY state').all() as Row[]).map(r => [r.state, Number(r.n)])); }
  events(limit = 100): Json[] { return (this.db.prepare('SELECT sequence,occurred_at,kind,entity_id,detail FROM events ORDER BY sequence DESC LIMIT ?').all(Math.max(1, Math.min(limit, 100))) as Row[]).map(r => ({ sequence: Number(r.sequence), occurredAt: r.occurred_at as string, kind: r.kind as string, entityId: r.entity_id as string, detail: JSON.parse(r.detail as string) as Json })); }
  /** True only while this open store holds the exclusive workspace lock of exactly `directory`. Owned
   * subdirectory stores use it to prove no other daemon can be their writer. */
  holdsWorkspaceLock(directory: string): boolean {
    if (this.closed || typeof directory !== 'string') return false;
    const a = resolve(directory), b = this.workspaceDirectory;
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  close(): void { if (!this.closed) { this.closed = true; this.clearStageContentHashes();this.#convertedStageInspections.clear();this.#assetDispatchGuards.clear();this.#importRevisionGuards.clear();this.#importObservationClaims.clear();this.#importRevisionClaims.clear(); for(const waiters of this.#commandResultWaiters.values())for(const finish of waiters)finish();
    const errors:unknown[]=[];for(const cleanup of [()=>this.db.close(),()=>this.#closeNativeDatabasePin(),()=>this.#releaseNativeLock()])try{cleanup();}catch(error){errors.push(error);}
    if(errors.length)throw errors[0];
  } }
}
