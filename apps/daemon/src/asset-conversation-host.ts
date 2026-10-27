import { types } from 'node:util';
import { CUSTOM_REQUEST_BYTES } from '../../../packages/asset-pipeline/src/recipe.js';
import type { AssetRequest } from '../../../packages/asset-pipeline/src/types.js';
import {parseAdoptGlbInput, type AdoptGlbInput} from '../../../packages/asset-pipeline/src/adopted-glb.js';
import {parseConvertGlbInput,type ConvertGlbInput} from './conversion-start.js';
import { normalizeRequest } from '../../../packages/asset-pipeline/src/validation.js';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import {
  CONVERSATION_WORK_LIMITS, ConversationWorkStore,
  type ConversationWorkBinding, type ConversationWorkPage, type NativeConversation,
} from '../../../packages/storage/src/conversation-work-store.js';
import type { AssetStartAdmission } from './asset-service.js';
import {
  assertNativeAssetActor, nativeAssetActorScope, acquireNativeAssetWork, type NativeAssetActor,
} from './native-asset-authority.js';

export interface AssetConversationHostOptions {
  /** Exact canonical path of the borrowed store and the host's asset service. */
  projectPath: string;
  workAssociations: ConversationWorkStore;
  /** Trusted live native identity only; never implement this from request metadata. */
  conversation: () => NativeConversation | null;
  /** Host attests this callback starts in projectPath and returns the created job ID.
   * It is invoked once per start. The adapter never owns or closes the service/store. */
  start: (request: AssetRequest) => string | Promise<string>;
  /** Trusted service creation witness only. Admission is host code, never JSON. */
  startNative?: (request: AssetRequest, admission: AssetStartAdmission) => Promise<string>;
  adoptNative?: (request: AdoptGlbInput, actor: NativeAssetActor, admission: AssetStartAdmission) => Promise<string>;
  convertNative?: (request: ConvertGlbInput, actor: NativeAssetActor, admission: AssetStartAdmission) => Promise<string>;
}
export interface AssetConversationStartResult {
  projectId: string;
  projectPath: string;
  jobId: string;
  association: 'bound' | 'unknown' | 'unscoped';
  /** The pre-start host snapshot; with unknown persistence this is not proof of binding. */
  conversation: NativeConversation | null;
  retry: false;
}
export interface AssetConversationListing extends ConversationWorkPage {
  projectId: string;
  projectPath: string;
  conversation: NativeConversation;
}
export interface NativeAssetConversationStartResult {
  projectId: string;
  projectPath: string;
  jobId: string | null;
  association: 'bound' | 'unknown';
  /** Original registry capture; unknown association is not proof of persistence. */
  conversation: NativeConversation;
  creation: 'created' | 'unknown';
  retry: false;
}

function fail(code: string): never {
  throw new ArcaneError('ASSET_CONVERSATION_' + code, 'Asset conversation request refused.');
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail('INPUT');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length ||
      keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) fail('INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (required.some(key => !Object.hasOwn(descriptors, key))) fail('INPUT');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('INPUT');
    result[key] = descriptor.value as unknown;
  }
  return result;
}

/** Detach bounded JSON without invoking accessors, proxies or toJSON. Asset recipe
 * semantics remain with the existing pure normalizer. No authority fields survive. */
