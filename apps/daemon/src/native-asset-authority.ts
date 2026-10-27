import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { workflowProjectIdentity } from '../../../packages/storage/src/workflow-store.js';
import type { NativeConversation } from '../../../packages/storage/src/conversation-work-store.js';
import type { AppAssetConversationBinding } from '../../../packages/protocol/src/asset-conversation.js';

export type NativeAssetOperation = 'read' | 'mutate';
/** Opaque host-only capability. A structurally identical JSON object grants nothing. */
export interface NativeAssetActor { readonly kind: 'native-asset-actor' }
export type NativeAssetWorkKind = 'generation' | 'preparation' | 'stage' | 'reconstruction' | 'revision';
/** Host-owned lifetime only. This is never dispatch, write or continuation authority. */
export interface NativeAssetWorkLease {
  readonly signal: AbortSignal;
  run<T>(start: () => T | Promise<T>): Promise<T>;
  finish(outcome: 'closed' | 'unresolved'): void;
}
export interface NativeAssetScope {
  readonly projectId: string; readonly projectPath: string;
  readonly conversation: Readonly<NativeConversation>;
}
export interface NativeAssetSeal {
  connectionId: string; provider: 'codex'; threadId: string; sessionId: string | null;
}
export interface NativeAssetIncarnation {
  /** Only the fixed final child launch consumes this secret; never return through HTTP/state/logs. */
  credential(): string;
  /** Host calls only after the exact configured native acknowledgement AND durable journal commit. */
  seal(value: NativeAssetSeal): void;
  /** Trusted app host only, after durable chat binding and its owned transport acknowledgement.
   * The local chat anchor is never presented as a Codex/native session acknowledgement. */
  bindAppConversation(value: AppAssetConversationBinding): void;
  grant(value: {connectionId: string; threadId: string}): void;
  /** Trusted HUMAN Send only, immediately before actual dispatch. Never grants
   * before dispatch and expires with that exact intent; manual grants persist. */
  grantNextIntent(value: {connectionId: string; threadId: string; sessionId: string | null}): void;
  revokeGrant(): void;
  /** Host dispatch intent, not provider-origin invocation/turn attestation. */
  dispatched(value: {connectionId: string; threadId: string; operationId: string}): void;
  ended(operationId: string): void;
  /** Explicit trusted human stop only. Normal completion/retirement does not
   * cancel already accepted asynchronous workers. Cleanup remains available
   * after retirement, without granting any new native operation. */
  cancelWork(scope: 'active-operation' | 'incarnation'): void;
  retire(): void;
  /** Actual owned transport closure or definitive proof that no child was launched. */
  transportClosed(): void;
  status(): Readonly<{sealed: boolean; granted: boolean; admissionOpen: boolean; retired: boolean; released: boolean}>;
}
export interface NativeAssetRegistry {
  issue(): NativeAssetIncarnation;
  capture(credential: string, operation: NativeAssetOperation): NativeAssetActor;
  /** Classification alone grants no operation; pending/retired credentials cannot be used. */
  recognizes(credential: string): boolean;
  close(): void;
}
const MAX_INCARNATIONS = 128, MAX_INTENTS = 128, MAX_WORK_LEASES = 128, MAX_WORK_HOLDS = 128;
// Bounded, non-evicting claims across a registry incarnation. Stage history is
// itself capped at 64; failed admissions must not make an old claim reusable.
const MAX_STAGE_CLAIMS = MAX_INTENTS * 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?![\s\S])/;
const TOKEN = /^[a-f0-9]{64}(?![\s\S])/;
const DUMMY = Buffer.alloc(32);
interface EntryCell { entry: Entry | null; retired: boolean; sealed: boolean; released: boolean }
interface Entry {
  cell: EntryCell; credential: string; transportClosed: boolean; leases: Set<WorkLeaseState>; reclaim(): void;
  projectId: string; projectPath: string; generation: number; retired: boolean;
  sealed: Readonly<{connectionId:string;provider:NativeConversation['provider'];threadId:string;sessionId:string|null}> | null;
  binding: Readonly<NativeAssetSeal | AppAssetConversationBinding> | null; granted: boolean; active: string | null;
  nextIntent: boolean; automaticIntent: string | null;
  intents: Set<string>;
  work: Map<string, AbortController>;
}
interface Admission {cell: EntryCell; generation: number; operation: NativeAssetOperation; scope: NativeAssetScope}
interface WorkLeaseState {
  cell: EntryCell; signal: AbortSignal;
  finished: boolean; unresolved: boolean; released: boolean; pending: number;
}
const workLeases = new WeakMap<object, WorkLeaseState>();
const actors = new WeakMap<object, Admission>();
const stagedOperations = new WeakMap<Entry, Set<string>>();
const revisedOperations = new WeakMap<Entry, Set<string>>();
function fail(): never {throw new ArcaneError('NATIVE_ASSET_AUTHORITY', 'Native asset authority is unavailable or changed.');}
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor,'value') || !descriptor.enumerable) fail();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function opaque(value: unknown): string {if (typeof value !== 'string' || !ID.test(value)) fail();return value;}
function allocated(cell: EntryCell): Entry { if (!cell.entry || cell.released) fail(); return cell.entry; }
function compact(entry: Entry): void {
  if (!entry.retired || !entry.transportClosed || entry.leases.size) return;
  // Only tiny permanently fenced cells survive in late actors/handles. No old
  // actor or callback can reach claims, secrets or a newly allocated entry.
  entry.cell.retired = true; entry.cell.released = true; entry.cell.entry = null;
  entry.credential = ''; entry.binding = null; entry.sealed = null;
  entry.intents.clear(); entry.work.clear(); stagedOperations.delete(entry); revisedOperations.delete(entry);
  const reclaim = entry.reclaim; entry.reclaim = () => {}; reclaim();
}
function retireEntry(entry: Entry): void {
  if (!entry.retired) {
    entry.granted = false; entry.active = null; entry.nextIntent = false; entry.automaticIntent = null;
    entry.retired = true; entry.cell.retired = true;
    if (Number.isSafeInteger(entry.generation) && entry.generation < 65535) entry.generation++;
  }
  compact(entry);
}
function finishLease(state: WorkLeaseState): void {
  if (state.released || !state.finished || state.unresolved || state.pending) return;
  const entry = allocated(state.cell);
  state.released = true; entry.leases.delete(state); compact(entry);
}
/** Assert a real private lease, not a serialized or structurally matching value. */
export function assertNativeAssetWorkLease(value: NativeAssetWorkLease): void {
  const state = value && typeof value === 'object' ? workLeases.get(value) : undefined;
  if (!state || state.finished || state.released || !state.cell.entry) fail();
}
export function acquireNativeAssetWork(actor: NativeAssetActor, kind: NativeAssetWorkKind): NativeAssetWorkLease {
  if (!['generation', 'preparation', 'stage', 'reconstruction', 'revision'].includes(kind)) fail();
  assertNativeAssetActor(actor, 'mutate');
  const admission = actors.get(actor)!, entry = allocated(admission.cell), operationId = entry.active!;
  const controller = entry.work.get(operationId);
  if (!controller || entry.leases.size >= MAX_WORK_LEASES) fail();
  const state: WorkLeaseState = { cell: admission.cell, signal: controller.signal,
    finished: false, unresolved: false, released: false, pending: 0 };
  const lease: NativeAssetWorkLease = {
    signal: state.signal,
    run<T>(this: NativeAssetWorkLease, start: () => T | Promise<T>): Promise<T> {
      const selected = workLeases.get(this);
      if (!selected || selected.finished || selected.released || !selected.cell.entry || selected.signal.aborted ||
          typeof start !== 'function' || selected.pending >= MAX_WORK_HOLDS) fail();
      selected.pending++;
      let task: T | Promise<T>;
      try { task = start(); }
      catch (error) { selected.pending--; finishLease(selected); throw error; }
      return Promise.resolve(task).finally(() => { selected.pending--; finishLease(selected); });
    },
    finish(this: NativeAssetWorkLease, outcome: 'closed' | 'unresolved'): void {
      const selected = workLeases.get(this);
      if (!selected || outcome !== 'closed' && outcome !== 'unresolved') fail();
      if (selected.released) return;
      selected.finished = true; selected.unresolved ||= outcome === 'unresolved';
      finishLease(selected);
    },
  };
  workLeases.set(lease, state); entry.leases.add(state); return Object.freeze(lease);
}
function bump(entry: Entry): void {
  if (!Number.isSafeInteger(entry.generation) || entry.generation >= 65535) {
    retireEntry(entry); fail();
  }
  entry.generation++;
}
function live(entry: Entry): NonNullable<Entry['sealed']> {
  if (entry.retired || !entry.sealed) fail();
  return entry.sealed;
}
function mutationGranted(entry: Entry): boolean {
  return entry.granted || entry.active !== null && entry.automaticIntent === entry.active;
}
function check(admission: Admission, operation: NativeAssetOperation): void {
  const entry = allocated(admission.cell);live(entry);
  if (admission.generation !== entry.generation ||
      (operation === 'mutate' && (admission.operation !== 'mutate' || !mutationGranted(entry) || entry.active === null))) fail();
}
/** Recheck the SAME capture; never upgrade/refetch a queued request into a new epoch. */
export function assertNativeAssetActor(actor: NativeAssetActor, operation: NativeAssetOperation): void {
  if (operation !== 'read' && operation !== 'mutate') fail();
  if (!actor || typeof actor !== 'object') fail();
  const admission = actors.get(actor);if (!admission) fail();check(admission,operation);
}
export function nativeAssetActorScope(actor: NativeAssetActor): NativeAssetScope {
  assertNativeAssetActor(actor,'read');return actors.get(actor)!.scope;
}
/** Host-only cancellation signal for the SAME actual dispatched operation.
 * It cannot be recovered from serialized actor/scope/operation claims. The
 * accepted worker may retain this signal after normal admission has ended.
 * Its actual host must hold a work lease until all worker/listener cleanup ends. */
