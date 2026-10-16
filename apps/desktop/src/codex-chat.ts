/// <reference lib="dom" />
import type { CodexAction, CodexActionRecord, CodexProductState } from '../../daemon/src/codex-service.js';
import type { RequestedModel } from '../../../packages/core/src/workflow-recipes.js';
import type { NativeWorkflowConversation, WorkflowDraftProvenance } from './workflow-panel.js';
import type { Approval, Model, SessionEvent, Snapshot } from '../../../packages/codex-client/src/types.js';
import type { ChatTabs, ChatTabsOptions, ChatTabView, ChatSelection, ChatTabsController } from './chat-tabs.js';
import type { ChatAttachmentsController } from './chat-attachments.js';

export const CODEX_STATE_BYTES = 4 * 1024 * 1024;
export const CODEX_INPUT_BYTES = 131072;
export const CODEX_DRAFT_SAVE_DELAY_MS = 250;
const DISPLAY_BYTES = 512 * 1024;
const utf8 = (value: string) => new TextEncoder().encode(value).length;
const sameWorkflowModel=(a:RequestedModel,b:RequestedModel)=>a.provider===b.provider&&a.model===b.model&&a.effort===b.effort&&a.connectionRevision===b.connectionRevision;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const ACTIONS = ['grant-assets','revoke-assets','connect','disconnect','select','thread-start','thread-resume','grant-writes','revoke-writes','turn-start','turn-interrupt','task-stop','task-focus','approval','history-load'];
const IDLE = ['idle','completed','failed','interrupted'];
type ChatEvent = SessionEvent;
export type ChatSnapshot = Omit<Snapshot, 'events'> & { events: ChatEvent[] };
export interface NativeAssetPermission { available: boolean; sealed: boolean; granted: boolean; admissionOpen: boolean }
export type ChatAction = CodexAction;
export type ChatActionRecord = CodexActionRecord;
export type ChatState = Omit<CodexProductState, 'snapshot' | 'lastSnapshot' | 'nativeAssets' | 'actions'> & {
  snapshot: ChatSnapshot | null; lastSnapshot: ChatSnapshot | null; actions: ChatActionRecord[];
  nativeAssets?: NativeAssetPermission;
};
/** JSON data only: reject getters without invoking them, including hidden/symbol fields. */
function dataObject(value: unknown, keys?: readonly string[]): value is Record<string, unknown> {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return (!keys || own.length === keys.length && keys.every(key => Object.hasOwn(value, key))) &&
    own.every(key => typeof key === 'string' && (() => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      return descriptor.enumerable && Object.hasOwn(descriptor, 'value');
    })());
}
function readNativeAssets(value: unknown): NativeAssetPermission | null {
  if (value === null) return null;
  const keys = ['available', 'sealed', 'granted', 'admissionOpen'];
  if (!dataObject(value, keys) || keys.some(key => typeof value[key] !== 'boolean') ||
      (!value.available && (value.sealed || value.granted || value.admissionOpen)) ||
      (value.granted || value.admissionOpen) && (!value.available || !value.sealed) ||
      value.admissionOpen && !value.granted) {
    throw new Error('Invalid exact native asset permission state.');
  }
  return value as unknown as NativeAssetPermission;
}
/** Exact optional public telemetry; absence stays absence, never a zero estimate. */
function readUsage(value:unknown,report=false):void {
  const keys=['source','continuity','total','last','modelContextWindow',...(report?['threadId','turnId','seq']:[])];
  if(!dataObject(value,keys)||value.source!=='thread/tokenUsage/updated'||!['reported','uncertain'].includes(String(value.continuity)))throw new Error('Invalid exact native usage report.');
  const count=(v:unknown,max=1_000_000_000_000):v is number=>integer(v)&&(v as number)<=max;
  const counters=['totalTokens','inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'];
  const counts=(v:unknown):Record<string,number>=>{
    const optional=dataObject(v)&&Object.hasOwn(v,'cacheWriteInputTokens');
    if(!dataObject(v,[...counters,...(optional?['cacheWriteInputTokens']:[])])||Object.values(v).some(n=>!count(n)))throw new Error('Invalid bounded native usage counts.');
    const c=v as Record<string,number>;
    if(c.totalTokens!<c.inputTokens!+c.outputTokens!||c.cachedInputTokens!+(c.cacheWriteInputTokens??0)>c.inputTokens!||c.reasoningOutputTokens!>c.outputTokens!)throw new Error('Inconsistent native usage counts.');
    return c;
  };
  const total=counts(value.total),last=counts(value.last);
  if(counters.some(key=>last[key]!>total[key]!)||last.cacheWriteInputTokens!==undefined&&total.cacheWriteInputTokens!==undefined&&last.cacheWriteInputTokens>total.cacheWriteInputTokens||!(value.modelContextWindow===null||count(value.modelContextWindow,1_000_000_000))||report&&(!text(value.threadId)||!text(value.turnId)||!integer(value.seq)||value.seq===0))throw new Error('Invalid native usage scope or totals.');
}
const duration=(v:unknown)=>integer(v)&&(v as number)<=31_536_000_000;

export function eventSequence(event: ChatEvent): number {
  const value = event.seq;
  if (!integer(value) || value === 0) throw new Error('Native event sequence is missing or inconsistent.');
  return value as number;
}
function readSnapshot(value: unknown): ChatSnapshot | null {
  if (value === null) return null;
  if (!dataObject(value) || !uuid(value.connectionId) || !['installed-cli','spawned-node-fixture'].includes(String(value.provenance)) || typeof value.connected !== 'boolean' || typeof value.ready !== 'boolean' || !Array.isArray(value.models) || value.models.length > 512 || !Array.isArray(value.operations) || value.operations.length > 128 || !Array.isArray(value.approvals) || value.approvals.length > 16 || !Array.isArray(value.events) || value.events.length > 256 || !integer(value.droppedEvents) || !integer(value.lastEventSeq)) throw new Error('Invalid bounded native snapshot.');
  if(value.mcpIsolation!==undefined&&!['native-config','arcane-only-pending','arcane-only-verified'].includes(String(value.mcpIsolation)))throw new Error('Invalid native MCP isolation evidence.');
  if(Object.hasOwn(value,'rateLimits'))readRateLimits(value.rateLimits);
  if (value.account !== null && (!object(value.account) || !['subscription','signed-out','unsupported'].includes(String(value.account.auth)) || !(value.account.plan === null || text(value.account.plan)) || typeof value.account.requiresOpenaiAuth !== 'boolean')) throw new Error('Invalid native account metadata.');
  const names = new Set<string>();
  const models = value.models;
  for (const model of models) {
    if (!object(model) || !text(model.model) || names.has(model.model) || !text(model.id) || !text(model.displayName) || model.entitlement !== 'unverified' || !Array.isArray(model.efforts) || !model.efforts.length || model.efforts.length > 16 || model.efforts.some(e => !text(e,64)) || new Set(model.efforts).size !== model.efforts.length) throw new Error('Invalid reported model/effort catalogue.');
    names.add(model.model);
    if(Object.hasOwn(model,'inputModalities')&&(!Array.isArray(model.inputModalities)||model.inputModalities.length>3||model.inputModalities.some(x=>!['text','image','audio'].includes(x))||new Set(model.inputModalities).size!==model.inputModalities.length)||
      Object.hasOwn(model,'inputModalitiesSource')&&!['reported','compatibility-default'].includes(String(model.inputModalitiesSource)))throw new Error('Invalid native input modality catalogue.');
  }
  const pair = (p: unknown) => dataObject(p) && text(p.model) && text(p.effort,64) && models.some((m: Model) => m.model === p.model && m.efforts.includes(p.effort as string));
  if (value.selection !== null && !pair(value.selection)) throw new Error('The native selection is absent from the reported catalogue.');
  if (value.thread !== null && (!dataObject(value.thread) || !text(value.thread.threadId) || !(value.thread.sessionId === null || text(value.thread.sessionId)) || !pair(value.thread.selection) || typeof value.thread.configured !== 'boolean' || typeof value.thread.writeGranted !== 'boolean' || !(value.thread.turnId === null || text(value.thread.turnId)) || ![...IDLE,'starting','inProgress','cancelling','unknown'].includes(String(value.thread.turnStatus)))) throw new Error('Invalid exact native thread scope.');
  if(dataObject(value.thread)&&Object.hasOwn(value.thread,'durationMs')&&!duration(value.thread.durationMs))throw new Error('Invalid native thread duration.');
  if(Object.hasOwn(value,'usage')) {
    readUsage(value.usage,true);
    const usage=value.usage as Record<string,unknown>;
    if((usage.seq as number)>(value.lastEventSeq as number)||!dataObject(value.thread)||usage.threadId!==value.thread.threadId)throw new Error('Invalid native usage sequence or thread scope.');
  }
  for (const a of value.approvals) {
    if (!object(a) || !text(a.handle) || !uuid(a.connectionId) || !text(a.threadId) || !text(a.turnId) || !text(a.itemId) || !['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(String(a.method)) || !(text(a.serverRequestId) || typeof a.serverRequestId === 'number' && Number.isSafeInteger(a.serverRequestId)) || !(a.reason === null || typeof a.reason === 'string' && utf8(a.reason) <= 4096) || typeof a.canAccept !== 'boolean' || !integer(a.expiresAt) || !(a.command === null || typeof a.command === 'string' && utf8(a.command) <= 32768) || !(a.cwd === null || text(a.cwd,4096)) || !(a.changes === null || Array.isArray(a.changes) && a.changes.length <= 32)) throw new Error('Invalid bounded native approval.');
    if (Array.isArray(a.changes)) for (const c of a.changes) if (!object(c) || !text(c.path,4096) || !['add','delete','update'].includes(String(c.kind)) || !(c.movePath === null || text(c.movePath,4096)) || typeof c.diff !== 'string' || utf8(c.diff) > 65536) throw new Error('A full file preview exceeded its bound.');
  }
  for (const operation of value.operations) {
    if (!dataObject(operation, ['operationId','method','requestId','threadId','turnId','state','errorCode']) || !text(operation.operationId) || !['thread/start','thread/resume','turn/start','turn/interrupt'].includes(String(operation.method)) ||
        !(operation.requestId===null||integer(operation.requestId)) || !['pending','acknowledged','rejected','unknown','not-sent'].includes(String(operation.state)) ||
        ['threadId','turnId','errorCode'].some(key=>!(operation[key]===null||text(operation[key])))) throw new Error('Invalid native operation lifecycle.');
  }
  let previous = 0;
  for (const event of value.events) {
    if (!object(event) || typeof event.type !== 'string') throw new Error('Invalid native event.');
    const seq = eventSequence(event as unknown as ChatEvent);
    if (seq <= previous || seq > (value.lastEventSeq as number)) throw new Error('Native event sequence is unordered.');
    previous = seq;
    if (event.type === 'delta' && (!text(event.threadId) || !text(event.turnId) || !text(event.itemId) || typeof event.text !== 'string' || utf8(event.text) > 1048576)) throw new Error('Invalid public native message delta.');
    if(event.type==='usage') {
      if(!dataObject(event,['type','seq','threadId','turnId','usage'])||!text(event.threadId)||!text(event.turnId))throw new Error('Invalid native usage event scope.');
      readUsage(event.usage);
    }
    if(Object.hasOwn(event,'durationMs')&&(event.type!=='turn'||!duration(event.durationMs)))throw new Error('Invalid native turn duration.');
    if(event.type==='turn'&&(!dataObject(event,['type','seq','threadId','turnId','status',...(Object.hasOwn(event,'durationMs')?['durationMs']:[])])||!text(event.threadId)||!text(event.turnId)||!text(event.status,64)))throw new Error('Invalid exact native turn event.');
  }
  return value as unknown as ChatSnapshot;
}
function readActionRecord(value: unknown): ChatActionRecord {
  const rotated=dataObject(value)&&Object.hasOwn(value,'nextConnectionId');
  const references=dataObject(value)&&Object.hasOwn(value,'references');
  if (!dataObject(value, ['requestId','action','connectionId','state','errorCode','threadId','turnId','model','effort','createdAt','finishedAt',...(rotated?['nextConnectionId']:[]),...(references?['references']:[])]) || !uuid(value.requestId) || !ACTIONS.includes(String(value.action)) || !(value.connectionId === null || uuid(value.connectionId)) || !['pending','acknowledged','rejected','unknown'].includes(String(value.state)) || rotated&&(!['turn-start','task-focus'].includes(String(value.action))||!uuid(value.nextConnectionId)||value.nextConnectionId===value.connectionId)) throw new Error('Invalid native action receipt.');
  if(references){
    if(value.action!=='turn-start'||!Array.isArray(value.references)||!value.references.length||value.references.length>4)throw new Error('Invalid image reference receipt.');
    let bytes=0,pixels=0;const names=new Set<string>();
    for(const image of value.references){if(!dataObject(image,['name','bytes','width','height','sha256'])||!text(image.name,128)||names.has(image.name)||
      !integer(image.bytes)||!image.bytes||!integer(image.width)||!image.width||(image.width as number)>4096||!integer(image.height)||!image.height||(image.height as number)>4096||
      !/^[a-f0-9]{64}(?![\s\S])/.test(String(image.sha256)))throw new Error('Invalid image reference metadata.');
      names.add(image.name);bytes+=image.bytes as number;pixels+=(image.width as number)*(image.height as number);}
    if(bytes>512*1024||pixels>8_000_000)throw new Error('Image receipt exceeds its bounds.');
  }
  for (const key of ['threadId','turnId','model','effort','errorCode']) if (!(value[key] === null || text(value[key], key === 'effort' ? 64 : 256))) throw new Error('Invalid native action receipt metadata.');
  if (!text(value.createdAt,64) || !Number.isFinite(Date.parse(value.createdAt)) || !(value.finishedAt === null || text(value.finishedAt,64) && Number.isFinite(Date.parse(value.finishedAt)))) throw new Error('Invalid native action receipt timestamps.');
  if (['grant-assets','revoke-assets'].includes(String(value.action)) && (!uuid(value.connectionId) || !text(value.threadId))) throw new Error('Invalid exact native asset action receipt scope.');
  return value as unknown as ChatActionRecord;
}
export function readCodexState(value: unknown): ChatState {
  if (!dataObject(value) || value.provider !== 'codex' || value.use !== 'personal-local' || !text(value.projectPath,4096) || typeof value.connecting !== 'boolean' || typeof value.closing !== 'boolean' || typeof value.busy !== 'boolean' || !(value.displayLimited===undefined||value.displayLimited===true) || !Array.isArray(value.actions) || value.actions.length > 100 || !dataObject(value.nativeTools, ['configured','verified']) || typeof value.nativeTools.configured !== 'boolean' || value.nativeTools.verified !== false) throw new Error('Invalid human-only native workflow state.');
  const allowed = ['provider','use','projectPath','connecting','closing','busy','snapshot','lastSnapshot','actions','nativeTools','nativeAssets','nativeHistory','nativeThreads','workflowModel','displayLimited','chatTasks'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected native workflow state field.');
  if (Object.hasOwn(value, 'nativeAssets')) readNativeAssets(value.nativeAssets);
  readSnapshot(value.snapshot); readSnapshot(value.lastSnapshot);
  if(Object.hasOwn(value,'chatTasks')){
    if(!Array.isArray(value.chatTasks)||value.chatTasks.length>256)throw new Error('Invalid bounded conversation task state.');
    const ids=new Set<string>();
    for(const task of value.chatTasks){
      if(!dataObject(task,['taskId','threadId','sessionId','connectionId','state','round','reason','reportDigest',...(dataObject(task)&&Object.hasOwn(task,'retained')?['retained']:[])])||Object.hasOwn(task,'retained')&&typeof task.retained!=='boolean'||!uuid(task.taskId)||ids.has(task.taskId)||!text(task.threadId)||!(task.sessionId===null||text(task.sessionId))||!uuid(task.connectionId)||
        !['working','awaiting_verification','repair_queued','repairing','verified','failed','cancelled','paused','unknown'].includes(String(task.state))||![0,1].includes(task.round as number)||!(task.reason===null||text(task.reason))||!(task.reportDigest===null||typeof task.reportDigest==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(task.reportDigest)))throw new Error('Invalid exact conversation task summary.');
      ids.add(task.taskId);
    }
  }
  if (value.nativeHistory !== undefined && value.nativeHistory !== null) {
    const binding = value.nativeHistory;
    const historyId = (id: unknown) => text(id) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id);
    if (!object(binding) || binding.projectPath !== value.projectPath || !historyId(binding.threadId) ||
        !(binding.sessionId === null || historyId(binding.sessionId)) || !(binding.recorded === null || object(binding.recorded))) {
      throw new Error('Invalid exact recorded native conversation binding.');
    }
  }
  if (value.nativeThreads !== undefined) {
    if (!Array.isArray(value.nativeThreads)||value.nativeThreads.length>256) throw new Error('Invalid bounded saved native chat catalogue.');
    const seen = new Set<string>(), historyId=(v:unknown)=>text(v)&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);
    for(const row of value.nativeThreads) {
      if(!dataObject(row,['provider','projectPath','threadId','sessionId','selection'])||row.provider!=='codex'||row.projectPath!==value.projectPath||!historyId(row.threadId)||!(row.sessionId===null||historyId(row.sessionId))||seen.has(row.threadId as string)||
        !(row.selection===null||dataObject(row.selection,['model','effort'])&&text(row.selection.model)&&text(row.selection.effort,64)))throw new Error('Invalid exact saved native chat identity.');
      seen.add(row.threadId as string);
    }
  }
  if (value.workflowModel !== undefined && value.workflowModel !== null) {
    const proof=value.workflowModel, snapshot=value.snapshot as ChatSnapshot|null, thread=snapshot?.thread;
    const keys=['version','source','projectPath','connectionId','threadId','sessionId','provenance','selection','entitlement'];
    const selected=object(proof)&&object(proof.selection)?proof.selection:null;
    if (!object(proof)||Object.keys(proof).length!==keys.length||keys.some(k=>!Object.hasOwn(proof,k))||proof.version!==1||proof.source!=='active-native-thread-catalogue'||
        proof.projectPath!==value.projectPath||value.displayLimited===true||value.connecting||value.closing||!snapshot?.connected||!snapshot.ready||!thread?.configured||proof.connectionId!==snapshot.connectionId||proof.threadId!==thread.threadId||proof.sessionId!==thread.sessionId||
        proof.provenance!==snapshot.provenance||proof.entitlement!=='unverified'||!selected||Object.keys(selected).sort().join(',')!=='connectionRevision,effort,model,provider'||selected.provider!=='codex'||
        typeof selected.connectionRevision!=='string'||!/^[a-f0-9]{64}$/.test(selected.connectionRevision)||selected.model!==thread.selection.model||selected.effort!==thread.selection.effort||
        !text(selected.model,160)||!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(String(selected.effort))||
        !snapshot.models.some(m=>m.model===selected.model&&m.efforts.includes(selected.effort as string)))throw new Error('Invalid host-attested active native model.');
  }
  const ids = new Set<string>();
  for (const action of value.actions) { const r = readActionRecord(action); if (ids.has(r.requestId)) throw new Error('Duplicate native action receipt.'); ids.add(r.requestId); }
  if (value.nativeAssets === null) { const { nativeAssets: unsupported, ...compatible } = value; return compatible as unknown as ChatState; }
  return value as unknown as ChatState;
}
export function prepareCodexAction(state: ChatState | null, action: string, fields: Record<string, unknown> = {}, requestId: string = crypto.randomUUID()): ChatAction {
  if (!uuid(requestId) || !ACTIONS.includes(action)) throw new Error('Choose an explicit native action and UUID request ID.');
  const accepted: Record<string, string[]> = { connect: [], disconnect: [], select:['model','effort'], 'thread-start':[], 'thread-resume':['threadId'], 'grant-writes':['threadId'], 'revoke-writes':['threadId'], 'grant-assets':['threadId'], 'revoke-assets':['threadId'], 'turn-start':['threadId','text'], 'turn-interrupt':['threadId','turnId'], 'task-stop':['threadId','taskId'], 'task-focus':['threadId','taskId'], approval:['threadId','turnId','handle','decision'], 'history-load':['threadId'] };
  const optional = action==='turn-start'?['allowAssets','allowWorkspaceWrites','references']:action==='disconnect'?['preserveAssetWork']:[];
  const keys = [...accepted[action]!, ...optional.filter(key=>Object.hasOwn(fields,key))];
  if (!dataObject(fields, keys)) throw new Error('Native action fields must match the exact browser envelope.');
  if (action==='disconnect' && Object.hasOwn(fields,'preserveAssetWork') && typeof fields.preserveAssetWork!=='boolean')
    throw new Error('Connection retirement intent requires a boolean.');
  if (action==='turn-start' && Object.hasOwn(fields,'allowWorkspaceWrites') && typeof fields.allowWorkspaceWrites!=='boolean')
    throw new Error('Send workspace permission requires a boolean.');
  if (action==='turn-start' && Object.hasOwn(fields,'allowAssets') &&
      (typeof fields.allowAssets!=='boolean' || fields.allowAssets && !state?.nativeAssets?.available))
    throw new Error('Send asset permission requires a boolean and an available managed asset capability.');
  if (action === 'grant-assets' || action === 'revoke-assets') {
    if (state) readCodexState(state);
    const assets = state?.nativeAssets, snapshot = state?.snapshot, thread = snapshot?.thread;
    if (!assets?.available || !assets.sealed || state?.connecting || state?.closing ||
        !snapshot?.connected || !snapshot.ready || !thread?.configured || fields.threadId !== thread.threadId ||
        action === 'grant-assets' && (state?.displayLimited || state?.busy || !IDLE.includes(thread.turnStatus))) {
      throw new Error('An available sealed asset capability and exact configured live native thread are required.');
    }
  }
  const s = state?.snapshot;
  if (action !== 'connect' && !s) throw new Error('An exact reported native connection is required.');
  if (action === 'select' && (!text(fields.model) || !text(fields.effort,64) || !s!.models.some(m => m.model === fields.model && m.efforts.includes(fields.effort as string)))) throw new Error('Choose an exact reported model and effort; there is no fallback.');
  for (const key of ['threadId','turnId','handle']) if (key in fields && !text(fields[key])) throw new Error('Enter an exact bounded scope ID.');
  if(action==='task-stop'&&(!uuid(fields.taskId)||!state?.chatTasks?.some(task=>task.taskId===fields.taskId&&task.threadId===s?.thread?.threadId&&task.sessionId===s.thread.sessionId&&fields.threadId===task.threadId)))throw new Error('Choose the exact owned task in this conversation.');
  if(action==='task-focus'&&(!uuid(fields.taskId)||!state?.chatTasks?.some(task=>task.taskId===fields.taskId&&task.threadId===fields.threadId&&task.retained===true&&state.nativeThreads?.some(saved=>saved.threadId===task.threadId&&saved.sessionId===task.sessionId))))throw new Error('Choose the exact retained task in a saved conversation.');
  if (action === 'turn-start' && (typeof fields.text !== 'string' || !fields.text.trim() || utf8(fields.text) > CODEX_INPUT_BYTES)) throw new Error('Submit nonempty text of at most 128 KiB in UTF-8.');
  if(action==='turn-start'&&Object.hasOwn(fields,'references')){
    const refs=fields.references;
    if(!Array.isArray(refs)||!refs.length||refs.length>4||refs.some(image=>!dataObject(image,['name','dataUrl'])||!text(image.name,128)||typeof image.dataUrl!=='string'||image.dataUrl.length>699074||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}(?![\s\S])/.test(image.dataUrl)))throw new Error('Choose bounded PNG references from the attachment picker.');
    const model=s!.models.find(row=>row.model===s!.thread?.selection.model);
    if(!model||model.inputModalities&&!model.inputModalities.includes('image'))throw new Error('The selected model does not advertise image input.');
    fields={...fields,references:Object.freeze(refs.map(image=>Object.freeze({name:image.name as string,dataUrl:image.dataUrl as string})))};
    if(utf8(JSON.stringify({requestId,connectionId:s!.connectionId,action,...fields}))>1_000_000)throw new Error('The complete message and PNG references are too large. Reduce the message or references; your draft is retained.');
  }
  if (action === 'approval' && !['accept','decline','cancel'].includes(String(fields.decision))) throw new Error('Choose one explicit approval decision.');
  return { requestId, connectionId: action === 'connect' ? null : s!.connectionId, action, ...fields } as ChatAction;
}