function assetRequest(value: unknown): AssetRequest {
  let nodes = 0, bytes = 0;
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 12) fail('INPUT');
    if (typeof item === 'string') {
      if (item.length > CUSTOM_REQUEST_BYTES) fail('INPUT');
      bytes += Buffer.byteLength(JSON.stringify(item));
    } else if (item === null || typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item))) {
      bytes += Buffer.byteLength(JSON.stringify(item));
    } else if (item && typeof item === 'object' && !types.isProxy(item)) {
      const array = Array.isArray(item), prototype: unknown = Object.getPrototypeOf(item);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('INPUT');
      const keys = Reflect.ownKeys(item);
      if (keys.length > 100000 - nodes || keys.some(key => typeof key !== 'string' || key.length > 64)) fail('INPUT');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const output: unknown[] = [];
      const length = array ? descriptors.length?.value as unknown : null;
      if (array && (typeof length !== 'number' || length > 100000 || keys.length !== length + 1)) fail('INPUT');
      bytes += 2; // JSON container brackets/braces.
      let count = 0;
      for (const key of keys as string[]) {
        if (array && key === 'length') continue;
        const descriptor = descriptors[key]!;
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable ||
            (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= (length as number)))) fail('INPUT');
        if (count++) bytes++; // Comma between serialized values.
        // Array property names are not serialized as JSON object keys.
        if (!array) bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        if (bytes > CUSTOM_REQUEST_BYTES) fail('INPUT');
        const child = copy(descriptor.value as unknown, depth + 1);
        if (array) output[Number(key)] = child;
        else result[key] = child;
      }
      return array ? output : result;
    } else fail('INPUT');
    if (bytes > CUSTOM_REQUEST_BYTES) fail('INPUT');
    return item;
  }
  const snapshot = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > CUSTOM_REQUEST_BYTES) fail('INPUT');
  try { return normalizeRequest(snapshot); }
  catch { fail('INPUT'); } // Never echo untrusted content or normalizer diagnostics.
}
function jobId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > CONVERSATION_WORK_LIMITS.workId ||
      /[^A-Za-z0-9_-]/.test(value)) fail('JOB_ID');
  return value;
}
function equal(a: NativeConversation, b: NativeConversation): boolean {
  return a.provider === b.provider && a.threadId === b.threadId && a.sessionId === b.sessionId;
}

/** Host-only seam. The parent authenticates callers before selecting a method;
 * human methods must never be reachable with an agent bearer. No client role,
 * project path, conversation, service or callback is accepted in operation data. */