export function nativeAssetOperationSignal(actor: NativeAssetActor): AbortSignal {
  assertNativeAssetActor(actor, 'mutate');
  const entry = allocated(actors.get(actor)!.cell), controller = entry.work.get(entry.active!);
  if (!controller) fail();
  return controller.signal;
}
function stageClaim(actor: NativeAssetActor, jobId: string): {entry: Entry; key: string; consumed: Set<string>} {
  assertNativeAssetActor(actor, 'mutate');
  if (typeof jobId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/.test(jobId)) fail();
  const admission = actors.get(actor)!;
  const entry = allocated(admission.cell), operation = entry.active!;
  const key = JSON.stringify([operation, admission.scope.projectId, jobId]);
  const consumed = stagedOperations.get(entry) ?? new Set<string>();
  if (consumed.has(key) || consumed.size >= MAX_STAGE_CLAIMS) fail();
  return {entry, key, consumed};
}
/** Non-consuming rejection before preflight prevents a spent turn/job from
 * creating orphan preparation records. Claim rechecks atomically at admission. */
export function assertNativeAssetStageOperationAvailable(actor: NativeAssetActor, jobId: string): void {
  stageClaim(actor, jobId);
}
/** Consume this actual native mutation operation once PER owned project/job,
 * across captures/controllers. One turn may stage several different owned jobs.
 * It grants CPU staging only; no upload or engine admission is created. */