export class CodexHttpError extends Error {
  constructor(message: string, readonly unknown: boolean) { super(message); }
}
/** Exact public quota shape; raw provider account/configuration objects never enter the view. */
function readRateLimits(value:unknown):void {
  const reasons=['rate_limit_reached','workspace_owner_credits_depleted','workspace_member_credits_depleted','workspace_owner_usage_limit_reached','workspace_member_usage_limit_reached'];
  const label=(v:unknown)=>v===null||text(v,160)&&!!v.trim()&&!/[\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(v)&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
  const count=(v:unknown,max:number)=>integer(v)&&(v as number)<=max;
  const window=(v:unknown)=>v===null||dataObject(v,['usedPercent','windowDurationMins','resetsAt'])&&typeof v.usedPercent==='number'&&Number.isFinite(v.usedPercent)&&v.usedPercent>=0&&v.usedPercent<=1_000_000&&
    (v.windowDurationMins===null||count(v.windowDurationMins,5_256_000)&&(v.windowDurationMins as number)>0)&&(v.resetsAt===null||count(v.resetsAt,253_402_300_799));
  if(!dataObject(value,['source','observedAt','ordinaryUsageAllowed','buckets'])||!['account/rateLimits/read','account/rateLimits/updated'].includes(String(value.source))||
    !count(value.observedAt,253_402_300_799_000)||!(value.ordinaryUsageAllowed===null||typeof value.ordinaryUsageAllowed==='boolean')||
    value.source==='account/rateLimits/updated'&&value.ordinaryUsageAllowed===true||!Array.isArray(value.buckets)||!value.buckets.length||value.buckets.length>16)throw new Error('Invalid reported account usage.');
  const ids=new Set<unknown>();
  for(const row of value.buckets){
    if(!dataObject(row,['limitId','limitName','normalModelSlug','primary','secondary','credits','spendControlReached','rateLimitReachedType'])||
      !label(row.limitId)||!label(row.limitName)||!label(row.normalModelSlug)||ids.has(row.limitId)||!window(row.primary)||!window(row.secondary)||
      !(row.credits===null||dataObject(row.credits,['hasCredits','unlimited'])&&typeof row.credits.hasCredits==='boolean'&&typeof row.credits.unlimited==='boolean')||
      !(row.spendControlReached===null||typeof row.spendControlReached==='boolean')||!(row.rateLimitReachedType===null||reasons.includes(String(row.rateLimitReachedType))))throw new Error('Invalid bounded account usage bucket.');
    ids.add(row.limitId);
  }
}
export function codexRateLimitDisplay(snapshot:ChatSnapshot|null):{status:string;rows:string[]} {
  const report=snapshot?.rateLimits;
  if(!report)return{status:'Usage limits appear when the provider reports them. Refresh usage to request a current snapshot.',rows:[]};
  readRateLimits(report);
  const observed=new Date(report.observedAt).toLocaleString(),live=snapshot.connected&&snapshot.ready&&snapshot.account?.auth==='subscription';
  const availability=report.ordinaryUsageAllowed===true?'Provider reports included usage available.':report.ordinaryUsageAllowed===false?'Provider reports included usage is blocked.':'Included usage availability needs a full refresh.';
  const reasons:Record<string,string>={rate_limit_reached:'Usage window reached.',workspace_owner_credits_depleted:'Workspace credits depleted. The workspace owner manages credits.',workspace_member_credits_depleted:'Member credits depleted. The workspace owner manages credits.',workspace_owner_usage_limit_reached:'Workspace usage limit reached. The workspace owner manages this limit.',workspace_member_usage_limit_reached:'Member usage limit reached. The workspace owner manages this limit.'};
  const rows=report.buckets.map(row=>{
    const parts=[row.limitName??row.limitId??'Usage bucket'];
    if(row.normalModelSlug)parts.push('Reported model: '+row.normalModelSlug);
    for(const [label,window] of [['Primary',row.primary],['Secondary',row.secondary]] as const)if(window){
      const mins=window.windowDurationMins,duration=mins===null?'':mins%1440===0?' · '+mins/1440+' days':mins%60===0?' · '+mins/60+' hours':' · '+mins+' minutes';
      parts.push(label+duration+': '+window.usedPercent+'% used · '+(window.resetsAt===null?'Reset time not reported':'Reported reset '+new Date(window.resetsAt*1000).toLocaleString()));
    }
    if(!row.primary&&!row.secondary)parts.push('Usage windows not reported.');
    if(row.rateLimitReachedType)parts.push(reasons[row.rateLimitReachedType]!);
    if(row.spendControlReached===true)parts.push('Account spending limit reached.');
    if(row.credits)parts.push(row.credits.unlimited?'Provider reports unlimited workspace credits.':row.credits.hasCredits?'Workspace credits available.':'Workspace credits unavailable.');
    return parts.join('\n');
  });
  return{status:(live?'Last reported ':'Disconnected · last reported ')+observed+'. '+availability,rows};
}
export class CodexChatApi {
  readonly #token: string;
  constructor(token: string, private readonly transport: typeof fetch = fetch, private readonly deadline = 45000) { this.#token = token; }
  safe(value: string): string {
    return value.replaceAll(this.#token || '\0', '[REDACTED]').replace(/\barcane_local_v1_[0-9]+_[a-f0-9]{64}\b/g,'[REDACTED]').replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,'Bearer [REDACTED]').replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g,'[REDACTED]').replace(/("?(?:accessToken|access_token|apiKey|api_key|password|secret)"?\s*[:=]\s*["']?)[^"',;\s]+/gi,'$1[REDACTED]').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'');
  }
  async request(path: '/v1/codex/state' | '/v1/codex/action' | '/v1/codex/reference-turn' | '/v1/codex/usage' | '/v1/codex/proposals', input?: ChatAction|{connectionId:string}|TaskProposalRead, signal?: AbortSignal): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(this.#token)) throw new CodexHttpError('Open the launcher’s human control link.',false);
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted) controller.abort();
    const timer = setTimeout(abort,this.deadline);
    const mutable=!!input&&path!=='/v1/codex/usage'&&path!=='/v1/codex/proposals';
    try {
      const transport = this.transport;
      const response = await transport(path,{method:input?'POST':'GET',headers:{Authorization:'Bearer '+this.#token,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{}),signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
      const reader = response.body?.getReader(); if(!reader) throw new Error('Native response has no JSON body.');
      const chunks: Uint8Array[]=[]; let length=0;
      try { for(;;) {const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>CODEX_STATE_BYTES){await reader.cancel();throw new Error('Native snapshot exceeded 4 MiB.');}chunks.push(part.value);} } finally {reader.releaseLock();}
      const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
      let result:unknown;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('Native response was not valid UTF-8 JSON.');}
      if (mutable && object(result) && object(result.record)) {
        const expected = result.record.state === 'acknowledged' ? 200 : result.record.state === 'rejected' ? 409 : ['pending','unknown'].includes(String(result.record.state)) ? 202 : 0;
        if (response.status !== expected) throw new CodexHttpError('Native HTTP status and acknowledgement state disagree; inspect this request ID.', true);
      }
      if (!response.ok && !(mutable && object(result) && object(result.record))) throw new CodexHttpError('Native request refused (HTTP '+response.status+'). '+(object(result)&&typeof result.error==='string'?this.safe(result.error):'Inspect recorded state.'),mutable&&response.status>=500);
      return result;
    } catch(error) {if(error instanceof CodexHttpError)throw error;throw new CodexHttpError(this.safe(error instanceof Error?error.message:'Native HTTP response unavailable.'),mutable);}
    finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async state(signal?: AbortSignal) { const value=await this.request('/v1/codex/state',undefined,signal); if(!object(value))throw new Error('Missing native state envelope.');return readCodexState(value.state); }
  /** Display-only read of one exact owned task; it never starts or retries work. */
  async proposals(scope:TaskProposalRead,signal?:AbortSignal):Promise<TaskProposalView[]> {
    if(!uuid(scope.connectionId)||!uuid(scope.taskId)||!text(scope.threadId))throw new CodexHttpError('Choose the exact current task.',false);
    const value=await this.request('/v1/codex/proposals',{connectionId:scope.connectionId,threadId:scope.threadId,taskId:scope.taskId},signal);
    try{return readTaskProposals(value,scope.taskId);}catch{throw new CodexHttpError('Proposal response was not recognized.',false);}
  }
  /** Raw bounded display response. The plan card parses it independently; this
   * GET cannot create work, replay a turn or approve evidence. */
  async taskPlan(scope:TaskProposalRead,signal?:AbortSignal):Promise<string>{
    if(!uuid(scope.connectionId)||!uuid(scope.taskId)||!text(scope.threadId)||!/^[a-f0-9]{64}$/.test(this.#token))throw new CodexHttpError('Choose the exact current task.',false);
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(abort,this.deadline);
    try{
      if(controller.signal.aborted)throw new Error('Task plan read was cancelled.');
      const query=new URLSearchParams({connectionId:scope.connectionId,threadId:scope.threadId,taskId:scope.taskId}),transport=this.transport;
      const response=await transport('/v1/codex/task-plan?'+query.toString(),{method:'GET',headers:{Authorization:'Bearer '+this.#token},
        signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
      if(controller.signal.aborted||response.status!==200||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw new Error('Task plan read was unavailable.');
      const reader=response.body?.getReader();if(!reader)throw new Error('Task plan response has no body.');
      const chunks:Uint8Array[]=[];let length=0;
      try{for(;;){const part=await reader.read();if(controller.signal.aborted)throw new Error('Task plan read was cancelled.');if(part.done)break;
        length+=part.value.byteLength;if(length>65536){await reader.cancel();throw new Error('Task plan response exceeded its bound.');}chunks.push(part.value);
      }}finally{reader.releaseLock();}
      if(controller.signal.aborted)throw new Error('Task plan read was cancelled.');
      const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
      return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    }catch(error){throw new CodexHttpError(this.safe(error instanceof Error?error.message:'Task plan unavailable.'),false);}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  /** One human-activated request. Its request ID is never regenerated or resent here. */
  async proposalStart(input:TaskProposalStart,signal?:AbortSignal):Promise<TaskProposalReceipt> {
    const value=await this.request('/v1/codex/action',input as unknown as ChatAction,signal);
    try{return readTaskProposalReceipt(value,input);}catch{throw new CodexHttpError('Proposal acknowledgement was unreadable; it was not resent.',true);}
  }
  async refreshUsage(connectionId:string,signal?:AbortSignal):Promise<void> {
    if(!uuid(connectionId))throw new CodexHttpError('Choose the exact current native connection.',false);
    const value=await this.request('/v1/codex/usage',{connectionId},signal);
    if(!dataObject(value,['state']))throw new CodexHttpError('Account usage response was not recognized.',false);
    const state=readCodexState(value.state);
    if(state.snapshot?.connectionId!==connectionId||!state.snapshot.rateLimits)throw new CodexHttpError('Account usage belongs to a different connection.',false);
  }
  async action(input: ChatAction, signal?: AbortSignal): Promise<{record: ChatActionRecord; replayed: boolean; state: ChatState}> {
    let expectedReferences:readonly {name:string;bytes:number;width:number;height:number;sha256:string}[]|undefined;
    if(input.action==='turn-start'&&input.references){
      // Snapshot before WebCrypto yields. A same-caption replacement cannot
      // change the submitted bytes or the expected acknowledgement underneath us.
      const references=Object.freeze(input.references.map(image=>Object.freeze({name:image.name,dataUrl:image.dataUrl})));
      input={...input,references};
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        expectedReferences=await Promise.race([(async()=>{
          const result=[];let total=0,pixels=0;
          if(!references.length||references.length>4)throw new Error();
          for(const image of references){
            if(signal?.aborted)throw new Error();
            if(!image.dataUrl.startsWith('data:image/png;base64,')||image.dataUrl.length>699074)throw new Error();
            const raw=atob(image.dataUrl.slice(22));if(!raw.length||(total+=raw.length)>512*1024||raw.length<33)throw new Error();
            const bytes=Uint8Array.from(raw,char=>char.charCodeAt(0)),view=new DataView(bytes.buffer),width=view.getUint32(16),height=view.getUint32(20);
            if(!width||!height||width>4096||height>4096||(pixels+=width*height)>8_000_000)throw new Error();
            const digest=await crypto.subtle.digest('SHA-256',bytes);
            result.push({name:image.name,bytes:bytes.length,width,height,sha256:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')});
          }
          return result;
        })(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error()),5000);})]);
        if(signal?.aborted)throw new Error();
      }catch{throw new CodexHttpError('PNG reference verification was cancelled or unavailable. No message was sent.',false);}
      finally{if(timer)clearTimeout(timer);}
    }
    const value=await this.request(input.action==='turn-start'&&input.references?'/v1/codex/reference-turn':'/v1/codex/action',input,signal);
    if(!object(value)||typeof value.replayed!=='boolean')throw new CodexHttpError('Native acknowledgement was unreadable; inspect this request ID.',true);
    try {
    const r=readActionRecord(value.record);
    if(expectedReferences&&(r.references?.length!==expectedReferences.length||r.references.some((image,i)=>{
      const expected=expectedReferences![i]!;return image.name!==expected.name||image.bytes!==expected.bytes||image.width!==expected.width||image.height!==expected.height||image.sha256!==expected.sha256;
    })))throw new CodexHttpError('Image acknowledgement did not match the original reference bytes and order.',true);
    if(r.requestId!==input.requestId||r.action!==input.action||(input.action!=='connect'&&r.connectionId!==input.connectionId)||(input.action==='connect'&&r.state==='acknowledged'&&!uuid(r.connectionId)))throw new CodexHttpError('Native acknowledgement did not match the exact request.',true);
    if ((input.action === 'grant-assets' || input.action === 'revoke-assets' || input.action === 'turn-start') && r.threadId !== input.threadId) throw new CodexHttpError('Native acknowledgement did not match the exact thread.', true);
    const state=readCodexState(value.state);
    if(r.nextConnectionId){const snapshot=state.snapshot??state.lastSnapshot,binding=state.nativeThreads?.find(row=>row.threadId===r.threadId);
      if(!['turn-start','task-focus'].includes(input.action)||!('threadId'in input)||r.threadId!==input.threadId||!snapshot||snapshot.connectionId!==r.nextConnectionId||snapshot.thread?.threadId!==input.threadId||!binding||snapshot.thread.sessionId!==binding.sessionId)
        throw new CodexHttpError('Fresh task acknowledgement changed its exact conversation.',true);}
    return {record:r,replayed:value.replayed,state};
    } catch(error) { if(error instanceof CodexHttpError)throw error;throw new CodexHttpError(this.safe(error instanceof Error?error.message:'Unreadable native acknowledgement.'),true); }
  }
}
export interface ChatMessage { key: string; role: 'human'|'codex'|'tool'; scope: string; text: string; acknowledgement?: string; threadId?: string }
export class CodexTranscript {
  connectionId=''; cursor=0; gaps=0; dropped=0; truncated=false; messages:ChatMessage[]=[];
  reset(id='') {this.connectionId=id;this.cursor=0;this.gaps=0;this.dropped=0;this.truncated=false;this.messages=[];}
  rebind(id:string) {this.connectionId=id;this.cursor=0;this.gaps=0;this.dropped=0;}
  consume(snapshot:ChatSnapshot) {
    if(snapshot.connectionId!==this.connectionId)this.reset(snapshot.connectionId);
    if(snapshot.lastEventSeq<this.cursor)throw new Error('Older native event snapshot discarded; refresh current state.');
    this.dropped=Math.max(this.dropped,snapshot.droppedEvents);
    for(const event of snapshot.events) {
      const seq=eventSequence(event);if(seq<=this.cursor)continue;
      this.gaps+=Math.max(0,seq-this.cursor-1);this.cursor=seq;
      if(event.type!=='delta')continue;
      const key=event.threadId+'\0'+event.turnId+'\0'+event.itemId;
      let message=this.messages.find(m=>m.role==='codex'&&m.key===key);
      if(!message) {message={key,role:'codex',threadId:event.threadId,scope:event.threadId+' · '+event.turnId+' · '+event.itemId,text:''};this.messages.push(message);}
      message.text+=event.text;
      if(utf8(message.text)>65536) {message.text=new TextDecoder().decode(new TextEncoder().encode(message.text).slice(0,65536),{stream:true});this.truncated=true;}
    }
    if(snapshot.lastEventSeq>this.cursor) {this.gaps+=snapshot.lastEventSeq-this.cursor;this.cursor=snapshot.lastEventSeq;}
    while(this.messages.length>128||this.messages.reduce((n,m)=>n+utf8(m.text),0)>DISPLAY_BYTES){this.messages.shift();this.truncated=true;}
  }
}
export function approvalFingerprint(a:Approval):string {
  return JSON.stringify([a.connectionId,a.threadId,a.turnId,a.handle,a.itemId,a.serverRequestId,a.method,a.command,a.cwd,a.changes,a.reason,a.canAccept,a.expiresAt]);
}
function scopedPath(path:string,root:string):boolean {
  let p=path.replaceAll('\\','/'),r=root.replaceAll('\\','/').replace(/\/$/,'');
  if(/^[a-z]:/i.test(r)){p=p.replace(/^[a-z]:/i,x=>x.toLowerCase());r=r.replace(/^[a-z]:/i,x=>x.toLowerCase());}
  if(p.startsWith(r+'/'))p=p.slice(r.length+1);
  return !!p&&!/^\/|^[a-z]:/i.test(p)&&!p.split('/').some(s=>!s||s==='.'||s==='..');
}
export function approvalEligible(state:ChatState|null,a:Approval):boolean {
  const s=state?.snapshot,t=s?.thread;
  if(!s?.connected||!s.ready||!t?.configured||!t.writeGranted||s.account?.auth!=='subscription'||!s.account.requiresOpenaiAuth||!a.canAccept||a.expiresAt<=Date.now()||a.connectionId!==s.connectionId||a.threadId!==t.threadId||a.turnId!==t.turnId||t.turnStatus!=='inProgress')return false;
  if(a.method==='item/commandExecution/requestApproval')return !!a.command&&a.cwd===state!.projectPath;
  return !!a.changes?.length&&a.changes.every(c=>scopedPath(c.path,state!.projectPath)&&(c.movePath===null||scopedPath(c.movePath,state!.projectPath)));
}
/** Append atomically to the existing composer; never submit or change permissions. */
export function appendWorkflowText(doc: Document, value: string): boolean {
  const input=doc.getElementById('codex-composer') as HTMLTextAreaElement|null;
  if(!input||input.tagName!=='TEXTAREA'||typeof value!=='string'||!value.trim()||utf8(value)>64*1024)return false;
  const next=input.value+(input.value?'\n\n':'')+value;
  const raw=input.getAttribute('maxlength'),limit=raw!==null&&/^\d+$/.test(raw)?Number(raw):CODEX_INPUT_BYTES;
  if(next.length>limit||utf8(next)>CODEX_INPUT_BYTES)return false;
  input.value=next;
  const EventType=doc.defaultView?.Event??Event;
  input.dispatchEvent(new EventType('input',{bubbles:true}));input.focus({preventScroll:true});return true;
}

interface Uncertain { input:ChatAction; read:boolean }
interface Confirmation { action:'grant-writes'|'approval'|'review-draft'; fields:Record<string,unknown>; fingerprint:string; connectionId:string; generation:number }
interface ReviewedDraft { context:string; text:string }
export interface ProviderConnectionStatus {
  connected: boolean; ready: boolean; fresh: boolean;
  auth: 'subscription' | 'signed-out' | 'unsupported' | 'unknown';
}
export interface ChatStateView {
  readonly state: ChatState | null; readonly fresh: boolean; readonly switching: boolean;
  readonly activeChat: ChatTabView | null; readonly nativeBoundToActiveChat: boolean;
  readonly conversation: NativeWorkflowConversation | null;
  readonly persistence: 'native'|'native-loading'|'native-error'|'browser-origin'|'memory';
  readonly preferredProvider: 'codex'|'claude';
  readonly preferencesSaved: boolean;
}
export class CodexChat {
  private state:ChatState|null=null;
  private fresh=false; private stopped=false; private generation=0; private readVersion=0;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private readController:AbortController|undefined;
  private usageController:AbortController|undefined;
  private usageNotice='';
  private readonly pending=new Map<string,ChatAction>();
  private readonly uncertain=new Map<string,Uncertain>();
  private readonly transcript=new CodexTranscript();
  private confirmation:Confirmation|null=null;
  private approvalSignature=''; private modelSignature=''; private messageSignature='';
  private selectionSignature=''; private pickerSignature='';
  private readonly pickerCleanup: (() => void)[] = [];
  private reasoningOpen=false;
  private pickerModelsOpen=false;
  private draftDirty=false;
  private draftTimer:ReturnType<typeof setTimeout>|undefined;
  private readonly draftCleanup:(()=>void)[]=[];
  private readonly providerStateListeners = new Set<() => void>();
  private providerStateSignature='';
  private workflowDraftOrigins: WorkflowDraftProvenance[] = [];
  private reviewedDraftTarget: ReviewedDraft | null = null;
  private tabs: ChatTabs | null = null;
  private tabTransition = false;
  private preparingMessage = false;
  private messageLifetime = 0;
  private restoredWorkflowDraft = false;
  private readonly tabDraftContexts = new Map<string,{origins:WorkflowDraftProvenance[];reviewed:ReviewedDraft|null;restored:boolean}>();
  private readonly stateListeners = new Set<()=>void>();
  private contextSignature = '';
  private preferencesLoadingProject: string | null = null;
  private preferenceController: ChatTabsController | null = null;
  private attachments: ChatAttachmentsController | null = null;
  private imageRequest:AbortController|null=null;
  private proposals:TaskProposalPanel|null=null;
  constructor(private readonly doc:Document,private readonly api:CodexChatApi) {}
  /** Presentation-only attachment mount; it creates no native thread or task. */
  enableTextAttachments(controller:ChatAttachmentsController):void {
    this.attachments?.cleanup();this.attachments=controller;
    if(this.stopped)controller.stop();else controller.syncScope();
  }
  /** Only authoritative native state may bind file copies to a conversation. */
  textAttachmentScope():string|null {
    const s=this.snapshot(),active=this.tabs?.active();
    if(this.stopped||!this.fresh||!this.providerAllowsCodex()||this.tabTransition||this.state?.displayLimited||
      !s?.connected||!s.ready||s.account?.auth!=='subscription'||!s.account.requiresOpenaiAuth||
      this.state?.connecting||this.state?.closing||this.tabs&&(!active||active.kind==='native'&&!this.tabs.bound(this.state)))return null;
    return JSON.stringify([this.state?.projectPath,active?.key??null,s.connectionId,
      active?.kind==='draft'?null:s.thread?.threadId??null,active?.kind==='draft'?null:s.thread?.sessionId??null]);
  }
  /** Display-only proposal scope: the latest owned task of the exact bound conversation. */
  taskProposalScope():TaskProposalScope|null {
    const s=this.snapshot(),t=s?.thread,active=this.tabs?.active();
    if(this.stopped||!this.fresh||!this.providerAllowsCodex()||this.tabTransition||this.state?.displayLimited||!s?.connected||!s.ready||
      s.account?.auth!=='subscription'||!s.account.requiresOpenaiAuth||!t?.configured||this.state?.connecting||this.state?.closing||
      this.tabs&&(!active||active.kind!=='native'||!this.tabs.bound(this.state)))return null;
    const task=this.state?.chatTasks?.findLast(row=>row.threadId===t.threadId&&row.sessionId===t.sessionId);
    if(!task||task.connectionId!==s.connectionId)return null;
    return Object.freeze({projectPath:this.state!.projectPath,chatKey:active?.key??null,connectionId:s.connectionId,threadId:t.threadId,sessionId:t.sessionId,taskId:task.taskId,
      active:['working','awaiting_verification','repair_queued','repairing'].includes(task.state),account:JSON.stringify([s.account.auth,s.account.plan]),
      model:t.selection.model,effort:t.selection.effort});
  }
  /** Mount the presentation-only proposal panel beside the conversation text once. */
  enableTaskProposals(options:{pollMs?:number}={}):void {
    if(this.proposals)return;
    this.proposals=TaskProposalPanel.mount(this.doc,this.api,()=>this.taskProposalScope(),listener=>this.subscribeStateChange(listener),options);
  }
  referenceImageInputAvailable():boolean{
    if(this.textAttachmentScope()===null)return false;
    const snapshot=this.snapshot(),pair=this.localPair()??snapshot?.thread?.selection;
    const model=snapshot?.models.find(row=>row.model===pair?.model&&row.efforts.includes(pair.effort));
    return !!model&&(model.inputModalities===undefined||model.inputModalities.includes('image'));
  }
  attachmentPresentationChanged():void {if(!this.stopped)this.renderComposer();}
  private el<T extends HTMLElement=HTMLElement>(id:string) {const e=this.doc.getElementById(id);if(!e)throw new Error('Missing Codex UI '+id);return e as T;}
  private make<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string) {const e=this.doc.createElement(tag);if(text!==undefined)e.textContent=this.api.safe(text);if(className)e.className=className;return e;}
  private text(id:string,value:string){this.el(id).textContent=this.api.safe(value);}
  private value(id:string){return this.el<HTMLInputElement>(id).value;}
  private on(id:string,event:string,fn:(e:Event)=>void){this.el(id).addEventListener(event,fn);}
  private readonly workflowContextListeners = new Set<() => void>();
  /** Parent boot seam: the only dynamic module load; it starts no native action. */
  async enableChatTabs(options: ChatTabsOptions = {}): Promise<void> {
    if(this.tabs)return;
    const module=await import('./chat-tabs.js');
    const preferences=options.preferences??module.workspacePreferencesAdapter(this.doc);
    const tabs=new module.ChatTabs(this.doc,value=>this.api.safe(value),{
      select:key=>this.selectChat(key),close:key=>this.closeChat(key),newChat:()=>this.newChat(),openSaved:id=>this.openSavedChat(id),
    },{...options,...(preferences?{preferences}:{})});
    if(!this.state||!this.fresh)await this.refresh();
    if(!this.state||!this.fresh)throw new Error('Read the canonical project before restoring chat tabs.');
    const project=this.state.projectPath;
    await tabs.initializePreferences(project);
    if(this.state.projectPath!==project||!this.fresh)throw new Error('The project changed while reading chat preferences.');
    if(this.tabs)return;
    this.tabs=tabs;this.syncTabs();tabs.mount();this.loadTabDraft();this.render();this.enableTaskProposals();this.publishState();
    this.preferenceController=module.connectChatTabPreferences(this.doc,this);
    if(tabs.persistenceStatus()==='native-error')this.text('codex-notice','Native chat preferences could not be verified. Local drafts are available; EXE persistence is unavailable.');
  }
  private draftView(tab:ChatTabView|null):ChatTabView|null {
    return tab&&this.draftDirty&&tab.key===this.tabs?.active()?.key?{...tab,draft:this.value('codex-composer'),workflowDraft:!!this.workflowDraftOrigins.length||this.restoredWorkflowDraft}:tab;
  }
  chatTabsView(): readonly ChatTabView[] { return this.safeView((this.tabs?.views()??[]).map(tab=>this.draftView(tab)!)); }
  currentStateView(): ChatStateView {
    const state=this.state?readCodexState(structuredClone(this.state)):null;
    return this.safeView({state,fresh:this.fresh&&!this.stopped,switching:this.tabTransition,activeChat:this.draftView(this.tabs?.active()??null),
      nativeBoundToActiveChat:this.tabs?this.tabs.bound(state):!!state?.snapshot?.thread?.configured,
      conversation:this.workflowConversation(),persistence:this.tabs?.persistenceStatus()??'memory',preferredProvider:this.providerPreference(),preferencesSaved:!this.draftDirty&&(this.tabs?.preferencesSaved()??false)});
  }
  /** Provider presentation preference only; Claude continues through native handoff. */
  setChatProviderPreference(provider:'codex'|'claude'):void {
    if(provider!==this.providerPreference()){this.messageLifetime++;this.imageRequest?.abort();}
    this.flushDraft();this.tabs?.setProviderPreference(provider);this.renderControls();this.publishState();
  }
  private providerPreference():'codex'|'claude' {
    // Before tab hydration completes, the existing provider control can only deny Codex work.
    return this.tabs?.providerPreference()??((this.doc.getElementById('provider-setup-provider') as HTMLSelectElement|null)?.value==='claude'?'claude':'codex');
  }
  private providerAllowsCodex():boolean {return this.providerPreference()==='codex';}
  updateChatPresentation(value:{tool?:ChatTabView['tool'];previewOpen?:boolean}):void {this.flushDraft();this.tabs?.updatePresentation(value);this.publishState();}
  private safeView<T>(value:T):T {
    const copy=JSON.parse(this.api.safe(JSON.stringify(value))) as T;
    const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}};
    freeze(copy);return copy;
  }
  subscribeStateChange(listener:()=>void):()=>void {this.stateListeners.add(listener);return()=>{this.stateListeners.delete(listener);};}
  private publishState():void {
    this.attachments?.syncScope();
    const signature=JSON.stringify([this.state?.projectPath??null,this.tabs?.active()?.key??null,this.workflowConversation(),this.workflowModelSelection()]);
    if(signature!==this.contextSignature){this.contextSignature=signature;for(const listener of this.workflowContextListeners){try{listener();}catch{}}}
    for(const listener of this.stateListeners){try{listener();}catch{}}
  }
  private tabBlockReason(includeTransition=true):string|null {
    const s=this.snapshot(),t=s?.thread;
    if(this.stopped||!this.fresh||!this.state)return 'Refresh native state before changing chats.';
    if(this.tabs?.persistenceStatus()==='native-loading')return 'Wait for the canonical project’s native chat preferences.';
    if(includeTransition&&this.tabTransition||this.pending.size||this.uncertain.size||this.state.busy||this.state.connecting||this.state.closing)return 'Wait for the pending native action and review uncertain receipts before changing chats.';
    if(this.confirmation||this.state.displayLimited||s?.approvals.length)return 'Finish the visible approval or confirmation before changing chats.';
    if(s&&!s.connected||s&&!s.ready||s?.operations.some(op=>op.state==='pending'||op.state==='unknown'))return 'The native connection or operation is unresolved. Review it before changing chats.';
    if(t&&(!t.configured||!IDLE.includes(t.turnStatus)))return 'Stop or finish the active native turn before changing chats.';
    if(t?.writeGranted||this.state.nativeAssets?.granted||this.state.nativeAssets?.admissionOpen)return 'Revoke workspace writes and asset permission before changing chats. Grants belong to this chat only.';
    return null;
  }
  private stashTabDraft():void {
    if(this.draftTimer!==undefined)clearTimeout(this.draftTimer);this.draftTimer=undefined;this.draftDirty=false;
    const active=this.tabs?.active();if(!active)return;
    this.tabs!.updateDraft(this.value('codex-composer'),active.kind==='draft'?active.selection:undefined,!!this.workflowDraftOrigins.length||this.restoredWorkflowDraft);
    // Compatibility seam for the independently owned tab persistence debounce.
    const persistence=this.tabs as ChatTabs&{flushPreferences?:()=>void};
    if(persistence.flushPreferences)persistence.flushPreferences();else persistence.updatePresentation({});
    this.tabDraftContexts.set(active.key,{origins:structuredClone(this.workflowDraftOrigins),reviewed:this.reviewedDraftTarget,restored:this.restoredWorkflowDraft});
  }
  private flushDraft():void {if(this.draftDirty)this.stashTabDraft();}
  private composerInput():void {
    if(this.stopped)return;
    if(!this.value('codex-composer'))this.clearDraftOrigins();
    this.renderComposer();
    this.draftDirty=true;
    if(this.draftTimer!==undefined)clearTimeout(this.draftTimer);
    this.draftTimer=setTimeout(()=>{this.draftTimer=undefined;this.flushDraft();this.publishState();},CODEX_DRAFT_SAVE_DELAY_MS);
  }
  private bindDraftLifecycle():void {
    if(this.draftCleanup.length||typeof this.doc.addEventListener!=='function')return;
    const listen=(target:EventTarget,type:string,fn:()=>void)=>{target.addEventListener(type,fn);this.draftCleanup.push(()=>target.removeEventListener(type,fn));};
    listen(this.doc,'visibilitychange',()=>{if(this.doc.hidden)this.flushDraft();});
    if(this.doc.defaultView)listen(this.doc.defaultView,'pagehide',()=>this.flushDraft());
  }
  private localPair():ChatSelection|null {
    const model=this.value('codex-model'),effort=this.value('codex-effort');
    return this.snapshot()?.models.some(row=>row.model===model&&row.efforts.includes(effort))?{model,effort}:null;
  }
  private loadTabDraft():void {
    const active=this.tabs?.active();if(!active)return;
    this.el<HTMLTextAreaElement>('codex-composer').value=active.draft;
    const context=this.tabDraftContexts.get(active.key);
    this.workflowDraftOrigins=structuredClone(context?.origins??[]);this.reviewedDraftTarget=context?.reviewed??null;
    this.restoredWorkflowDraft=context?.restored??active.workflowDraft;
    this.selectionSignature='';this.messageSignature='';this.closePicker();
  }
  private syncTabs():void {
    if(!this.tabs||!this.state)return;
    this.flushDraft(); // Persist the outgoing tab before sync can change its project/key.
    const before=this.tabs.active(),initial=this.value('codex-composer');
    const s=this.snapshot(),t=s?.thread;
    const attention=!!t&&(!t.configured||!IDLE.includes(t.turnStatus)||t.writeGranted||!!s?.approvals.length||!!this.state.nativeAssets?.granted);
    if(!this.tabTransition&&attention)this.stashTabDraft();
    const changed=this.tabs.sync(this.state,!this.tabTransition&&attention);
    if(!before&&initial&&!this.tabs.active()?.draft)this.tabs.updateDraft(initial);
    if(changed)this.loadTabDraft();
    if(this.tabs.needsNativePreferences(this.state.projectPath)&&this.preferencesLoadingProject!==this.state.projectPath) {
      const tabs=this.tabs,project=this.state.projectPath;this.preferencesLoadingProject=project;
      void tabs.initializePreferences(project).then(()=>{
        if(this.stopped||this.tabs!==tabs||this.state?.projectPath!==project)return;
        tabs.reloadPreferences(this.state);this.loadTabDraft();this.render();this.publishState();
      }).finally(()=>{if(this.preferencesLoadingProject===project)this.preferencesLoadingProject=null;});
    }
  }
  async newChat():Promise<boolean> {
    if(!this.tabs||this.preparingMessage)return false;
    const blocked=this.tabBlockReason();if(blocked){this.text('codex-notice',blocked);return false;}
    this.stashTabDraft();if(!this.tabs.createDraft()){this.text('codex-notice','Close an open tab before creating another draft. Saved native history is retained.');return false;}
    this.loadTabDraft();this.render();this.publishState();this.el('codex-composer').focus({preventScroll:true});return true;
  }
  async selectChat(key:string):Promise<boolean> {
    if(this.preparingMessage)return false;
    const target=this.tabs?.views().find(row=>row.key===key);if(!target)return false;
    if(this.tabs!.active()?.key===key&&(target.kind==='draft'||this.tabs!.bound(this.state)))return true;
    const blocked=this.tabBlockReason();if(blocked){this.text('codex-notice',blocked);return false;}
    this.stashTabDraft();
    if(target.kind==='native'&&!this.tabs!.owns(target))return false;
    if(target.kind==='native'&&!(this.state?.snapshot?.thread?.configured&&this.state.snapshot.thread.threadId===target.threadId&&this.state.snapshot.thread.sessionId===target.sessionId)) {
      if(!target.selection){this.text('codex-notice','This saved chat has no recorded model choice. Choose an exact reported model and effort before resuming it.');return false;}
      if(!await this.bindNativeChat('thread-resume',target.selection,target.threadId!))return false;
    }
    if(this.state?.projectPath!==target.projectPath||target.kind==='native'&&!this.tabs!.owns(target))return false;
    this.flushDraft(); // Capture edits made while the explicit native resume was awaiting a receipt.
    if(!this.tabs!.activate(key))return false;
    this.loadTabDraft();this.render();this.publishState();return true;
  }
  async closeChat(key:string):Promise<boolean> {
    if(this.preparingMessage||!this.tabs||!this.tabs.views().some(row=>row.key===key))return false;
    if(this.tabs.active()?.key===key) {
      const blocked=this.tabBlockReason();if(blocked){this.text('codex-notice',blocked);return false;}
      const next=this.tabs.views().find(row=>row.key!==key);
      if(next){if(!await this.selectChat(next.key))return false;}else if(!await this.newChat())return false;
    }
    const closed=this.tabs.remove(key);if(closed)this.tabDraftContexts.delete(key);
    this.render();this.publishState();return closed;
  }
  async openSavedChat(threadId:string):Promise<boolean> {
    if(this.preparingMessage||!this.tabs||!this.tabs.saved().some(row=>row.threadId===threadId))return false;
    const blocked=this.tabBlockReason();if(blocked){this.text('codex-notice',blocked);return false;}
    const target=this.tabs.ensureSaved(threadId);if(!target){this.text('codex-notice','Close an open tab before opening another saved chat.');return false;}
    // A restored active tab still needs an explicit native resume after daemon/EXE restart.
    if(this.tabs.active()?.key===target.key&&!this.tabs.bound(this.state)) {
      if(!target.selection)return false;
      const bound=await this.bindNativeChat('thread-resume',target.selection,target.threadId!);this.render();this.publishState();return bound;
    }
    const selected=await this.selectChat(target.key);this.render();this.publishState();return selected;
  }
  async startCurrentChat():Promise<boolean> {
    if(!this.tabs||this.tabs.active()?.kind!=='draft'||!this.canStartThread())return false;
    this.stashTabDraft();const pair=this.localPair();return !!pair&&await this.bindNativeChat('thread-start',pair);
  }
  private async bindNativeChat(action:'thread-start'|'thread-resume',selection:ChatSelection,threadId?:string):Promise<boolean> {
    if(!this.providerAllowsCodex()){this.text('codex-notice','Choose Codex to open this saved chat. Claude Code uses its native handoff.');return false;}
    const lifetime=this.messageLifetime,originProject=this.state?.projectPath,provider=this.providerPreference(),source=this.tabs?.active();
    const sameNavigation=()=>this.messageLifetime===lifetime&&this.state?.projectPath===originProject&&this.providerPreference()===provider;
    const sameSource=()=>{const current=this.tabs?.active();return !!source&&!!current&&current.localId===source.localId&&current.key===source.key&&
      current.kind===source.kind&&current.projectPath===source.projectPath&&current.threadId===source.threadId&&current.sessionId===source.sessionId;};
    await this.refresh();const project=this.state?.projectPath;
    if(!sameNavigation()||!sameSource())return false;
    const blocked=this.tabBlockReason();if(!project||blocked){if(blocked)this.text('codex-notice',blocked);return false;}
    const saved=this.state?.nativeThreads?.find(row=>row.threadId===threadId),retained=action==='thread-resume'?this.state?.chatTasks?.filter(task=>task.retained===true&&task.threadId===threadId&&task.sessionId===saved?.sessionId)??[]:[];
    if(retained.length>1){this.text('codex-notice','Multiple retained task owners require review before opening this conversation.');return false;}
    if(!retained.length&&this.snapshot()&&!this.snapshot()!.models.some(row=>row.model===selection.model&&row.efforts.includes(selection.effort))){this.text('codex-notice','The saved model and effort are absent from the current catalogue. No fallback was selected.');return false;}
    this.tabTransition=true;this.render();this.publishState();
    const exact=()=>sameNavigation()&&this.state?.projectPath===project&&this.fresh&&!this.stopped&&this.providerAllowsCodex();
    const perform=async(name:string,fields:Record<string,unknown>={})=>{if(!exact())return false;const receipt=await this.dispatch(name,fields,true);return exact()&&receipt?.state==='acknowledged';};
    let historyLimited=false,historyHadRecording=false;
    try {
      if(retained.length===1){
        if(!this.snapshot()&&!await perform('connect'))return false;
        if(!await perform('task-focus',{threadId,taskId:retained[0]!.taskId}))return false;
        const live=this.snapshot()?.thread;if(!live?.configured||live.threadId!==threadId||live.sessionId!==saved?.sessionId)return false;
        if(IDLE.includes(live.turnStatus))await perform('history-load',{threadId:live.threadId});
        return exact();
      }
      const oldConnection=this.snapshot()?.connectionId,old=this.snapshot()?.thread;
      if(old?.configured&&this.state?.nativeHistory?.threadId===old.threadId) {
        const receipt=exact()?await this.dispatch('history-load',{threadId:old.threadId},true):undefined;
        if(!exact())return false;
        if(receipt?.state!=='acknowledged') {
          const live=this.snapshot(),savedOld=this.state?.nativeThreads?.find(row=>row.threadId===old.threadId&&row.sessionId===old.sessionId&&row.projectPath===project),binding=this.state?.nativeHistory;
          const recorded=this.state?.actions.find(row=>row.requestId===receipt?.requestId);
          // A terminal display-size refusal is not a successful read. It may
          // release only this outgoing navigation gate after fresh exact scope
          // and every ordinary navigation blocker have been checked again.
          if(!receipt||receipt.action!=='history-load'||receipt.connectionId!==oldConnection||receipt.threadId!==old.threadId||receipt.state!=='rejected'||receipt.errorCode!=='FRAME_LIMIT'||receipt.finishedAt===null||
            !recorded||recorded.action!==receipt.action||recorded.connectionId!==receipt.connectionId||recorded.threadId!==receipt.threadId||recorded.state!==receipt.state||recorded.errorCode!==receipt.errorCode||recorded.finishedAt!==receipt.finishedAt||
            !sameSource()||this.tabBlockReason(false)||live?.connectionId!==oldConnection||!live.thread?.configured||live.thread.threadId!==old.threadId||live.thread.sessionId!==old.sessionId||
            live.thread.selection.model!==old.selection.model||live.thread.selection.effort!==old.selection.effort||live.account?.auth!=='subscription'||!live.account.requiresOpenaiAuth||
            !savedOld||!binding||binding.projectPath!==project||binding.threadId!==old.threadId||binding.sessionId!==old.sessionId)return false;
          historyLimited=true;
          historyHadRecording=binding.recorded!==null;
        }
      }
      if(this.snapshot()?.thread&&!await perform('disconnect',{preserveAssetWork:true}))return false;
      if(!this.snapshot()&&!await perform('connect'))return false;
      if(!this.snapshot()?.models.some(row=>row.model===selection.model&&row.efforts.includes(selection.effort))){this.text('codex-notice','The reconnect catalogue no longer contains this exact model and effort. Choose explicitly; no fallback was used.');return false;}
      if(!await perform('select',{...selection}))return false;
      if(action==='thread-resume'&&!this.tabs?.saved().some(row=>row.threadId===threadId&&row.projectPath===project))return false;
      if(!await perform(action,action==='thread-resume'?{threadId}:{}))return false;
      const live=this.snapshot()?.thread;
      if(!live?.configured||live.writeGranted||this.state?.nativeAssets?.granted||action==='thread-resume'&&live.threadId!==threadId)return false;
      if(action==='thread-start') {
        const draft=this.tabs?.active();
        if(!this.tabs?.bindDraft(this.state!))return false;
        if(draft){const context=this.tabDraftContexts.get(draft.key);if(context)this.tabDraftContexts.set(this.tabs.active()!.key,context);this.tabDraftContexts.delete(draft.key);}
      }
      // A newly created conversation has no prior history to load. Saved chats
      // still load their public history as part of the explicit open gesture.
      const targetHistoryReady=action==='thread-start'||!IDLE.includes(live.turnStatus)||await perform('history-load',{threadId:live.threadId});
      if(historyLimited&&targetHistoryReady&&exact())this.text('codex-notice',historyHadRecording
        ?'Opened this conversation. The previous conversation\u2019s history exceeded the display limit; its earlier recording and unsent draft were retained.'
        :'Opened this conversation. The previous conversation\u2019s history exceeded the display limit; no earlier recording was available. Your unsent draft was retained.');
      return exact();
    } finally {this.tabTransition=false;this.syncTabs();this.render();this.publishState();}
  }
  /** Presentation metadata only, from validated state; unknown is never signed-out. */
  providerConnectionStatus(): ProviderConnectionStatus | null {
    if (!this.state) return null;
    const snapshot = this.snapshot();
    return { connected: snapshot?.connected === true, ready: snapshot?.ready === true,
      fresh: this.fresh && !this.stopped, auth: snapshot?.account?.auth ?? 'unknown' };
  }
  /** User-requested startup connection discovery; never starts a chat or model turn. */
  async connectForSavedLogin(): Promise<void> {
    if(this.stopped||!this.providerAllowsCodex())return;
    await this.refresh();
    if(this.stopped||!this.providerAllowsCodex()||!this.fresh||this.snapshot()||this.pending.size||this.uncertain.size||this.state?.busy||this.state?.connecting||this.state?.closing)return;
    await this.dispatch('connect');
  }
  subscribeProviderStateChange(listener: () => void): () => void {
    this.providerStateListeners.add(listener);
    return () => { this.providerStateListeners.delete(listener); };
  }
  private publishProviderState() {
    const signature = JSON.stringify(this.providerConnectionStatus());
    if (signature === this.providerStateSignature) return;
    this.providerStateSignature = signature;
    // A presentation subscriber cannot interrupt the native action lifecycle.
    for (const listener of this.providerStateListeners) { try { listener(); } catch {} }
  }
  subscribeWorkflowContextChange(listener: () => void): () => void {
    this.workflowContextListeners.add(listener);
    return () => { this.workflowContextListeners.delete(listener); };
  }
  workflowConversation(): NativeWorkflowConversation | null {
    if(!this.providerAllowsCodex())return null;
    if(this.tabs) {
      const active=this.tabs.active(),state=this.state;
      if(!active||!state||active.kind!=='native'||!this.tabs.owns(active)||active.projectPath!==state.projectPath)return null;
      const live=state.snapshot?.thread;
      const binding=live?.configured?live:state.nativeHistory;
      return binding?.threadId===active.threadId&&binding.sessionId===active.sessionId?{provider:'codex',projectPath:active.projectPath,threadId:active.threadId!,sessionId:active.sessionId}:null;
    }
    const state = this.state, thread = state?.snapshot?.thread;
    // Match the host's configured-thread precedence and durable history fallback.
    const binding = thread?.configured ? thread : state?.nativeHistory;
    return binding && state ? { provider: 'codex', threadId: binding.threadId, sessionId: binding.sessionId, projectPath: state.projectPath } : null;
  }
  workflowModelSelection(): RequestedModel | null {
    if(!this.providerAllowsCodex())return null;
    if(this.tabs&&!this.tabs.bound(this.state))return null;
    const proof=this.state?.workflowModel;
    return proof ? {...proof.selection} : null;
  }
  /** Host-prepared metadata is context, never a write grant or workflow acceptance. */
  appendWorkflowDraft(value: string, provenance: WorkflowDraftProvenance): boolean {
    const native = this.workflowConversation(), model = this.workflowModelSelection();
    if (!this.fresh || this.stopped || !native || !model || this.workflowDraftOrigins.length >= 20 ||
        provenance.projectPath !== this.state?.projectPath || provenance.conversation.provider !== native.provider ||
        provenance.conversation.threadId !== native.threadId || provenance.conversation.sessionId !== native.sessionId ||
        !sameWorkflowModel(provenance.model,model)) return false;
    const previous = this.workflowDraftOrigins, review = this.reviewedDraftTarget;
    this.workflowDraftOrigins = [...previous, structuredClone(provenance)]; this.reviewedDraftTarget = null;
    if (!appendWorkflowText(this.doc, value)) { this.workflowDraftOrigins = previous; this.reviewedDraftTarget = review; return false; }
    this.renderControls(); return true;
  }
  private draftContextFingerprint():string {
    return JSON.stringify([this.workflowDraftOrigins,this.state?.projectPath??null,this.workflowConversation(),this.workflowModelSelection()]);
  }
  private draftNeedsReview(): boolean {
    if(!this.restoredWorkflowDraft&&!this.workflowDraftOrigins.length)return false;
    if (this.reviewedDraftTarget?.text===this.value('codex-composer')&&this.reviewedDraftTarget.context===this.draftContextFingerprint()) return false;
    if(this.restoredWorkflowDraft)return true;
    if (!this.workflowDraftOrigins.length) return false;
    const native = this.workflowConversation(), model = this.workflowModelSelection();
    return !native || !model || this.workflowDraftOrigins.some(origin => origin.projectPath !== this.state?.projectPath ||
      origin.conversation.provider !== native.provider || origin.conversation.threadId !== native.threadId ||
      origin.conversation.sessionId !== native.sessionId || !sameWorkflowModel(origin.model,model));
  }
  private clearDraftOrigins(): void { this.workflowDraftOrigins = []; this.reviewedDraftTarget = null; this.restoredWorkflowDraft=false; }
  private openDraftReview(): void {
    const thread = this.snapshot()?.thread;
    if (!thread?.configured || !this.normal() || !IDLE.includes(thread.turnStatus) || !this.workflowModelSelection() || !this.draftNeedsReview()) return;
    this.confirmation = { action: 'review-draft', fields: {text:this.value('codex-composer')}, fingerprint: this.draftContextFingerprint(), connectionId: this.snapshot()!.connectionId, generation: this.generation };
    this.text('codex-confirm-title', 'Review this draft for the current conversation');
    this.text('codex-confirm-preview', 'Original workflow context:\n' + JSON.stringify(this.workflowDraftOrigins, null, 2) +
      '\n\nCurrent conversation/model:\n' + JSON.stringify({projectPath: this.state!.projectPath, conversation: this.workflowConversation(), model: this.workflowModelSelection()}, null, 2) +
      '\n\nFull unsent draft:\n' + this.value('codex-composer'));
    this.showConfirmation();
    this.text('codex-confirm-warning', 'This only re-reviews draft text for this conversation. It does not submit a turn, move a workflow, grant writes or accept evidence.');
  }
  private snapshot(){return this.state?.snapshot;}
  private currentTask(){const thread=this.snapshot()?.thread;if(!thread||this.tabs&&!this.tabs.bound(this.state))return null;
    return this.state?.chatTasks?.findLast(task=>task.threadId===thread.threadId&&task.sessionId===thread.sessionId&&['working','awaiting_verification','repair_queued','repairing'].includes(task.state))??null;}
  private stopCurrentTask(){const task=this.currentTask(),thread=this.snapshot()?.thread;
    if(task)void this.dispatch('task-stop',{threadId:task.threadId,taskId:task.taskId});
    else if(thread?.turnId)void this.dispatch('turn-interrupt',{threadId:thread.threadId,turnId:thread.turnId});}
  private assetScope(state = this.state) {
    const s = state?.snapshot, t = s?.thread;
    return JSON.stringify([state?.projectPath, s?.connectionId, s?.connected, s?.ready, t?.threadId, t?.sessionId, t?.configured]);
  }
  private assetEligible(action: 'grant-assets' | 'revoke-assets') {
    const s = this.snapshot(), t = s?.thread, assets = this.state?.nativeAssets;
    if (this.stopped || !this.fresh || this.state?.connecting || this.state?.closing ||
        !s?.connected || !s.ready || !t?.configured || !assets?.available || !assets.sealed) return false;
    if (action === 'revoke-assets') return ![...this.pending.values()].some(p => p.action === action);
    return this.providerAllowsCodex()&&!this.tabTransition&&(!this.tabs||this.tabs.bound(this.state))&&this.normal() && IDLE.includes(t.turnStatus) && !(assets.granted && assets.admissionOpen);
  }
  private bindAssetButton(id: string, action: 'grant-assets' | 'revoke-assets') {
    const button = this.el<HTMLButtonElement>(id);
    let gesture: { scope: string; generation: number } | null = null;
    const capture = () => { gesture = { scope: this.assetScope(), generation: this.generation }; };
    const modified = (input: MouseEvent | KeyboardEvent) => input.altKey || input.ctrlKey || input.metaKey || input.shiftKey;
    this.on(id, 'pointerdown', event => {
      const input = event as PointerEvent;
      gesture = null;
      if (event.isTrusted === true && !event.defaultPrevented && input.button === 0 && !modified(input) && !button.disabled && this.assetEligible(action)) capture();
    });
    this.on(id, 'keydown', event => {
      const input = event as KeyboardEvent;
      if (input.key !== 'Enter' && input.key !== ' ') return;
      gesture = null;
      if (event.isTrusted !== true || input.repeat || modified(input) || button.disabled || !this.assetEligible(action)) event.preventDefault();
      else capture(); // Native button activation produces the trusted click; no separate key dispatch.
    });
    this.on(id, 'click', event => {
      const input = event as MouseEvent, bound = gesture;
      gesture = null;
      if (event.isTrusted !== true || event.defaultPrevented || input.button !== 0 || modified(input) ||
          button.disabled || !this.assetEligible(action) ||
          bound && (bound.generation !== this.generation || bound.scope !== this.assetScope())) return;
      event.preventDefault();
      const thread = this.snapshot()!.thread!;
      void this.dispatch(action, { threadId: thread.threadId });
    });
  }
  private renderAssets() {
    const assets = this.state?.nativeAssets;
    let status = 'Asset jobs are unsupported by this native connection.';
    if (!this.state) status = 'Asset permission has not been read.';
    else if (!this.fresh || this.uncertain.size || this.state.displayLimited) status = 'Asset permission is uncertain. Refresh and review recorded native actions.';
    else if (assets) {
      if (!assets.available) status = 'Asset jobs are unavailable.';
      else if (!assets.sealed) status = 'Asset capability is not sealed. Allowing jobs is disabled.';
      else if (!this.snapshot()?.connected || !this.snapshot()?.ready || this.state.connecting || this.state.closing) status = 'No live native connection. Allowing jobs is disabled.';
      else if (!this.snapshot()?.thread?.configured) status = 'Choose a configured native thread before allowing asset jobs.';
      else status = (assets.granted ? 'Asset permission granted for this thread.' : 'Asset permission not granted for this thread.') +
        (assets.admissionOpen ? ' Job admission is open.' : ' Job admission is closed.');
    }
    if ([...this.pending.values()].some(p => p.action === 'grant-assets' || p.action === 'revoke-assets')) status = 'Asset permission change awaiting native acknowledgement. ' + status;
    this.text('codex-assets-status', status);
    this.el<HTMLButtonElement>('codex-assets-grant').disabled = !this.assetEligible('grant-assets');
    this.el<HTMLButtonElement>('codex-assets-revoke').disabled = !this.assetEligible('revoke-assets');
  }
  private scope(){const s=this.snapshot();return JSON.stringify([s?.connectionId,s?.thread?.threadId,s?.thread?.turnId,this.state?.projectPath,s?.thread?.selection.model,s?.thread?.selection.effort]);}
  private normal(){const s=this.snapshot();return !this.state?.displayLimited&&this.fresh&&!this.stopped&&!this.uncertain.size&&!this.pending.size&&!this.state?.busy&&!this.state?.connecting&&!this.state?.closing&&!!s?.connected&&s.ready;}
  private canSelectModel() {
    if(this.preparingMessage||!this.providerAllowsCodex())return false;
    const snapshot=this.snapshot(),active=this.tabs?.active(),thread=snapshot?.thread;
    if(this.stopped||!this.fresh||this.tabTransition||this.uncertain.size||this.state?.displayLimited||this.state?.connecting||this.state?.closing||
      !snapshot?.connected||!snapshot.ready||snapshot.account?.auth!=='subscription'||!snapshot.account.requiresOpenaiAuth)return false;
    if(this.tabs&&(!active||active.kind==='native'&&!this.tabs.owns(active)))return false;
    if(thread&&!thread.configured)return false;
    if(!this.tabs)return this.normal()&&(!thread||IDLE.includes(thread.turnStatus));
    // During a task or before a saved chat is resumed, changes are advisory
    // preferences for the next user Send; no native operation starts here.
    return true;
  }
  private canStartConversation() {
    if(!this.providerAllowsCodex())return false;
    const snapshot = this.snapshot();
    if(this.tabs)return this.tabs.active()?.kind==='draft'&&!this.tabBlockReason()&&!!snapshot?.connected&&snapshot.account?.auth==='subscription'&&snapshot.account.requiresOpenaiAuth;
    return this.normal() && !snapshot?.thread && snapshot?.account?.auth === 'subscription' && snapshot.account.requiresOpenaiAuth;
  }
  private startPairReady() {
    if(this.tabs?.active()?.kind==='draft')return !!this.localPair();
    const snapshot = this.snapshot(), selection = snapshot?.selection;
    return !!selection && selection.model === this.value('codex-model') && selection.effort === this.value('codex-effort') &&
      !!snapshot.models.some(model => model.model === selection.model && model.efforts.includes(selection.effort));
  }
  private canStartThread() { return this.canStartConversation() && this.startPairReady(); }
  /** A user Send gesture may set up its exact chat, never a background turn. */
  private messageTargetReady():boolean {
    const snapshot=this.snapshot();
    if(!this.providerAllowsCodex()||!this.normal()||this.tabTransition||snapshot?.account?.auth!=='subscription'||!snapshot.account.requiresOpenaiAuth)return false;
    const active=this.tabs?.active();
    if(this.tabs&&active?.kind==='native'&&!this.tabs.bound(this.state)) {
      return !this.tabBlockReason()&&this.tabs.owns(active)&&!!active.selection&&
        snapshot.models.some(row=>row.model===active.selection!.model&&row.efforts.includes(active.selection!.effort));
    }
    if(this.tabs&&active?.kind==='draft'||!this.tabs&&!snapshot.thread)return this.canStartThread();
    return !!snapshot.thread?.configured&&IDLE.includes(snapshot.thread.turnStatus)&&(!this.tabs||this.tabs.bound(this.state));
  }
  private async submitMessage():Promise<void> {
    if(this.preparingMessage||!this.messageTargetReady()||this.draftNeedsReview())return;
    const draft=this.value('codex-composer');
    let message:string,references:readonly {readonly name:string;readonly dataUrl:string}[]=[];
    try {message=this.attachments?.prepareText(draft)??draft;references=this.attachments?.prepareReferences()??[];}
    catch(error){this.text('codex-notice',error instanceof Error?error.message:'Attachments could not be prepared.');return;}
    if(!message.trim()||utf8(message)>CODEX_INPUT_BYTES)return;
    const lifetime=this.messageLifetime,project=this.state!.projectPath,source=this.tabs?.active(),selection=source?.kind==='native'?this.displaySelection():this.localPair();
    const referenceRevision=this.attachments?.selectionRevision(),referenceFields=references.length?{references}:{};
    // Reject an oversized caption/reference envelope before opening a draft's
    // native thread or clearing its selected files. Unknown future thread IDs
    // reserve their maximum encoded space; dispatch checks the exact body again.
    if(references.length&&utf8(JSON.stringify({requestId:'f'.repeat(36),connectionId:this.snapshot()!.connectionId,action:'turn-start',
      threadId:source?.kind==='native'?source.threadId:'X'.repeat(1024),text:message,references,allowWorkspaceWrites:true,allowAssets:true}))>1_000_000){
      this.text('codex-notice','The complete message and PNG references are too large. Reduce the message or references; your draft and selected files are retained.');return;
    }
    const bound=!!this.snapshot()?.thread?.configured&&(!this.tabs||this.tabs.bound(this.state));
    const applyPreferred=bound&&!!selection&&(selection.model!==this.snapshot()!.thread!.selection.model||selection.effort!==this.snapshot()!.thread!.selection.effort);
    if(bound&&!applyPreferred){await this.dispatch('turn-start',{threadId:this.snapshot()!.thread!.threadId,text:message,...referenceFields,allowWorkspaceWrites:true,...(this.state?.nativeAssets?.available?{allowAssets:true}:{})});return;}
    if(!selection)return;
    this.preparingMessage=true;this.renderControls();
    try {
      const opened=applyPreferred?(await this.dispatch('select',{...selection},true))?.state==='acknowledged':this.tabs?source?.kind==='draft'?await this.startCurrentChat():
        await this.bindNativeChat('thread-resume',selection,source?.threadId??undefined):
        (await this.dispatch('thread-start'))?.state==='acknowledged';
      const live=this.snapshot()?.thread;
      if(!opened||this.stopped||lifetime!==this.messageLifetime||this.state?.projectPath!==project||!live?.configured||
        live.selection.model!==selection.model||live.selection.effort!==selection.effort||
        references.length&&(this.tabs?.active()?.localId!==source?.localId||this.attachments?.selectionRevision()!==referenceRevision)||
        !this.messageTargetReady()||this.draftNeedsReview())return;
      let current:string;
      try {current=this.attachments?.prepareText(this.value('codex-composer'))??this.value('codex-composer');}
      catch {this.text('codex-notice','Your chat is ready. Review your attachments before sending.');return;}
      if(this.value('codex-composer')!==draft||!references.length&&current!==message){this.text('codex-notice','Your chat is ready. Your edited draft is saved; send it when ready.');return;}
      await this.dispatch('turn-start',{threadId:live.threadId,text:message,...referenceFields,allowWorkspaceWrites:true,...(this.state?.nativeAssets?.available?{allowAssets:true}:{})});
    } finally {this.preparingMessage=false;if(!this.stopped){this.renderControls();this.publishState();}}
  }
  private startConversation(event: Event) {
    const input = event as MouseEvent;
    if (!event.isTrusted || event.defaultPrevented || input.button !== 0 || input.altKey || input.ctrlKey || input.metaKey || input.shiftKey || !this.canStartConversation()) return;
    event.preventDefault();
    if (!this.startPairReady()) { this.openPicker(); return; }
    void this.dispatch('thread-start');
  }

  // The composer stages the existing settings controls; it owns no second selection.
  private picker() {
    const popover = this.doc.getElementById('codex-model-popover');
    return popover?.getAttribute('role') === 'dialog' ? popover : null;
  }
  private pickerCanOpen() {
    return this.canSelectModel();
  }
  private closePicker(restore = false) {
    const popover = this.picker(); if (!popover) return;
    const wasOpen = !popover.hidden; popover.hidden = true;
    this.el('codex-model-trigger').setAttribute('aria-expanded', 'false');
    this.setReasoningOpen(false);
    this.showPickerModels(false);
    if (restore && wasOpen) {
      const trigger = this.el<HTMLButtonElement>('codex-model-trigger');
      (trigger.disabled ? this.el('codex-composer') : trigger).focus({ preventScroll: true });
    }
  }
  private positionPicker() {
    const popover = this.picker(), view = this.doc.defaultView;
    if (!popover || popover.hidden || !view) return;
    const viewport = view.visualViewport, margin = 12, gap = 8;
    const leftEdge = (viewport?.offsetLeft ?? 0) + margin, topEdge = (viewport?.offsetTop ?? 0) + margin;
    const width = Math.max(0, (viewport?.width ?? view.innerWidth) - margin * 2);
    const bottomEdge = topEdge + Math.max(0, (viewport?.height ?? view.innerHeight) - margin * 2);
    const rect = this.el('codex-model-trigger').getBoundingClientRect(), panelWidth = Math.min(this.pickerModelsOpen?300:240, width);
    const above = Math.max(0, rect.top - topEdge - gap), below = Math.max(0, bottomEdge - rect.bottom - gap);
    const useAbove = above >= below;
    popover.style.width = panelWidth + 'px';
    popover.style.maxHeight = Math.min(480, useAbove ? above : below) + 'px';
    popover.style.left = Math.max(leftEdge, Math.min(rect.left, leftEdge + width - panelWidth)) + 'px';
    const height = popover.getBoundingClientRect().height;
    popover.style.top = Math.max(topEdge, Math.min(useAbove ? rect.top - gap - height : rect.bottom + gap, bottomEdge - height)) + 'px';
  }
  private openPicker() {
    const popover = this.picker();
    if (!popover || !this.pickerCanOpen()) return;
    popover.hidden = false; this.el('codex-model-trigger').setAttribute('aria-expanded', 'true');
    this.el<HTMLInputElement>('codex-model-search').value = ''; this.pickerSignature = '';
    this.showPickerModels(false);this.renderPicker();
    (this.doc.getElementById('codex-picker-effort-slider')??this.reasoningTrigger())?.focus({preventScroll:true});this.positionPicker();
  }
  private showPickerModels(open:boolean):void {
    this.pickerModelsOpen=open;
    const summary=this.doc.getElementById('codex-picker-summary'),list=this.doc.getElementById('codex-picker-model-list');
    if(summary)summary.hidden=open;if(list)list.hidden=!open;
    this.doc.getElementById('codex-picker-current-model')?.setAttribute('aria-expanded',String(open));
    if(this.picker())this.picker()!.dataset.view=open?'models':'reasoning';
    this.positionPicker();
  }
  private applyPickerSelection():void {
    const button=this.el<HTMLButtonElement>('codex-select');
    if(this.canSelectModel()&&!this.picker()!.hidden&&!button.disabled)void this.dispatch('select',{model:this.value('codex-model'),effort:this.value('codex-effort')});
  }
  private styleEffortRange(slider:HTMLInputElement,efforts:readonly string[],index:number):void {
    const ratio=efforts.length>1&&index>=0?Math.min(1,index/(efforts.length-1)):0;
    slider.style.setProperty('--effort-position',String(ratio*100)+'%');
    slider.style.setProperty('--effort-offset',String(ratio*24)+'px');
    slider.dataset.effortTone=efforts[index]==='ultra'?'ultra':'standard';
  }
  private reasoningTrigger():HTMLButtonElement|null {
    return this.doc.getElementById('codex-picker-reasoning-trigger') as HTMLButtonElement|null;
  }
  private setReasoningOpen(open:boolean,focus=false):void {
    this.reasoningOpen=open;
    this.el('codex-picker-efforts').hidden=!open;
    this.reasoningTrigger()?.setAttribute('aria-expanded',String(open));
    if(focus) {
      const rows=Array.from(this.el('codex-picker-efforts').querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      (rows.find(row=>row.getAttribute('aria-checked')==='true')??rows[0])?.focus({preventScroll:true});
    }
    this.positionPicker();
  }
  private pickerCheck(selected:boolean):SVGSVGElement {
    const icon=this.doc.createElementNS('http://www.w3.org/2000/svg','svg');
    icon.setAttribute('class','icon picker-selected-check');icon.setAttribute('viewBox','0 0 24 24');
    icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.8');
    icon.setAttribute('aria-hidden','true');icon.setAttribute('data-selected',String(selected));
    const path=this.doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','m5 12 4 4L19 6');
    if(selected)icon.append(path);return icon;
  }
  private bindPicker() {
    if (!this.picker() || this.pickerCleanup.length) return;
    // Upgrade the existing effort section without requiring a second catalogue or settings control.
    let reasoning=this.reasoningTrigger();
    if(!reasoning) {
      reasoning=this.make('button',undefined,'picker-reasoning-trigger secondary');reasoning.id='codex-picker-reasoning-trigger';reasoning.type='button';
      this.el('codex-picker-efforts').parentElement!.insertBefore(reasoning,this.el('codex-picker-efforts'));
    }
    reasoning.setAttribute('aria-controls','codex-picker-efforts');reasoning.setAttribute('aria-expanded','false');reasoning.setAttribute('aria-haspopup','true');
    this.el('codex-picker-effort-heading').hidden=true;this.el('codex-picker-effort-hint').hidden=true;
    this.el('codex-picker-efforts').setAttribute('aria-label','Reasoning effort');this.setReasoningOpen(false);
    const listen = (target: EventTarget, type: string, fn: (event: Event) => void, capture = false) => {
      target.addEventListener(type, fn, capture);
      this.pickerCleanup.push(() => target.removeEventListener(type, fn, capture));
    };
    listen(this.el('codex-model-trigger'), 'click', () => {
      if (!this.pickerCanOpen()) return;
      const popover = this.picker()!;
      if (!popover.hidden) { this.closePicker(true); return; }
      this.openPicker();
    });
    listen(this.el('codex-model-search'), 'input', () => this.renderPicker());
    const currentModel=this.doc.getElementById('codex-picker-current-model');
    if(currentModel)listen(currentModel,'click',()=>{if(this.pickerCanOpen()&&!this.picker()!.hidden){this.showPickerModels(true);this.el('codex-model-search').focus({preventScroll:true});}});
    const back=this.doc.getElementById('codex-picker-back');
    if(back)listen(back,'click',()=>{this.showPickerModels(false);currentModel?.focus({preventScroll:true});});
    const slider=this.doc.getElementById('codex-picker-effort-slider') as HTMLInputElement|null;
    if(slider){
      listen(slider,'input',()=>{
        const efforts=this.snapshot()?.models.find(item=>item.model===this.value('codex-model'))?.efforts??[];
        const index=Number(slider.value);if(!this.canSelectModel()||this.picker()!.hidden||!Number.isInteger(index)||index<0||index>=efforts.length)return;
        this.el<HTMLSelectElement>('codex-effort').value=efforts[index]!;this.renderControls();
      });
      listen(slider,'change',()=>this.applyPickerSelection());
    }
    const reset=this.doc.getElementById('codex-picker-reset');
    if(reset)listen(reset,'click',()=>{
      const item=this.snapshot()?.models.find(item=>item.model===this.value('codex-model'));
      if(!this.canSelectModel()||this.picker()!.hidden||!item?.defaultEffort||!item.efforts.includes(item.defaultEffort))return;
      this.el<HTMLSelectElement>('codex-effort').value=item.defaultEffort;this.renderControls();this.applyPickerSelection();
    });
    listen(reasoning,'click',()=>{if(this.canSelectModel()&&!this.picker()!.hidden&&!reasoning!.disabled)this.setReasoningOpen(!this.reasoningOpen,true);});
    listen(this.el('codex-model-options'),'focusin',event=>{
      const target=event.target as HTMLElement;
      if(!target.dataset.pickerModel)return;
      for(const row of Array.from(this.el('codex-model-options').querySelectorAll<HTMLButtonElement>('button')))row.tabIndex=row===target?0:-1;
    });
    listen(this.el('codex-picker-apply'), 'click', () => {
      const select = this.el<HTMLButtonElement>('codex-select');
      if (!this.canSelectModel() || select.disabled || this.picker()!.hidden) return;
      this.closePicker(true); select.click(); // The real guarded select action remains authoritative.
    });
    for (const [id, provider] of [['codex-picker-connect', 'codex'], ['codex-picker-claude', 'claude']] as const) {
      listen(this.el(id), 'click', () => {
        if (this.stopped || this.picker()!.hidden) return;
        this.closePicker();
        const EventType = this.doc.defaultView?.CustomEvent ?? CustomEvent;
        this.doc.dispatchEvent(new EventType('workspace:providersetup', { detail: { provider } }));
      });
    }
    listen(this.picker()!, 'keydown', event => {
      const key = event as KeyboardEvent;
      if (key.isComposing || key.altKey || key.ctrlKey || key.metaKey) return;
      if (key.key === 'Escape') {
        event.preventDefault();
        if(this.pickerModelsOpen){this.showPickerModels(false);currentModel?.focus({preventScroll:true});}else this.closePicker(true);
        return;
      }
      const target = event.target as HTMLElement, models = this.el('codex-model-options'), efforts = this.el('codex-picker-efforts');
      const inModels = models.contains(target), inEfforts = efforts.contains(target);
      if(inModels&&key.key==='ArrowRight'){event.preventDefault();(target as HTMLButtonElement).click();return;}
      if(inEfforts&&key.key==='ArrowLeft'){event.preventDefault();this.setReasoningOpen(false);this.reasoningTrigger()?.focus({preventScroll:true});return;}
      if (target === this.el('codex-model-search') && ['ArrowDown', 'ArrowUp'].includes(key.key)) {
        const rows = Array.from(models.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const row = key.key === 'ArrowDown' ? rows[0] : rows.at(-1);
        if (row) { event.preventDefault(); row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); }
      } else if ((inModels || inEfforts) && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key.key)) {
        const rows = Array.from((inModels ? models : efforts).querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = rows.indexOf(target as HTMLButtonElement), step = ['ArrowUp', 'ArrowLeft'].includes(key.key) ? -1 : 1;
        const next = key.key === 'Home' ? 0 : key.key === 'End' ? rows.length - 1 : (index + step + rows.length) % rows.length;
        const row = rows[next]; if (!row) return;
        event.preventDefault(); row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' });
        if (inEfforts) row.click();
      } else if (target === this.el('codex-model-search') && key.key === 'Enter') {
        event.preventDefault(); // Searching must never submit the surrounding conversation form.
        this.el('codex-model-options').querySelector<HTMLButtonElement>('button:not(:disabled)')?.click();
      }
    });
    const outside = (event: Event) => {
      const popover = this.picker()!; if (popover.hidden) return;
      const target = event.target as Node | null;
      if (target && !popover.contains(target) && !this.el('codex-model-trigger').contains(target)) this.closePicker();
    };
    listen(this.doc, 'pointerdown', outside); listen(this.doc, 'focusin', outside);
    const reposition = () => this.positionPicker();
    listen(this.doc, 'scroll', reposition, true);
    if (this.doc.defaultView) {
      listen(this.doc.defaultView, 'resize', reposition);
      if (this.doc.defaultView.visualViewport) {
        listen(this.doc.defaultView.visualViewport, 'resize', reposition);
        listen(this.doc.defaultView.visualViewport, 'scroll', reposition);
      }
    }
  }
  private renderPicker() {
    const popover = this.picker(); if (!popover) return;
    const snapshot = this.snapshot(), selection = this.displaySelection();
    const reported = snapshot?.models.find(model => model.model === selection?.model);
    this.text('codex-model-label', reported?.displayName ?? 'Choose model');
    this.text('codex-effort-label', selection?.effort ?? ''); this.el('codex-effort-label').hidden = !selection;
    const trigger = this.el<HTMLButtonElement>('codex-model-trigger'); trigger.disabled = !this.pickerCanOpen();
    trigger.setAttribute('aria-busy', String([...this.pending.values()].some(input => input.action === 'select')));
    trigger.setAttribute('aria-label', this.api.safe(selection ? 'Codex reported model: ' + selection.model + ', effort: ' + selection.effort : 'Choose Codex model and effort'));
    this.text('codex-model-picker-status', this.uncertain.size ? 'Native acknowledgement is uncertain. Review recorded actions.' :
      this.pending.size ? 'Awaiting native acknowledgement.' : !snapshot ? 'Connect Codex to read its reported models.' :
      !this.fresh ? 'Native state is unavailable. Refresh before changing models.' : !this.canSelectModel() ? 'Model changes are unavailable in the current native state.' :
      selection ? 'Reported selection: ' + selection.model + ' · ' + selection.effort : 'No model and effort selection acknowledged.');
    if (trigger.disabled && !popover.hidden) this.closePicker(popover.contains(this.doc.activeElement));
    if (popover.hidden) return;
    const query = this.value('codex-model-search').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const model = this.value('codex-model'), effort = this.value('codex-effort'), enabled = this.canSelectModel();
    const signature = JSON.stringify([snapshot?.models ?? [], query, model, effort, enabled]);
    if (signature !== this.pickerSignature) {
      this.pickerSignature = signature;
      const focused = this.doc.activeElement as HTMLElement | null;
      const focusModel = focused?.dataset.pickerModel, focusEffort = focused?.dataset.pickerEffort;
      const host = this.el('codex-model-options'); host.replaceChildren();
      const models = (snapshot?.models ?? []).filter(item => query.every(word => (item.displayName + ' ' + item.model).toLocaleLowerCase().includes(word)));
      const tabModel=models.find(item=>item.model===model)?.model??models[0]?.model;
      for (const item of models) {
        const row = this.make('button', undefined, 'picker-model-option'); row.type = 'button'; row.tabIndex = item.model===tabModel?0:-1;
        row.dataset.pickerModel = item.model; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(item.model === model)); row.disabled = !enabled;
        row.title=this.api.safe(item.model);row.append(this.make('span', item.displayName),this.pickerCheck(item.model===model));
        row.addEventListener('click', () => {
          const current=this.snapshot()?.models.find(current=>current.model===item.model);
          if (!this.canSelectModel() || this.picker()!.hidden || !current) return;
          if (this.value('codex-model') !== item.model) {
            this.el<HTMLSelectElement>('codex-model').value = item.model; this.populateEfforts();
            // Choose only an effort from this fresh native catalogue. The reset
            // control separately requires a reported default (not a guessed one).
            this.el<HTMLSelectElement>('codex-effort').value=current.defaultEffort&&current.efforts.includes(current.defaultEffort)?current.defaultEffort:current.efforts[0]??'';
          }
          this.renderControls();
          this.showPickerModels(false);this.applyPickerSelection();
        }); host.append(row);
      }
      this.el('codex-model-empty').hidden = models.length > 0;
      this.text('codex-model-empty', snapshot?.models.length ? 'No reported models match your search.' : 'No Codex models have been reported. Review connection setup.');
      const effortHost = this.el('codex-picker-efforts'); effortHost.replaceChildren();
      const efforts = snapshot?.models.find(item => item.model === model)?.efforts ?? [];
      for (const value of efforts) {
        const button = this.make('button', value, 'picker-effort-option'); button.type = 'button'; button.dataset.pickerEffort = value;
        button.append(this.pickerCheck(value===effort));button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', String(value === effort));
        button.tabIndex = value === (effort || efforts[0]) ? 0 : -1; button.disabled = !enabled;
        button.addEventListener('click', () => {
          if (!this.canSelectModel() || this.picker()!.hidden || !this.snapshot()?.models.find(item => item.model === this.value('codex-model'))?.efforts.includes(value)) return;
          this.el<HTMLSelectElement>('codex-effort').value = value; this.renderControls();
        }); effortHost.append(button);
      }
      this.text('codex-picker-effort-hint', efforts.length ? 'Only efforts reported for this model are shown.' : 'Choose a reported model, then an effort.');
      if (focusModel) Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(row => row.dataset.pickerModel === focusModel)?.focus({ preventScroll: true });
      if (focusEffort) Array.from(effortHost.querySelectorAll<HTMLButtonElement>('button')).find(row => row.dataset.pickerEffort === focusEffort)?.focus({ preventScroll: true });
    }
    const reasoning=this.reasoningTrigger();
    if(reasoning){reasoning.textContent=this.api.safe('Reasoning'+(effort?' · '+effort:''));reasoning.disabled=!enabled||!snapshot?.models.some(item=>item.model===model);}
    this.el<HTMLButtonElement>('codex-picker-apply').disabled = this.el<HTMLButtonElement>('codex-select').disabled;
    const selected=snapshot?.models.find(item=>item.model===model);
    const displayEffort=effort?effort.charAt(0).toUpperCase()+effort.slice(1):'Reasoning';
    const effortValue=this.doc.getElementById('codex-picker-effort-value');if(effortValue)effortValue.textContent=this.api.safe(displayEffort);
    const modelValue=this.doc.getElementById('codex-picker-current-model-label');if(modelValue)modelValue.textContent=this.api.safe(selected?.displayName??'Choose model');
    const slider=this.doc.getElementById('codex-picker-effort-slider') as HTMLInputElement|null;
    if(slider){const efforts=selected?.efforts??[],index=efforts.indexOf(effort);slider.max=String(Math.max(0,efforts.length-1));slider.value=String(Math.max(0,index));slider.disabled=!enabled||efforts.length<2||index<0;slider.setAttribute('aria-valuetext',displayEffort);this.styleEffortRange(slider,efforts,index);}
    const reset=this.doc.getElementById('codex-picker-reset') as HTMLButtonElement|null;if(reset)reset.disabled=!enabled||!selected?.defaultEffort||!selected.efforts.includes(selected.defaultEffort);
    this.positionPicker();
  }

  async start() {
    this.bindPicker();
    this.bindDraftLifecycle();
    this.on('codex-connect','click',()=>void this.dispatch('connect'));
    this.on('codex-refresh','click',()=>void this.refresh());
    this.on('codex-disconnect','click',()=>void this.dispatch('disconnect'));
    this.on('codex-select','click',()=>void this.dispatch('select',{model:this.value('codex-model'),effort:this.value('codex-effort')}));
    this.on('codex-model','change',()=>{this.populateEfforts();this.renderControls();});
    this.on('codex-effort','change',()=>this.renderControls());
    const startConversation = (event: Event) => this.startConversation(event);
    this.on('codex-thread-start', 'click', startConversation);
    this.doc.getElementById('codex-conversation-start')?.addEventListener('click', startConversation);
    this.on('codex-resume-id','input',()=>this.renderControls());
    this.on('codex-thread-resume','click',()=>{if(this.tabs)void this.openSavedChat(this.value('codex-resume-id'));else void this.dispatch('thread-resume',{threadId:this.value('codex-resume-id')});});
    this.bindAssetButton('codex-assets-grant', 'grant-assets');
    this.bindAssetButton('codex-assets-revoke', 'revoke-assets');
    this.on('codex-grant','click',()=>this.openGrant());
    this.on('codex-revoke','click',()=>{const t=this.snapshot()?.thread;if(t)void this.dispatch('revoke-writes',{threadId:t.threadId});});
    this.on('codex-interrupt','click',()=>this.stopCurrentTask());
    this.on('codex-composer','input',()=>this.composerInput());
    this.on('codex-composer','keydown',event=>{
      const key=event as KeyboardEvent;
      if(key.key==='Enter'&&!key.shiftKey&&!key.altKey&&!key.ctrlKey&&!key.metaKey&&!key.isComposing&&key.keyCode!==229&&this.messageTargetReady()){
        event.preventDefault();void this.submitMessage();
      }
    });
    this.on('codex-draft-review-button','click',event=>{if(event.isTrusted)this.openDraftReview();});
    this.on('codex-compose','submit',e=>{
      e.preventDefault();void this.submitMessage();
    });
    this.on('codex-submit','click',()=>{
      const thread=this.snapshot()?.thread;
      if(this.providerAllowsCodex()&&thread?.configured&&thread.turnId&&['starting','inProgress'].includes(thread.turnStatus)&&(!this.tabs||this.tabs.bound(this.state)))this.stopCurrentTask();
    });
    this.on('codex-reconcile','click',()=>void this.refresh());
    const usageButton=this.doc.getElementById('codex-refresh-usage');
    if(usageButton)usageButton.addEventListener('click',()=>void this.refreshUsage());
    this.on('codex-acknowledge','click',()=>{if(!this.canAcknowledge())return;this.uncertain.clear();this.text('codex-notice','Recorded action IDs and native state reviewed. No request was retried.');this.render();});
    this.on('codex-confirm-check','change',()=>this.renderControls());
    this.on('codex-confirm-cancel','click',()=>this.closeConfirmation());
    this.on('codex-confirm','close',()=>{if(!this.el<HTMLDialogElement>('codex-confirm').open)this.confirmation=null;});
    this.on('codex-confirm-submit','click',()=>void this.confirm());
    this.on('codex-panel','toggle',()=>{if(this.el<HTMLDetailsElement>('codex-panel').open)void this.refresh();});
    this.renderControls();await this.refresh();this.schedule();
  }
  stop() {
    this.usageController?.abort();this.usageController=undefined;this.usageNotice='';
    this.messageLifetime++;
    this.imageRequest?.abort();
    this.attachments?.stop();
    this.preferenceController?.stop();this.stashTabDraft();this.tabs?.stop();
    this.stopped=true;this.generation++;this.readVersion++;this.readController?.abort();if(this.timer)clearTimeout(this.timer);
    for(const input of this.pending.values())this.uncertain.set(input.requestId,{input,read:false});
    this.closePicker();for(const cleanup of this.pickerCleanup.splice(0))cleanup();
    for(const cleanup of this.draftCleanup.splice(0))cleanup();
    this.closeConfirmation();this.fresh=false;this.transcript.reset();this.messageSignature='';this.el('codex-messages').replaceChildren();this.renderControls();this.publishProviderState();this.publishState();
  }
  resume(){this.stopped=false;this.attachments?.resume();this.tabs?.mount();this.preferenceController?.resume();this.bindPicker();this.bindDraftLifecycle();void this.refresh().finally(()=>this.schedule());}
  private schedule() {
    if(this.stopped)return;if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{const active=!this.doc.hidden&&(this.el<HTMLDetailsElement>('codex-panel').open||this.pending.size>0||this.uncertain.size>0||!!this.confirmation);if(active)void this.refresh().finally(()=>this.schedule());else this.schedule();},1500);
  }
  async refresh() {
    if(this.stopped)return;
    this.readController?.abort();const controller=new AbortController();this.readController=controller;
    const epoch=this.generation,version=++this.readVersion;
    try {
      const state=await this.api.state(controller.signal);
      if(this.stopped||epoch!==this.generation||version!==this.readVersion)return;
      this.applyState(state);for(const u of this.uncertain.values())u.read=true;this.fresh=true;
    } catch(error) {
      if(controller.signal.aborted||this.stopped||epoch!==this.generation||version!==this.readVersion)return;
      this.fresh=false;this.text('codex-notice',error instanceof Error?error.message:'Native state unavailable.');
    } finally {if(version===this.readVersion&&!this.stopped){this.render();this.publishProviderState();this.publishState();}}
  }
  private async refreshUsage():Promise<void> {
    const snapshot=this.snapshot();
    if(this.stopped||this.usageController||!this.fresh||!this.providerAllowsCodex()||!snapshot?.connected||!snapshot.ready||snapshot.account?.auth!=='subscription')return;
    const controller=new AbortController(),connectionId=snapshot.connectionId,epoch=this.generation;
    this.usageController=controller;this.usageNotice='Refreshing account usage…';this.renderUsage();
    try{
      await this.api.refreshUsage(connectionId,controller.signal);
      if(this.stopped||epoch!==this.generation||this.snapshot()?.connectionId!==connectionId)return;
      this.usageNotice='';await this.refresh();
    }catch(error){
      if(this.stopped||controller.signal.aborted||epoch!==this.generation||this.snapshot()?.connectionId!==connectionId)return;
      this.usageNotice=(error instanceof Error?error.message:'Usage refresh is unavailable.')+' The last report is retained. Refresh again when ready.';
    }finally{if(this.usageController===controller){this.usageController=undefined;if(!this.stopped)this.renderUsage();}}
  }
  private renderUsage():void {
    const status=this.doc.getElementById('codex-usage-status'),buckets=this.doc.getElementById('codex-usage-buckets'),button=this.doc.getElementById('codex-refresh-usage') as HTMLButtonElement|null;
    const snapshot=this.snapshot(),view=codexRateLimitDisplay(snapshot??null);
    if(status)status.textContent=this.api.safe(this.usageNotice||view.status);
    if(buckets){const signature=this.api.safe(JSON.stringify(view.rows));if(buckets.dataset.signature!==signature){buckets.dataset.signature=signature;buckets.replaceChildren();for(const row of view.rows)buckets.append(this.make('p',row,'hint codex-quota-bucket'));}}
    if(button)button.disabled=this.stopped||!!this.usageController||!this.fresh||!this.providerAllowsCodex()||!!this.state?.connecting||!!this.state?.closing||!snapshot?.connected||!snapshot.ready||snapshot.account?.auth!=='subscription';
  }
  private applyState(state:ChatState) {
    if(this.state&&this.state.projectPath!==state.projectPath){this.messageLifetime++;this.imageRequest?.abort();}
    this.flushDraft();
    const before=this.snapshot()?.connectionId??'',after=state.snapshot?.connectionId??'';
    const previous=this.snapshot()?.thread,next=state.snapshot?.thread;
    const rotation=before!==after&&!!before&&!!after&&!!previous&&!!next&&previous.threadId===next.threadId&&previous.sessionId===next.sessionId&&
      state.actions.some(record=>record.action==='turn-start'&&record.connectionId===before&&record.nextConnectionId===after&&record.threadId===next.threadId);
    const focus=before!==after&&!!next&&state.actions.some(record=>record.action==='task-focus'&&record.connectionId===before&&record.nextConnectionId===after&&record.threadId===next.threadId)&&
      this.state?.chatTasks?.some(task=>task.retained===true&&task.connectionId===after&&task.threadId===next.threadId&&task.sessionId===next.sessionId);
    if(before!==after){this.usageController?.abort();this.usageController=undefined;this.usageNotice='';if(!rotation&&!focus)this.generation++;if(rotation)this.transcript.rebind(after);else this.transcript.reset(after);this.messageSignature='';this.approvalSignature='';this.modelSignature='';this.selectionSignature='';this.closeConfirmation();this.closePicker(true);}
    else if(this.assetScope()!==this.assetScope(state)) { this.generation++; this.closePicker(true); } // Invalidate gestures/replies; retain the disabled stale review for explicit dismissal.
    if(state.snapshot)this.transcript.consume(state.snapshot);
    this.state = state;
    this.syncTabs();
    // Recover unresolved IDs from the service journal after reload, without new browser storage.
    for(const r of state.actions) if(['pending','unknown'].includes(r.state)&&!this.pending.has(r.requestId)&&!this.uncertain.has(r.requestId)&&(r.connectionId===state.snapshot?.connectionId||r.nextConnectionId===state.snapshot?.connectionId||r.action==='connect'&&state.connecting)) {
      this.uncertain.set(r.requestId,{input:{requestId:r.requestId,connectionId:r.action==='connect'?null:r.connectionId,action:r.action} as ChatAction,read:true});
    }
    this.publishProviderState();
    this.publishState();
  }
  private canAcknowledge() {
    if(!this.fresh||!this.uncertain.size)return false;
    return [...this.uncertain.values()].every(u=>{
      if(!u.read)return false;
      const r=this.state!.actions.find(r=>r.requestId===u.input.requestId&&r.action===u.input.action);
      if(r&&['acknowledged','rejected'].includes(r.state))return true;
      return !this.state!.connecting&&!this.state!.closing&&!this.state!.busy&&((u.input.connectionId!==null&&u.input.connectionId!==this.snapshot()?.connectionId)||(u.input.action==='connect'&&!this.snapshot()));
    });
  }
  private async dispatch(action:string,fields:Record<string,unknown>={},internal=false) {
    if(this.stopped)return;
    if(['turn-start','thread-start','thread-resume','select','grant-writes','grant-assets'].includes(action)&&!this.providerAllowsCodex())return;
    if(this.tabTransition&&!internal&&!['disconnect','revoke-writes','revoke-assets','turn-interrupt','task-stop','approval'].includes(action))return;
    if(action==='thread-start'&&!internal) {
      if(!this.canStartThread())return;
      if(this.tabs?.active()?.kind==='draft') {
        await this.startCurrentChat();return;
      }
    }
    if(action==='thread-start'&&internal&&(!this.normal()||!!this.snapshot()?.thread||!this.snapshot()?.selection))return;
    if(action==='select'&&!internal) {
      if(!this.canSelectModel())return;
      if(this.tabs&&(this.tabs.active()?.kind==='draft'||!this.tabs.bound(this.state)||!this.normal()||!IDLE.includes(this.snapshot()?.thread?.turnStatus??''))) {
        try {prepareCodexAction(this.state,action,fields);}catch{return;}
        this.imageRequest?.abort();
        this.tabs.updateDraft(this.value('codex-composer'),{model:fields.model as string,effort:fields.effort as string},!!this.workflowDraftOrigins.length||this.restoredWorkflowDraft);
        this.selectionSignature='';this.closePicker(true);this.render();this.publishState();return;
      }
    }
    if(this.tabs&&!internal&&['turn-start','grant-writes','grant-assets','select'].includes(action)&&!this.tabs.bound(this.state))return;
    if(this.tabs&&!internal&&action==='thread-resume')return; // Only openSavedChat can resolve advisory browser IDs.
    if(action==='turn-start'&&(!this.snapshot()?.thread?.configured||!IDLE.includes(this.snapshot()!.thread!.turnStatus)))return;
    if ((action === 'grant-assets' || action === 'revoke-assets') && !this.assetEligible(action)) return;
    const safety=action==='revoke-assets'||action==='disconnect'||action==='revoke-writes'||action==='turn-interrupt'||action==='task-stop'||action==='approval'&&fields.decision!=='accept';
    if(this.state?.displayLimited&&!safety&&action!=='connect')return;
    if(!safety&&action!=='connect'&&!this.normal()&&!(action==='approval'&&!this.uncertain.size&&this.fresh))return;
    if(action==='connect'&&(!this.fresh||this.snapshot()||this.uncertain.size||this.pending.size||this.state?.connecting||this.state?.closing))return;
    if(action==='turn-start'&&this.draftNeedsReview()){this.text('codex-notice','This workflow draft belongs to another conversation or model. Review it before submitting; your text has been preserved.');this.renderControls();return;}
    let input:ChatAction;try{input=prepareCodexAction(this.state,action,fields);}catch(error){this.text('codex-notice',String(error));return;}
    const cancelsImagePreparation=!internal&&(input.action==='disconnect'||(input.action==='revoke-assets'||input.action==='revoke-writes')&&input.threadId===this.snapshot()?.thread?.threadId);
    if(cancelsImagePreparation){this.imageRequest?.abort();if(this.preparingMessage)this.messageLifetime++;}
    if([...this.pending.values()].some(p=>p.action===input.action&&(input.action!=='approval'||'handle' in p&&p.handle===fields.handle)))return;
    if(safety){this.generation++;this.readVersion++;this.readController?.abort();this.closeConfirmation();}
    if(action==='disconnect')this.fresh=false;
    const epoch=this.generation, assetScope=this.assetScope();
    const imageRequest=input.action==='turn-start'&&input.references?new AbortController():null;
    if(imageRequest)this.imageRequest=imageRequest;
    this.pending.set(input.requestId,input);this.text('codex-notice','Waiting for confirmation…');
    if(input.action==='turn-start'){this.transcript.messages.push({key:input.requestId,role:'human',threadId:input.threadId,scope:input.threadId,text:input.text,acknowledgement:'Awaiting native acknowledgement'});this.el<HTMLTextAreaElement>('codex-composer').value='';this.attachments?.clear();this.clearDraftOrigins();this.stashTabDraft();}
    this.render();this.publishState();
    try {
      const outcome=await this.api.action(input,imageRequest?.signal);
      const current=this.snapshot()?.connectionId;
      const freshTask=input.action==='turn-start'&&!!outcome.record.nextConnectionId&&(current===input.connectionId||current===outcome.record.nextConnectionId)&&
        outcome.state.snapshot?.connectionId===outcome.record.nextConnectionId&&outcome.state.snapshot.thread?.threadId===input.threadId&&outcome.state.snapshot.thread.sessionId===this.snapshot()?.thread?.sessionId;
      const focusedTask=input.action==='task-focus'&&!!outcome.record.nextConnectionId&&(current===input.connectionId||current===outcome.record.nextConnectionId)&&
        this.state?.chatTasks?.some(task=>task.taskId===input.taskId&&task.retained===true&&task.threadId===input.threadId&&task.sessionId===outcome.state.snapshot?.thread?.sessionId&&task.connectionId===outcome.record.nextConnectionId);
      const fenced=this.stopped||epoch!==this.generation||((input.action==='grant-assets'||input.action==='revoke-assets')&&assetScope!==this.assetScope())||(input.action!=='connect'&&input.action!=='disconnect'&&current!==input.connectionId&&!freshTask&&!focusedTask)||(input.action==='disconnect'&&!!current&&current!==input.connectionId)||(input.action==='connect'&&!!current&&current!==outcome.record.connectionId);
      if(!fenced){this.readVersion++;this.applyState(outcome.state);this.fresh=true;
        const acknowledged:Record<string,string>={connect:'Connected. Choose a model to continue.',disconnect:'Disconnected.',select:'Model updated.','thread-start':'Conversation ready.','thread-resume':'Conversation opened.','turn-start':'Message accepted. Waiting for a response.','turn-interrupt':'Stop requested.','task-stop':'Task stopped.','grant-writes':'Workspace editing enabled for this conversation.','revoke-writes':'Workspace editing disabled.','grant-assets':'Asset jobs enabled for this conversation.','revoke-assets':'Asset jobs disabled.',approval:'Your review was recorded.','history-load':'History loaded.'};
        this.text('codex-notice',outcome.record.state==='acknowledged'?(acknowledged[input.action]??'Request confirmed.'):input.action+' · native acknowledgement '+outcome.record.state+' · '+input.requestId+'. Review recorded state before continuing.');}
      if(['pending','unknown'].includes(outcome.record.state))this.uncertain.set(input.requestId,{input,read:false});
      const message=this.transcript.messages.find(m=>m.key===input.requestId);if(message)message.acknowledgement='Native acknowledgement: '+outcome.record.state;
      return fenced?undefined:outcome.record;
    } catch(error) {
      if(!(error instanceof CodexHttpError)||error.unknown)this.uncertain.set(input.requestId,{input,read:false});
      if(!this.stopped&&epoch===this.generation)this.text('codex-notice',(error instanceof Error?error.message:'Unknown native HTTP acknowledgement.')+' Request ID retained: '+input.requestId+'. No automatic retry.');
    } finally {
        if(this.imageRequest===imageRequest)this.imageRequest=null;
      this.pending.delete(input.requestId);
      if(!this.stopped){this.render();this.publishProviderState();this.publishState();await this.refresh();}
    }
  }
  private populateEfforts() {
    const select=this.el<HTMLSelectElement>('codex-effort');select.replaceChildren();
    const placeholder=this.make('option','Choose reported effort');placeholder.value='';select.append(placeholder);
    for(const effort of this.snapshot()?.models.find(m=>m.model===this.value('codex-model'))?.efforts??[]){const o=this.make('option',effort);o.value=effort;select.append(o);}
    select.value='';
  }
  private displaySelection():ChatSelection|null {
    if(this.tabs) {
      const active=this.tabs.active();if(!active)return null;
      const selection=active.kind==='native'&&this.tabs.bound(this.state)&&!this.tabs.hasPreferredSelection()?this.snapshot()!.thread!.selection:active.selection;
      return selection&&this.snapshot()?.models.some(model=>model.model===selection.model&&model.efforts.includes(selection.effort))?selection:null;
    }
    const s=this.snapshot();return s?.thread?.configured?s.thread.selection:s?.selection??null;
  }
  private displayMessages():ChatMessage[] {
    if(!this.tabs)return this.transcript.messages;
    const active=this.tabs.active();if(!active||active.kind==='draft')return [];
    const saved=this.tabs.recording(active)?.recorded?.result.entries??[];
    const recorded:ChatMessage[]=saved.map(entry=>({key:entry.ids.threadId+'\0'+entry.ids.turnId+'\0'+entry.ids.itemId,
      role:entry.role==='user'?'human':entry.role==='assistant'?'codex':'tool',threadId:entry.ids.threadId,
      scope:entry.ids.threadId+' · '+entry.ids.turnId+' · '+entry.ids.itemId,text:entry.text}));
    const keys=new Set(recorded.map(row=>row.key));
    return [...recorded,...(this.tabs.bound(this.state)?this.transcript.messages.filter(row=>row.threadId===active.threadId&&!keys.has(row.key)):[])];
  }

  private render() {
    const s=this.snapshot(),t=s?.thread;
    const notice=this.el('codex-notice').textContent??'';
    if(['Connect your local CLI when you’re ready.','No connection or model request is started automatically.','Choose a model to start this conversation.'].includes(notice)) this.text('codex-notice',s?.connected?(t?'Continue in this conversation.':s.selection?'Start your conversation when you’re ready.':'Choose a model to start this conversation.'):'Connect your local CLI when you’re ready.');
    const welcome=this.doc.getElementById('welcome-connect');if(welcome){welcome.hidden=!!s?.connected;welcome.textContent='Connect your local CLI';}
    this.text('codex-status',this.state?.connecting?'Connecting':this.state?.closing?'Disconnecting':s?.connected?s.provenance==='spawned-node-fixture'?'Test connection':'Connected':s?'Disconnected':'Not connected');
    this.text('codex-scope',s?'Connection '+s.connectionId+(t?'\nThread '+t.threadId+'\nTurn '+(t.turnId??'Not started'):'\nNo thread started'):'No native connection selected.');
    this.text('codex-account',s?.account?'Native account: '+s.account.auth+' · reported plan '+(s.account.plan??'not reported')+' · model access unverified':'Connect reads account and model metadata only.');
    this.text('codex-policy',t?(t.writeGranted?'Workspace editing enabled':'Send enables workspace editing for the next task')+' · native turn status: '+t.turnStatus:'Send starts a task with workspace editing.');
    this.text('codex-profile',this.state?.nativeTools.configured?'Native tool profile requested · verified:false. Studio grants remain separate; no Studio connection was established by this panel.':'Native tool profile not requested · verified:false. Studio grants remain separate.');
    if(this.state?.displayLimited)this.text('codex-profile','Display limited: public events and approvals were omitted, not resolved. New work is blocked. Review the native client or use interrupt, revoke or disconnect. '+this.el('codex-profile').textContent);
    if(s?.mcpIsolation)this.text('codex-profile','Native MCP scope: '+s.mcpIsolation+'. Read-only applies to native file/command execution; Arcane MCP operations still use their separate grants. '+this.el('codex-profile').textContent);
    if(t){const task=this.state?.chatTasks?.findLast(task=>task.threadId===t.threadId&&task.sessionId===t.sessionId);if(task){
      const labels:Record<string,string>={working:IDLE.includes(t.turnStatus)?'No settled gameplay verification yet.':'Working on this task.',awaiting_verification:'Waiting for bounded verification.',repair_queued:'One repair is queued.',repairing:'Repairing and verifying once.',verified:'The bounded scenario passed.',failed:'The bounded scenario still fails after one repair.',cancelled:'Task stopped.',paused:'Verification needs review.',unknown:'Task outcome is uncertain. No automatic retry.'};
      this.text('codex-policy',labels[task.state]??'Verification needs review.');}}
    const signature=JSON.stringify(s?.models??[]),selection=this.displaySelection(),selectionSignature=JSON.stringify(selection??null);
    const catalogueChanged=signature!==this.modelSignature;
    if(catalogueChanged){this.modelSignature=signature;const select=this.el<HTMLSelectElement>('codex-model');select.replaceChildren();const p=this.make('option','Choose reported model');p.value='';select.append(p);for(const m of s?.models??[]){const o=this.make('option',m.displayName+' · '+m.model);o.value=m.model;select.append(o);}}
    if(catalogueChanged||selectionSignature!==this.selectionSignature){this.selectionSignature=selectionSignature;this.el<HTMLSelectElement>('codex-model').value=selection?.model??'';this.populateEfforts();if(selection)this.el<HTMLSelectElement>('codex-effort').value=selection.effort;}
    this.text('codex-selection',s?.selection?'Reported selection: '+s.selection.model+' · '+s.selection.effort:'No model/effort selection acknowledged.');
    const displayedMessages=this.displayMessages(),messageSignature=JSON.stringify(displayedMessages);
    if(messageSignature!==this.messageSignature){
    this.messageSignature=messageSignature;
    const messages=this.el('codex-messages'),bottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;messages.replaceChildren();
    if(!displayedMessages.length)messages.append(this.make('p',this.tabs?.active()?.kind==='draft'?'Local draft. Starting a conversation will not send your message.':this.tabs?.recording()?.recorded?'No public text entries in this saved recording.':'No public history has been loaded for this conversation.','empty'));
    for(const message of displayedMessages){
      const card=this.make('article',undefined,'codex-message '+message.role);card.setAttribute('aria-label',message.role==='human'?'Your message':'Assistant message');if(message.role==='tool')card.setAttribute('aria-label','Public tool output');card.append(this.make('pre',message.text,'message-text'));
      if(message.acknowledgement){const acknowledgement=message.acknowledgement==='Native acknowledgement: acknowledged'?'Accepted':message.acknowledgement==='Native acknowledgement: rejected'?'Not accepted':'Awaiting confirmation';card.append(this.make('p',acknowledgement,'message-acknowledgement'));}
      const metadata=this.make('details',undefined,'message-details');metadata.append(this.make('summary','Message details'),this.make('pre',message.scope+(message.acknowledgement?'\n'+message.acknowledgement:''),'hint mono'));card.append(metadata);messages.append(card);
    }
    if(bottom)messages.scrollTop=messages.scrollHeight;
    }
    this.text('codex-events-note','Event sequence '+this.transcript.cursor+' · native dropped '+this.transcript.dropped+' · missing sequences '+this.transcript.gaps+(this.transcript.truncated?' · public display truncated; earlier text may be missing.':' · bounded public message stream.'));
    if(this.tabs) {
      const active=this.tabs.active(),history=this.tabs.recording()?.recorded;
      this.text('codex-events-note',active?.kind==='draft'?'Unsent local draft. No native thread or message has been created.':history?`Saved public history: ${history.result.entries.length} entries · ${history.result.completeness} · ${history.loadedAt}${history.result.marker?' · '+history.result.marker:''}`:'No saved public history has been loaded.');
      if(active?.kind==='draft')this.text('codex-policy','Local draft. Start explicitly to create a read-only native thread; sending remains a separate action.');
    }
    const approvals=s?.approvals??[],approvalSignature=JSON.stringify(approvals);
    if(approvalSignature!==this.approvalSignature){this.approvalSignature=approvalSignature;const host=this.el('codex-approvals');host.replaceChildren();for(const approval of approvals)this.renderApproval(host,approval);}
    this.el('codex-approval-section').hidden=!approvals.length;
    this.el('codex-unknown').hidden=!this.uncertain.size;
    this.text('codex-unknown-requests',[...this.uncertain].map(([id,u])=>{const r=this.state?.actions.find(r=>r.requestId===id);return id+' · '+u.input.action+' · '+(r?.state??'not found in recorded actions')+(r?.errorCode?' · '+r.errorCode:'');}).join('\n'));
    const actions=this.el('codex-actions');actions.replaceChildren();for(const r of this.state?.actions??[])actions.append(this.make('p',r.requestId+' · '+r.action+' · native acknowledgement '+r.state+(r.errorCode?' · '+r.errorCode:''),'hint mono'));
    this.renderControls();
  }
  private renderApproval(host:HTMLElement,a:Approval) {
    const card=this.make('article',undefined,'codex-approval');card.dataset.handle=a.handle;
    card.append(this.make('h3',a.method==='item/fileChange/requestApproval'?'Review scoped file changes':'Review command'),this.make('pre','Connection '+a.connectionId+'\nThread '+a.threadId+'\nTurn '+a.turnId+'\nApproval '+a.handle+'\nItem '+a.itemId+'\nServer request '+a.serverRequestId),this.make('p',a.reason??'No reason reported.','hint'));
    if(a.command!==null)card.append(this.make('h3','Command'),this.make('pre',a.command));
    card.append(this.make('p','Working directory: '+(a.cwd??'Not reported'),'hint mono'));
    if(a.changes?.length)for(const change of a.changes){card.append(this.make('h3',change.kind+' · '+change.path+(change.movePath?' → '+change.movePath:'')),this.make('pre',change.diff));}
    else if(a.method==='item/fileChange/requestApproval')card.append(this.make('p','No complete scoped file diff available. Acceptance is disabled.','hint'));
    const row=this.make('div',undefined,'button-row');
    for(const decision of ['accept','decline','cancel'] as const){const button=this.make('button',decision==='accept'?'Review acceptance…':decision==='decline'?'Decline':'Cancel request',decision==='accept'?'':'secondary');button.type='button';button.dataset.decision=decision;button.addEventListener('click',()=>{if(decision==='accept')this.openApproval(a);else void this.dispatch('approval',{threadId:a.threadId,turnId:a.turnId,handle:a.handle,decision});});row.append(button);}
    card.append(row);host.append(card);
  }
  private renderControls() {
    this.renderUsage();
    this.renderAssets();
    const s=this.snapshot(),t=s?.thread,activeThread=(!this.tabs||this.tabs.bound(this.state))?t:null,
      normal=this.normal()&&!this.tabTransition,connected=!!s,selection=this.displaySelection(),pair=selection?.model===this.value('codex-model')&&selection?.effort===this.value('codex-effort');
    const disable=(id:string,value:boolean)=>{this.el<HTMLButtonElement>(id).disabled=value;};
    const pending=(action:string)=>[...this.pending.values()].some(p=>p.action===action);
    disable('codex-connect',!this.fresh||this.stopped||connected||!!this.pending.size||!!this.uncertain.size||!!this.state?.connecting||!!this.state?.closing);
    this.el<HTMLTextAreaElement>('codex-composer').disabled=this.tabs?.persistenceStatus()==='native-loading';
    disable('codex-disconnect',this.stopped||!s||pending('disconnect'));
    const reportedPair=s?.models.some(model=>model.model===this.value('codex-model')&&model.efforts.includes(this.value('codex-effort')));
    disable('codex-select',!this.canSelectModel()||pair||!reportedPair);
    disable('codex-model',!this.canSelectModel());disable('codex-effort',!this.canSelectModel());
    const subscription=s?.account?.auth==='subscription'&&s.account.requiresOpenaiAuth;
    disable('codex-thread-start',this.preparingMessage||!this.canStartThread());disable('codex-thread-resume',this.preparingMessage||(this.tabs?!!this.tabBlockReason()||!this.tabs.saved().some(row=>row.threadId===this.value('codex-resume-id')):!normal||!!t||!pair||!subscription||!text(this.value('codex-resume-id'))));
    const start = this.doc.getElementById('codex-conversation-start') as HTMLButtonElement | null;
    if (start) {
      start.hidden = !s?.connected || (this.tabs?this.tabs.active()?.kind!=='draft':!!t);
      start.disabled = this.preparingMessage||!this.canStartConversation();
      start.textContent = pending('thread-start') ? 'Starting conversation…' : 'Start conversation';
      start.setAttribute('aria-busy', String(pending('thread-start')));
    }
    const onboardingStatus = this.doc.getElementById('codex-onboarding-status');
    if (onboardingStatus) onboardingStatus.textContent = this.api.safe(
      this.uncertain.size ? 'Confirmation is uncertain. Review the recorded request.' :
      pending('thread-start') ? 'Waiting for confirmation. Your message has not been sent.' :
      activeThread?.configured ? 'Your conversation is ready. Send a message to begin.' :
      !this.canStartConversation() ? 'Conversation setup is unavailable in the current connection state.' :
      !this.startPairReady() ? 'Choose a model and effort to continue.' : 'Starting a conversation won’t send your message.');
    disable('codex-grant',!this.providerAllowsCodex()||!normal||!activeThread?.configured||activeThread.writeGranted||!IDLE.includes(activeThread.turnStatus));
    disable('codex-revoke',this.stopped||!t?.configured||pending('revoke-writes'));
    const ownedTask=this.currentTask();this.text('codex-interrupt',ownedTask?'Stop task':'Interrupt current turn');
    disable('codex-interrupt',this.stopped||(!ownedTask&&(!t?.turnId||!['starting','inProgress'].includes(t.turnStatus)))||pending('turn-interrupt')||pending('task-stop'));
    this.renderComposer();
    disable('codex-acknowledge',!this.canAcknowledge());
    for(const card of Array.from(this.el('codex-approvals').children)){const a=s?.approvals.find(a=>a.handle===(card as HTMLElement).dataset.handle);for(const b of Array.from(card.querySelectorAll<HTMLButtonElement>('button[data-decision]')))b.disabled=this.stopped||!a||a.connectionId!==s?.connectionId||a.threadId!==t?.threadId||a.turnId!==t?.turnId||a.expiresAt<=Date.now()||[...this.pending.values()].some(p=>p.action==='approval'&&p.handle===a.handle)||(b.dataset.decision==='accept'&&(!this.fresh||!!this.uncertain.size||!approvalEligible(this.state,a)));}
    this.renderPicker();
    this.tabs?.render(!!this.tabBlockReason());
  }
  /** The input hot path only validates the composer; no tabs, catalogue or state notifications. */
  private renderComposer():void {
    const s=this.snapshot(),t=(!this.tabs||this.tabs.bound(this.state))?s?.thread:null;
    const normal=this.normal()&&!this.tabTransition,message=this.value('codex-composer'),size=utf8(message),draftBlocked=this.draftNeedsReview();
    const disabled=(id:string,value:boolean)=>{const button=this.el<HTMLButtonElement>(id);if(button.disabled!==value)button.disabled=value;};
    const active=!!t&&['starting','inProgress','cancelling'].includes(t.turnStatus);
    const submit=this.el<HTMLButtonElement>('codex-submit');submit.type=active?'button':'submit';
    const taskState=active?'active':'idle';
    if(submit.dataset.taskState!==taskState){
      submit.dataset.taskState=taskState;submit.setAttribute('aria-label',active?'Stop task':'Send message');
      const path=submit.querySelector?.('svg path');path?.setAttribute('d',active?'M7 7h10v10H7Z':'M12 19V5m-6 6 6-6 6 6');
      path?.setAttribute('fill',active?'currentColor':'none');
    }
    const controls=submit.closest?.<HTMLElement>('.composer-controls');if(controls)controls.dataset.taskActive=String(active);
    disabled('codex-submit',active?!this.providerAllowsCodex()||!this.fresh||!t?.turnId||t.turnStatus==='cancelling'||[...this.pending.values()].some(input=>input.action==='turn-interrupt'||input.action==='task-stop'):this.preparingMessage||!this.messageTargetReady()||!message.trim()||size>CODEX_INPUT_BYTES||draftBlocked);
    this.el('codex-draft-review').hidden=!draftBlocked;
    const notice=draftBlocked?this.restoredWorkflowDraft?'Restored draft. Review it for this conversation and model before sending.':'Workflow draft context changed. Your unsent text is preserved; review it for this conversation before sending.':'';
    if(this.el('codex-draft-review-notice').textContent!==notice)this.text('codex-draft-review-notice',notice);
    disabled('codex-draft-review-button',!draftBlocked||!normal||!t?.configured||!IDLE.includes(t.turnStatus)||!this.workflowModelSelection());
    this.text('codex-input-size',size+' / '+CODEX_INPUT_BYTES+' UTF-8 bytes · Submit starts a native turn.');
    this.el('codex-input-size').className=size>CODEX_INPUT_BYTES?'hint warning':'visually-hidden';
    disabled('codex-confirm-submit',!this.el<HTMLInputElement>('codex-confirm-check').checked||!this.confirmationValid());
  }
  private openGrant() {
    if(!this.providerAllowsCodex())return;
    if(this.tabTransition||this.tabs&&!this.tabs.bound(this.state))return;
    const t=this.snapshot()?.thread;if(!t||!this.normal()||!IDLE.includes(t.turnStatus))return;
    this.confirmation={action:'grant-writes',fields:{threadId:t.threadId},fingerprint:this.scope(),connectionId:this.snapshot()!.connectionId,generation:this.generation};
    this.text('codex-confirm-title','Grant workspace writes to this thread');
    this.text('codex-confirm-preview','Connection '+this.snapshot()!.connectionId+'\nThread '+t.threadId+'\nTurn '+(t.turnId??'Not started')+'\nWorkspace '+this.state!.projectPath+'\nScope: this workspace only, network disabled, individual native approvals remain required.');
    this.showConfirmation();
  }
  private openApproval(a:Approval) {
    const current=this.snapshot()?.approvals.find(v=>v.handle===a.handle);
    if(!current||approvalFingerprint(current)!==approvalFingerprint(a)||!this.fresh||this.uncertain.size||!approvalEligible(this.state,current))return;
    this.confirmation={action:'approval',fields:{threadId:a.threadId,turnId:a.turnId,handle:a.handle,decision:'accept'},fingerprint:approvalFingerprint(a),connectionId:a.connectionId,generation:this.generation};
    this.text('codex-confirm-title','Accept this exact native request');
    this.text('codex-confirm-preview','Connection '+a.connectionId+'\nThread '+a.threadId+'\nTurn '+a.turnId+'\nApproval '+a.handle+'\nItem '+a.itemId+'\nWorkspace '+this.state!.projectPath+'\nWorking directory '+(a.cwd??'Not reported')+'\nCommand '+(a.command??'Not applicable')+'\n'+(a.changes??[]).map(c=>c.kind+' '+c.path+(c.movePath?' → '+c.movePath:'')+'\n'+c.diff).join('\n\n'));
    this.showConfirmation();
  }
  private showConfirmation(){this.el<HTMLInputElement>('codex-confirm-check').checked=false;this.text('codex-confirm-warning','Confirm only the exact connection, thread, turn and request shown.');this.el<HTMLDialogElement>('codex-confirm').showModal();this.renderControls();}
  private closeConfirmation(){this.confirmation=null;const dialog=this.el<HTMLDialogElement>('codex-confirm');if(dialog.open)dialog.close();}
  private confirmationValid() {
    const c=this.confirmation;if(!c||c.generation!==this.generation||c.connectionId!==this.snapshot()?.connectionId||!this.fresh||this.uncertain.size)return false;
    if(c.action==='review-draft')return c.fields.text===this.value('codex-composer')&&this.normal()&&!!this.workflowModelSelection()&&!!this.snapshot()?.thread?.configured&&IDLE.includes(this.snapshot()!.thread!.turnStatus)&&this.draftNeedsReview()&&c.fingerprint===this.draftContextFingerprint();
    if(c.action==='grant-writes')return this.providerAllowsCodex()&&this.normal()&&c.fingerprint===this.scope()&&!!this.snapshot()?.thread&&!this.snapshot()!.thread!.writeGranted&&IDLE.includes(this.snapshot()!.thread!.turnStatus);
    const a=this.snapshot()?.approvals.find(a=>a.handle===c.fields.handle);return !!a&&c.fingerprint===approvalFingerprint(a)&&approvalEligible(this.state,a);
  }
  private async confirm() {
    const c=this.confirmation;if(!c||!this.el<HTMLInputElement>('codex-confirm-check').checked)return;
    await this.refresh();if(this.confirmation!==c||!this.confirmationValid()){this.text('codex-confirm-warning','The native scope or preview changed. Close this confirmation and review current state.');return;}
    if(c.action==='review-draft'){this.reviewedDraftTarget={context:this.draftContextFingerprint(),text:this.value('codex-composer')};this.closeConfirmation();this.text('codex-notice','Draft re-reviewed for this conversation. No turn was submitted and no permission changed.');this.renderControls();return;}
    this.closeConfirmation();await this.dispatch(c.action,c.fields);
  }
}

// ------------------------------------------------------------- task proposals
// Display-only proposals for the exact owned task in the bound conversation.
// Proposal text is rendered as plain text and never becomes an instruction,
// approval, grant, workflow result or continuation.
export const TASK_PROPOSAL_LIMITS = Object.freeze({ promptBytes: 16384, textBytes: 65536, entries: 8, polls: 90 });
const PROPOSAL_STATES = ['reserved','proposed','failed','unknown'] as const;
const PROPOSAL_REASONS: Record<string,string> = {
  worker_unavailable:'Codex was unavailable.', worker_failed_before_dispatch:'Codex could not start.', dispatch_uncertain:'The request may not have finished.',
  parent_retired:'The task stopped first.', output_rejected:'The reply could not be shown.', worker_close_unconfirmed:'Codex did not close cleanly.',
  daemon_restarted_no_replay:'Arcane restarted first.', journal_failure:'It could not be saved.',
};
export interface TaskProposalRead { connectionId: string; threadId: string; taskId: string }
export interface TaskProposalStart extends TaskProposalRead { requestId: string; action: 'proposal-start'; text: string }
export interface TaskProposalView {
  proposalId: string; requestId: string; state: typeof PROPOSAL_STATES[number]; reason: string | null;
  text: string | null; textSha256: string | null; textBytes: number | null; createdAt: string; updatedAt: string;
}
export interface TaskProposalReceipt { state: 'acknowledged'|'rejected'|'unknown'|'pending'; errorCode: string | null; proposalId: string | null; replayed: boolean }
export interface TaskProposalScope {
  readonly projectPath: string; readonly chatKey: string | null; readonly connectionId: string; readonly threadId: string; readonly sessionId: string | null;
  readonly taskId: string; readonly active: boolean; readonly account: string; readonly model: string; readonly effort: string;
}
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const wellFormed = (value: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const isoTime = (value: unknown) => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
/** Strict bounded projection of one scoped proposal list. */
export function readTaskProposals(value: unknown, taskId: string): TaskProposalView[] {
  if (!dataObject(value, ['proposals']) || !dataObject(value.proposals, ['taskId','display','proposals'])) throw new Error('Invalid proposal envelope.');
  const list = value.proposals;
  if (list.taskId !== taskId || list.display !== 'proposal_not_applied' || !Array.isArray(list.proposals) || list.proposals.length > TASK_PROPOSAL_LIMITS.entries) throw new Error('Invalid proposal scope.');
  const ids = new Set<string>();
  return list.proposals.map(row => {
    if (!dataObject(row, ['proposalId','requestId','state','reason','text','textSha256','textBytes','createdAt','updatedAt']) || !uuid(row.proposalId) || !uuid(row.requestId) ||
        ids.has(row.proposalId) || !PROPOSAL_STATES.includes(row.state as never) || !(row.reason === null || typeof row.reason === 'string' && Object.hasOwn(PROPOSAL_REASONS, row.reason)) ||
        !isoTime(row.createdAt) || !isoTime(row.updatedAt)) throw new Error('Invalid proposal.');
    ids.add(row.proposalId);
    if (row.state === 'proposed') {
      if (row.reason !== null || typeof row.text !== 'string' || !row.text.length || !wellFormed(row.text) || typeof row.textSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.textSha256) ||
          typeof row.textBytes !== 'number' || utf8Bytes(row.text) !== row.textBytes || row.textBytes > TASK_PROPOSAL_LIMITS.textBytes) throw new Error('Invalid proposal text.');
    } else if (row.text !== null || row.textSha256 !== null || row.textBytes !== null || (row.state === 'reserved') !== (row.reason === null)) throw new Error('Invalid proposal outcome.');
    return { proposalId: row.proposalId, requestId: row.requestId, state: row.state as TaskProposalView['state'], reason: row.reason as string | null, text: row.text as string | null,
      textSha256: row.textSha256 as string | null, textBytes: row.textBytes as number | null, createdAt: row.createdAt as string, updatedAt: row.updatedAt as string };
  });
}
/** Exact receipt for the exact request; anything else is uncertain, never resent. */
export function readTaskProposalReceipt(value: unknown, input: TaskProposalStart): TaskProposalReceipt {
  if (!dataObject(value, ['record','replayed','state']) || typeof value.replayed !== 'boolean') throw new Error('Invalid proposal receipt.');
  const r = value.record, keys = ['requestId','action','connectionId','state','errorCode','threadId','turnId','model','effort','createdAt','finishedAt'];
  if (!dataObject(r, object(r) && Object.hasOwn(r, 'proposalId') ? [...keys,'proposalId'] : keys) || r.requestId !== input.requestId || r.action !== 'proposal-start' ||
      r.connectionId !== input.connectionId || !['acknowledged','rejected','unknown','pending'].includes(String(r.state)) || !(r.errorCode === null || text(r.errorCode,64)) ||
      r.threadId!==input.threadId||!(r.turnId===null||text(r.turnId))||!(r.model===null||text(r.model))||!(r.effort===null||text(r.effort,64))||
      !isoTime(r.createdAt)||!(r.finishedAt===null||isoTime(r.finishedAt))||
      (r.state === 'acknowledged') !== uuid(r.proposalId) || Object.hasOwn(r,'proposalId') && !uuid(r.proposalId)) throw new Error('Invalid proposal receipt.');
  readCodexState(value.state);
  return { state: r.state as TaskProposalReceipt['state'], errorCode: r.errorCode as string | null, proposalId: uuid(r.proposalId) ? r.proposalId : null, replayed: value.replayed };
}
async function proposalDigestsMatch(entries: readonly TaskProposalView[]): Promise<boolean> {
  for (const entry of entries) if (entry.text !== null) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entry.text));
    if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('') !== entry.textSha256) return false;
  }
  return true;
}
const proposalKey = (scope: TaskProposalScope | null) => scope ? JSON.stringify([scope.projectPath, scope.chatKey, scope.connectionId, scope.threadId, scope.sessionId, scope.taskId, scope.account, scope.model, scope.effort]) : '';
interface ProposalAttempt { requestId: string; state: 'sending'|'acknowledged'|'rejected'|'uncertain'; code: string | null }
/** Presentation controller mounted beside the conversation text. */
export class TaskProposalPanel {
  #scope: TaskProposalScope | null = null; #key = ''; #generation = 0; #stopped = false;
  #request: AbortController | null = null; #read: AbortController | null = null; #timer: ReturnType<typeof setTimeout> | undefined; #polls = 0;
  #attempt: ProposalAttempt | null = null; #entries: TaskProposalView[] = []; #notice = ''; #reading = false;
  readonly #unsubscribe: () => void;
  readonly root: HTMLElement; readonly #input: HTMLTextAreaElement; readonly #button: HTMLButtonElement; readonly #check: HTMLButtonElement;
  readonly #status: HTMLElement; readonly #list: HTMLElement;
  static mount(doc: Document, api: CodexChatApi, scope: () => TaskProposalScope | null, subscribe: (listener: () => void) => () => void, options: { pollMs?: number } = {}): TaskProposalPanel | null {
    const anchor = doc.getElementById('codex-messages');
    if (!anchor || doc.getElementById('codex-proposals')) return null;
    return new TaskProposalPanel(doc, anchor, api, scope, subscribe, options.pollMs ?? 1000);
  }
  private constructor(private readonly doc: Document, anchor: HTMLElement, private readonly api: CodexChatApi, private readonly scope: () => TaskProposalScope | null,
      subscribe: (listener: () => void) => () => void, private readonly pollMs: number) {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, id?: string, className?: string, value?: string) => {
      const element = doc.createElement(tag); if (id) element.id = id; if (className) element.className = className; if (value !== undefined) element.textContent = value; return element; };
    this.root = make('section', 'codex-proposals', 'codex-proposals'); this.root.setAttribute('aria-label', 'Task proposals'); this.root.hidden = true;
    const label = make('label', undefined, 'visually-hidden', 'What should the proposal cover?'); label.setAttribute('for', 'codex-proposal-text');
    this.#input = make('textarea', 'codex-proposal-text'); this.#input.rows = 2; this.#input.placeholder = 'What should Codex propose for this task?';
    this.#button = make('button', 'codex-proposal-request', 'secondary', 'Request proposal'); this.#button.type = 'button';
    this.#check = make('button', 'codex-proposal-check', 'secondary', 'Check again'); this.#check.type = 'button'; this.#check.hidden = true;
    const row = make('div', undefined, 'button-row'); row.append(this.#button, this.#check);
    this.#status = make('p', 'codex-proposal-status', 'hint'); this.#status.setAttribute('role', 'status'); this.#status.setAttribute('aria-live', 'polite');
    this.#list = make('ol', 'codex-proposal-list', 'codex-proposal-list');
    this.root.append(make('h3', undefined, undefined, 'Ask for a proposal'), make('p', undefined, 'hint', 'Codex suggests a change for this task. Nothing is applied.'), label, this.#input, row, this.#status, this.#list);
    anchor.after(this.root);
    this.#button.addEventListener('click', event => { void this.#start(event); });
    this.#check.addEventListener('click', event => { if (this.#trusted(event)) void this.#refresh(); });
    this.#input.addEventListener('input', () => this.#render());
    this.#unsubscribe = subscribe(() => this.sync());
    this.sync();
  }
  #trusted(event: Event): boolean {
    const input = event as MouseEvent;
    return event.isTrusted === true && !event.defaultPrevented && input.button === 0 && !input.altKey && !input.ctrlKey && !input.metaKey && !input.shiftKey;
  }
  /** Any scope change stops display work, clears scoped content and ignores late replies. */
  sync(): void {
    if (this.#stopped) return;
    const next = this.scope(), key = proposalKey(next);
    if (key !== this.#key) {
      this.#generation++; this.#request?.abort(); this.#read?.abort(); this.#request = this.#read = null;
      if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
      this.#key = key; this.#attempt = null; this.#entries = []; this.#notice = ''; this.#polls = 0; this.#reading = false; this.#input.value = '';
      this.#list.replaceChildren();
      this.#scope = next;
      if (next) void this.#refresh();
    } else this.#scope = next;
    this.#render();
  }
  stop(): void { this.#stopped = true; this.#generation++; this.#request?.abort(); this.#read?.abort(); if (this.#timer) clearTimeout(this.#timer); this.#unsubscribe(); this.root.remove(); }
  #blocked(): boolean {
    return !this.#scope?.active || this.#reading && !this.#entries.length && !this.#attempt || this.#attempt !== null && this.#attempt.state !== 'rejected' ||
      this.#entries.some(entry => entry.state === 'reserved') || this.#entries.length >= TASK_PROPOSAL_LIMITS.entries;
  }
  async #start(event: Event): Promise<void> {
    const scope = this.#scope, prompt = this.#input.value;
    if (!this.#trusted(event) || !scope || this.#button.disabled || this.#blocked() || !prompt.trim() || utf8Bytes(prompt) > TASK_PROPOSAL_LIMITS.promptBytes || !wellFormed(prompt)) return;
    const generation = this.#generation, requestId = crypto.randomUUID(), controller = new AbortController();
    const attempt: ProposalAttempt = { requestId, state: 'sending', code: null };
    this.#attempt = attempt; this.#request = controller; this.#notice = ''; this.#render();
    try {
      const receipt = await this.api.proposalStart({ requestId, connectionId: scope.connectionId, action: 'proposal-start', threadId: scope.threadId, taskId: scope.taskId, text: prompt }, controller.signal);
      if (generation !== this.#generation) return;
      attempt.state = receipt.state === 'acknowledged' ? 'acknowledged' : receipt.state === 'rejected' ? 'rejected' : 'uncertain'; attempt.code = receipt.errorCode;
      if (attempt.state === 'acknowledged') this.#input.value = '';
    } catch (error) {
      if (generation !== this.#generation) return;
      attempt.state = error instanceof CodexHttpError && !error.unknown ? 'rejected' : 'uncertain';
    } finally {
      if (generation === this.#generation) { this.#request = null; this.#polls = 0; void this.#refresh(); }
    }
  }
  async #refresh(): Promise<void> {
    const scope = this.#scope, generation = this.#generation;
    if (!scope || this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    this.#read?.abort(); const controller = new AbortController(); this.#read = controller; this.#reading = true; this.#render();
    try {
      const entries = await this.api.proposals({ connectionId: scope.connectionId, threadId: scope.threadId, taskId: scope.taskId }, controller.signal);
      if (generation !== this.#generation) return;
      if (!await proposalDigestsMatch(entries)) throw new Error('digest');
      if (generation !== this.#generation) return;
      this.#entries = entries; this.#notice = '';
      // The original attempt is read back by its scoped request ID; it is never resent.
      if (this.#attempt && entries.some(entry => entry.requestId === this.#attempt!.requestId)) this.#attempt = null;
    } catch {
      if (generation !== this.#generation) return;
      this.#notice = 'Proposals could not be read. Use Check again.';
    } finally {
      if (generation === this.#generation) {
        this.#reading = false; this.#read = null;
        const waiting = this.#entries.some(entry => entry.state === 'reserved') || this.#attempt?.state === 'acknowledged' || this.#attempt?.state === 'uncertain';
        if (waiting && !this.#notice && this.#polls < TASK_PROPOSAL_LIMITS.polls) { this.#polls++; this.#timer = setTimeout(() => { void this.#refresh(); }, this.pollMs); }
        this.#render();
      }
    }
  }
  #render(): void {
    const scope = this.#scope, attempt = this.#attempt;
    this.root.hidden = !scope;
    const prompt = this.#input.value, oversized = utf8Bytes(prompt) > TASK_PROPOSAL_LIMITS.promptBytes;
    this.#button.disabled = !scope || this.#blocked() || !prompt.trim() || oversized;
    this.#input.disabled = !scope?.active;
    const waiting = this.#entries.some(entry => entry.state === 'reserved') || attempt?.state === 'acknowledged';
    this.#check.hidden = !(attempt?.state === 'uncertain' || this.#notice || waiting && this.#polls >= TASK_PROPOSAL_LIMITS.polls);
    this.#status.textContent = this.api.safe(
      !scope ? '' : this.#notice ? this.#notice :
      attempt?.state === 'sending' ? 'Requesting a proposal…' :
      attempt?.state === 'uncertain' ? 'The request outcome is unknown. It was not resent; use Check again.' :
      attempt?.state === 'rejected' ? 'The proposal request was refused.' :
      attempt?.state === 'acknowledged' || waiting ? (this.#polls >= TASK_PROPOSAL_LIMITS.polls ? 'Still working. Use Check again.' : 'Working on the proposal…') :
      oversized ? 'Shorten the request to 16 KiB.' :
      !scope.active ? 'Proposals can be requested while this task is running.' :
      this.#entries.length >= TASK_PROPOSAL_LIMITS.entries ? 'This task has reached its proposal limit.' : '');
    const signature = JSON.stringify(this.#entries);
    if (this.#list.dataset.signature === signature) return;
    this.#list.dataset.signature = signature;
    this.#list.replaceChildren(...this.#entries.map(entry => {
      const item = this.doc.createElement('li'), label = this.doc.createElement('p');
      label.className = 'hint';
      label.textContent = entry.state === 'proposed' ? 'Proposal — not applied' : entry.state === 'reserved' ? 'Working on the proposal…' :
        (entry.state === 'failed' ? 'No proposal. ' : 'Outcome unknown; it was not retried. ') + (entry.reason ? PROPOSAL_REASONS[entry.reason] ?? '' : '');
      item.append(label);
      if (entry.text !== null) { const body = this.doc.createElement('pre'); body.className = 'codex-proposal-text'; body.textContent = this.api.safe(entry.text); item.append(body); }
      return item;
    }));
  }
}