export function createAssetConversationHost(options: AssetConversationHostOptions) {
  const a = fields(options, ['projectPath', 'workAssociations', 'conversation', 'start'], ['startNative', 'adoptNative', 'convertNative']);
  if (!a.workAssociations || types.isProxy(a.workAssociations) || !(a.workAssociations instanceof ConversationWorkStore) ||
      typeof a.conversation !== 'function' || typeof a.start !== 'function' ||
      (Object.hasOwn(a, 'startNative') && typeof a.startNative !== 'function') || (Object.hasOwn(a,'adoptNative') && typeof a.adoptNative !== 'function') ||
      (Object.hasOwn(a,'convertNative') && typeof a.convertNative !== 'function')) fail('INPUT');
  const associations = a.workAssociations;
  // Do not normalize a different project spelling into authority.
  if (typeof a.projectPath !== 'string' || a.projectPath !== associations.projectPath) fail('PROJECT');
  const projectPath = a.projectPath, projectId = associations.projectId;
  const observe = a.conversation as AssetConversationHostOptions['conversation'];
  const start = a.start as AssetConversationHostOptions['start'];
  const startNative = a.startNative as AssetConversationHostOptions['startNative'];
  const adoptNative = a.adoptNative as AssetConversationHostOptions['adoptNative'];
  const convertNative = a.convertNative as AssetConversationHostOptions['convertNative'];
  function captured(actor: NativeAssetActor, operation: 'read' | 'mutate'): NativeConversation {
    assertNativeAssetActor(actor, operation);
    const scope = nativeAssetActorScope(actor);
    if (scope.projectId !== projectId || scope.projectPath !== projectPath) fail('PROJECT');
    // Registry identity only. Never observe current/saved/human native context.
    return Object.freeze({ ...scope.conversation });
  }
  function current(): NativeConversation {
    const value = observe();
    if (value === null) fail('REQUIRED');
    const native = fields(value, ['provider', 'threadId', 'sessionId']);
    // Storage validates provider, opaque IDs, credential patterns and exact scope
    // before any start; its returned page is not used to infer an identity.
    return Object.freeze({ provider: native.provider, threadId: native.threadId,
      sessionId: native.sessionId }) as NativeConversation;
  }
  function page(native: NativeConversation, pagination: unknown): ConversationWorkPage {
    const p = fields(pagination, [], ['limit', 'after']);
    return associations.list(native, 'asset-job', p);
  }
  return {
    async startNative(actor: NativeAssetActor, input: unknown): Promise<NativeAssetConversationStartResult> {
      const conversation = captured(actor, 'mutate'), request = assetRequest(input);
      page(conversation, { limit: 1 }); // Validate scope and borrowed storage before dispatch.
      if (!startNative) fail('NATIVE_UNAVAILABLE');
      const work = acquireNativeAssetWork(actor, 'generation');
      let active = true, attempted = false, admitted = false, witnessed = false, uncertain = false;
      let id: string | null = null, association: 'bound' | 'unknown' = 'unknown';
      let admissionFailure: unknown;
      const admission: AssetStartAdmission = Object.freeze({
        signal: work.signal, work,
        beforeCreate(): void {
          if (!active || attempted || witnessed) { uncertain = true; fail('ADMISSION'); }
          attempted = true;
          try {
            // Called synchronously by the service AFTER its awaited preflight,
            // immediately before allocation. Never recapture or upgrade the actor.
            assertNativeAssetActor(actor, 'mutate');
            page(conversation, { limit: 1 });
            admitted = true;
          } catch (error) { admissionFailure = error; throw error; }
        },
        created(value: string): void {
          if (!active || witnessed) { uncertain = true; fail('ADMISSION'); }
          witnessed = true; // Record creation even if the witness ID is malformed.
          try { id = jobId(value); } catch { uncertain = true; return; }
          if (!admitted) { uncertain = true; return; }
          // Allocation has happened. Original attribution must survive revocation,
          // retirement, window end and UI context changes. Exactly one bind attempt.
          try { associations.bind({ conversation, kind: 'asset-job', id }); association = 'bound'; }
          catch { uncertain = true; } // Includes a lost persistence ACK. Never probe/rebind.
        },
      });
      try {
        const returned = jobId(await startNative(request, admission));
        if (!witnessed) { id = returned; uncertain = true; } // Missing witness cannot adopt a global job.
        else if (id !== returned) uncertain = true;
      } catch (error) {
        // Only an observed admission refusal, before any witness, is definitive.
        // A callback rejection alone cannot rule out a lost creation acknowledgement.
        if (!witnessed && !admitted && admissionFailure !== undefined) throw admissionFailure;
        uncertain = true;
      } finally { active = false; work.finish('closed'); }
      return { projectId, projectPath, jobId: id,
        association: uncertain ? 'unknown' : association, conversation: { ...conversation },
        creation: uncertain ? 'unknown' : 'created', retry: false };
    },
    async adoptNative(actor: NativeAssetActor,input:unknown):Promise<NativeAssetConversationStartResult> {
      const conversation=captured(actor,'mutate'),request=parseAdoptGlbInput(input);
      page(conversation,{limit:1});if(!adoptNative)fail('NATIVE_UNAVAILABLE');
      let active=true,attempted=false,admitted=false,witnessed=false,uncertain=false;
      let id:string|null=null,association:'bound'|'unknown'='unknown';
      const admission:AssetStartAdmission=Object.freeze({
        beforeCreate():void {
          if(!active||attempted||witnessed)fail('ADMISSION');attempted=true;
          assertNativeAssetActor(actor,'mutate');page(conversation,{limit:1});admitted=true;
        },
        created(value:string):void {
          if(!active||witnessed){uncertain=true;fail('ADMISSION');}witnessed=true;
          try{id=jobId(value);}catch{uncertain=true;return;}
          if(!admitted){uncertain=true;return;}
          try{associations.bind({conversation,kind:'asset-job',id});association='bound';}catch{uncertain=true;fail('BINDING_UNKNOWN');}
        },
      });
      try{
        const returned=jobId(await adoptNative(request,actor,admission));
        if(!witnessed){id=returned;uncertain=true;}else if(id!==returned)uncertain=true;
      }catch(error){
        // Actual service guarantees all ordinary-file/GLB preflight precedes
        // beforeCreate. A refusal before that observed boundary creates no job.
        if(!attempted&&!witnessed)throw error;
        uncertain=true;
      }finally{active=false;}
      return {projectId,projectPath,jobId:id,association:uncertain?'unknown':association,conversation:{...conversation},creation:uncertain?'unknown':'created',retry:false};
    },
    async convertNative(actor: NativeAssetActor,input:unknown):Promise<NativeAssetConversationStartResult> {
      const conversation=captured(actor,'mutate'),request=parseConvertGlbInput(input);
      page(conversation,{limit:1});if(!convertNative)fail('NATIVE_UNAVAILABLE');
      const work=acquireNativeAssetWork(actor,'generation');
      let active=true,attempted=false,admitted=false,witnessed=false,uncertain=false,returnedObserved=false;
      let id:string|null=null,association:'bound'|'unknown'='unknown',admissionFailure:unknown;
      const exactJob=(value:unknown):string=>{
        const parsed=jobId(value);
        if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/.test(parsed))fail('JOB_ID');
        return parsed;
      };
      const admission:AssetStartAdmission=Object.freeze({signal:work.signal,work,
        beforeCreate():void {
          if(!active||attempted||witnessed){uncertain=true;fail('ADMISSION');}attempted=true;
          try{assertNativeAssetActor(actor,'mutate');page(conversation,{limit:1});admitted=true;}
          catch(error){admissionFailure=error;throw error;}
        },
        created(value:string):void {
          if(!active||witnessed){uncertain=true;fail('ADMISSION');}witnessed=true;
          try{id=exactJob(value);}catch{uncertain=true;return;}
          if(!admitted){uncertain=true;return;}
          // Allocation is a fact. Attribute once to the original capture even
          // when the actor retires while durable bookkeeping is returning.
          try{associations.bind({conversation,kind:'asset-job',id});association='bound';}
          catch{uncertain=true;fail('BINDING_UNKNOWN');}
        },
      });
      try{
        const raw=await convertNative(request,actor,admission);returnedObserved=true;
        const returned=exactJob(raw);
        if(!witnessed){id=returned;uncertain=true;}else if(id!==returned)uncertain=true;
      }catch(error){
        if(!witnessed&&!admitted&&admissionFailure!==undefined)throw admissionFailure;
        // Actual service preflight rejects before beforeCreate or allocation.
        // A malformed returned acknowledgement never proves that no job exists.
        if(!attempted&&!witnessed&&!returnedObserved)throw error;
        uncertain=true;
      }finally{active=false;work.finish('closed');}
      return{projectId,projectPath,jobId:id,association:uncertain?'unknown':association,conversation:{...conversation},creation:uncertain?'unknown':'created',retry:false};
    },
    listNative(actor: NativeAssetActor, pagination: unknown = {}): AssetConversationListing {
      const conversation = captured(actor, 'read'), result = page(conversation, pagination);
      return { projectId, projectPath, conversation: { ...conversation }, ...result };
    },
    bindingNative(actor: NativeAssetActor, input: unknown): ConversationWorkBinding | null {
      const conversation = captured(actor, 'read'), id = jobId(input);
      page(conversation, { limit: 1 });
      const binding = associations.binding('asset-job', id);
      return binding && binding.projectId === projectId && equal(binding.conversation, conversation) ? binding : null;
    },
    async startHuman(input: unknown): Promise<AssetConversationStartResult> {
      const request = assetRequest(input), conversation = current();
      page(conversation, { limit: 1 });
      const id = jobId(await start(request));
      let association: 'bound' | 'unknown' = 'unknown';
      try {
        associations.bind({ conversation, kind: 'asset-job', id });
        association = 'bound';
      } catch { /* Creation already happened. Preserve its ID; never retry, recreate or rebind. */ }
      return { projectId, projectPath, jobId: id, association, conversation: { ...conversation }, retry: false };
    },
    async startAgent(input: unknown): Promise<AssetConversationStartResult> {
      const request = assetRequest(input);
      const id = jobId(await start(request));
      // The daemon agent bearer provides no canonical native conversation authority.
      return { projectId, projectPath, jobId: id, association: 'unscoped', conversation: null, retry: false };
    },
    listHuman(pagination: unknown = {}): AssetConversationListing {
      const conversation = current(), result = page(conversation, pagination);
      // Return stored identities from one snapshot, never replace them with later live context.
      return { projectId, projectPath, conversation: { ...conversation }, ...result };
    },
    bindingHuman(input: unknown): ConversationWorkBinding | null {
      const id = jobId(input), conversation = current();
      page(conversation, { limit: 1 });
      const binding = associations.binding('asset-job', id);
      return binding && binding.projectId === projectId && equal(binding.conversation, conversation) ? binding : null;
    },
  };
}
// Preserve the original structural seam used by human routes and their fixtures.
export type AssetConversationHost = Pick<ReturnType<typeof createAssetConversationHost>,
  'startHuman' | 'startAgent' | 'listHuman' | 'bindingHuman'>;
export type NativeAssetConversationHost = Pick<ReturnType<typeof createAssetConversationHost>,
  'startNative' | 'listNative' | 'bindingNative'> & Partial<Pick<ReturnType<typeof createAssetConversationHost>, 'adoptNative' | 'convertNative'>>;