export function claimNativeAssetStageOperation(actor: NativeAssetActor, jobId: string): void {
  const {entry, key, consumed} = stageClaim(actor, jobId);
  consumed.add(key); stagedOperations.set(entry, consumed);
}
/** Revision claims have their own bounded namespace, so staging this same
 * owned job cannot consume its later apply operation. Metadata grants nothing. */
function revisionClaim(actor: NativeAssetActor, jobId: string): {entry: Entry; key: string; consumed: Set<string>} {
  assertNativeAssetActor(actor, 'mutate');
  if (typeof jobId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/.test(jobId)) fail();
  const admission = actors.get(actor)!;
  const entry = allocated(admission.cell), operation = entry.active!;
  const key = JSON.stringify([operation, admission.scope.projectId, jobId]);
  const consumed = revisedOperations.get(entry) ?? new Set<string>();
  if (consumed.has(key) || consumed.size >= MAX_STAGE_CLAIMS) fail();
  return {entry, key, consumed};
}
export function assertNativeAssetRevisionOperationAvailable(actor:NativeAssetActor,jobId:string):void {
  revisionClaim(actor,jobId);
}
export function claimNativeAssetRevisionOperation(actor:NativeAssetActor,jobId:string):void {
  const {entry,key,consumed}=revisionClaim(actor,jobId);
  consumed.add(key);revisedOperations.set(entry,consumed);
}
/** Volatile host authority only. It never reads provider auth/config or persists secrets.
 * Registry lifetime is one daemon/project. Restart retires every credential/intent;
 * durable conversation bindings live in the separate ConversationWorkStore. */
