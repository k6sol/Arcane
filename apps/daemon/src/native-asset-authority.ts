import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { workflowProjectIdentity } from '../../../packages/storage/src/workflow-store.js';
import type { NativeConversation } from '../../../packages/storage/src/conversation-work-store.js';

export type NativeAssetOperation = 'read' | 'mutate';
/** Opaque host-only capability. A structurally identical JSON object grants nothing. */
export interface NativeAssetActor { readonly kind: 'native-asset-actor' }
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
  grant(value: {connectionId: string; threadId: string}): void;
  /** Trusted HUMAN Send only, immediately before actual dispatch. Never grants
   * before dispatch and expires with that exact intent; manual grants persist. */
  grantNextIntent(value: {connectionId: string; threadId: string; sessionId: string | null}): void;
  revokeGrant(): void;
  /** Host dispatch intent, not provider-origin invocation/turn attestation. */
  dispatched(value: {connectionId: string; threadId: string; operationId: string}): void;
  ended(operationId: string): void;
  retire(): void;
  status(): Readonly<{sealed: boolean; granted: boolean; admissionOpen: boolean; retired: boolean}>;
}
export interface NativeAssetRegistry {
  issue(): NativeAssetIncarnation;
  capture(credential: string, operation: NativeAssetOperation): NativeAssetActor;
  /** Classification alone grants no operation; pending/retired credentials cannot be used. */
  recognizes(credential: string): boolean;
  close(): void;
}
const MAX_INCARNATIONS = 128, MAX_INTENTS = 128;
// Bounded, non-evicting claims across a registry incarnation. Stage history is
// itself capped at 64; failed admissions must not make an old claim reusable.
const MAX_STAGE_CLAIMS = MAX_INTENTS * 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?![\s\S])/;
const TOKEN = /^[a-f0-9]{64}(?![\s\S])/;
const DUMMY = Buffer.alloc(32);
interface Entry {
  projectId: string; projectPath: string; generation: number; retired: boolean;
  sealed: Readonly<NativeAssetSeal> | null; granted: boolean; active: string | null;
  nextIntent: boolean; automaticIntent: string | null;
  intents: Set<string>;
}
interface Admission {entry: Entry; generation: number; operation: NativeAssetOperation; scope: NativeAssetScope}
const actors = new WeakMap<object, Admission>();
const stagedOperations = new WeakMap<Entry, Set<string>>();
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
function bump(entry: Entry): void {
  if (!Number.isSafeInteger(entry.generation) || entry.generation >= 65535) {
    entry.retired = true; entry.granted = false; entry.active = null; entry.nextIntent = false; entry.automaticIntent = null; fail();
  }
  entry.generation++;
}
function live(entry: Entry): Readonly<NativeAssetSeal> {
  if (entry.retired || !entry.sealed) fail();
  return entry.sealed;
}
function mutationGranted(entry: Entry): boolean {
  return entry.granted || entry.active !== null && entry.automaticIntent === entry.active;
}
function check(admission: Admission, operation: NativeAssetOperation): void {
  const entry = admission.entry;live(entry);
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
function stageClaim(actor: NativeAssetActor, jobId: string): {entry: Entry; key: string; consumed: Set<string>} {
  assertNativeAssetActor(actor, 'mutate');
  if (typeof jobId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/.test(jobId)) fail();
  const admission = actors.get(actor)!;
  const operation = admission.entry.active!;
  const key = JSON.stringify([operation, admission.scope.projectId, jobId]);
  const consumed = stagedOperations.get(admission.entry) ?? new Set<string>();
  if (consumed.has(key) || consumed.size >= MAX_STAGE_CLAIMS) fail();
  return {entry: admission.entry, key, consumed};
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
/** Volatile host authority only. It never reads provider auth/config or persists secrets.
 * Registry lifetime is one daemon/project. Restart retires every credential/intent;
 * durable conversation bindings live in the separate ConversationWorkStore. */
export function createNativeAssetRegistry(options: {projectPath: string}): NativeAssetRegistry {
  const input = data(options,['projectPath']);if (typeof input.projectPath !== 'string') fail();
  const project = workflowProjectIdentity(input.projectPath);
  if (project.projectPath !== input.projectPath) fail();
  const entries = new Map<string,{digest: Buffer;entry: Entry}>();let closed = false;
  const open = () => {if (closed) fail();};
  function find(credential: string): Entry | null {
    if (typeof credential !== 'string' || !TOKEN.test(credential)) return null;
    const digest = createHash('sha256').update(credential).digest();
    const stored = entries.get(digest.toString('hex'));
    const matched = timingSafeEqual(digest,stored?.digest ?? DUMMY);digest.fill(0);
    return matched && stored ? stored.entry : null;
  }
  const retire = (entry: Entry) => {
    if (entry.retired) return; entry.granted = false;entry.active = null;entry.nextIntent = false;entry.automaticIntent = null;entry.retired = true;
    // Retirement/close must fence ALL entries even at a saturated epoch.
    if (Number.isSafeInteger(entry.generation) && entry.generation < 65535) entry.generation++;
  };
  return Object.freeze({
    issue(): NativeAssetIncarnation {
      open();if (entries.size >= MAX_INCARNATIONS) fail();
      const credential = randomBytes(32).toString('hex');
      const digest = createHash('sha256').update(credential).digest();
      if (entries.has(digest.toString('hex'))) {digest.fill(0);fail();}
      const entry: Entry = {...project,generation:0,retired:false,sealed:null,granted:false,active:null,nextIntent:false,automaticIntent:null,intents:new Set()};
      entries.set(digest.toString('hex'),{digest,entry});
      const binding = (value: unknown, extra: readonly string[] = []): Record<string, unknown> => {
        open();const seal = live(entry), a=data(value,['connectionId','threadId',...extra]);
        if (opaque(a.connectionId)!==seal.connectionId || opaque(a.threadId)!==seal.threadId) fail();return a;
      };
      return Object.freeze({
        credential() {open();if (entry.retired) fail();return credential;},
        seal(value: NativeAssetSeal) {
          open();if (entry.retired) fail();const a=data(value,['connectionId','provider','threadId','sessionId']);
          if (a.provider !== 'codex' || (a.sessionId !== null && typeof a.sessionId !== 'string')) fail();
          const seal=Object.freeze({connectionId:opaque(a.connectionId),provider:'codex' as const,
            threadId:opaque(a.threadId),sessionId:a.sessionId===null?null:opaque(a.sessionId)});
          if (entry.sealed) {
            if (JSON.stringify(entry.sealed)!==JSON.stringify(seal)) {retire(entry);fail();}
            return; // Exact duplicate durable ACK cannot open/regrant an intent.
          }
          entry.sealed=seal;bump(entry);
        },
        grant(value: {connectionId:string;threadId:string}) {binding(value);entry.granted=true;bump(entry);},
        grantNextIntent(value: {connectionId:string;threadId:string;sessionId:string|null}) {
          const a=binding(value,['sessionId']);
          if(a.sessionId!==live(entry).sessionId || entry.active!==null || entry.nextIntent) fail();
          entry.nextIntent=true;bump(entry);
        },
        revokeGrant() {open();if(entry.retired)return;entry.granted=false;entry.active=null;entry.nextIntent=false;entry.automaticIntent=null;bump(entry);},
        dispatched(value: {connectionId:string;threadId:string;operationId:string}) {
          try {
            const a=binding(value,['operationId']),operationId=opaque(a.operationId);
            if (entry.active!==null || entry.intents.has(operationId) || entry.intents.size>=MAX_INTENTS) fail();
            entry.intents.add(operationId);entry.active=operationId;
            entry.automaticIntent=entry.nextIntent?operationId:null;entry.nextIntent=false;bump(entry);
          } catch(error) {
            // A failed actual start cannot leave permission for a later intent.
            if(entry.nextIntent){entry.nextIntent=false;bump(entry);}throw error;
          }
        },
        ended(operationId:string) {
          open();opaque(operationId);if (entry.retired || entry.active!==operationId) return;
          entry.active=null;entry.automaticIntent=null;entry.nextIntent=false;bump(entry);
        },
        retire() {retire(entry);},
        status() {return Object.freeze({sealed:entry.sealed!==null,granted:mutationGranted(entry),
          admissionOpen:!entry.retired&&entry.active!==null,retired:entry.retired});},
      });
    },
    capture(credential:string,operation:NativeAssetOperation):NativeAssetActor {
      open();if(operation!=='read'&&operation!=='mutate')fail();const entry=find(credential);if(!entry)fail();const seal=live(entry);
      if(operation==='mutate'&&(!mutationGranted(entry)||entry.active===null))fail();
      const scope=Object.freeze({projectId:entry.projectId,projectPath:entry.projectPath,
        conversation:Object.freeze({provider:seal.provider,threadId:seal.threadId,sessionId:seal.sessionId})});
      const actor=Object.freeze({kind:'native-asset-actor' as const});
      actors.set(actor,{entry,generation:entry.generation,operation,scope});return actor;
    },
    recognizes(credential:string):boolean {if(closed)return false;const entry=find(credential);return !!entry&&!entry.retired&&entry.sealed!==null;},
    close() {if(closed)return;closed=true;for(const {entry,digest} of entries.values()){retire(entry);digest.fill(0);}entries.clear();},
  });
}