export function createNativeAssetRegistry(options: {projectPath: string}): NativeAssetRegistry {
  const input = data(options,['projectPath']);if (typeof input.projectPath !== 'string') fail();
  const project = workflowProjectIdentity(input.projectPath);
  if (project.projectPath !== input.projectPath) fail();
  const entries = new Map<string,{digest: Buffer;entry: Entry}>();let closed = false, issuance = 0n;
  const open = () => {if (closed) fail();};
  function find(credential: string): Entry | null {
    if (typeof credential !== 'string' || !TOKEN.test(credential)) return null;
    const digest = createHash('sha256').update(credential).digest();
    const stored = entries.get(digest.toString('hex'));
    const matched = timingSafeEqual(digest,stored?.digest ?? DUMMY);digest.fill(0);
    return matched && stored ? stored.entry : null;
  }
  function incarnation(cell: EntryCell): NativeAssetIncarnation {
      const binding = (value: unknown, extra: readonly string[] = []): Record<string, unknown> => {
        open();const entry = allocated(cell), seal = live(entry), a=data(value,['connectionId','threadId',...extra]);
        if (opaque(a.connectionId)!==seal.connectionId || opaque(a.threadId)!==seal.threadId) fail();return a;
      };
      return Object.freeze({
        credential() {open();const entry = allocated(cell);if (entry.retired) fail();return entry.credential;},
        seal(value: NativeAssetSeal) {
          open();const entry = allocated(cell);if (entry.retired) fail();const a=data(value,['connectionId','provider','threadId','sessionId']);
          if (a.provider !== 'codex' || (a.sessionId !== null && typeof a.sessionId !== 'string')) fail();
          const seal=Object.freeze({connectionId:opaque(a.connectionId),provider:'codex' as const,
            threadId:opaque(a.threadId),sessionId:a.sessionId===null?null:opaque(a.sessionId)});
          if (entry.sealed) {
            if (JSON.stringify(entry.binding)!==JSON.stringify(seal)) {retireEntry(entry);fail();}
            return; // Exact duplicate durable ACK cannot open/regrant an intent.
          }
          entry.binding=seal;entry.sealed=seal;cell.sealed=true;bump(entry);
        },
        bindAppConversation(value: AppAssetConversationBinding) {
          open();const entry = allocated(cell);if(entry.retired)fail();
          const a=data(value,['kind','connectionId','provider','conversationId','transport']);
          if(a.kind!=='app-conversation'||a.provider!=='claude-code'&&a.provider!=='arcane'||typeof a.conversationId!=='string'||
            !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/.test(a.conversationId))fail();
          const provider=a.provider,connectionId=opaque(a.connectionId),conversationId=a.conversationId;
          let transport:AppAssetConversationBinding['transport'];
          if(provider==='claude-code'){
            const t=data(a.transport,['kind','incarnationId','nativeSessionId']);
            if(t.kind!=='claude-code-process'||t.nativeSessionId!==null&&typeof t.nativeSessionId!=='string')fail();
            transport=Object.freeze({kind:'claude-code-process',incarnationId:opaque(t.incarnationId),nativeSessionId:t.nativeSessionId===null?null:opaque(t.nativeSessionId)});
          }else{
            const t=data(a.transport,['kind','incarnationId']);if(t.kind!=='arcane-gateway-loop')fail();
            transport=Object.freeze({kind:'arcane-gateway-loop',incarnationId:opaque(t.incarnationId)});
          }
          const anchor={kind:'app-conversation' as const,connectionId,conversationId};
          const binding:Readonly<AppAssetConversationBinding>=transport.kind==='claude-code-process'
            ?Object.freeze({...anchor,provider:'claude-code',transport})
            :Object.freeze({...anchor,provider:'arcane',transport});
          if(entry.sealed){if(JSON.stringify(entry.binding)!==JSON.stringify(binding)){retireEntry(entry);fail();}return;}
          entry.binding=binding;
          entry.sealed=Object.freeze({connectionId,provider,threadId:'app:'+conversationId,sessionId:null});cell.sealed=true;bump(entry);
        },
        grant(value: {connectionId:string;threadId:string}) {binding(value);const entry=allocated(cell);entry.granted=true;bump(entry);},
        grantNextIntent(value: {connectionId:string;threadId:string;sessionId:string|null}) {
          const a=binding(value,['sessionId']),entry=allocated(cell);
          if(a.sessionId!==live(entry).sessionId || entry.active!==null || entry.nextIntent) fail();
          entry.nextIntent=true;bump(entry);
        },
        revokeGrant() {open();if(cell.retired)return;const entry=allocated(cell);entry.granted=false;entry.active=null;entry.nextIntent=false;entry.automaticIntent=null;bump(entry);},
        dispatched(value: {connectionId:string;threadId:string;operationId:string}) {
          const entry=allocated(cell);
          try {
            const a=binding(value,['operationId']),operationId=opaque(a.operationId);
            if (entry.active!==null || entry.intents.has(operationId) || entry.intents.size>=MAX_INTENTS) fail();
            entry.intents.add(operationId);entry.active=operationId;
            entry.work.set(operationId, new AbortController());
            entry.automaticIntent=entry.nextIntent?operationId:null;entry.nextIntent=false;bump(entry);
          } catch(error) {
            // A failed actual start cannot leave permission for a later intent.
            if(entry.nextIntent){entry.nextIntent=false;bump(entry);}throw error;
          }
        },
        ended(operationId:string) {
          open();opaque(operationId);if(cell.retired)return;const entry=allocated(cell);if (entry.active!==operationId) return;
          entry.active=null;entry.automaticIntent=null;entry.nextIntent=false;bump(entry);
        },
        cancelWork(scope:'active-operation'|'incarnation') {
          open();if (scope !== 'active-operation' && scope !== 'incarnation') fail();if(cell.released)return;const entry=allocated(cell);
          const controllers = scope === 'incarnation' ? [...entry.work.values()] : entry.active === null ? [] : [entry.work.get(entry.active)!];
          // Fence admission before notifying any accepted worker. Completed
          // workers removed their listeners; other incarnations are untouched.
          entry.active=null;entry.automaticIntent=null;entry.nextIntent=false;
          if (!entry.retired) {
            // Stop remains effective at a saturated epoch; exhausting admission
            // history cannot strand an already accepted child process.
            if (Number.isSafeInteger(entry.generation) && entry.generation < 65535) entry.generation++;
            else retireEntry(entry);
          }
          for (const controller of controllers) controller.abort();
        },
        retire() {if(cell.entry)retireEntry(cell.entry);},
        transportClosed() {if(!cell.entry)return;const entry=cell.entry;entry.transportClosed=true;retireEntry(entry);},
        status() {const entry=cell.entry;return Object.freeze({sealed:cell.sealed,granted:entry?mutationGranted(entry):false,
          admissionOpen:!!entry&&!entry.retired&&entry.active!==null,retired:cell.retired,released:cell.released});},
      });
  }
  return Object.freeze({
    issue(): NativeAssetIncarnation {
      open();if(issuance>0xffffffffffffffffn)fail();
      // Reserve before allocation/randomness/capacity errors. Prefixes never
      // repeat in this registry; the suffix contains 192 unpredictable bits.
      const prefix=issuance.toString(16).padStart(16,'0');issuance++;
      if (entries.size >= MAX_INCARNATIONS) fail();
      const credential=prefix+randomBytes(24).toString('hex'),digest=createHash('sha256').update(credential).digest();
      const key=digest.toString('hex');if(entries.has(key)){digest.fill(0);fail();}
      const cell:EntryCell={entry:null,retired:false,sealed:false,released:false};
      const entry:Entry={...project,cell,credential,transportClosed:false,leases:new Set(),
        reclaim(){entries.delete(key);digest.fill(0);},generation:0,retired:false,sealed:null,binding:null,
        granted:false,active:null,nextIntent:false,automaticIntent:null,intents:new Set(),work:new Map()};
      cell.entry=entry;entries.set(key,{digest,entry});return incarnation(cell);
    },
    capture(credential:string,operation:NativeAssetOperation):NativeAssetActor {
      open();if(operation!=='read'&&operation!=='mutate')fail();const entry=find(credential);if(!entry)fail();const seal=live(entry);
      if(operation==='mutate'&&(!mutationGranted(entry)||entry.active===null))fail();
      const scope=Object.freeze({projectId:entry.projectId,projectPath:entry.projectPath,
        conversation:Object.freeze({provider:seal.provider,threadId:seal.threadId,sessionId:seal.sessionId})});
      const actor=Object.freeze({kind:'native-asset-actor' as const});
      actors.set(actor,{cell:entry.cell,generation:entry.generation,operation,scope});return actor;
    },
    recognizes(credential:string):boolean {if(closed)return false;const entry=find(credential);return !!entry&&!entry.retired&&entry.sealed!==null;},
    close() {if(closed)return;closed=true;for(const {entry,digest} of entries.values()){retireEntry(entry);digest.fill(0);}entries.clear();},
  });
}
