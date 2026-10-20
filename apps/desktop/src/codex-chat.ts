/// <reference lib="dom" />
import type { CodexAction, CodexActionRecord, CodexProductState } from '../../daemon/src/codex-service.js';
import type { RequestedModel } from '../../../packages/core/src/workflow-recipes.js';
import type { NativeWorkflowConversation, WorkflowDraftProvenance } from './workflow-panel.js';
import type { Approval, McpToolCallArgs, Model, SessionEvent, Snapshot } from '../../../packages/codex-client/src/types.js';
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
const TOOL_ARG_TEXT:Record<string,number>={root:64,query:100,name:100,className:64,kind:100};
/** Exact allowlisted live tool identity (server, tool, display-only args); anything else rejects the snapshot. */
function readToolCall(value:unknown):void {
  if(!dataObject(value,['server','tool','args'])||!text(value.server,64)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.server)||!text(value.tool,128)||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.tool))throw new Error('Invalid live tool identity.');
  const args=value.args;if(args===null)return;
  if(value.server!=='arcane'||!dataObject(args)||!Object.keys(args).length||utf8(JSON.stringify(args))>2048)throw new Error('Invalid live tool arguments.');
  const ref=(r:unknown)=>dataObject(r,['root','pathSegments'])&&text(r.root,64)&&Array.isArray(r.pathSegments)&&r.pathSegments.length<=16&&r.pathSegments.every(part=>text(part,100));
  for(const [key,item] of Object.entries(args)){
    const ok=key==='ref'||key==='parent'?ref(item):key==='enabled'?typeof item==='boolean':key==='properties'?dataObject(item)&&Object.keys(item).length>0&&Object.keys(item).length<=6&&Object.entries(item).every(([name,flag])=>/^[A-Za-z]{1,32}$/.test(name)&&flag===true):Object.hasOwn(TOOL_ARG_TEXT,key)&&text(item,TOOL_ARG_TEXT[key]);
    if(!ok)throw new Error('Invalid live tool arguments.');
  }
}

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
    if(Object.hasOwn(event,'tool')&&(event.type!=='item'||event.itemType!=='mcpToolCall'||(readToolCall(event.tool),false)))throw new Error('Invalid live tool event.');
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
/** Plain next steps for outages and stopped services; the technical receipt text still follows them. */
export const CODEX_SERVICES_UNREACHABLE_TEXT='Arcane could not reach its local services (they may be restarting). Wait a moment, then try again.';
export const CODEX_SERVICES_SLOW_TEXT='Arcane’s local services did not answer in time. Wait a moment, then try again.';
const CODEX_FAILURE_HINTS:Readonly<Record<string,string>>=Object.freeze({
  CLI_MISSING:'Codex was not found. Install or check it in provider setup, then try again.',
  PROCESS_START:'Codex could not be started. Check it in provider setup, then try again.',
  DISCONNECTED:'Codex disconnected. Reconnect, then send the message again.',
  CLOSED:'Codex disconnected. Reconnect, then send the message again.',
  TIMEOUT:'Codex did not answer in time. Check your internet connection, then try again.',
  REMOTE_REJECTED:'ChatGPT did not accept the request. If your sign-in expired, sign in again in provider setup.',
  DAEMON_RESTART:'Arcane services restarted before this finished. It was not sent again.',
});
/** A friendly first sentence for a recorded native error code; null when none applies. */
export function codexFailureHint(code:string|null|undefined):string|null{return code&&Object.hasOwn(CODEX_FAILURE_HINTS,code)?CODEX_FAILURE_HINTS[code]!:null;}
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
/** Presentation-only usage-limit evidence for the composer notice; never authority to send, retry or switch. */
export interface ProviderUsageLimit { resetsAt:number|null }
/** Turn rejections that name a usage or rate limit (the native client's recorded error code). */
const USAGE_LIMIT_CODES=/^(?:USAGE_LIMIT(?:_EXCEEDED|_REACHED)?|RATE_LIMIT(?:_EXCEEDED|_REACHED)|QUOTA_EXCEEDED|CREDITS_DEPLETED)$/;
/**
 * Whether the signed-in ChatGPT account reports it is out of included usage: the provider's own account verdict
 * (ordinaryUsageAllowed false), a general bucket with a classified limit reason, a spending limit or a 100% window, or
 * the latest turn start on this connection rejected with a usage-limit code. The reset time is the latest reported reset
 * of the exhausted windows, or null when none was reported.
 */
export function codexUsageLimit(snapshot:ChatSnapshot|null|undefined,actions:readonly ChatActionRecord[]=[]):ProviderUsageLimit|null {
  if(!snapshot||snapshot.account?.auth!=='subscription')return null;
  const turn=actions.findLast(row=>row.action==='turn-start'&&row.connectionId===snapshot.connectionId&&row.state!=='pending');
  const rejected=turn?.state==='rejected'&&!!turn.errorCode&&USAGE_LIMIT_CODES.test(turn.errorCode);
  const report=snapshot.rateLimits;
  let buckets:NonNullable<ChatSnapshot['rateLimits']>['buckets']=[];
  if(report){
    try{readRateLimits(report);}catch{return rejected?{resetsAt:null}:null;}
    const full=(w:{usedPercent:number}|null)=>!!w&&w.usedPercent>=100;
    const blocked=(b:typeof report.buckets[number])=>b.rateLimitReachedType!==null||b.spendControlReached===true||full(b.primary)||full(b.secondary);
    buckets=report.ordinaryUsageAllowed===true?[]:report.ordinaryUsageAllowed===false?report.buckets:report.buckets.filter(b=>b.normalModelSlug===null&&blocked(b));
    if(report.ordinaryUsageAllowed===false&&buckets.some(blocked))buckets=buckets.filter(blocked);
  }
  if(!buckets.length&&!rejected)return null;
  const resets=buckets.flatMap(b=>[b.primary,b.secondary]).filter(w=>!!w&&w.usedPercent>=100&&w.resetsAt!==null).map(w=>w!.resetsAt!);
  return{resetsAt:resets.length?Math.max(...resets):null};
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
    } catch(error) {if(error instanceof CodexHttpError)throw error;
      // A refused connection (services stopped or restarting) or our own deadline: plain words, same uncertainty rules.
      if(error instanceof TypeError&&/fetch|network/i.test(error.message))throw new CodexHttpError(CODEX_SERVICES_UNREACHABLE_TEXT,mutable);
      if(error instanceof Error&&error.name==='AbortError'&&!signal?.aborted)throw new CodexHttpError(CODEX_SERVICES_SLOW_TEXT,mutable);
      throw new CodexHttpError(this.safe(error instanceof Error?error.message:'Native HTTP response unavailable.'),mutable);}
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
  /** Human-only display read of one succeeded script edit's recorded before/after source. It never changes Studio. */
  async scriptChange(commandId:string,signal?:AbortSignal):Promise<ScriptChangeSources>{
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(commandId)||!/^[a-f0-9]{64}$/.test(this.#token))throw new CodexHttpError('Choose one recorded script edit.',false);
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(abort,this.deadline);
    try{
      const transport=this.transport;
      const response=await transport('/v1/studio/script-diff/'+encodeURIComponent(commandId),{method:'GET',headers:{Authorization:'Bearer '+this.#token},
        signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
      if(response.status!==200||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw new Error('This script change is not available.');
      const reader=response.body?.getReader();if(!reader)throw new Error('Script change response has no body.');
      const chunks:Uint8Array[]=[];let length=0;
      try{for(;;){const part=await reader.read();if(part.done)break;
        length+=part.value.byteLength;if(length>SCRIPT_CHANGE_BYTES){await reader.cancel();throw new Error('Script change response exceeded its bound.');}chunks.push(part.value);
      }}finally{reader.releaseLock();}
      const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
      const change=readScriptChange(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown,commandId);
      if(!change)throw new Error('Script change response was not recognized.');
      return change;
    }catch(error){throw new CodexHttpError(this.safe(error instanceof Error?error.message:'Script change unavailable.'),false);}
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
export interface ChatMessage { key: string; role: 'human'|'codex'|'tool'; scope: string; text: string; acknowledgement?: string; threadId?: string; toolState?: ToolActivityState; toolCall?: LiveToolCall }
/** Live Arcane tool identity from the native item event: tool name plus allowlisted display arguments. Presentation only. */
export interface LiveToolCall { name:string; input:McpToolCallArgs|null }
type TurnCounts={inputTokens:number;cachedInputTokens:number;outputTokens:number};
/** One turn's token counts from native usage reports: the thread total before its first request, and the latest total. */
export interface TurnUsageRow { baseline:TurnCounts; latest:TurnCounts }
/** Input for a finished reply's usage line (the same '12k tokens (~$0.31)' line the Claude chat shows). */
export interface ReplyUsageInput extends TurnCounts { model:string|null; tokens:number }
export type ReplyUsageFormat=(usage:ReplyUsageInput)=>{text:string;title:string}|null;
/** The turn's own tokens (latest total minus its baseline); null when the reports went backwards or are empty. */
export function turnReplyUsage(row:TurnUsageRow|undefined,model:string|null):ReplyUsageInput|null {
  if(!row)return null;
  const input=row.latest.inputTokens-row.baseline.inputTokens,cached=row.latest.cachedInputTokens-row.baseline.cachedInputTokens,output=row.latest.outputTokens-row.baseline.outputTokens;
  if(input<0||cached<0||output<0||input+output===0)return null;
  return {model,tokens:input+output,inputTokens:input,cachedInputTokens:Math.min(cached,input),outputTokens:output};
}
const TURN_USAGE_ROWS=256,TERMINAL_TURNS=new Set(['completed','failed','interrupted']);
const turnCounts=(v:TurnCounts):TurnCounts=>({inputTokens:v.inputTokens,cachedInputTokens:v.cachedInputTokens,outputTokens:v.outputTokens});
const bounded=<T>(set:Map<string,T>|Set<string>)=>{while(set.size>TURN_USAGE_ROWS)set.delete(set.keys().next().value!);};
export class CodexTranscript {
  connectionId=''; cursor=0; gaps=0; dropped=0; truncated=false; messages:ChatMessage[]=[];
  /** Per-turn token usage and finished turns, keyed thread\0turn. Presentation only. */
  turnUsage=new Map<string,TurnUsageRow>(); finishedTurns=new Set<string>();
  reset(id='') {this.connectionId=id;this.cursor=0;this.gaps=0;this.dropped=0;this.truncated=false;this.messages=[];this.turnUsage.clear();this.finishedTurns.clear();}
  rebind(id:string) {this.connectionId=id;this.cursor=0;this.gaps=0;this.dropped=0;}
  consume(snapshot:ChatSnapshot) {
    if(snapshot.connectionId!==this.connectionId)this.reset(snapshot.connectionId);
    if(snapshot.lastEventSeq<this.cursor)throw new Error('Older native event snapshot discarded; refresh current state.');
    this.dropped=Math.max(this.dropped,snapshot.droppedEvents);
    for(const event of snapshot.events) {
      const seq=eventSequence(event);if(seq<=this.cursor)continue;
      this.gaps+=Math.max(0,seq-this.cursor-1);this.cursor=seq;
      if(event.type==='item'&&event.itemType==='mcpToolCall'){
        // Live tool calls report their state and, for Arcane, the tool name and display arguments, so the line reads the
        // same as the Claude chat while it runs; the saved history later adds the real result.
        const key=event.threadId+'\0'+event.turnId+'\0'+event.itemId,toolState:ToolActivityState=event.status==='failed'?'failed':event.status==='completed'?'finished':'started';
        const toolCall:LiveToolCall|undefined=event.tool?.server==='arcane'?{name:event.tool.tool,input:event.tool.args}:undefined;
        const existing=this.messages.find(m=>m.role==='tool'&&m.key===key);
        if(existing){existing.toolState=toolState;if(toolCall)existing.toolCall=toolCall;}
        else this.messages.push({key,role:'tool',threadId:event.threadId,scope:event.threadId+' · '+event.turnId+' · '+event.itemId,text:'',toolState,...(toolCall?{toolCall}:{})});
        continue;
      }
      if(event.type==='usage'){
        const key=event.threadId+'\0'+event.turnId,{total,last}=event.usage,row=this.turnUsage.get(key);
        if(row)row.latest=turnCounts(total);
        else{this.turnUsage.set(key,{baseline:{inputTokens:total.inputTokens-last.inputTokens,cachedInputTokens:total.cachedInputTokens-last.cachedInputTokens,outputTokens:total.outputTokens-last.outputTokens},latest:turnCounts(total)});bounded(this.turnUsage);}
        continue;
      }
      if(event.type==='turn'){if(TERMINAL_TURNS.has(event.status)){this.finishedTurns.add(event.threadId+'\0'+event.turnId);bounded(this.finishedTurns);}continue;}
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
// ------------------------------------------------------------- auto-approval
// With the project's "Auto-approve edits and tool use" switch on (Settings > Permissions, persisted per project by the
// desktop host), a request is accepted without a click only when it is ALREADY acceptable by hand (approvalEligible:
// exact connection/thread/turn, workspace writes granted for this task, subscription account, unexpired, the native
// policy's own safe-to-accept flag, every path inside the workspace) AND none of the hard fences below match. Fenced
// requests keep the normal review card. Revoke, interrupt and disconnect stay one click away; every accept is the same
// recorded native approval action as a manual one.
const SENSITIVE_PATH=/(^|\/)(\.git|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker)(\/|$)|(^|\/)\.env($|\.)|(^|\/)(\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_rsa|id_ed25519|id_ecdsa)$|\.(pem|key|pfx|p12|keystore)$|secret|credential|password|token/i;
/** Files that steer later agent runs or tooling (persistent prompt injection, hooks, tasks): always a human review. */
const AGENT_CONFIG_PATH=/(^|\/)(ARCANE\.md|AGENTS\.md|CLAUDE\.md|\.mcp\.json)$|(^|\/)\.(claude|codex|vscode|arcane|github|husky)(\/|$)/i;
const COMMAND_FENCES:readonly (readonly [RegExp,string])[]=[
  [/\b(rm|rmdir|del|erase|rd|remove-item|shred|mkfs|diskpart|truncate|clear-content|clear-recyclebin)\b|(^|[;&|]\s*)format\b|\bdd\s+if=/i,'deletes or overwrites data'],
  [/\bgit\s+(reset|clean|checkout|restore|rebase|stash|filter-branch|filter-repo|gc|prune|update-ref|reflog)\b|\bgit\s+branch\s+-[dD]\b|\bgit\s+tag\s+-d\b/i,'rewrites version history'],
  [/\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|start-bitstransfer|ssh|scp|sftp|ftp|rsync|nc|ncat|netcat|telnet|invoke-command|enter-pssession|new-pssession)\b|\bgit\s+(clone|fetch|pull|push|remote|submodule)\b|https?:\/\/|\bwww\./i,'uses the network'],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|update|upgrade|up|publish|login|adduser|exec|dlx|x|link)\b|\b(npx|pnpx|bunx|pipx|choco|winget|scoop|brew|apt|apt-get|dnf|yum|gem|docker|podman|kubectl|gh|az|aws|gcloud)\b|\b(pip3?|uv|poetry|cargo|go|dotnet)\s+(install|add|get|publish|tool)\b/i,'installs software or uses an online service'],
  [/\b(publish|deploy|upload|release)\b|\brojo\s+upload\b|\bmantle\b|\brbxcloud\b/i,'publishes or deploys'],
  [/\$env:|%[A-Za-z_][A-Za-z0-9_]*%|\$HOME\b|\$\{|(^|[\s"'=])~(?=[\\/\s]|$)|\benv:|\b(printenv|get-credential|cmdkey|vaultcmd|convertfrom-securestring|keychain)\b|\.ssh\b|\.aws\b|\.git-credentials|\.npmrc|\.netrc|(^|[\s\\/"'])\.env\b|\b(secret|credential|password|passwd|token)s?\b/i,'reads environment variables or credentials'],
  [/\b(shutdown|reboot|restart-computer|stop-computer|reg|regedit|bcdedit|netsh|icacls|takeown|attrib|chmod|chown|sudo|runas|setx|schtasks|crontab|set-executionpolicy|taskkill|stop-process|kill|pkill|killall)\b|\bnet\s+(user|localgroup|share|use)\b|\bsc(\.exe)?\s+(delete|stop|config|create)\b/i,'changes the system or other processes'],
  [/\b(iex|invoke-expression|eval|frombase64string)\b|-enc(odedcommand)?\b|base64\s+(-d|--decode)|\|\s*(sh|bash|zsh|pwsh|powershell|cmd)\b|`|\$\(/i,'runs hidden or generated code'],
  // Obfuscation and indirection the fences above cannot see through (cmd carets and %VAR:~x,y% slices, PowerShell's
  // abbreviated -e/-ec/-en… encoded command, dynamic `& (...)` / `.('…')` calls, .NET static calls, inline interpreter code).
  [/[A-Za-z]\^[A-Za-z]|%[^%\s]+%|![A-Za-z_][A-Za-z0-9_]*!|\b(powershell|pwsh)(\.exe)?\b[^|;&]*\s[-/]e(c|n[a-z]*)?\b|(^|[\s;|&({])[&.]\s*[('"$]|\[[A-Za-z_][\w.]*\]\s*::|\b(new-object|add-type|start-process|saps|invoke-item|mshta|rundll32|regsvr32|certutil|bitsadmin|msiexec|wscript|cscript)\b|\b(node|deno|bun|python3?|py|ruby|perl|php)(\.exe)?\s+(?:-{1,2}[\w-]+\s+)*(-e|--eval|-p|--print|-c|-r|eval)\b/i,'runs hidden or generated code'],
  [/\b(ri|rp|clear-item|cli|robocopy)\b|\s-delete\b/i,'deletes or overwrites data'],
  [/\b(ping|nslookup|resolve-dnsname|test-netconnection|tnc|test-connection)\b/i,'uses the network'],
  // Links and junctions let later in-workspace edits land outside it; version-control internals (hooks) run code later.
  [/\b(mklink|fsutil|ln)\b|\b(symboliclink|junction|hardlink)\b/i,'creates links that could reach outside the workspace'],
  [/(^|[\s"'=\\/.])\.(git|claude|codex|vscode|arcane|github|husky)(?=[\\/]|$|[\s"';|&])|\b(ARCANE|AGENTS|CLAUDE)\.md\b|\.mcp\.json\b|\bgit\s+(config|-c)\b/i,'touches version-control internals, project memory or agent settings'],
];
/** PowerShell treats en/em dashes and curly quotes like their ASCII forms; fold them so the fences see the same text. */
const foldPunctuation=(text:string)=>text.replace(/[‐-―−]/g,'-').replace(/[‘-‛]/g,"'").replace(/[“-‟]/g,'"');
/** One leading shell wrapper (`powershell -Command "…"`, `bash -lc '…'`, `cmd /c …`) is unwrapped so the real command is checked. */
function innerCommand(command:string):string {
  const m=/^\s*(?:"[^"]*[\\/])?(?:[A-Za-z]:[\\/][^"\s]*[\\/])?(?:powershell|pwsh|cmd|bash|sh|zsh)(?:\.exe)?"?\s+(?:-NoLogo\s+|-NoProfile\s+|-NonInteractive\s+)*(?:-Command|-c|-lc|\/c|\/s\s+\/c)\s+([\s\S]+)$/i.exec(command);
  if(!m)return command;
  const body=m[1]!.trim();
  return /^(["']).*\1$/s.test(body)?body.slice(1,-1):body;
}
/** Absolute paths outside the workspace and parent-directory escapes are fenced (the null device is fine). */
function commandEscapesRoot(command:string,root:string):boolean {
  const r=root.replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
  if(/(^|[\s"'=:(,;|&<>])\.\.([\\/]|$|[\s"';|&])/.test(command))return true;
  for(const m of command.matchAll(/(?:^|[\s"'=(,;|&<>])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"';|&<>]*)/g)){
    const path=m[1]!.replaceAll('\\','/').toLowerCase();
    if(path==='/dev/null')continue;
    if(path!==r&&!path.startsWith(r+'/'))return true;
  }
  return false;
}
export interface AutoApprovalVerdict { accept: boolean; reason: string }
/** Pure policy: may this exact pending request be accepted automatically? Never weaker than approvalEligible. */
export function autoApprovalVerdict(state:ChatState|null,a:Approval):AutoApprovalVerdict {
  if(!approvalEligible(state,a))return {accept:false,reason:'it is outside the reviewed scope'};
  const root=state!.projectPath;
  if(a.method==='item/fileChange/requestApproval') {
    const changes=a.changes??[];
    if(changes.some(c=>c.kind==='delete'))return {accept:false,reason:'it deletes files'};
    if(changes.some(c=>SENSITIVE_PATH.test(c.path.replaceAll('\\','/'))||c.movePath!==null&&SENSITIVE_PATH.test(c.movePath.replaceAll('\\','/'))))return {accept:false,reason:'it touches version-control or credential files'};
    if(changes.some(c=>AGENT_CONFIG_PATH.test(c.path.replaceAll('\\','/'))||c.movePath!==null&&AGENT_CONFIG_PATH.test(c.movePath.replaceAll('\\','/'))))return {accept:false,reason:'it changes project memory, agent or tool settings'};
    return {accept:true,reason:changes.length===1?'edit '+changes[0]!.path:'edit '+changes.length+' files'};
  }
  const command=a.command??'';
  if(!command.trim()||command.length>2000||/[\r\n]/.test(command))return {accept:false,reason:'the command is too long to check'};
  const inner=innerCommand(foldPunctuation(command));
  for(const [pattern,reason] of COMMAND_FENCES)if(pattern.test(inner))return {accept:false,reason:'it '+reason};
  if(commandEscapesRoot(inner,root))return {accept:false,reason:'it reaches outside the workspace'};
  return {accept:true,reason:'run '+(inner.length>80?inner.slice(0,79)+'…':inner)};
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

/** Composer nodes shared with another provider's chat; Codex handlers on them pause while the surface is yielded. */
const SHARED_SURFACE_IDS=new Set(['codex-composer','codex-compose','codex-submit']);
/** Model list width with the two provider columns, and the narrowest width that still fits them side by side. */
export const MODEL_COLUMNS_WIDTH=500, MODEL_COLUMNS_MIN=420;
/** The same for three provider columns (ChatGPT, Claude and Arcane Credits). */
export const MODEL_THREE_COLUMNS_WIDTH=720, MODEL_THREE_COLUMNS_MIN=600;
/** Shared model-picker placement: above or below the trigger, inside the visual viewport. */
export function positionComposerPopover(doc:Document,popover:HTMLElement,trigger:HTMLElement,wide:boolean):void {
  const view = doc.defaultView;
  if (popover.hidden || !view) return;
  const viewport = view.visualViewport, margin = 12, gap = 8;
  const leftEdge = (viewport?.offsetLeft ?? 0) + margin, topEdge = (viewport?.offsetTop ?? 0) + margin;
  const width = Math.max(0, (viewport?.width ?? view.innerWidth) - margin * 2);
  const bottomEdge = topEdge + Math.max(0, (viewport?.height ?? view.innerHeight) - margin * 2);
  // Provider columns need room side by side; below the minimum they stack (ChatGPT above Claude above Arcane).
  const options = popover.querySelector<HTMLElement>('#codex-model-options[data-layout=columns]'), columns = wide && !!options;
  const three = columns && options!.dataset.columns === '3';
  const rect = trigger.getBoundingClientRect(), panelWidth = Math.min(three?MODEL_THREE_COLUMNS_WIDTH:columns?MODEL_COLUMNS_WIDTH:wide?300:240, width);
  const above = Math.max(0, rect.top - topEdge - gap), below = Math.max(0, bottomEdge - rect.bottom - gap);
  const useAbove = above >= below;
  if (columns) popover.dataset.columns = panelWidth < (three?MODEL_THREE_COLUMNS_MIN:MODEL_COLUMNS_MIN) ? 'stacked' : 'split'; else delete popover.dataset.columns;
  popover.style.width = panelWidth + 'px';
  popover.style.maxHeight = Math.min(480, useAbove ? above : below) + 'px';
  popover.style.left = Math.max(leftEdge, Math.min(rect.left, leftEdge + width - panelWidth)) + 'px';
  const height = popover.getBoundingClientRect().height;
  popover.style.top = Math.max(topEdge, Math.min(useAbove ? rect.top - gap - height : rect.bottom + gap, bottomEdge - height)) + 'px';
}
// ---- Rich assistant text: a small, bounded markdown subset rendered as DOM nodes with textContent only. Headings (#–####),
// **bold**, *italic*, ~~struck~~, `code`, bullet and numbered lists (two levels), > quotes, rules and GFM pipe tables.
// Links never navigate: the link text is shown with its address beside it. Every scan is linear (indexOf with failure
// memos, no backtracking patterns) and oversized text falls back to plain paragraphs. While a reply streams, an unfinished
// span or table (no closing ** yet, no separator row yet) simply stays literal text until the closing part arrives.
export const MARKDOWN_LIMITS=Object.freeze({chars:200_000,inline:20_000,depth:4,columns:12,rows:100,url:2048});
type MdInline={t:'text';v:string}|{t:'code';v:string}|{t:'strong';c:MdInline[]}|{t:'em';c:MdInline[]}|{t:'del';c:MdInline[]}|{t:'link';c:MdInline[];url:string};
type MdList={t:'list';ordered:boolean;start:number;items:{text:string;sub:MdList|null}[]};
type MdBlock={t:'p';text:string}|{t:'h';level:number;text:string}|{t:'hr'}|{t:'quote';blocks:MdBlock[]}|MdList
  |{t:'table';align:string[];head:string[];rows:string[][]};
const MD_PUNCT='!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const mdSpace=(c:string|undefined)=>c===undefined||c===' '||c==='\t'||c==='\n';
const mdWord=(c:string|undefined)=>c!==undefined&&/[\p{L}\p{N}]/u.test(c);
const mdRun=(s:string,i:number,c:string)=>{let j=i;while(s[j]===c)j++;return j-i;};
/** Inline spans. Each opener searches forward once; a failed search is remembered so later openers of that kind stay literal. */
export function parseInline(s:string,depth=0,links=true):MdInline[] {
  if(s.length>MARKDOWN_LIMITS.inline||depth>=MARKDOWN_LIMITS.depth)return s?[{t:'text',v:s}]:[];
  const out:MdInline[]=[],failed=new Set<string>();let buf='',i=0,close=-2,paren=-2;
  const flush=()=>{if(buf){out.push({t:'text',v:buf});buf='';}};
  while(i<s.length){
    const c=s[i]!;
    if(c==='\\'&&i+1<s.length&&MD_PUNCT.includes(s[i+1]!)){buf+=s[i+1];i+=2;continue;}
    if(c==='`'){
      const k=mdRun(s,i,'`');let end=-1;
      if(!failed.has('`'+k))for(let j=i+k;;){const p=s.indexOf('`',j);if(p<0)break;const m=mdRun(s,p,'`');if(m===k){end=p;break;}j=p+m;}
      if(end<0){failed.add('`'+k);buf+=s.slice(i,i+k);i+=k;continue;}
      let code=s.slice(i+k,end);if(code.length>1&&code[0]===' '&&code.at(-1)===' '&&code.trim())code=code.slice(1,-1);
      flush();out.push({t:'code',v:code});i=end+k;continue;
    }
    if(c==='*'||c==='_'||c==='~'){
      const r=mdRun(s,i,c),size=c==='~'||r>=2?2:1,delim=c.repeat(size),literal=c==='~'?r:size;
      const opens=!(c==='~'&&r<2)&&!failed.has(delim)&&!mdSpace(s[i+size])&&!(c==='_'&&mdWord(s[i-1]));
      let end=-1;
      if(opens)for(let j=i+size;;){
        const p=s.indexOf(delim,j);if(p<0)break;
        const m=mdRun(s,p,c);
        // A single * or _ never closes on part of a longer run (the ** of a nested bold span).
        if(size===1&&m>1){j=p+m;continue;}
        if(p>i+size&&!mdSpace(s[p-1])&&!(c==='_'&&mdWord(s[p+size]))){end=p;break;}
        j=p+1;
      }
      if(end<0){if(opens)failed.add(delim);buf+=s.slice(i,i+literal);i+=literal;continue;}
      flush();out.push({t:c==='~'?'del':size===2?'strong':'em',c:parseInline(s.slice(i+size,end),depth+1,links)});i=end+size;continue;
    }
    if(c==='['&&links&&!failed.has(']')){
      if(close<=i)close=s.indexOf(']',i+1);
      if(close<0){failed.add(']');buf+=c;i++;continue;}
      const label=s.slice(i+1,close);
      if(s[close+1]==='('&&!label.includes('[')&&label.trim()&&!failed.has(')')){
        if(paren<=close+1)paren=s.indexOf(')',close+2);
        if(paren<0)failed.add(')');
        else{
          const url=s.slice(close+2,paren).trim().split(/[ \t]/)[0]!;
          if(url&&url.length<=MARKDOWN_LIMITS.url&&!url.includes('\n')){flush();out.push({t:'link',c:parseInline(label,depth+1,false),url});i=paren+1;continue;}
        }
      }
    }
    buf+=c;i++;
  }
  flush();return out;
}
const mdRule=(line:string)=>{const t=line.replace(/[ \t]/g,'');return t.length>=3&&(t[0]==='-'||t[0]==='*'||t[0]==='_')&&mdRun(t,0,t[0])===t.length&&/^ {0,3}\S/.test(line);};
const mdItem=(line:string)=>{
  const m=/^([ \t]{0,16})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/.exec(line);if(!m)return null;
  const ordered=/\d/.test(m[2]!);
  return {indent:m[1]!.replace(/\t/g,'    ').length,ordered,start:ordered?Number.parseInt(m[2]!,10):1,text:(m[3]??'').trim()};
};
const mdHeading=(line:string)=>{
  const m=/^ {0,3}(#{1,4})[ \t]+(.*)$/.exec(line);if(!m)return null;
  let text=m[2]!.trim(),k=text.length;while(k>0&&text[k-1]==='#')k--;
  if(k<text.length&&(k===0||mdSpace(text[k-1])))text=text.slice(0,k).trim();
  return text?{level:m[1]!.length,text}:null;
};
const mdQuote=(line:string)=>/^ {0,3}>/.test(line);
/** Table cells: outer pipes dropped, split on unescaped pipes (an escaped pipe stays for the inline pass to unescape). */
function mdCells(line:string):string[] {
  let t=line.trim();if(t.startsWith('|'))t=t.slice(1);if(t.endsWith('|')&&!t.endsWith('\\|'))t=t.slice(0,-1);
  const cells:string[]=[];let start=0;
  for(let i=0;i<t.length;i++){if(t[i]==='\\'){i++;continue;}if(t[i]==='|'){cells.push(t.slice(start,i).trim());start=i+1;}}
  cells.push(t.slice(start).trim());return cells;
}
function mdTableStart(lines:string[],i:number):string[]|null {
  const head=lines[i]!,sep=lines[i+1];if(!head.includes('|')||sep===undefined||!sep.includes('-')||sep.length>4096)return null;
  const align=mdCells(sep);if(align.length>MARKDOWN_LIMITS.columns||!align.every(cell=>/^:?-+:?$/.test(cell)))return null;
  return mdCells(head).length===align.length?align.map(cell=>cell.endsWith(':')?cell.startsWith(':')?'center':'right':cell.startsWith(':')?'left':''):null;
}
const mdStarts=(lines:string[],i:number,depth:number)=>{const line=lines[i]!;return mdHeading(line)!==null||mdRule(line)||(depth<2&&mdQuote(line))||mdItem(line)!==null||mdTableStart(lines,i)!==null;};
/** Block structure, line by line. Paragraph lines keep their line breaks; a list may be loose (blank lines between items). */
function parseBlocks(lines:string[],depth=0):MdBlock[] {
  const blocks:MdBlock[]=[];let para:string[]=[],i=0;
  const flush=()=>{if(para.length)blocks.push({t:'p',text:para.join('\n')});para=[];};
  while(i<lines.length){
    const line=lines[i]!;
    if(!line.trim()){flush();i++;continue;}
    const heading=mdHeading(line);
    if(heading){flush();blocks.push({t:'h',...heading});i++;continue;}
    if(mdRule(line)){flush();blocks.push({t:'hr'});i++;continue;}
    if(depth<2&&mdQuote(line)){
      flush();const inner:string[]=[];
      while(i<lines.length&&mdQuote(lines[i]!)){inner.push(lines[i]!.replace(/^ {0,3}> ?/,''));i++;}
      blocks.push({t:'quote',blocks:parseBlocks(inner,depth+1)});continue;
    }
    const align=mdTableStart(lines,i);
    if(align){
      flush();const head=mdCells(line),rows:string[][]=[];i+=2;
      while(i<lines.length&&rows.length<MARKDOWN_LIMITS.rows&&lines[i]!.includes('|')&&lines[i]!.trim()){
        const cells=mdCells(lines[i]!);rows.push(head.map((_,index)=>cells[index]??''));i++;
      }
      blocks.push({t:'table',align,head,rows});continue;
    }
    const first=mdItem(line);
    if(first){
      flush();let list:MdList={t:'list',ordered:first.ordered,start:first.start,items:[]},last:{text:string}|null=null;
      while(i<lines.length){
        const row=lines[i]!;
        if(!row.trim()){
          let next=i+1;while(next<lines.length&&!lines[next]!.trim())next++;
          if(next<lines.length&&!mdRule(lines[next]!)&&mdItem(lines[next]!)){i=next;continue;}
          break;
        }
        const item=mdRule(row)?null:mdItem(row);
        if(item&&item.indent>=first.indent+2&&list.items.length){
          // Second level; anything deeper joins the second level too.
          const parent=list.items.at(-1)!;parent.sub??={t:'list',ordered:item.ordered,start:item.start,items:[]};
          parent.sub.items.push({text:item.text,sub:null});last=parent.sub.items.at(-1)!;i++;continue;
        }
        if(item){
          if(item.ordered!==list.ordered){blocks.push(list);list={t:'list',ordered:item.ordered,start:item.start,items:[]};}
          list.items.push({text:item.text,sub:null});last=list.items.at(-1)!;i++;continue;
        }
        if(!last||mdStarts(lines,i,depth))break;
        last.text+=(last.text?'\n':'')+row.trim();i++;
      }
      blocks.push(list);continue;
    }
    para.push(line.trim());i++;
  }
  flush();return blocks;
}
function mdText(doc:Document,parent:HTMLElement,value:string):void {
  if(typeof doc.createTextNode==='function')parent.append(doc.createTextNode(value));
  else{const span=doc.createElement('span');span.textContent=value;parent.append(span);}
}
const mdLabel=(spans:MdInline[]):string=>spans.map(span=>span.t==='text'||span.t==='code'?span.v:mdLabel(span.c)).join('');
function renderInline(doc:Document,parent:HTMLElement,spans:MdInline[]):void {
  if(spans.length===1&&spans[0]!.t==='text'){parent.textContent=spans[0]!.v;return;}
  for(const span of spans){
    if(span.t==='text'){mdText(doc,parent,span.v);continue;}
    if(span.t==='code'){const code=doc.createElement('code');code.textContent=span.v;parent.append(code);continue;}
    if(span.t==='link'){
      // Never a navigable anchor: the text, with the address in its tooltip and beside it.
      const link=doc.createElement('span');link.className='md-link';link.setAttribute('title',span.url);renderInline(doc,link,span.c);parent.append(link);
      if(mdLabel(span.c).trim()!==span.url){const url=doc.createElement('span');url.className='md-link-url';url.textContent=' ('+span.url+')';parent.append(url);}
      continue;
    }
    const element=doc.createElement(span.t==='strong'?'strong':span.t==='em'?'em':'del');renderInline(doc,element,span.c);parent.append(element);
  }
}
function renderBlocks(doc:Document,parent:HTMLElement,blocks:MdBlock[],inline:(text:string)=>MdInline[]):void {
  for(const block of blocks){
    if(block.t==='p'){const p=doc.createElement('p');renderInline(doc,p,inline(block.text));parent.append(p);continue;}
    if(block.t==='h'){const h=doc.createElement('h'+(block.level+2));h.className='md-heading';renderInline(doc,h,inline(block.text));parent.append(h);continue;}
    if(block.t==='hr'){parent.append(doc.createElement('hr'));continue;}
    if(block.t==='quote'){const quote=doc.createElement('blockquote');renderBlocks(doc,quote,block.blocks,inline);parent.append(quote);continue;}
    if(block.t==='list'){
      const list=doc.createElement(block.ordered?'ol':'ul');if(block.ordered&&block.start!==1)list.setAttribute('start',String(block.start));
      for(const item of block.items){
        const li=doc.createElement('li');
        if(item.sub){const text=doc.createElement('span');renderInline(doc,text,inline(item.text));li.append(text);renderBlocks(doc,li,[item.sub],inline);}
        else renderInline(doc,li,inline(item.text));
        list.append(li);
      }
      parent.append(list);continue;
    }
    const wrap=doc.createElement('div');wrap.className='md-table';wrap.setAttribute('role','region');wrap.setAttribute('aria-label','Table');wrap.tabIndex=0;
    const table=doc.createElement('table'),thead=doc.createElement('thead'),head=doc.createElement('tr');
    const cell=(tag:'th'|'td',value:string,index:number)=>{
      const element=doc.createElement(tag);if(tag==='th')element.setAttribute('scope','col');
      if(block.align[index])element.dataset.align=block.align[index];renderInline(doc,element,inline(value));return element;
    };
    block.head.forEach((value,index)=>head.append(cell('th',value,index)));thead.append(head);table.append(thead);
    if(block.rows.length){const tbody=doc.createElement('tbody');for(const row of block.rows){const tr=doc.createElement('tr');row.forEach((value,index)=>tr.append(cell('td',value,index)));tbody.append(tr);}table.append(tbody);}
    wrap.append(table);parent.append(wrap);
  }
}
/** Markdown text (no ``` fences) as blocks; null when it is plain prose that reads the same without formatting, or too large. */
function markdownBlocks(value:string):{blocks:MdBlock[];inline:(text:string)=>MdInline[]}|null {
  if(value.length>MARKDOWN_LIMITS.chars)return null;
  const cache=new Map<string,MdInline[]>(),inline=(text:string)=>{let spans=cache.get(text);if(!spans){spans=parseInline(text);cache.set(text,spans);}return spans;};
  const blocks=parseBlocks(value.replace(/\r\n?/g,'\n').split('\n'));
  const plain=blocks.every(block=>{if(block.t!=='p')return false;const spans=inline(block.text);return !spans.length||spans.length===1&&spans[0]!.t==='text'&&spans[0]!.v===block.text;});
  return plain?null:{blocks,inline};
}
/**
 * Shared assistant text rendering for both providers. Plain prose stays one pre.message-text. Markdown or ``` fences become
 * div.message-text.claude-message-body holding paragraphs, headings, lists, quotes, tables and <pre><code> blocks.
 * DOM nodes and textContent only.
 */
export function renderMessageText(doc:Document,value:string,options:ChoiceBlockOptions={}):HTMLElement {
  const rich=()=>{const box=doc.createElement('div');box.className='message-text claude-message-body';box.dataset.format='rich';return box;};
  if(!value.includes('```')){
    const markdown=markdownBlocks(value);
    if(!markdown){const pre=doc.createElement('pre');pre.className='message-text';pre.textContent=value;return pre;}
    const box=rich();renderBlocks(doc,box,markdown.blocks,markdown.inline);return box;
  }
  const box=rich();
  value.split('```').forEach((part,index,parts)=>{
    if(index%2===1){
      // A complete arcane-choices / arcane-plan fence becomes buttons; anything that does not validate stays a code block.
      const marker=/^(arcane-(?:choices|plan))[ \t]*(?:\r?\n|(?=\{))/.exec(part);
      const block=marker&&index<parts.length-1?parseChoiceBlock(marker[1]!,part.slice(marker[0].length)):null;
      if(block){box.append(renderChoiceBlock(doc,block,options));return;}
      // A complete arcane-memory fence is a suggested project-memory note: shown as text with an explicit save button.
      const memory=/^arcane-memory[ \t]*\r?\n/.exec(part);
      const note=memory&&index<parts.length-1?parseMemoryBlock(part.slice(memory[0].length)):null;
      if(note!==null){box.append(renderMemoryBlock(doc,note));return;}
      let code=part,language='';const newline=code.indexOf('\n');
      if(newline>=0&&/^[A-Za-z0-9_+#.-]{0,32}$/.test(code.slice(0,newline).trim())){language=code.slice(0,newline).trim();code=code.slice(newline+1);}
      const pre=doc.createElement('pre'),element=doc.createElement('code');element.textContent=code.replace(/\n$/,'');
      if(language)element.setAttribute('data-language',language);pre.append(element);box.append(pre);return;
    }
    const markdown=markdownBlocks(part);
    if(markdown){renderBlocks(doc,box,markdown.blocks,markdown.inline);return;}
    for(const paragraph of part.split(/\n[ \t]*\n/)){
      const trimmed=paragraph.replace(/^\n+|\n+$/g,'');if(!trimmed.trim())continue;
      const p=doc.createElement('p');p.textContent=trimmed;box.append(p);
    }
  });
  return box;
}
/**
 * Streaming update of an assistant body (both providers). Renders `value` exactly as renderMessageText would, then keeps
 * every leading top-level block that is unchanged and replaces only the changed tail (normally the one block still being
 * written), so finished paragraphs, code and tables are never rebuilt, re-laid out or re-announced. Returns `current` when
 * it was patched in place, otherwise the fresh element for the caller to put in its place. Choice blocks are always
 * replaced so their buttons follow the latest options. DOM nodes and textContent only.
 */
export function patchMessageText(doc:Document,current:HTMLElement|null,value:string,options:ChoiceBlockOptions={}):HTMLElement {
  const next=renderMessageText(doc,value,options);
  if(!current||typeof current.isEqualNode!=='function'||current.tagName!==next.tagName||current.className!==next.className||current.dataset?.format!==next.dataset?.format)return next;
  if(next.tagName==='PRE'){if(current.textContent!==value)current.textContent=value;return current;}
  const old=Array.from(current.childNodes),fresh=Array.from(next.childNodes);
  let same=0;
  while(same<old.length&&same<fresh.length&&!(old[same] as Element).matches?.('.chat-choices')&&old[same]!.isEqualNode(fresh[same]!))same++;
  for(const node of old.slice(same))(node as ChildNode).remove();
  if(same<fresh.length)current.append(...fresh.slice(same));
  return current;
}
// ---- Long transcripts (both providers): the last turns render at once; older turns wait behind one "Show earlier
// messages" button and render in full, in place, when asked for. The hidden part grows in steps so a new turn does not
// move the window on every reply.
export const TRANSCRIPT_WINDOW=Object.freeze({turns:50,step:25});
/** Index of the first message to render, given the index where each turn starts (ascending). 0 renders everything. */
export function transcriptWindowStart(turnStarts:readonly number[]):number {
  const extra=turnStarts.length-TRANSCRIPT_WINDOW.turns;
  if(extra<TRANSCRIPT_WINDOW.step)return 0;
  return turnStarts[Math.floor(extra/TRANSCRIPT_WINDOW.step)*TRANSCRIPT_WINDOW.step]??0;
}
export function renderEarlierButton(doc:Document,hidden:number,show:()=>void):HTMLButtonElement {
  const button=doc.createElement('button');button.type='button';button.className='quiet chat-earlier';
  button.textContent='Show '+hidden+' earlier messages';
  button.setAttribute('aria-label','Show '+hidden+' earlier messages in this conversation');
  button.addEventListener('click',show);return button;
}
/**
 * Puts revealed earlier messages where the button was, keeps the message that was on screen in place and moves focus to
 * the first revealed message, so keyboard and screen-reader users continue from the start of what was added.
 */
export function revealEarlier(container:HTMLElement,insert:()=>void):void {
  const anchor=container.querySelector<HTMLElement>('.codex-message'),top=anchor?.getBoundingClientRect?.().top??0;
  insert();
  // Whichever element scrolls the transcript moves by exactly the height that was added above the anchor.
  const shift=(anchor?.isConnected?anchor.getBoundingClientRect?.().top??top:top)-top;
  if(shift){const scroller=scrollParent(container);if(scroller)scroller.scrollTop+=shift;}
  const first=container.querySelector<HTMLElement>('.codex-message');
  if(first){first.tabIndex=-1;first.focus?.({preventScroll:true});}
}
function scrollParent(node:HTMLElement):HTMLElement|null {
  const view=node.ownerDocument?.defaultView;
  for(let element:HTMLElement|null=node;element;element=element.parentElement){
    const overflow=view?.getComputedStyle?.(element).overflowY??'';
    if(/auto|scroll|overlay/.test(overflow)&&element.scrollHeight>element.clientHeight)return element;
  }
  return (node.ownerDocument?.scrollingElement as HTMLElement|null)??null;
}
// ---- Interactive choices (both providers): an assistant reply may end with a small fenced JSON block that asks the user to
// pick an option (```arcane-choices {"question":"…","options":["…"]}```) or to approve a plan (```arcane-plan {"steps":["…"]}```).
// The JSON is validated strictly and shown with textContent only; a click is the user's explicit answer and sends exactly one
// message. Anything that does not validate stays an ordinary code block.
export const CHOICE_BLOCK_LIMITS=Object.freeze({bytes:4096,question:300,option:120,minOptions:2,options:6,step:300,steps:12});
export type ChoiceBlock={kind:'choices';question:string;options:string[]}|{kind:'plan';steps:string[]};
export interface ChoiceBlockOptions {
  /** Sends `answer` as the user's next message; returns true when it was sent or queued. Absent: the block is display-only. */
  choose?:(answer:string)=>boolean;
  /**
   * Rendered from saved history (a reloaded transcript): the block is always inert — buttons disabled, no click handlers —
   * and never sends anything, even with `choose`. `answer` is the user's next message after it when already known.
   */
  restored?:boolean;
  answer?:string|null;
}
/** The message an "Approve plan" click sends, and the text "Change plan" writes into the message box (never sent). */
export const PLAN_APPROVE_TEXT='I approve the plan. Go ahead.', PLAN_CHANGE_TEXT='Please change the plan: ';
// A clicked option is sent verbatim as the next message, so one starting with '/' or '!' (a CLI slash or shell command) or
// carrying invisible characters is never offered as a button.
const choiceText=(value:unknown,max:number):string|null=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u.test(value)
  &&!/[­؜᠎​‌‎‏⁠-⁯︀-️﻿]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u.test(value)&&value.trim()&&!/^[/!]/.test(value.trim())?value.trim():null;
const exactKeys=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return false;
  const own=Object.keys(value);return own.length===keys.length&&keys.every(key=>own.includes(key));
};
/** Strict parse of one arcane-choices / arcane-plan fence body; null on any problem (the caller then shows plain text). */
export function parseChoiceBlock(language:string,body:string):ChoiceBlock|null {
  if(typeof body!=='string'||utf8(body)>CHOICE_BLOCK_LIMITS.bytes)return null;
  let value:unknown;try{value=JSON.parse(body);}catch{return null;}
  const strings=(list:unknown,min:number,max:number,chars:number):string[]|null=>{
    if(!Array.isArray(list)||list.length<min||list.length>max)return null;
    const out=list.map(item=>choiceText(item,chars));
    if(out.some(item=>item===null))return null;
    return new Set(out.map(item=>item!.toLocaleLowerCase())).size===out.length?out as string[]:null;
  };
  if(language==='arcane-choices'&&exactKeys(value,['question','options'])){
    const question=choiceText(value.question,CHOICE_BLOCK_LIMITS.question),options=strings(value.options,CHOICE_BLOCK_LIMITS.minOptions,CHOICE_BLOCK_LIMITS.options,CHOICE_BLOCK_LIMITS.option);
    return question&&options?{kind:'choices',question,options}:null;
  }
  if(language==='arcane-plan'&&exactKeys(value,['steps'])){
    const steps=strings(value.steps,1,CHOICE_BLOCK_LIMITS.steps,CHOICE_BLOCK_LIMITS.step);
    return steps?{kind:'plan',steps}:null;
  }
  return null;
}
function closeChoiceBlock(box:HTMLElement,state:'answered'|'closed'):void {
  box.dataset.state=state;
  for(const button of Array.from(box.querySelectorAll<HTMLButtonElement>('button')))button.disabled=true;
}
/**
 * Shows on an inert (saved-history) block which answer was given: the button whose label equals the user's next message
 * (or the plan approval text) is marked "Chosen"; another message reads "Answered earlier"; none yet reads "No longer active".
 */
function markChoiceAnswer(box:HTMLElement,answer:string|null|undefined):void {
  const status=box.querySelector<HTMLElement>('.chat-choices-status'),said=typeof answer==='string'?answer.trim():'';
  const buttons=Array.from(box.querySelectorAll<HTMLButtonElement>('button'));
  const label=box.dataset.kind==='plan'
    ?(said===PLAN_APPROVE_TEXT?'Approve plan':said.startsWith(PLAN_CHANGE_TEXT.trim())?'Change plan':null)
    :buttons.find(node=>(node.textContent??'').trim().toLocaleLowerCase()===said.toLocaleLowerCase())?.textContent??null;
  const chosen=said&&label?buttons.find(node=>node.textContent===label)??null:null;
  for(const node of buttons){node.disabled=true;if(node===chosen)node.dataset.chosen='true';else delete node.dataset.chosen;node.setAttribute('aria-pressed',node===chosen?'true':'false');}
  box.dataset.answer=chosen?'chosen':said?'answered':'none';
  if(status)status.textContent=chosen?'Chosen: '+(box.dataset.kind==='plan'?(label==='Approve plan'?'plan approved':'plan change requested'):label):said?'Answered earlier':'No longer active';
}
/** A later user message answers or supersedes every open choice block above it; saved blocks show the chosen answer. */
export function closeChoiceBlocks(root:{querySelectorAll?:(selector:string)=>ArrayLike<Element>|Iterable<Element>}|null,answer?:string|null):void {
  for(const box of Array.from(root?.querySelectorAll?.('.chat-choices')??[]) as HTMLElement[]){
    if(box.dataset.state==='open')closeChoiceBlock(box,'closed');
    else if(box.dataset.restored==='true'&&box.dataset.answer==='none'&&typeof answer==='string')markChoiceAnswer(box,answer);
  }
}
/** Buttons for one validated block. Plan: "Approve plan" sends PLAN_APPROVE_TEXT; "Change plan" only pre-fills the message box. */
export function renderChoiceBlock(doc:Document,block:ChoiceBlock,options:ChoiceBlockOptions={}):HTMLElement {
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const box=make('section',undefined,'chat-choices');box.dataset.kind=block.kind;box.setAttribute('role','group');
  const live=!!options.choose&&options.restored!==true;
  box.dataset.state=live?'open':'closed';if(options.restored===true)box.dataset.restored='true';
  const status=make('p','','chat-choices-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  if(block.kind==='plan'){
    box.setAttribute('aria-label','Proposed plan');box.append(make('strong','Proposed plan','chat-choices-question'));
    const list=make('ol',undefined,'chat-plan-steps');for(const step of block.steps)list.append(make('li',step));box.append(list);
  } else {box.setAttribute('aria-label','Question: '+block.question);box.append(make('p',block.question,'chat-choices-question'));}
  const actions=make('div',undefined,'chat-choices-actions');
  const answer=(button:HTMLButtonElement,text:string)=>{
    if(!live||box.dataset.state!=='open'||!options.choose)return;
    let accepted=false;try{accepted=options.choose(text)===true;}catch{accepted=false;}
    if(!accepted){status.textContent='This answer could not be sent now. Try again when the chat is ready.';return;}
    closeChoiceBlock(box,'answered');button.setAttribute('aria-pressed','true');status.textContent='Sent: '+text;
  };
  const button=(label:string,className:string,onClick:(node:HTMLButtonElement)=>void)=>{
    const node=make('button',label,className);node.type='button';node.disabled=!live;
    // A restored block gets no click handler at all: it can never send or pre-fill anything.
    if(live)node.addEventListener('click',()=>onClick(node));actions.append(node);return node;
  };
  if(block.kind==='plan'){
    button('Approve plan','chat-choice chat-choice-primary',node=>answer(node,PLAN_APPROVE_TEXT));
    button('Change plan','secondary chat-choice',()=>{
      if(!live||box.dataset.state!=='open')return;
      if(prefillComposer(doc,PLAN_CHANGE_TEXT))status.textContent='Describe the change in the message box, then send it.';
    });
  } else for(const option of block.options)button(option,'secondary chat-choice',node=>answer(node,option));
  box.append(actions,status);
  if(options.restored===true)markChoiceAnswer(box,options.answer);
  return box;
}
// ---- Suggested project memory (both providers): ```arcane-memory\n<1 to 8 short lines>\n``` in a finished reply. It is never
// saved automatically; only a click on "Save to project memory" appends it to ARCANE.md through the registered saver.
export const MEMORY_BLOCK_LIMITS=Object.freeze({bytes:2048,lines:8,line:300});
export type ProjectMemorySaver=(note:string)=>Promise<{ok:boolean;message:string}>;
let projectMemorySaver:ProjectMemorySaver|null=null;
/** Installed by the Settings › Project memory module; null removes it (save buttons then explain they are unavailable). */
export function setProjectMemorySaver(saver:ProjectMemorySaver|null):void { projectMemorySaver=typeof saver==='function'?saver:null; }
/** Strict parse of one arcane-memory fence body; null on any problem (the caller then shows a plain code block). */
export function parseMemoryBlock(body:string):string|null {
  if(typeof body!=='string'||utf8(body)>MEMORY_BLOCK_LIMITS.bytes)return null;
  const lines=body.replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/\s+$/,'')).filter(line=>line.trim());
  if(!lines.length||lines.length>MEMORY_BLOCK_LIMITS.lines||lines.some(line=>line.length>MEMORY_BLOCK_LIMITS.line||/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/u.test(line)
    // Invisible characters (zero-width, tags, variation selectors) or the memory delimiter: never offered for saving.
    ||/[­؜᠎​‌‎‏⁠-⁯︀-️﻿]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]|<\/?\s*project-memory/iu.test(line)))return null;
  return lines.join('\n');
}
/** The suggestion as text plus one explicit save button; textContent only. */
export function renderMemoryBlock(doc:Document,note:string):HTMLElement {
  const box=doc.createElement('section');box.className='chat-memory';box.dataset.state='open';
  box.setAttribute('role','group');box.setAttribute('aria-label','Suggested project memory');
  const heading=doc.createElement('strong');heading.className='chat-memory-heading';heading.textContent='Suggested project memory';
  const text=doc.createElement('pre');text.className='chat-memory-text';text.textContent=note;
  const button=doc.createElement('button');button.type='button';button.className='secondary chat-memory-save';button.textContent='Save to project memory';
  const status=doc.createElement('p');status.className='chat-memory-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  button.addEventListener('click',()=>{
    if(box.dataset.state!=='open')return;
    const saver=projectMemorySaver;
    if(!saver){status.textContent='Project memory is unavailable right now. Add the note in Settings › Project memory.';return;}
    box.dataset.state='saving';button.disabled=true;status.textContent='Saving…';
    let pending:Promise<{ok:boolean;message:string}>;
    try{pending=saver(note);}catch{pending=Promise.resolve({ok:false,message:'Project memory could not be saved.'});}
    void pending.catch(()=>({ok:false,message:'Project memory could not be saved.'})).then(result=>{
      const ok=result?.ok===true;
      box.dataset.state=ok?'saved':'open';button.disabled=ok;
      if(ok)button.textContent='Saved to project memory';
      status.textContent=typeof result?.message==='string'&&result.message.length<=300?result.message:ok?'Saved to ARCANE.md.':'Project memory could not be saved.';
    });
  });
  box.append(heading,text,button,status);
  return box;
}
/** Visible, enabled tab stops of the open model picker's current view, in DOM order. */
export function pickerTabStops(popover:HTMLElement):HTMLElement[] {
  return Array.from(popover.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')).filter(node=>
    node.tabIndex>=0&&!(node as HTMLButtonElement).disabled&&!node.closest('[hidden],[inert]')&&
    (typeof node.getClientRects!=='function'||node.getClientRects().length>0));
}
/**
 * Focus loop for the open model picker (both providers): Tab / Shift+Tab move between its visible controls and wrap at the
 * ends, so focus never escapes to the page behind it. Returns true when it handled the key.
 */
export function loopPickerFocus(popover:HTMLElement,event:KeyboardEvent):boolean {
  if(event.key!=='Tab'||event.altKey||event.ctrlKey||event.metaKey||popover.hidden)return false;
  const stops=pickerTabStops(popover);event.preventDefault();
  if(!stops.length)return true;
  const active=popover.ownerDocument.activeElement as HTMLElement|null;
  const inside=!!active&&popover.contains(active)&&active!==popover;
  // compareDocumentPosition: 4 = the stop follows the focused node, 2 = it precedes it.
  const after=inside?stops.filter(stop=>stop!==active&&(active!.compareDocumentPosition(stop)&4)!==0):[];
  const before=inside?stops.filter(stop=>stop!==active&&(active!.compareDocumentPosition(stop)&2)!==0):[];
  const next=event.shiftKey?(before.at(-1)??stops.at(-1)):(after[0]??stops[0]);
  next?.focus({preventScroll:true});
  return true;
}
/** Shared selected-row check mark for model and reasoning options. */
export function composerPickerCheck(doc:Document,selected:boolean):SVGSVGElement {
  const icon=doc.createElementNS('http://www.w3.org/2000/svg','svg');
  icon.setAttribute('class','icon picker-selected-check');icon.setAttribute('viewBox','0 0 24 24');
  icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.8');
  icon.setAttribute('aria-hidden','true');icon.setAttribute('data-selected',String(selected));
  const path=doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','m5 12 4 4L19 6');
  if(selected)icon.append(path);return icon;
}

// ---- Chat activity (both providers): plain-language tool lines, per-turn change cards and composer helpers. ----
// Everything here is presentation only, built from the tool name, input and result each provider actually reports.
// Text goes through textContent; raw details stay behind a collapsed "Details" disclosure.
export type ToolActivityState='started'|'finished'|'failed';
export interface ToolChange {
  kind:'created'|'updated'|'script'|'enabled'|'disabled';
  /** Plain-language line, e.g. Created Part "SpawnPlatform" in Workspace. */
  text:string;
  /** Mutation receipt (command id) that receipt_restore can revert. */
  receipt:string;
  /** Dotted Studio path (display only) for scripts and updated instances. */
  path:string|null;
}
/** How consecutive calls of one kind on one container collapse into a single card (see groupToolCards). */
export interface ToolGroupInfo {
  /** Same key = same kind of call on the same target container. */
  key:string;
  /** Present and past verb, e.g. ['Creating','Created']. */
  verbs:readonly [string,string];
  /** Singular and plural noun for one call's subject, e.g. ['part','parts']. */
  noun:readonly [string,string];
  /** Dotted Studio container the calls target, or null. */
  container:string|null;
}
export interface ToolActivity {
  text:string; change:ToolChange|null; group?:ToolGroupInfo|null;
  /** Arcane tool name (no MCP prefix), for retry counting in the build progress group. */
  tool?:string;
  /** Short result facts shown as chips, e.g. ['240 trees','11.5k tris']. */
  facts?:readonly string[];
  /** Short failure reason for a failed call. */
  reason?:string|null;
  /** PNG returned by the call (viewport capture), as base64 without a prefix. */
  image?:string|null;
}
const activityRecord=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const activityText=(value:unknown,max=100):string|null=>typeof value==='string'&&value.trim()&&!/[\x00-\x1f\x7f]/.test(value)?value.trim().slice(0,max):null;
/** Parses a bounded JSON tool detail; anything else is null. */
export function parseToolDetail(value:unknown):unknown {
  if(typeof value!=='string'||!value||value.length>65536)return null;
  try{return JSON.parse(value) as unknown;}catch{return null;}
}
/** Display path of an opaque Studio reference: root plus its display-only path segments (Workspace.Lobby.Door). */
export function studioRefPath(value:unknown):string|null {
  const ref=activityRecord(value),root=activityText(ref?.root,64);
  if(!ref||!root)return null;
  const segments=Array.isArray(ref.pathSegments)?ref.pathSegments.slice(0,64).map(part=>activityText(part,100)).filter((part):part is string=>!!part):[];
  return [root,...segments].join('.');
}
const STUDIO_METHOD_TOOLS:Record<string,string>={'scene.children':'scene_children','scene.inspect':'scene_inspect','scene.search':'scene_search','selection.read':'selection_read',
  'script.read':'script_read','script.search':'script_search','script.update':'script_update','script.set_enabled':'script_set_enabled','scene.create':'scene_create',
  'scene.update':'scene_update','scene.restore':'receipt_restore','output.read':'studio_output_read','scene.build':'scene_build','terrain.generate':'terrain_generate',
  'environment.apply':'environment_apply'};
/** Arcane tool name without an MCP server prefix (mcp__arcane__scene_create -> scene_create). */
export function arcaneToolName(name:string):string {
  const short=/^mcp__[A-Za-z0-9_-]+?__(.+)$/.exec(name)?.[1]??name;
  return short.slice(0,128);
}
const quoted=(value:string|null)=>value?'"'+value+'"':'';
/** " (Size, Color)" for the changed properties of a scene_update, or ''. */
const propertyList=(args:Record<string,unknown>|null)=>{
  const keys=Object.keys(activityRecord(args?.properties)??{}).filter(key=>/^[A-Za-z]{1,32}$/.test(key)).slice(0,6);
  return keys.length?' ('+keys.join(', ')+')':'';
};
/** Present-tense activity phrase for one Arcane tool call. Unknown tools keep their own name. */
function toolPhrase(tool:string,args:Record<string,unknown>|null):string {
  const ref=studioRefPath(args?.ref),root=activityText(args?.root,64),query=activityText(args?.query,60);
  switch(tool){
    case 'sessions':return 'Checking the Studio connection';
    case 'scene_children':return 'Reading '+(ref??root??'the Studio place');
    case 'scene_inspect':return 'Inspecting '+(ref??'an instance');
    case 'scene_search':return 'Searching '+(root??'Studio')+(query?' for '+quoted(query):'');
    case 'selection_read':return 'Reading the Studio selection';
    case 'studio_output_read':return 'Reading Studio Output';
    case 'script_read':return 'Reading script '+(ref??'');
    case 'script_search':return 'Searching scripts'+(query?' for '+quoted(query):'');
    case 'script_update':return 'Updating script '+(ref??'');
    case 'script_set_enabled':return (args?.enabled===false?'Disabling':'Enabling')+' script '+(ref??'');
    case 'scene_create':{
      const kind=activityText(args?.className,64)??'instance',name=activityText(args?.name),parent=studioRefPath(args?.parent);
      return 'Creating '+kind+(name?' '+quoted(name):'')+(parent?' in '+parent:'');
    }
    case 'scene_update':return 'Updating '+(ref??'an instance')+propertyList(args);
    case 'scene_build':{
      const kinds=new Set((Array.isArray(args?.kits)?args.kits.slice(0,16):[]).map(kit=>activityRecord(kit)?.kind));
      if(kinds.has('forest'))return 'Placing forest'+(kinds.has('plinth')?' and spawn plinth':'');
      if(kinds.has('plinth'))return 'Building the spawn plinth';
      const parent=studioRefPath(args?.parent);return 'Building a scene'+(parent?' in '+parent:'');
    }
    case 'environment_apply':{
      const preset=activityText(args?.preset,40);
      if(preset&&/^forest-/.test(preset))return 'Applying forest lighting';
      return preset&&/^[a-z][a-z0-9-]{0,39}$/.test(preset)?'Applying '+preset.replace(/-/g,' ')+' lighting':'Shaping terrain and lighting';
    }
    case 'terrain_generate':return activityRecord(args?.caves)?'Carving caves':'Generating terrain';
    case 'studio_viewport_capture':return 'Capturing viewport';
    case 'studio_asset_search':{const query=activityText(args?.query,60);return 'Searching the Creator Store'+(query?' for '+quoted(query):'');}
    case 'studio_asset_insert':return 'Placing a Creator Store asset';
    case 'studio_asset_generate':return 'Generating '+(activityText(args?.kind,20)??'an asset');
    case 'assets_procedural':{
      const generator=activityRecord(args?.generator),kind=activityText(generator?.kind,20),species=activityText(generator?.species,20);
      if(!kind||!/^[a-z]{1,20}$/.test(kind))return 'Modelling a procedural mesh';
      return 'Generating '+(kind==='tree'&&species&&/^[a-z]{1,20}$/.test(species)?species:kind)+' model';
    }
    case 'assets_jobs':return 'Checking Blender progress';
    case 'assets_manifest':return 'Reading the model manifest';
    case 'assets_preview':return 'Previewing a mesh';
    case 'assets_place_studio_import':return 'Placing a mesh in Studio';
    case 'receipt_status':return 'Checking a change receipt';
    case 'receipt_restore':return 'Restoring an earlier change';
    case 'playtest_request':return 'Starting a playtest';
    case 'playtest_status':return 'Checking the playtest';
    case 'playtest_cancel':return 'Stopping the playtest';
    case 'skills_recommend':return 'Choosing the right skills';
    case 'skills_list':return 'Listing skills';
    case 'skills_get':return 'Reading skill guidance';
  }
  if(tool.startsWith('work_'))return 'Updating the task plan';
  if(tool.startsWith('assets_'))return 'Working with assets';
  return 'Using '+tool;
}
/**
 * Describes one tool call from its real name, input and result. A change is reported only for a Studio mutation whose
 * result carries a succeeded receipt; ambiguous or failed outcomes never produce a change.
 */
export function describeToolActivity(name:string,input:unknown,result:unknown,state:ToolActivityState):ToolActivity {
  const activity=describeToolCall(name,input,result,state),tool=arcaneToolName(name),command=activityRecord(activityRecord(result)?.command);
  const args=activityRecord(input)??activityRecord(command?.args);
  return {...activity,group:toolGroupInfo(tool,args),tool,facts:state==='finished'?toolResultFacts(tool,args,result):[],
    reason:state==='failed'&&!/ — /.test(activity.text)?toolFailureReason(result):null,image:state==='finished'?toolResultImage(result):null};
}
// ---- Result facts: a few plain numbers from the compact tool results (never the raw JSON). ----
const activityNumber=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?value:null;
/** 240 -> '240', 11500 -> '11.5k', 240000 -> '240k'. */
export function compactCount(value:number):string {
  const n=Math.max(0,value);
  if(n<1000)return String(Math.round(n));
  if(n<100000)return (n/1000).toFixed(1).replace(/\.0$/,'')+'k';
  if(n<1e6)return Math.round(n/1000)+'k';
  return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M';
}
const countFact=(value:unknown,one:string,many:string):string|null=>{const n=activityNumber(value);return n!==null&&n>0?compactCount(n)+' '+(n===1?one:many):null;};
/** The plugin's own result inside a daemon outcome ({command:{result}}), or a bare result. */
function pluginResult(outcome:Record<string,unknown>|null):Record<string,unknown>|null {
  return activityRecord(activityRecord(outcome?.command)?.result)??activityRecord(outcome?.result);
}
/**
 * Up to four short facts for a finished call, read from fields the Arcane tools really return: kit reports (trees placed,
 * triangles, spawn height), cave plans (chambers, entrances), terrain size, created counts, Output errors, capture size and
 * Blender job states. Anything unrecognised yields no facts.
 */
export function toolResultFacts(tool:string,args:Record<string,unknown>|null,result:unknown):string[] {
  const outcome=activityRecord(result);if(!outcome)return [];
  const plugin=pluginResult(outcome),after=activityRecord(activityRecord(plugin?.mutation)?.after);
  const facts:(string|null)[]=[];
  const list=(value:unknown,max=64)=>Array.isArray(value)?value.slice(0,max):[];
  switch(tool){
    case 'scene_build':{
      const kits=list(outcome.kits,16).map(activityRecord).filter((kit):kit is Record<string,unknown>=>!!kit);
      for(const kit of kits){
        if(kit.kind==='forest')facts.push(countFact(kit.placed,'tree','trees'));
        const spawn=activityNumber(activityRecord(kit.spawn)?.top);if(spawn!==null)facts.push('spawn at '+Math.round(spawn)+' studs');
      }
      const tris=kits.reduce((sum,kit)=>sum+(activityNumber(kit.triangles)??0),0);if(tris>0)facts.push(compactCount(tris)+' tris');
      if(kits.some(kit=>Object.keys(activityRecord(kit.originals)??{}).length))facts.push('Blender originals');
      if(!kits.length){
        const placed=list(outcome.scatter).reduce((sum:number,row)=>sum+(activityNumber(activityRecord(row)?.placed)??0),0);
        facts.push(countFact(activityRecord(plugin?.created)?.count??after?.count??outcome.plannedInstances,'instance','instances'),placed>0?compactCount(placed)+' scattered':null);
      }
      break;
    }
    case 'terrain_generate':{
      const caves=activityRecord(outcome.caves),size=Array.isArray(after?.size)?after.size:null;
      if(caves){facts.push(countFact(list(caves.chambers).length,'chamber','chambers'),countFact(list(caves.mouths).length,'entrance','entrances'));}
      const x=activityNumber(size?.[0]),z=activityNumber(size?.[2]);if(x&&z)facts.push(Math.round(x)+'×'+Math.round(z)+' studs');
      facts.push(countFact(after?.features,'feature','features'));
      break;
    }
    case 'studio_output_read':{
      const entries=list(plugin?.entries??outcome.entries,4096).map(activityRecord);
      const errors=entries.filter(entry=>/error/i.test(String(entry?.kind??entry?.level??entry?.messageType??''))).length;
      facts.push(countFact(entries.length,'line','lines'),errors?countFact(errors,'error','errors'):entries.length?'no errors':null);
      break;
    }
    case 'studio_viewport_capture':{
      const view=activityRecord(outcome.viewport),w=activityNumber(view?.width),h=activityNumber(view?.height);
      if(w&&h)facts.push(Math.round(w)+'×'+Math.round(h));
      break;
    }
    case 'assets_preview':facts.push(countFact(list(outcome.previews).length,'render','renders'));break;
    case 'assets_jobs':{
      const jobs=list(outcome.jobs??outcome.items).map(activityRecord),count=(test:(state:string)=>boolean)=>jobs.filter(job=>test(String(job?.state??''))).length;
      facts.push(countFact(count(state=>/^(queued|running|started|pending)$/.test(state)),'running','running'),countFact(count(state=>state==='succeeded'),'done','done'),countFact(count(state=>state==='failed'),'failed','failed'));
      break;
    }
    case 'scene_create':case 'scene_update':case 'script_update':break;
    default:{const tris=activityNumber(outcome.triangles)??activityNumber(plugin?.triangles);if(tris)facts.push(compactCount(tris)+' tris');}
  }
  return [...new Set(facts.filter((fact):fact is string=>!!fact))].slice(0,4);
}
/** A short, single-line reason for a failed call: the error message the tool returned, or its plain-text excerpt. */
export function toolFailureReason(result:unknown):string|null {
  const outcome=activityRecord(result),command=activityRecord(outcome?.command);
  const raw=typeof result==='string'?result:[activityRecord(outcome?.error)?.message,outcome?.error,activityRecord(command?.error)?.message,command?.error,outcome?.message]
    .find(value=>typeof value==='string'&&value.trim());
  if(typeof raw!=='string')return null;
  let line=raw.replace(/[\x00-\x1f\x7f]+/g,' ').replace(/\s+/g,' ').trim();
  if(!line||parseToolDetail(line)!==null)return null;
  const sentence=/^(.{12,}?[.!?])(\s|$)/.exec(line)?.[1];if(sentence)line=sentence;
  return line.length>96?line.slice(0,95).trimEnd()+'…':line;
}
// PNG (iVBORw0KGgo = 89 50 4E 47 0D 0A 1A 0A) or JPEG (/9j/ = FF D8 FF) base64, at most 1.5 MiB decoded.
const IMAGE_BASE64=/^(?:iVBORw0KGgo|\/9j\/)[A-Za-z0-9+/]*={0,2}$/,IMAGE_CHARS=Math.ceil(1536*1024/3)*4;
/** The PNG or JPEG a call returned (an MCP image block, a viewport `data` field or a data URL), as base64; otherwise null. */
export function toolResultImage(result:unknown):string|null {
  const outcome=activityRecord(result);if(!outcome)return null;
  const base64=(value:unknown,declared?:unknown):string|null=>{
    if(typeof value!=='string'||value.length>IMAGE_CHARS+23)return null;
    const prefix=/^data:image\/(png|jpeg);base64,/.exec(value),data=prefix?value.slice(prefix[0].length):value,type=prefix?'image/'+prefix[1]:declared;
    if(data.length>IMAGE_CHARS||data.length%4!==0||!IMAGE_BASE64.test(data))return null;
    // A declared type (data URL or image block) must match the bytes' signature.
    return type===undefined||(type==='image/png'?data.startsWith('iVBORw0KGgo'):type==='image/jpeg'&&data.startsWith('/9j/'))?data:null;
  };
  const blocks=Array.isArray(outcome.content)?outcome.content.slice(0,8).map(activityRecord):[];
  const block=blocks.find(item=>item?.type==='image'&&(item.mimeType==='image/png'||item.mimeType==='image/jpeg'));
  return base64(block?.data,block?.mimeType)??(activityRecord(outcome.viewport)?base64(outcome.data):null)??base64(outcome.image)??base64(outcome.dataUrl);
}
/** "MeshPart" -> ['mesh part','mesh parts']. */
function classNoun(className:string|null):[string,string] {
  if(!className||!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(className))return ['instance','instances'];
  const words=className.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g,'$1 $2').toLowerCase();
  return [words,/(s|x|ch|sh)$/.test(words)?words+'es':/[^aeiou]y$/.test(words)?words.slice(0,-1)+'ies':words+'s'];
}
/** Parent container of a dotted Studio path (Workspace.Forest.Tree -> Workspace.Forest), or null for a root. */
function parentPath(path:string|null):string|null {
  if(!path)return null;const at=path.lastIndexOf('.');return at>0?path.slice(0,at):null;
}
/** Grouping for repeatable calls; null keeps a call on its own line (playtests, plans, assets, connection checks). */
function toolGroupInfo(tool:string,args:Record<string,unknown>|null):ToolGroupInfo|null {
  const ref=studioRefPath(args?.ref),make=(verbs:[string,string],noun:[string,string],container:string|null,variant='')=>
    ({key:tool+(variant?':'+variant:'')+' @ '+(container??''),verbs,noun,container});
  switch(tool){
    case 'scene_create':return make(['Creating','Created'],classNoun(activityText(args?.className,64)),studioRefPath(args?.parent));
    case 'scene_update':return make(['Updating','Updated'],['instance','instances'],parentPath(ref));
    // Long build steps (scene kits, terrain and caves, lighting, captures) keep their own labelled line in the build
    // progress group, so a retry or a second capture stays readable instead of folding into a count.
    case 'scene_build':case 'environment_apply':case 'terrain_generate':case 'studio_viewport_capture':return null;
    case 'studio_asset_search':return make(['Searching','Searched'],['asset search','asset searches'],null);
    case 'studio_asset_insert':return make(['Placing','Placed'],['asset','assets'],null);
    case 'studio_asset_generate':return make(['Generating','Generated'],['asset','assets'],null);
    case 'scene_inspect':return make(['Inspecting','Inspected'],['instance','instances'],parentPath(ref));
    case 'scene_children':return make(['Reading','Read'],['container','containers'],null);
    case 'scene_search':return make(['Running','Ran'],['search','searches'],activityText(args?.root,64));
    case 'script_read':return make(['Reading','Read'],['script','scripts'],parentPath(ref));
    case 'script_update':return make(['Updating','Updated'],['script','scripts'],parentPath(ref));
    case 'script_search':return make(['Running','Ran'],['script search','script searches'],null);
    case 'script_set_enabled':{const enabled=args?.enabled!==false;
      return make(enabled?['Enabling','Enabled']:['Disabling','Disabled'],['script','scripts'],parentPath(ref),enabled?'on':'off');}
    case 'assets_procedural':return make(['Modelling','Modelled'],['mesh','meshes'],null);
    case 'receipt_status':return make(['Checking','Checked'],['change receipt','change receipts'],null);
    case 'skills_get':return make(['Reading','Read'],['skill guide','skill guides'],null);
  }
  return null;
}
export const STUDIO_OFFLINE_TOOL_TEXT='Studio is disconnected, so nothing was sent. Reconnect Studio, then try again.';
function describeToolCall(name:string,input:unknown,result:unknown,state:ToolActivityState):ToolActivity {
  const tool=arcaneToolName(name),outcome=activityRecord(result),command=activityRecord(outcome?.command);
  const args=activityRecord(input)??activityRecord(command?.args);
  const phrase=toolPhrase(tool,args).trim();
  const text=state==='started'?phrase+'…':phrase;
  const receipt=activityText(outcome?.commandId,256);
  // An offline Studio session refuses commands (SESSION_OFFLINE): say so plainly instead of a bare failure.
  if(state==='failed'&&activityRecord(outcome?.error)?.code==='SESSION_OFFLINE')return {text:phrase+' — '+STUDIO_OFFLINE_TOOL_TEXT,change:null};
  if(state!=='finished'||!receipt||outcome?.state!=='succeeded'||!['scene_create','scene_update','script_update','script_set_enabled'].includes(tool))return {text,change:null};
  const ref=studioRefPath(args?.ref);
  if(tool==='scene_create'){
    const kind=activityText(args?.className,64)??'instance',label=activityText(args?.name),parent=studioRefPath(args?.parent);
    return {text,change:{kind:'created',text:'Created '+kind+(label?' '+quoted(label):'')+(parent?' in '+parent:''),receipt,path:parent&&label?parent+'.'+label:null}};
  }
  if(tool==='scene_update')return {text,change:{kind:'updated',text:'Updated '+(ref??'an instance')+propertyList(args),receipt,path:ref}};
  if(tool==='script_update')return {text,change:{kind:'script',text:'Edited script '+(ref??''),receipt,path:ref}};
  const enabled=args?.enabled!==false;
  return {text,change:{kind:enabled?'enabled':'disabled',text:(enabled?'Enabled':'Disabled')+' script '+(ref??''),receipt,path:ref}};
}
/**
 * Codex history keeps only a tool's result text. Arcane Studio results name their command (method and arguments), so a
 * result that parses as one describes itself; anything else stays a generic line.
 */
export function readToolResultText(text:string):{name:string|null;input:unknown;result:unknown;state:ToolActivityState} {
  const result=activityRecord(parseToolDetail(text)),command=activityRecord(result?.command),method=typeof command?.method==='string'?command.method:'';
  const failed=!!result&&(!!activityRecord(result.error)||['failed','cancelled','needs_reconciliation'].includes(String(result.state)));
  return {name:STUDIO_METHOD_TOOLS[method]??null,input:command?.args??null,result,state:failed?'failed':'finished'};
}
const STATE_WORDS:Record<ToolActivityState,string>={started:'Running',finished:'Done',failed:'Failed'};
/**
 * The activity line for a tool message: a state mark (red dot running, check finished, cross failed), the plain-language
 * text in .message-text and, collapsed, the raw details. Returns the nodes to place inside article.codex-message.tool.
 */
export function renderToolActivity(doc:Document,activity:ToolActivity,state:ToolActivityState,details:string):HTMLElement[] {
  const line=doc.createElement('div');line.className='tool-activity';line.dataset.toolState=state;
  const mark=doc.createElement('span');mark.className='tool-activity-mark';mark.setAttribute('aria-hidden','true');mark.dataset.toolState=state;
  const label=doc.createElement('span');label.className='message-text tool-activity-text';label.textContent=activity.text;
  const status=doc.createElement('span');status.className='visually-hidden';status.textContent=' · '+STATE_WORDS[state];
  line.append(mark,label,status);
  if(activity.tool)line.dataset.toolName=activity.tool;
  const facts=activity.facts??[];
  if(facts.length){
    const chips=doc.createElement('span');chips.className='tool-facts';
    const lead=doc.createElement('span');lead.className='visually-hidden';lead.textContent=' · ';chips.append(lead);
    for(const fact of facts){const chip=doc.createElement('span');chip.className='tool-fact';chip.textContent=fact;chips.append(chip);}
    line.append(chips);
  }
  // Elapsed time is filled in by the build progress group (groupBuildProgress); empty lines hide it.
  const time=doc.createElement('span');time.className='tool-activity-time';line.append(time);
  const group=activity.group;
  if(group){line.dataset.toolGroup=group.key;line.dataset.toolVerbs=group.verbs.join('|');line.dataset.toolNoun=group.noun.join('|');if(group.container)line.dataset.toolContainer=group.container;}
  const out:HTMLElement[]=[line];
  if(state==='failed'&&activity.reason){const reason=doc.createElement('p');reason.className='tool-activity-reason';reason.textContent=activity.reason;out.push(reason);}
  const thumb=activity.image?renderToolThumbnail(doc,activity.image,activity.facts?.[0]??null):null;if(thumb)out.push(thumb);
  const more=doc.createElement('details');more.className='message-details tool-details';
  const summary=doc.createElement('summary');summary.textContent='Details';
  const pre=doc.createElement('pre');pre.className='hint mono';pre.textContent=details;
  more.append(summary,pre);
  out.push(more);
  return out;
}
// Captured PNG/JPEG images are shown through blob: URLs (the page allows blob: images, not data: URLs). Bounded; oldest revoked.
const thumbnailUrls=new Map<string,string>();
function pngObjectUrl(doc:Document,base64:string):string|null {
  const view=doc.defaultView as (Window&typeof globalThis)|null,known=thumbnailUrls.get(base64);
  if(known)return known;
  if(!view?.URL?.createObjectURL||!view.Blob||!view.atob)return null;
  try{
    const raw=view.atob(base64),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    const url=view.URL.createObjectURL(new view.Blob([bytes],{type:base64.startsWith('/9j/')?'image/jpeg':'image/png'}));
    thumbnailUrls.set(base64,url);
    while(thumbnailUrls.size>8){const [oldest,href]=thumbnailUrls.entries().next().value!;thumbnailUrls.delete(oldest);view.URL.revokeObjectURL(href);}
    return url;
  }catch{return null;}
}
/** A viewport capture thumbnail: a button that toggles between a small preview and the full-width image. */
export function renderToolThumbnail(doc:Document,base64:string,size:string|null):HTMLElement|null {
  const url=pngObjectUrl(doc,base64);if(!url)return null;
  const button=doc.createElement('button');button.type='button';button.className='tool-thumb';button.setAttribute('aria-expanded','false');
  const name='Studio viewport capture'+(size?' ('+size+')':'');
  button.setAttribute('aria-label','Enlarge '+name);button.title='Click to enlarge';
  const image=doc.createElement('img');image.src=url;image.alt=name;image.decoding='async';
  button.append(image);
  const toggle=(open:boolean)=>{button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',(open?'Shrink ':'Enlarge ')+name);button.title=open?'Click to shrink':'Click to enlarge';};
  button.addEventListener('click',()=>toggle(button.getAttribute('aria-expanded')!=='true'));
  button.addEventListener('keydown',event=>{if(event.key==='Escape'&&button.getAttribute('aria-expanded')==='true'){event.preventDefault();event.stopPropagation();toggle(false);}});
  return button;
}
/**
 * A Codex transcript tool message as article.codex-message.tool: the same activity line, state and Details the Claude
 * chat renders for its tool events. Saved history keeps only the result text; an Arcane Studio result names its command.
 */
/** A result that does not name its command, recognised by the fields only one Arcane tool returns; otherwise null. */
export function inferToolFromResult(result:unknown):string|null {
  const r=activityRecord(result);if(!r)return null;
  if(activityRecord(r.viewport))return 'studio_viewport_capture';
  if(Array.isArray(r.kits)||Array.isArray(r.scatter)||typeof r.plannedInstances==='number')return 'scene_build';
  if(activityRecord(r.caves))return 'terrain_generate';
  if(Array.isArray(r.previews)&&typeof r.jobId==='string')return 'assets_preview';
  if(Array.isArray(r.entries)&&typeof r.latest==='number')return 'studio_output_read';
  if(Array.isArray(r.jobs))return 'assets_jobs';
  return null;
}
export function renderCodexToolArticle(doc:Document,message:Pick<ChatMessage,'scope'|'text'|'toolState'|'toolCall'>&{key?:string},safe:(value:string)=>string=value=>value):{article:HTMLElement;change:ToolChange|null} {
  const read=message.text?readToolResultText(message.text):null,state:ToolActivityState=message.toolState??read?.state??'finished';
  // A failed call's plain-text result is its reason.
  const result=read?.result??(state==='failed'&&message.text?message.text:null);
  // A result that names its own command wins; otherwise the live identity (tool name + display args) describes the call,
  // then a result recognised by its shape; a bare result stays a generic step.
  const live=message.toolCall,inferred=!read?.name&&!live?inferToolFromResult(read?.result):null;
  const activity:ToolActivity=read?.name?describeToolActivity(read.name,read.input,read.result,state)
    :live?describeToolActivity(live.name,live.input,result,state):inferred?describeToolActivity(inferred,null,read?.result,state)
    :{text:message.text?state==='failed'?'A step failed':'Finished a step':state==='started'?'Using an Arcane tool…':'Used an Arcane tool',change:null,reason:state==='failed'?toolFailureReason(result):null};
  const article=doc.createElement('article');article.className='codex-message tool';
  article.setAttribute('data-role','tool');article.setAttribute('aria-label','Tool activity');article.dataset.toolState=state;
  if(message.key)article.dataset.toolKey=message.key.slice(0,512);
  article.append(...renderToolActivity(doc,activity,state,safe(message.scope+(message.text?'\n'+message.text:''))));
  return {article,change:activity.change};
}
// ---- Grouped tool cards: consecutive calls of one kind on one container collapse into one compact, expandable card. ----
/** Calls needed before a run of same-kind lines becomes one card. */
export const TOOL_GROUP_MIN=2;
const isToolArticle=(node:Element):node is HTMLElement=>node.tagName==='ARTICLE'&&node.classList.contains('codex-message')&&node.classList.contains('tool');
const toolLine=(article:Element)=>article.querySelector<HTMLElement>('.tool-activity');
const articleState=(article:HTMLElement):ToolActivityState=>{const value=article.dataset.toolState??toolLine(article)?.dataset.toolState;return value==='started'||value==='failed'?value:'finished';};
/** Summary of a run of grouped lines, e.g. "Created 48 parts in Workspace.Forest" (live "Creating 12 parts in …" while running). */
export function toolGroupSummary(members:readonly HTMLElement[]):{text:string;state:ToolActivityState;failed:number} {
  const lines=members.map(toolLine),first=lines[0]?.dataset;
  const verbs=(first?.toolVerbs??'Running|Ran').split('|'),container=first?.toolContainer??null;
  const nouns=new Set(lines.map(line=>line?.dataset.toolNoun??''));
  const noun=(nouns.size===1&&[...nouns][0]?[...nouns][0]!:'instance|instances').split('|');
  const states=members.map(articleState),failed=states.filter(state=>state==='failed').length,running=states.includes('started');
  const count=running?members.length:members.length-failed,where=container?' in '+container:'';
  const phrase=(verb:string|undefined,n:number)=>(verb??'Running')+' '+n+' '+(n===1?noun[0]:noun[1]??noun[0])+where;
  const text=running?phrase(verbs[0],count)+'…':count?phrase(verbs[1],count):phrase(verbs[0],members.length);
  return {text:text+(failed?' · '+failed+' failed':''),state:running?'started':failed?'failed':'finished',failed};
}
function makeToolGroup(doc:Document,key:string,id:string):HTMLDetailsElement {
  const group=doc.createElement('details');group.className='tool-group';group.dataset.toolGroup=key;group.dataset.groupId=id;
  const summary=doc.createElement('summary');summary.className='tool-group-summary';
  const mark=doc.createElement('span');mark.className='tool-activity-mark';mark.setAttribute('aria-hidden','true');
  const label=doc.createElement('span');label.className='tool-group-text';
  const status=doc.createElement('span');status.className='visually-hidden tool-group-status';
  const count=doc.createElement('span');count.className='tool-group-count';count.setAttribute('aria-hidden','true');
  summary.append(mark,label,status,count);
  const items=doc.createElement('div');items.className='tool-group-items';
  group.append(summary,items);return group;
}
function paintToolGroup(group:HTMLElement,members:readonly HTMLElement[]):void {
  const {text,state}=toolGroupSummary(members);
  const set=(selector:string,value:string)=>{const node=group.querySelector<HTMLElement>(selector);if(node&&node.textContent!==value)node.textContent=value;};
  if(group.dataset.toolState!==state)group.dataset.toolState=state;
  const mark=group.querySelector<HTMLElement>('.tool-group-summary>.tool-activity-mark');if(mark&&mark.dataset.toolState!==state)mark.dataset.toolState=state;
  set('.tool-group-text',text);set('.tool-group-status',' · '+STATE_WORDS[state]+' · '+members.length+' steps');
  set('.tool-group-count',members.length+' steps');
}
/**
 * Collapses consecutive tool lines that share a group key into one card per run (TOOL_GROUP_MIN or more), keeps each
 * line (with its own Details) inside the card's expandable list, and unwraps a run that shrinks to one line. Idempotent:
 * a second call on an unchanged transcript changes nothing. `open` restores which cards were expanded (by group id).
 */
export function groupToolCards(container:HTMLElement,open:ReadonlySet<string>=new Set(),prefix=''):void {
  const doc=container.ownerDocument;
  interface Entry { article:HTMLElement; key:string|null; top:Element; group:HTMLElement|null }
  const entries:(Entry|null)[]=[];
  for(const child of [...container.children]){
    if(child.classList.contains('tool-group')){
      const items=child.querySelector('.tool-group-items');
      for(const article of [...(items?.children??[])])if(isToolArticle(article))entries.push({article,key:toolLine(article)?.dataset.toolGroup??null,top:child,group:child as HTMLElement});
    }else if(isToolArticle(child))entries.push({article:child,key:toolLine(child)?.dataset.toolGroup??null,top:child,group:null});
    else entries.push(null);
  }
  const runs:Entry[][]=[];let run:Entry[]|null=null;
  for(const entry of entries){
    if(!entry||!entry.key){run=null;if(entry)runs.push([entry]);continue;}
    if(!run||run[0]!.key!==entry.key){run=[];runs.push(run);}
    run.push(entry);
  }
  const used=new Set<Element>(),ordinals=new Map<string,number>();
  for(const members of runs){
    const key=members[0]!.key;
    if(!key||members.length<TOOL_GROUP_MIN){
      // Too short to group: a line still inside a card moves back out, just before it.
      for(const entry of members)if(entry.group)container.insertBefore(entry.article,entry.group);
      continue;
    }
    const ordinal=ordinals.get(key)??0;ordinals.set(key,ordinal+1);
    let group=members.find(entry=>entry.group&&!used.has(entry.group))?.group??null;
    if(!group){const created=makeToolGroup(doc,key,prefix+key+'#'+ordinal);created.open=open.has(created.dataset.groupId!);group=created;}
    used.add(group);
    const first=members[0]!.top;
    if(first!==group)container.insertBefore(group,first);
    const items=group.querySelector('.tool-group-items')!,articles=members.map(entry=>entry.article),current=[...items.children];
    if(current.length<=articles.length&&current.every((node,index)=>node===articles[index]))items.append(...articles.slice(current.length));
    else items.replaceChildren(...articles);
    paintToolGroup(group,articles);
  }
  for(const child of [...container.children])if(child.classList.contains('tool-group')&&!used.has(child))child.remove();
}
// ---- Build progress: one compact group per assistant turn that ran tools, live while the turn runs. ----
// Each call keeps its own line (label, state mark, fact chips, elapsed time, Details); the group's header says what is
// running and for how long, and collapses to one summary line ("Built in 2m 14s · 9 steps · 1 retried") when the turn ends.
// Liveness comes from #codex-messages[data-turn-live], which each chat sets while its visible turn runs.
/** Calls needed in one turn before its lines move into a build progress group. */
export const BUILD_PROGRESS_MIN=2;
/** Tools that change the place or make assets: a turn with one reads "Built", otherwise "Done". */
const BUILDING_TOOLS=new Set(['scene_create','scene_update','scene_build','scene_delete','environment_apply','terrain_generate','studio_asset_insert',
  'assets_procedural','assets_place_studio_import','assets_adopt_glb','script_update','script_set_enabled','receipt_restore']);
/** 900 -> '<1s', 42000 -> '42s', 134000 -> '2m 14s', 3900000 -> '1h 05m'. */
export function formatElapsed(ms:number):string {
  if(!(ms>=0))return '';
  const seconds=Math.floor(ms/1000);if(seconds<1)return '<1s';if(seconds<60)return seconds+'s';
  const minutes=Math.floor(seconds/60);if(minutes<60)return minutes+'m '+String(seconds%60).padStart(2,'0')+'s';
  return Math.floor(minutes/60)+'h '+String(minutes%60).padStart(2,'0')+'m';
}
export interface BuildProgressRow { tool:string|null; text:string; state:ToolActivityState }
export interface BuildProgressSummary { title:string; meta:string; state:ToolActivityState; steps:number; retried:number; failed:number }
/**
 * The group header for a turn's calls. Live: "Build progress" plus the running step, the step count and the elapsed time.
 * Ended: one line, e.g. "Built in 2m 14s · 9 steps · 1 retried". A failed call counts as retried when a later call of the
 * same tool finished; otherwise it is failed. `elapsed` is null when the time was not observed (saved history).
 */
export function buildProgressSummary(rows:readonly BuildProgressRow[],live:boolean,elapsed:number|null):BuildProgressSummary {
  const steps=rows.length,plural=(n:number,word:string)=>n+' '+word+(n===1?'':'s');
  let retried=0,failed=0;
  rows.forEach((row,index)=>{
    if(row.state!=='failed')return;
    if(row.tool&&rows.slice(index+1).some(later=>later.tool===row.tool&&later.state==='finished'))retried++;else failed++;
  });
  const building=rows.some(row=>!!row.tool&&BUILDING_TOOLS.has(row.tool)),time=elapsed===null?'':formatElapsed(elapsed);
  if(live){
    const running=rows.filter(row=>row.state==='started').at(-1);
    const meta=[running?running.text.replace(/…$/,'')+'…':'',plural(steps,'step'),retried?retried+' retried':'',failed?failed+' failed':'',time].filter(Boolean).join(' · ');
    return {title:building?'Build progress':'Working',meta,state:'started',steps,retried,failed};
  }
  const unfinished=rows.filter(row=>row.state==='started').length;
  const lead=(failed&&failed===steps?'Stopped':building?'Built':'Done')+(time?' in '+time:'');
  const title=[lead,plural(steps,'step'),retried?retried+' retried':'',failed?failed+' failed':'',unfinished?unfinished+' unfinished':''].filter(Boolean).join(' · ');
  return {title,meta:'',state:failed||unfinished?'failed':'finished',steps,retried,failed};
}
interface ToolTime { start:number|null; end:number|null }
const toolTimes=new WeakMap<Document,Map<string,ToolTime>>();
const timesOf=(doc:Document)=>{let map=toolTimes.get(doc);if(!map){map=new Map();toolTimes.set(doc,map);}return map;};
const remember=(map:Map<string,ToolTime>,key:string,time:ToolTime)=>{map.set(key,time);while(map.size>2048)map.delete(map.keys().next().value!);return time;};
const isBuildGroup=(node:Element)=>node.classList.contains('build-progress');
const rowArticles=(row:Element):HTMLElement[]=>isToolArticle(row)?[row]:row.classList.contains('tool-group')?[...(row.querySelector('.tool-group-items')?.children??[])].filter(isToolArticle):[];
const buildArticles=(group:Element)=>[...(group.querySelector('.build-progress-items')?.children??[])].flatMap(rowArticles);
/** Start/end per call key: observed live (Claude's start time when it has one), unknown for saved history. */
function trackToolTimes(doc:Document,articles:readonly HTMLElement[],live:boolean,now:number):void {
  const map=timesOf(doc);
  for(const article of articles){
    const key=article.dataset.toolKey;if(!key)continue;
    const state=articleState(article),known=map.get(key);
    if(!known){
      const at=Date.parse(article.dataset.toolAt??''),start=Number.isFinite(at)&&at<=now&&now-at<86_400_000?at:now;
      remember(map,key,state==='started'?{start,end:null}:live?{start:now,end:now}:{start:null,end:null});
    }else if(known.end===null&&known.start!==null&&state!=='started')known.end=now;
  }
}
function makeBuildGroup(doc:Document,id:string):HTMLDetailsElement {
  const group=doc.createElement('details');group.className='build-progress';group.dataset.groupId=id;
  const summary=doc.createElement('summary');summary.className='build-progress-summary';
  const mark=doc.createElement('span');mark.className='tool-activity-mark';mark.setAttribute('aria-hidden','true');
  const text=doc.createElement('span');text.className='build-progress-text';
  const title=doc.createElement('span');title.className='build-progress-title';
  const meta=doc.createElement('span');meta.className='build-progress-meta';
  text.append(title,meta);
  const facts=doc.createElement('span');facts.className='build-progress-facts';
  const status=doc.createElement('span');status.className='visually-hidden build-progress-status';
  const chevron=doc.createElement('span');chevron.className='build-progress-chevron';chevron.setAttribute('aria-hidden','true');
  summary.append(mark,text,facts,status,chevron);
  const items=doc.createElement('div');items.className='build-progress-items';
  group.append(summary,items);return group;
}
/** Repaints a group's header and its lines' elapsed times from the recorded times. Moves no nodes. */
function paintBuildGroup(group:HTMLElement,live:boolean,now:number):void {
  const doc=group.ownerDocument,map=timesOf(doc),articles=buildArticles(group);
  const set=(node:Element|null,value:string)=>{if(node&&node.textContent!==value)node.textContent=value;};
  for(const article of articles){
    const time=article.dataset.toolKey?map.get(article.dataset.toolKey):undefined,running=articleState(article)==='started';
    let ms:number|null=null;
    if(time&&time.start!==null){if(time.end!==null)ms=time.end-time.start;else if(running&&live)ms=now-time.start;}
    set(article.querySelector('.tool-activity-time'),ms!==null&&ms>=1000?formatElapsed(ms):'');
  }
  const groupTime=map.get('group:'+group.dataset.groupId);
  let elapsed:number|null=null;
  if(groupTime&&groupTime.start!==null){if(live)elapsed=now-groupTime.start;else if(groupTime.end!==null)elapsed=groupTime.end-groupTime.start;}
  const rows=articles.map(article=>({tool:toolLine(article)?.dataset.toolName??null,text:article.querySelector('.tool-activity-text')?.textContent??'',state:articleState(article)}));
  const summary=buildProgressSummary(rows,live,elapsed);
  set(group.querySelector('.build-progress-title'),summary.title);
  set(group.querySelector('.build-progress-meta'),summary.meta);
  set(group.querySelector('.build-progress-status'),' · '+STATE_WORDS[summary.state]);
  if(group.dataset.toolState!==summary.state)group.dataset.toolState=summary.state;
  const mark=group.querySelector<HTMLElement>('.build-progress-summary>.tool-activity-mark');if(mark&&mark.dataset.toolState!==summary.state)mark.dataset.toolState=summary.state;
  // The turn's key facts stay readable while the group is collapsed: the headline fact of each build step first.
  const firsts=(building:boolean)=>articles.filter(article=>BUILDING_TOOLS.has(toolLine(article)?.dataset.toolName??'')===building)
    .map(article=>article.querySelector('.tool-fact')?.textContent??'').filter(Boolean);
  const facts=[...new Set([...firsts(true),...firsts(false)])].slice(0,3);
  const holder=group.querySelector<HTMLElement>('.build-progress-facts');
  if(holder&&holder.dataset.facts!==facts.join('\n')){
    holder.dataset.facts=facts.join('\n');
    holder.replaceChildren(...facts.map(fact=>{const chip=doc.createElement('span');chip.className='tool-fact';chip.textContent=fact;return chip;}));
  }
}
/**
 * Moves each turn's tool lines (and grouped cards) into one build progress group placed where its first call appeared,
 * groups same-kind runs inside it, unwraps a turn that shrinks below BUILD_PROGRESS_MIN calls and collapses a group when its
 * turn ends. Idempotent: a second call on an unchanged transcript moves nothing. `open` keeps groups a person expanded.
 */
export function groupBuildProgress(container:HTMLElement,open:ReadonlySet<string>=new Set(),now=Date.now()):void {
  const doc=container.ownerDocument,flag=container.dataset.turnLive,map=timesOf(doc);
  interface Segment { rows:Element[]; tops:Element[]; groups:HTMLElement[] }
  const segments:Segment[]=[{rows:[],tops:[],groups:[]}];
  for(const child of [...container.children]){
    const segment=segments.at(-1)!;
    if(child.classList.contains('human')){segments.push({rows:[],tops:[],groups:[]});continue;}
    if(isBuildGroup(child)){segment.groups.push(child as HTMLElement);segment.tops.push(child);segment.rows.push(...(child.querySelector('.build-progress-items')?.children??[]));}
    else if(isToolArticle(child)||child.classList.contains('tool-group')){segment.rows.push(child);segment.tops.push(child);}
  }
  const used=new Set<Element>();
  segments.forEach((segment,index)=>{
    const articles=segment.rows.flatMap(rowArticles);
    const live=index===segments.length-1&&(flag!==undefined?flag==='true':articles.some(article=>articleState(article)==='started'));
    // Times are recorded from a turn's first call, before it has enough calls for a group.
    trackToolTimes(doc,articles,live,now);
    if(articles.length<BUILD_PROGRESS_MIN){
      for(const group of segment.groups)for(const row of [...(group.querySelector('.build-progress-items')?.children??[])])container.insertBefore(row,group);
      return;
    }
    const id='build:'+(articles[0]!.dataset.toolKey??'turn-'+index);
    let group:HTMLElement|null=segment.groups[0]??null;
    if(!group){const created=makeBuildGroup(doc,id);created.open=live||open.has(id);created.dataset.live=String(live);group=created;}
    used.add(group);
    if(segment.tops[0]!==group)container.insertBefore(group,segment.tops[0]!);
    const items=group.querySelector('.build-progress-items')!,current=[...items.children];
    if(current.length<=segment.rows.length&&current.every((node,at)=>node===segment.rows[at]))items.append(...segment.rows.slice(current.length));
    else items.replaceChildren(...segment.rows);
    groupToolCards(items as HTMLElement,open,id+'/');
    const key='group:'+group.dataset.groupId;
    const time=map.get(key)??remember(map,key,{start:live?Math.min(now,...articles.map(article=>map.get(article.dataset.toolKey??'')?.start??now)):null,end:null});
    if(!live&&time.start!==null&&time.end===null)time.end=now;
    // The turn just ended: fold the group to its one-line summary.
    if(group.dataset.live==='true'&&!live)(group as HTMLDetailsElement).open=false;
    group.dataset.live=String(live);
    paintBuildGroup(group,live,now);
  });
  for(const child of [...container.children])if(isBuildGroup(child)&&!used.has(child)){
    for(const row of [...(child.querySelector('.build-progress-items')?.children??[])])container.insertBefore(row,child);
    child.remove();
  }
}
const groupedTranscripts=new WeakSet<Element>();
/** Keeps the shared transcript (#codex-messages, used by every chat) grouped as lines arrive. Presentation only. */
export function installToolGrouping(doc:Document):void {
  try{
    const container=doc.getElementById('codex-messages'),view=doc.defaultView,Observer=view?.MutationObserver;
    if(!container||!view||!Observer||groupedTranscripts.has(container))return;
    groupedTranscripts.add(container);
    const open=new Set<string>();
    container.addEventListener('toggle',event=>{
      const target=event.target as HTMLDetailsElement|null,id=target?.classList?.contains('tool-group')||target?.classList?.contains('build-progress')?target.dataset.groupId:undefined;
      if(id){if(target!.open)open.add(id);else open.delete(id);}
    },true);
    // Live groups tick once a second (elapsed times only); the ticker stops when no group is live.
    let ticker:number|null=null;
    const tick=()=>{
      const live=[...container.querySelectorAll<HTMLElement>('.build-progress[data-live="true"]')];
      if(!live.length){if(ticker!==null){view.clearInterval(ticker);ticker=null;}return;}
      const now=Date.now();for(const group of live)paintBuildGroup(group,true,now);
    };
    let busy=false;
    const run=()=>{
      busy=true;
      try{groupBuildProgress(container,open);groupToolCards(container,open);}catch{/* Grouping is presentation only. */}
      finally{observer.takeRecords();busy=false;}
      if(ticker===null&&container.querySelector('.build-progress[data-live="true"]'))ticker=view.setInterval(tick,1000);
    };
    // Timer repaints (elapsed text) are not structure changes.
    const own=(target:Node)=>!!(target as Element).closest?.('.tool-activity-time,.build-progress-summary')||!!target.parentElement?.closest?.('.tool-activity-time,.build-progress-summary');
    const observer=new Observer(records=>{
      if(busy||!records.some(record=>(record.target===container||!!(record.target as Element|null)?.closest?.('.tool-group,.build-progress'))&&!own(record.target)))return;
      run();
    });
    observer.observe(container,{childList:true,subtree:true,attributes:true,attributeFilter:['data-turn-live']});
    run();
  }catch{/* Grouping is presentation only. */}
}
/** Pretty raw detail text for the collapsed Details: JSON is indented, other text kept as is. */
export function toolDetailText(parts:readonly [string,unknown][]):string {
  return parts.filter(([,value])=>value!==null&&value!==undefined&&value!=='').map(([label,value])=>{
    const parsed=typeof value==='string'?parseToolDetail(value)??value:value;
    let body:string;try{body=typeof parsed==='string'?parsed:JSON.stringify(parsed,null,2);}catch{body=String(parsed);}
    return label+': '+body;
  }).join('\n');
}
const CHANGE_NOUNS:Record<ToolChange['kind'],[string,string]>={created:['created','created'],updated:['updated','updated'],script:['script edited','scripts edited'],enabled:['script enabled','scripts enabled'],disabled:['script disabled','scripts disabled']};
/** Count summary for a change card, e.g. "2 created · 1 script edited". */
export function changeSummary(changes:readonly ToolChange[]):string {
  const counts=new Map<ToolChange['kind'],number>();for(const change of changes)counts.set(change.kind,(counts.get(change.kind)??0)+1);
  return [...counts].map(([kind,count])=>count+' '+CHANGE_NOUNS[kind][count===1?0:1]).join(' · ');
}
/** The explicit request a Restore click writes into the composer. It is never sent automatically. */
export function restoreRequestText(changes:readonly ToolChange[]):string {
  const receipts=[...new Set(changes.map(change=>change.receipt))].reverse();
  return 'Please restore the Studio changes from '+(receipts.length===1?'receipt ':'these receipts, newest first: ')+receipts.join(', ')+
    '. Use receipt_restore for each one and tell me what was restored or why it could not be.';
}
/** Writes text into the shared composer for the user to review; nothing is sent. Existing draft text is kept above it. */
export function prefillComposer(doc:Document,text:string):boolean {
  const input=doc.getElementById?.('codex-composer') as HTMLTextAreaElement|null;
  if(!input)return false;
  const current=input.value.replace(/\s+$/,'');
  input.value=current?current+'\n\n'+text:text;
  input.dispatchEvent(new Event('input'));
  try{input.focus({preventScroll:true});input.setSelectionRange?.(input.value.length,input.value.length);}catch{/* Focus is presentation only. */}
  return true;
}
/** Recorded before/after source of one script edit, read on demand for the change card's diff (display only). */
export interface ScriptChangeSources { commandId:string; path:string; before:string; after:string }
export type ScriptChangeReader=(commandId:string)=>Promise<ScriptChangeSources>;
/** Response bound for one script change read: two 100 KiB sources with worst-case JSON escaping. */
const SCRIPT_CHANGE_BYTES=1536*1024,SCRIPT_SOURCE_CHARS=100*1024;
/** Validates the daemon's `{change}` envelope for the exact requested receipt; anything else is null. */
export function readScriptChange(value:unknown,commandId:string):ScriptChangeSources|null {
  const change=object(value)?value.change:null;
  if(!object(change)||change.commandId!==commandId||!text(change.path,8192)||typeof change.before!=='string'||typeof change.after!=='string'
    ||change.before.length>SCRIPT_SOURCE_CHARS||change.after.length>SCRIPT_SOURCE_CHARS)return null;
  return {commandId,path:change.path,before:change.before,after:change.after};
}
// One reader per document: the chat that owns the human control token provides it, and every change card in that
// document (either provider's transcript) uses it. Without a reader, script rows show no diff actions.
const scriptChangeReaders=new WeakMap<object,ScriptChangeReader>();
export function provideScriptChanges(doc:Document,reader:ScriptChangeReader):void { scriptChangeReaders.set(doc,reader); }
export interface ChangeCardOptions { copy?:(text:string)=>Promise<void>; scriptChange?:ScriptChangeReader|null }
const CHANGE_CARD_ROWS=8;
// The diff viewer loads only when someone first opens a script's changes.
let scriptDiffModule:Promise<typeof import('./script-diff.js')>|null=null;
const loadScriptDiff=()=>scriptDiffModule??=import('./script-diff.js').catch((error:unknown)=>{scriptDiffModule=null;throw error;});
let scriptDiffIds=0;
/** "View changes" (an inline unified diff) and "Copy new source" for one edited script. Sources are read once, on demand. */
function scriptRowActions(doc:Document,row:HTMLElement,change:ToolChange,read:ScriptChangeReader,copy:(text:string)=>Promise<void>,status:HTMLElement):void {
  const button=(label:string,className:string,aria:string)=>{const node=doc.createElement('button');node.type='button';node.textContent=label;node.className=className;node.setAttribute('aria-label',aria);return node;};
  const name=change.path??'this script';
  let sources:Promise<ScriptChangeSources>|null=null;
  const load=()=>sources??=read(change.receipt).catch((error:unknown)=>{sources=null;throw error;});
  const view=button('View changes','quiet chat-change-diff','View changes to '+name),copySource=button('Copy new source','quiet chat-change-copy-source','Copy new source of '+name);
  view.setAttribute('aria-expanded','false');
  let panel:HTMLElement|null=null,busy=false;
  const expanded=(open:boolean)=>{view.setAttribute('aria-expanded',String(open));view.textContent=open?'Hide changes':'View changes';view.setAttribute('aria-label',(open?'Hide changes to ':'View changes to ')+name);};
  view.addEventListener('click',()=>{
    if(panel){panel.hidden=!panel.hidden;expanded(!panel.hidden);return;}
    if(busy)return;busy=true;view.disabled=true;status.textContent='Loading the changes to '+name+'…';
    void Promise.all([load(),loadScriptDiff()]).then(([source,module])=>{
      panel=module.renderScriptDiff(doc,{path:source.path,before:source.before,after:source.after});
      panel.id='chat-script-diff-'+(++scriptDiffIds);view.setAttribute('aria-controls',panel.id);
      row.append(panel);expanded(true);status.textContent='';
    },()=>{status.textContent='Could not load the changes to '+name+'. Its receipt may no longer be recorded.';}).finally(()=>{busy=false;view.disabled=false;});
  });
  copySource.addEventListener('click',()=>{
    void load().then(source=>copy(source.after)).then(()=>{status.textContent='Copied the new source of '+name;},()=>{status.textContent='Could not copy the new source of '+name+'.';});
  });
  row.append(view,copySource);
}
/** One compact card per turn that changed the Studio place: counts, names and actions. Null when nothing changed. */
export function renderChangeCard(doc:Document,changes:readonly ToolChange[],options:ChangeCardOptions={}):HTMLElement|null {
  const unique=changes.filter((change,index)=>changes.findIndex(other=>other.receipt===change.receipt)===index);
  if(!unique.length)return null;
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const card=make('section',undefined,'chat-change-card');card.setAttribute('aria-label','Studio changes in this reply');
  const head=make('div',undefined,'chat-change-head');
  head.append(make('strong','Studio changes'),make('span',changeSummary(unique),'chat-change-summary'));
  const list=make('ul',undefined,'chat-change-list');
  const status=make('p','','chat-change-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const copy=options.copy??(async (text:string)=>{const clipboard=doc.defaultView?.navigator?.clipboard;if(!clipboard)throw Error('clipboard');await clipboard.writeText(text);});
  const readScript=options.scriptChange===undefined?scriptChangeReaders.get(doc)??null:options.scriptChange;
  unique.slice(0,CHANGE_CARD_ROWS).forEach(change=>{
    const row=make('li',undefined,'chat-change-row');row.dataset.changeKind=change.kind;
    row.append(make('span',change.text,'chat-change-text'));
    if((change.kind==='script'||change.kind==='enabled'||change.kind==='disabled')&&change.path){
      const path=change.path,button=make('button','Copy path','quiet chat-change-copy');button.type='button';button.setAttribute('aria-label','Copy path '+path);
      button.addEventListener('click',()=>{void copy(path).then(()=>{status.textContent='Copied '+path;},()=>{status.textContent='Could not copy. Path: '+path;});});
      row.append(button);
    }
    if(change.kind==='script'&&readScript)scriptRowActions(doc,row,change,readScript,copy,status);
    list.append(row);
  });
  if(unique.length>CHANGE_CARD_ROWS)list.append(make('li','+'+(unique.length-CHANGE_CARD_ROWS)+' more','chat-change-row chat-change-more'));
  const actions=make('div',undefined,'chat-change-actions');
  const restore=make('button','Restore…','secondary chat-change-restore');restore.type='button';
  restore.title='Write a restore request into the message box. Review it, then send it yourself.';
  restore.addEventListener('click',()=>{if(prefillComposer(doc,restoreRequestText(unique)))status.textContent='A restore request is in the message box. Review it, then send it to restore these changes.';});
  actions.append(restore);
  card.append(head,list,actions,status);
  return card;
}

// ---- Composer commands: "/" opens a small command menu, "@" offers @selection. Shared by both providers. ----
export const COMPOSER_COMMANDS=Object.freeze([
  {name:'/new',hint:'Start a new chat'},{name:'/clear-draft',hint:'Clear the message box'},
  {name:'/model',hint:'Choose model and reasoning'},{name:'/help',hint:'Show composer tips'},
] as const);
export const COMPOSER_MENTIONS=Object.freeze([{name:'@selection',hint:'Refer to what is selected in Studio'}] as const);
export const COMPOSER_TIPS=Object.freeze([
  'Enter sends. Shift+Enter starts a new line.',
  'Type / for commands: /new, /clear-draft, /model and /help.',
  'Type @selection to refer to what is selected in Studio; the assistant reads it with selection_read.',
  'While Claude is replying, press Enter to queue your next message. It is sent when the reply finishes.',
  'Studio changes appear in a card after each reply. Restore writes a restore request you can review before sending.',
  'Be specific: name the style, scale and mood. Turn on Playtest to let the assistant check gameplay.',
]);
/** The Settings › Guide page (studio.html) that /help links to. */
export const COMPOSER_GUIDE_ID='settings-guide';
type ComposerMenuItem={name:string;hint:string};
class ComposerCommands {
  private mode:'slash'|'mention'|'help'|null=null;
  private items:ComposerMenuItem[]=[];
  private index=0;
  private dismissed:string|null=null;
  private mention:{start:number;end:number}|null=null;
  private readonly menu:HTMLElement;
  constructor(private readonly doc:Document,private readonly input:HTMLTextAreaElement,form:HTMLElement){
    this.menu=doc.createElement('div');this.menu.id='composer-command-menu';this.menu.className='composer-command-menu';this.menu.hidden=true;
    form.append(this.menu);
    this.attr('aria-autocomplete','list');this.attr('aria-controls','composer-command-menu');this.attr('aria-expanded','false');
    // The menu is optional presentation: a failure here never reaches the chat controllers' own handlers.
    const safe=<E,>(fn:(event:E)=>void)=>(event:E)=>{try{fn(event);}catch{/* presentation only */}};
    input.addEventListener('input',safe(()=>this.update()));
    input.addEventListener('keydown',safe((event:Event)=>this.key(event as KeyboardEvent)));
    input.addEventListener('blur',safe(()=>{if(this.mode!=='help')this.close();}));
  }
  private attr(name:string,value:string|null):void {
    try{if(value===null)this.input.removeAttribute?.(name);else this.input.setAttribute?.(name,value);}catch{/* presentation only */}
  }
  /** True while the command or mention list is offered; Enter then picks from it instead of sending. */
  listOpen():boolean {return (this.mode==='slash'||this.mode==='mention')&&this.items.length>0;}
  private update():void {
    const value=this.input.value;
    if(this.dismissed!==null&&value===this.dismissed)return;
    this.dismissed=null;
    const slash=/^\/([a-z-]*)$/i.exec(value);
    if(slash){this.open('slash',COMPOSER_COMMANDS.filter(command=>command.name.startsWith('/'+slash[1]!.toLowerCase())));return;}
    const caret=typeof this.input.selectionStart==='number'?this.input.selectionStart:value.length;
    const at=/(^|\s)@([a-z]*)$/i.exec(value.slice(0,caret));
    if(at){
      const query=at[2]!.toLowerCase(),start=caret-at[2]!.length-1;
      const items=COMPOSER_MENTIONS.filter(item=>item.name.startsWith('@'+query)&&item.name!=='@'+query);
      this.mention={start,end:caret};this.open('mention',items);return;
    }
    this.close();
  }
  private open(mode:'slash'|'mention',items:readonly ComposerMenuItem[]):void {
    if(!items.length){this.close();return;}
    const same=this.mode===mode&&items.length===this.items.length&&items.every((item,i)=>item.name===this.items[i]?.name);
    this.mode=mode;this.items=[...items];if(!same)this.index=0;this.index=Math.min(this.index,this.items.length-1);
    this.render();
  }
  close():void {
    if(this.mode===null&&this.menu.hidden)return; // Typing with the menu closed does no DOM work.
    this.mode=null;this.items=[];this.mention=null;this.menu.hidden=true;this.menu.replaceChildren();
    this.attr('aria-expanded','false');this.attr('aria-activedescendant',null);
  }
  private render():void {
    const menu=this.menu;menu.replaceChildren();menu.hidden=false;
    menu.setAttribute('role','listbox');menu.setAttribute('aria-label',this.mode==='mention'?'Mentions':'Commands');menu.dataset.mode=this.mode??'';
    this.items.forEach((item,i)=>{
      const option=this.doc.createElement('div');option.id='composer-command-option-'+i;option.className='composer-command-option';
      option.setAttribute('role','option');option.setAttribute('aria-selected',String(i===this.index));
      const name=this.doc.createElement('span');name.className='composer-command-name';name.textContent=item.name;
      const hint=this.doc.createElement('span');hint.className='composer-command-hint';hint.textContent=item.hint;
      option.append(name,hint);
      option.addEventListener('pointerdown',event=>event.preventDefault());
      option.addEventListener('click',()=>{this.index=i;this.choose();});
      menu.append(option);
    });
    this.attr('aria-expanded','true');this.attr('aria-activedescendant','composer-command-option-'+this.index);
  }
  private key(event:KeyboardEvent):void {
    if(event.isComposing||event.altKey||event.ctrlKey||event.metaKey)return;
    if(this.mode==='help'){if(event.key==='Escape'){event.preventDefault();this.close();}return;}
    if(!this.listOpen())return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();const step=event.key==='ArrowDown'?1:-1;this.index=(this.index+step+this.items.length)%this.items.length;this.render();return;
    }
    if(event.key==='Escape'){event.preventDefault();this.dismissed=this.input.value;this.close();return;}
    if((event.key==='Enter'&&!event.shiftKey)||event.key==='Tab'&&!event.shiftKey){event.preventDefault();this.choose();}
  }
  private setValue(value:string,caret=value.length):void {
    this.input.value=value;
    try{this.input.setSelectionRange?.(caret,caret);}catch{/* Caret placement is presentation only. */}
    this.input.dispatchEvent(new Event('input'));
  }
  private choose():void {
    const item=this.items[this.index];if(!item)return;
    if(this.mode==='mention'&&this.mention){
      const value=this.input.value,{start,end}=this.mention,insert=item.name+' ';
      this.close();this.setValue(value.slice(0,start)+insert+value.slice(end),start+insert.length);return;
    }
    this.close();this.setValue('');
    const button=(id:string)=>{const node=this.doc.getElementById(id) as HTMLButtonElement|null;if(node&&!node.disabled)node.click();return !!node&&!node.disabled;};
    if(item.name==='/new'){button('workspace-new-chat');try{this.input.focus();}catch{/* presentation only */}}
    else if(item.name==='/model')button('codex-model-trigger');
    else if(item.name==='/help')this.help();
  }
  private help():void {
    const menu=this.menu;menu.replaceChildren();menu.hidden=false;this.mode='help';
    menu.setAttribute('role','note');menu.setAttribute('aria-label','Composer tips');menu.dataset.mode='help';
    const title=this.doc.createElement('strong');title.textContent='Tips';
    const list=this.doc.createElement('ul');
    for(const tip of COMPOSER_TIPS){const row=this.doc.createElement('li');row.textContent=tip;list.append(row);}
    const close=this.doc.createElement('p');close.className='hint';close.textContent='Press Esc or start typing to close.';
    menu.append(title,list);
    // The full guide lives in Settings; the shell opens it through its existing settings request.
    if(this.doc.getElementById(COMPOSER_GUIDE_ID)){
      const guide=this.doc.createElement('button');guide.type='button';guide.className='settings-text-button';guide.textContent='Open the full guide';
      guide.addEventListener('click',()=>{
        this.close();
        try{const View=this.doc.defaultView?.CustomEvent??(typeof CustomEvent==='function'?CustomEvent:null);if(View)this.doc.dispatchEvent(new View('workspace:settingsrequest',{detail:{target:COMPOSER_GUIDE_ID}}));}catch{/* presentation only */}
      });
      menu.append(guide);
    }
    menu.append(close);
    // Typing closes the tips (update() runs on every input).
    this.attr('aria-expanded','false');this.attr('aria-activedescendant',null);
  }
}
const composerCommands=new WeakMap<Document,ComposerCommands>();
/** Installs the shared "/" and "@" composer menu once per document (both chat controllers call this). */
export function installComposerCommands(doc:Document):void {
  try{
    if(!doc||composerCommands.has(doc))return;
    const input=doc.getElementById('codex-composer') as HTMLTextAreaElement|null,form=doc.getElementById('codex-compose');
    if(!input||!form)return;
    composerCommands.set(doc,new ComposerCommands(doc,input,form));
  }catch{/* The command menu is optional presentation. */}
}
/** True while the composer command/mention list is open: Enter picks from it and must not send. */
export function composerMenuOpen(doc:Document):boolean {return composerCommands.get(doc)?.listOpen()??false;}
/** 'arcane' is Arcane Credits: models through the user's Arcane account, shown only once that account is connected. */
export type ComposerProvider='codex'|'claude'|'arcane';
/** One provider's section of the shared composer model list (presentation data only). */
export interface ComposerModelGroup {
  provider:ComposerProvider; label:string;
  /** False when the provider is not signed in: its section shows one disabled row with `hint`. */
  available:boolean; hint:string;
  /** `detail`: a short second line on the row (e.g. its credit price). */
  models:readonly {id:string;label:string;title?:string;detail?:string}[];
  /** A short line under the column heading (e.g. the Arcane Credits balance). */
  note?:string;
}
/** The other providers' sections of the model list. Choosing from one switches provider explicitly; it never starts a turn. */
export interface CrossProviderModels {
  group():ComposerModelGroup|null;
  /** Every other provider's section in display order; when absent the list shows `group()` only. */
  groups?():readonly ComposerModelGroup[];
  /** `provider` names the section the row came from (absent: the only other provider). */
  choose(model:string,provider?:ComposerProvider):void;
  /** The model list opened: the other provider may read its models lazily. */
  opened?():void;
}
/** Provider logo marks: monochrome inline SVG (currentColor), built from fixed path data with createElementNS only. */
const PROVIDER_MARKS:Record<ComposerProvider,{name:string;path:string}>={
  codex:{name:'ChatGPT',path:'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'},
  // The Arcane mark (studio.html wordmark) redrawn on the 24-unit grid.
  arcane:{name:'Arcane',path:'M12 1.5 1.5 21.375h4.875L12 10.5l5.625 10.875h4.875L12 1.5ZM10.125 15l7.125 4.875-2.25-4.875Z'},
  claude:{name:'Claude',path:'M4.7144 15.9555l4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'},
};
/**
 * The provider's logo mark. Decorative by default (aria-hidden) where adjacent text already names the provider; with
 * `labelled` it carries role=img and the provider name.
 */
export function providerLogo(doc:Document,provider:ComposerProvider,labelled=false):SVGSVGElement {
  const mark=PROVIDER_MARKS[provider],ns='http://www.w3.org/2000/svg';
  const icon=doc.createElementNS(ns,'svg');
  icon.setAttribute('class','provider-logo');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('fill','currentColor');
  icon.setAttribute('focusable','false');icon.setAttribute('data-provider',provider);
  if(labelled){icon.setAttribute('role','img');icon.setAttribute('aria-label',mark.name);}else icon.setAttribute('aria-hidden','true');
  const path=doc.createElementNS(ns,'path');path.setAttribute('d',mark.path);icon.append(path);return icon;
}
/**
 * Leads a chat tab with its provider's decorative mark; the tab text keeps naming the chat. The mark is presentation
 * only, so a document without SVG support simply shows the text.
 */
export function prependProviderLogo(doc:Document,target:HTMLElement,provider:ComposerProvider):void {
  if(typeof doc.createElementNS!=='function'||typeof target.prepend!=='function')return;
  try{target.dataset.provider=provider;target.prepend(providerLogo(doc,provider));}catch{/* The text label remains. */}
}
/** Column heading in the shared model list: the provider's logo mark and name. Styled by studio.css. */
export function composerModelGroupHeading(doc:Document,label:string,provider:ComposerProvider):HTMLElement {
  const heading=doc.createElement('div');heading.className='model-group-heading';heading.setAttribute('role','presentation');
  heading.dataset.pickerGroup=provider;
  const name=doc.createElement('span');name.textContent=label;
  heading.append(providerLogo(doc,provider),name);return heading;
}
const GROUP_ORDER:Record<ComposerProvider,number>={codex:0,claude:1,arcane:2};
/**
 * Rows for the other provider's column: one option per matching model, or one disabled row with the sign-in hint. An
 * available provider without reported models offers one row that switches provider only (id '').
 */
export function crossProviderRows(doc:Document,group:ComposerModelGroup,query:readonly string[],choose:(model:string)=>void):HTMLElement[] {
  const matches=(text:string)=>query.every(word=>text.toLocaleLowerCase().includes(word));
  const row=(id:string,label:string,title:string,disabled:boolean,detail='')=>{
    const button=doc.createElement('button');button.type='button';button.className='picker-model-option';button.tabIndex=-1;
    button.dataset.pickerModel=id;button.dataset.pickerProvider=group.provider;button.setAttribute('role','option');button.setAttribute('aria-selected','false');
    button.disabled=disabled;button.title=title;
    const name=doc.createElement('span');name.textContent=label;if(disabled)name.className='hint';button.append(name);
    if(detail){const line=doc.createElement('small');line.className='picker-model-detail';line.textContent=detail;button.append(line);}
    button.append(composerPickerCheck(doc,false));
    if(!disabled)button.addEventListener('click',()=>choose(id));
    return button;
  };
  const rows:HTMLElement[]=[];
  if(!group.available||!group.models.length){
    if(matches(group.label+' '+group.hint))rows.push(row('',group.hint,group.label+' · '+group.hint,!group.available));
  } else for(const model of group.models)if(matches(model.label+' '+model.id+' '+(model.title??'')+' '+group.label))rows.push(row(model.id,model.label,model.title??model.id,false,model.detail??''));
  return rows;
}
/** Every other provider's column: its group and rows; choosing a row names that provider. */
export function crossProviderColumns(doc:Document,cross:CrossProviderModels|null,query:readonly string[],choose:(model:string,provider:ComposerProvider)=>void):{group:ComposerModelGroup;rows:HTMLElement[]}[] {
  let groups:readonly (ComposerModelGroup|null)[]=[];
  try{groups=cross?(cross.groups?cross.groups():[cross.group()]):[];}catch{groups=[];}
  return groups.filter((group):group is ComposerModelGroup=>!!group).slice(0,2).map(group=>({group,rows:crossProviderRows(doc,group,query,id=>choose(id,group.provider))}));
}
/** Search Enter target: the first enabled own-provider row, else the first enabled row of the other provider. */
export function firstModelRow(host:HTMLElement):HTMLButtonElement|null {
  const rows=Array.from(host.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  return rows.find(row=>!row.dataset.pickerProvider)??rows[0]??null;
}
/** Search ArrowUp target: the last enabled own-provider row, else the last enabled row. */
function lastModelRow(host:HTMLElement):HTMLButtonElement|null {
  const rows=Array.from(host.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  return rows.filter(row=>!row.dataset.pickerProvider).at(-1)??rows.at(-1)??null;
}
/** One provider's column: logo heading (and its note), then its rows, or a short note when nothing matches. */
function composerModelColumn(doc:Document,provider:ComposerProvider,label:string,rows:HTMLElement[],empty:string,note?:string):HTMLElement {
  const column=doc.createElement('div');column.className='model-column';column.dataset.pickerGroup=provider;
  column.setAttribute('role','group');column.setAttribute('aria-label',label+' models');
  column.append(composerModelGroupHeading(doc,label,provider));
  if(note){const line=doc.createElement('p');line.className='model-column-note hint';line.textContent=note;column.append(line);}
  if(rows.length)column.append(...rows);
  else{const note=doc.createElement('p');note.className='model-column-empty hint';note.textContent=empty;column.append(note);}
  return column;
}
/**
 * Fills the shared model list. Without the other provider it is one plain list of the own rows. With it, two columns
 * side by side in a fixed order: ChatGPT on the left, Claude on the right (stacked ChatGPT above Claude when narrow).
 */
export function fillModelOptions(doc:Document,host:HTMLElement,own:{provider:ComposerProvider;label:string;rows:HTMLElement[];empty:string;note?:string},other:ComposerModelGroup|null,otherRows:HTMLElement[],query:readonly string[]):void {
  fillModelColumns(doc,host,own,other?[{group:other,rows:otherRows}]:[],query);
}
/**
 * The model list with any number of other providers: one column per provider in the fixed order ChatGPT, Claude,
 * Arcane (three columns side by side when there is room, stacked when narrow; data-columns on the list says how many).
 */
export function fillModelColumns(doc:Document,host:HTMLElement,own:{provider:ComposerProvider;label:string;rows:HTMLElement[];empty:string;note?:string},others:readonly {group:ComposerModelGroup;rows:HTMLElement[]}[],query:readonly string[]):void {
  host.replaceChildren();
  if(!others.length){delete host.dataset.layout;delete host.dataset.columns;for(const row of own.rows)host.append(row);return;}
  host.dataset.layout='columns';
  if(others.length>1)host.dataset.columns=String(others.length+1);else delete host.dataset.columns;
  const columns=[{order:GROUP_ORDER[own.provider],element:composerModelColumn(doc,own.provider,own.label,own.rows,own.empty,own.note)},
    ...others.map(({group,rows})=>({order:GROUP_ORDER[group.provider],element:composerModelColumn(doc,group.provider,group.label,rows,query.length?'No matching models':'No models reported',group.note)}))];
  for(const column of columns.sort((a,b)=>a.order-b.order))host.append(column.element);
}
/**
 * Keyboard movement in the model list. Up/Down/Home/End stay within the focused column (wrapping); Left/Right move to
 * the neighbouring column at the same position. Disabled rows are skipped. Null when there is nowhere to go.
 */
export function modelListMove(host:HTMLElement,target:HTMLElement,key:string):HTMLButtonElement|null {
  const enabled=(scope:HTMLElement)=>Array.from(scope.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const columns=Array.from(host.querySelectorAll<HTMLElement>('.model-column'));
  const column=columns.find(item=>item.contains(target))??null;
  const rows=enabled(column??host),index=rows.indexOf(target as HTMLButtonElement);
  if(key==='ArrowLeft'||key==='ArrowRight'){
    if(!column)return null;
    const step=key==='ArrowLeft'?-1:1;
    for(let at=columns.indexOf(column)+step;at>=0&&at<columns.length;at+=step){
      const next=enabled(columns[at]!);if(next.length)return next[Math.min(Math.max(index,0),next.length-1)]!;
    }
    return null;
  }
  if(!rows.length)return null;
  if(key==='Home')return rows[0]!;
  if(key==='End')return rows.at(-1)!;
  if(key==='ArrowDown'||key==='ArrowUp')return rows[(index+(key==='ArrowUp'?-1:1)+rows.length)%rows.length]!;
  return null;
}
/** Search ArrowDown/ArrowUp: enter the list at the own provider's first or last enabled row. */
export function modelListEntry(host:HTMLElement,key:string):HTMLButtonElement|null {
  return key==='ArrowDown'?firstModelRow(host):key==='ArrowUp'?lastModelRow(host):null;
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
  /** While another provider's chat renders into the shared transcript/composer/picker, Codex keeps its state but stops drawing there. */
  private surfaceYielded=false;
  private yieldedComposer='';
  private crossProvider:CrossProviderModels|null=null;
  private pendingSelection:{model:string;effort:string|null;at:number}|null=null;
  /** Project switch "Auto-approve edits and tool use" (off until the desktop host reports the saved setting). */
  private autoApprove=false;
  /** Formats a finished turn's usage line; null (no line) until the usage presentation attaches one. */
  private replyUsage:ReplyUsageFormat|null=null;
  private replyUsageVersion=0;
  private readonly autoHandled=new Set<string>();
  private readonly autoLog:{at:number;summary:string}[]=[];
  private readonly autoListeners=new Set<()=>void>();
  constructor(private readonly doc:Document,private readonly api:CodexChatApi) {
    // Change cards in this document (both providers) read script diffs through this human-token API.
    if(typeof api?.scriptChange==='function')provideScriptChanges(doc,commandId=>api.scriptChange(commandId));
  }
  /** Apply the persisted per-project switch; turning it off stops automatic acceptance immediately. */
  setAutoApprove(enabled:boolean):void {
    this.autoApprove=enabled===true;
    if(this.autoApprove&&!this.stopped)this.autoReview();
  }
  autoApproveEnabled():boolean { return this.autoApprove; }
  /** The most recent automatic acceptances in this session (newest last); each is also a recorded native approval action. */
  autoApprovals():readonly {at:number;summary:string}[] { return this.autoLog.map(entry=>({...entry})); }
  subscribeAutoApprovals(listener:()=>void):()=>void { this.autoListeners.add(listener);return()=>{this.autoListeners.delete(listener);}; }
  /** Accept pending requests the auto-approval policy allows; fenced ones keep their review card. Each handle is tried once. */
  private autoReview():void {
    const s=this.snapshot();
    if(!s)return;
    const live=new Set(s.approvals.map(a=>a.handle));
    for(const handle of [...this.autoHandled])if(!live.has(handle))this.autoHandled.delete(handle);
    if(!this.autoApprove||this.stopped||!this.fresh||this.uncertain.size||this.state?.displayLimited)return;
    for(const a of s.approvals) {
      if(this.autoHandled.has(a.handle)||[...this.pending.values()].some(p=>p.action==='approval'&&'handle' in p&&p.handle===a.handle))continue;
      const verdict=autoApprovalVerdict(this.state,a);
      if(!verdict.accept) {
        // Ask once per request; it may become eligible later (e.g. writes enabled), so only fenced verdicts are remembered.
        if(verdict.reason!=='it is outside the reviewed scope'){this.autoHandled.add(a.handle);this.text('codex-notice','Needs your review: this request was not auto-approved because '+verdict.reason+'.');}
        continue;
      }
      this.autoHandled.add(a.handle);
      void this.dispatch('approval',{threadId:a.threadId,turnId:a.turnId,handle:a.handle,decision:'accept'}).then(record=>{
        if(!record||record.state!=='acknowledged'||this.stopped)return;
        this.autoLog.push({at:Date.now(),summary:verdict.reason});if(this.autoLog.length>32)this.autoLog.shift();
        this.text('codex-notice','Auto-approved: '+verdict.reason+'.');
        for(const listener of this.autoListeners){try{listener();}catch{/* display only */}}
      });
    }
  }
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
  private value(id:string){return this.surfaceYielded&&id==='codex-composer'?this.yieldedComposer:this.el<HTMLInputElement>(id).value;}
  private setComposer(value:string){if(this.surfaceYielded)this.yieldedComposer=value;else this.el<HTMLTextAreaElement>('codex-composer').value=value;}
  private on(id:string,event:string,fn:(e:Event)=>void){this.el(id).addEventListener(event,e=>{if(this.surfaceYielded&&SHARED_SURFACE_IDS.has(id))return;fn(e);});}
  /**
   * Presentation hand-off of the shared chat surface (transcript, composer, model picker) to another provider's chat.
   * Codex state, polling, drafts and native authority are untouched; only its drawing into the shared nodes pauses.
   */
  yieldSurface(yielded:boolean):void {
    if(yielded===this.surfaceYielded)return;
    if(yielded){this.closePicker();this.flushDraft();this.pendingSelection=null;this.yieldedComposer=this.el<HTMLTextAreaElement>('codex-composer').value;this.surfaceYielded=true;}
    else {this.surfaceYielded=false;this.el<HTMLTextAreaElement>('codex-composer').value=this.yieldedComposer;this.yieldedComposer='';this.messageSignature='';this.pickerSignature='';this.selectionSignature='';}
    this.render();
  }
  surfaceIsYielded():boolean {return this.surfaceYielded;}
  /** The other provider's section of the shared model list (null hides it). */
  setCrossProviderModels(source:CrossProviderModels|null):void {this.crossProvider=source;this.crossProviderChanged();}
  /** The other provider's models or sign-in changed: redraw an open list. */
  crossProviderChanged():void {if(this.surfaceYielded||this.stopped)return;this.pickerSignature='';this.renderPicker();}
  /** Codex's section for the other provider's model list: reported models once connected with a subscription account. */
  modelGroup():ComposerModelGroup {
    const s=this.snapshot(),signedIn=!!this.state&&this.fresh&&!this.stopped&&s?.account?.auth==='subscription';
    const models=signedIn&&s?.connected&&s.ready?s.models.map(row=>({id:row.model,label:this.api.safe(row.displayName),title:this.api.safe(row.model)})):[];
    return {provider:'codex',label:'ChatGPT',available:signedIn,hint:signedIn?'Connect to choose a model':'Sign in to use',models};
  }
  /** Fresh evidence that the signed-in ChatGPT account is out of usage (presentation only; see codexUsageLimit). */
  /** Shows a '12k tokens (~$0.31)' line under each finished reply, as the Claude chat does. Presentation only. */
  setReplyUsage(format:ReplyUsageFormat|null):void {this.replyUsage=format;this.replyUsageChanged();}
  /** Cost display preferences changed: redraw the usage lines. */
  replyUsageChanged():void {this.replyUsageVersion++;if(this.state&&!this.stopped&&!this.surfaceYielded)this.render();}
  private replyUsageLine(threadId:string,turnId:string):HTMLElement|null {
    const key=threadId+'\0'+turnId;
    if(!this.replyUsage||!this.transcript.finishedTurns.has(key))return null;
    const model=this.state?.actions.findLast(row=>row.action==='turn-start'&&row.threadId===threadId&&row.turnId===turnId)?.model??this.snapshot()?.thread?.selection.model??null;
    const usage=turnReplyUsage(this.transcript.turnUsage.get(key),model);if(!usage)return null;
    let view:{text:string;title:string}|null=null;try{view=this.replyUsage(usage);}catch{view=null;}
    if(!view)return null;
    const line=this.make('p',view.text,'reply-usage');line.title=view.title;line.dataset.tokens=String(usage.tokens);
    return line;
  }
  usageLimit():ProviderUsageLimit|null {
    if(!this.state||!this.fresh||this.stopped)return null;
    try{return codexUsageLimit(this.snapshot(),this.state.actions);}catch{return null;}
  }
  /** Effort of the visible Codex choice, carried to the other provider when the user switches from the model list. */
  currentEffort():string|null {return this.displaySelection()?.effort??(this.value('codex-effort')||null);}
  /** Moves the unsent composer text out of Codex for a provider switch; the Codex tab keeps an empty draft. */
  takeComposerDraft():string {
    if(this.surfaceYielded||this.stopped)return '';
    const text=this.value('codex-composer');if(!text)return '';
    this.setComposer('');this.clearDraftOrigins();this.draftDirty=true;this.stashTabDraft();this.renderComposer();this.publishState();
    return text;
  }
  /**
   * Receives a provider switch from the model list: the carried draft becomes the composer text, and the chosen model is
   * applied through the existing guarded select path once Codex can select models. Nothing starts a thread or turn.
   */
  receiveHandoff(handoff:{draft:string;model:string|null;effort:string|null}):void {
    if(this.stopped)return;
    if(handoff.draft){this.setComposer(handoff.draft);this.composerInput();}
    this.pendingSelection=handoff.model?{model:handoff.model,effort:handoff.effort,at:Date.now()}:null;
    this.applyPendingSelection();
  }
  private applyPendingSelection():void {
    const pending=this.pendingSelection;
    if(!pending||this.surfaceYielded||this.stopped)return;
    if(Date.now()-pending.at>120000){this.pendingSelection=null;return;}
    if(!this.canSelectModel()||this.pending.size)return;
    this.pendingSelection=null;
    const item=this.snapshot()?.models.find(row=>row.model===pending.model);if(!item)return;
    const effort=pending.effort&&item.efforts.includes(pending.effort)?pending.effort:item.defaultEffort&&item.efforts.includes(item.defaultEffort)?item.defaultEffort:item.efforts[0];
    if(!effort)return;
    this.el<HTMLSelectElement>('codex-model').value=item.model;this.populateEfforts();this.el<HTMLSelectElement>('codex-effort').value=effort;
    this.renderControls();
    if(!this.el<HTMLButtonElement>('codex-select').disabled)void this.dispatch('select',{model:item.model,effort});
  }
  private readonly workflowContextListeners = new Set<() => void>();
  /** Parent boot seam: the only dynamic module load; it starts no native action. */
  async enableChatTabs(options: ChatTabsOptions = {}): Promise<void> {
    if(this.tabs)return;
    const module=await import('./chat-tabs.js');
    const preferences=options.preferences??module.workspacePreferencesAdapter(this.doc);
    const tabs=new module.ChatTabs(this.doc,value=>this.api.safe(value),{
      select:key=>this.selectChat(key),close:key=>this.closeChat(key),newChat:()=>this.newChat(),openSaved:id=>this.openSavedChat(id),
    },{...options,...(preferences?{preferences}:{}),onPersistenceChange:()=>{options.onPersistenceChange?.();this.persistenceChanged(tabs);}});
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
  /** A native preference save failed or recovered: show it and republish the unsaved state. */
  private persistenceChanged(tabs:ChatTabs):void {
    if(this.stopped||this.tabs!==tabs)return;
    const failed='Chat preferences could not be saved. Your unsent text stays in this window; saving retries on your next change.';
    if(tabs.persistenceStatus()==='native-error')this.text('codex-notice',failed);
    else if(this.el('codex-notice').textContent===failed)this.text('codex-notice','Chat preferences saved.');
    this.publishState();
  }
  private draftView(tab:ChatTabView|null):ChatTabView|null {
    return tab&&this.draftDirty&&tab.key===this.tabs?.active()?.key?{...tab,draft:this.value('codex-composer'),workflowDraft:!!this.workflowDraftOrigins.length||this.restoredWorkflowDraft}:tab;
  }
  chatTabsView(): readonly ChatTabView[] { return this.safeView((this.tabs?.views()??[]).map(tab=>this.draftView(tab)!)); }
  async readyForRuntimeRecovery():Promise<void> { if(this.tabs?.persistenceStatus()==='native-error')throw new Error('Saved chat drafts could not be read.'); }
  async prepareForRuntimeRecovery():Promise<void> { await this.checkpointDrafts(false); }
  async prepareForRestart():Promise<void> { await this.checkpointDrafts(true); }
  private async checkpointDrafts(checkActivity:boolean):Promise<void> {
    const idle=()=>{const thread=this.snapshot()?.thread;
      if(checkActivity&&(this.pending.size||this.uncertain.size||this.state?.busy||this.state?.connecting||this.state?.closing||thread&&!IDLE.includes(thread.turnStatus)))throw new Error('Finish or stop the current chat before restarting.');
      if(!this.surfaceYielded&&this.attachments&&(this.attachments.prepareReferences().length||this.attachments.prepareText('')))throw new Error('Send or remove your attachments before restarting.');
    };
    idle();this.flushDraft();this.tabs?.updatePresentation({});
    // A settings acknowledgement must not trap an idle workspace with no unsent text.
    const hasDraft=()=>!this.surfaceYielded&&this.value('codex-composer').length>0||this.tabs?.views().some(tab=>tab.draft.length>0);
    if(!this.tabs?.active()||!hasDraft())return;
    const project=this.state?.projectPath,key=this.tabs.active()?.key,deadline=Date.now()+10000;
    let retryAt=Date.now()+500;
    while(!this.tabs.preferencesSaved()){
      if(!hasDraft())return;
      if(Date.now()>=deadline)throw new Error('Your chat draft could not be saved. Keep this window open and try again.');
      if(Date.now()>=retryAt){this.tabs.flushPreferences();retryAt=Date.now()+500;}
      await new Promise<void>(resolve=>setTimeout(resolve,25));
      if(project!==this.state?.projectPath||key!==this.tabs.active()?.key)throw new Error('The workspace changed. Review your draft before restarting.');
      idle();this.flushDraft();
    }
    idle();
  }
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
    this.setComposer(active.draft);
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
    // A background read may observe this transition's own acknowledged thread before its HTTP
    // receipt settles; that would bump the asset-scope generation and fence the receipt.
    this.tabTransition=true;this.readVersion++;this.readController?.abort();this.render();this.publishState();
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
    if (!this.fresh || this.stopped || this.surfaceYielded || !native || !model || this.workflowDraftOrigins.length >= 20 ||
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
  /**
   * A choice button click (an explicit answer). With an empty message box and an idle chat it is sent as the next message
   * through the normal Send path; otherwise it is written into the message box for the user to send, so no draft or
   * attachment is ever replaced or sent along with it.
   */
  private answerChoice(answer:string):boolean {
    if(this.surfaceYielded||!this.providerAllowsCodex()||!answer.trim())return false;
    const input=this.doc.getElementById('codex-composer') as HTMLTextAreaElement|null;
    if(!input)return false;
    let plain=false;
    try{plain=!input.value.trim()&&(this.attachments?.prepareText(answer)??answer)===answer&&!(this.attachments?.prepareReferences().length);}catch{plain=false;}
    if(plain&&!this.preparingMessage&&this.messageTargetReady()&&!this.draftNeedsReview()){
      const EventType=this.doc.defaultView?.Event??Event;
      input.value=answer;input.dispatchEvent(new EventType('input',{bubbles:true}));void this.submitMessage();return true;
    }
    if(!prefillComposer(this.doc,answer))return false;
    this.text('codex-notice','Your answer is in the message box. Send it when ready.');
    return true;
  }
  /** Saved native threads cannot be rewound from Arcane, so a past message is copied into the message box as a new message. */
  private editAsNewButton(text:string):HTMLButtonElement {
    const button=this.make('button','Edit as new message','quiet chat-message-edit');button.type='button';
    button.title='Copy this message into the message box to edit and send it as a new message. Earlier replies are kept.';
    button.addEventListener('click',()=>{if(!this.surfaceYielded&&prefillComposer(this.doc,text))this.text('codex-notice','The message is in the message box. Edit it, then send it as a new message.');});
    return button;
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
    const popover = this.picker(); if (!popover || this.surfaceYielded) return;
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
    const popover = this.picker();
    if (!popover || this.surfaceYielded) return;
    positionComposerPopover(this.doc, popover, this.el('codex-model-trigger'), this.pickerModelsOpen);
  }
  private openPicker() {
    const popover = this.picker();
    if (!popover || !this.pickerCanOpen()) return;
    try { this.crossProvider?.opened?.(); } catch { /* The other provider's section is optional. */ }
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
  private pickerCheck(selected:boolean):SVGSVGElement {return composerPickerCheck(this.doc,selected);}
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
    const listen = (target: EventTarget, type: string, handler: (event: Event) => void, capture = false) => {
      // The shared picker belongs to the other provider's chat while the surface is yielded.
      const fn = (event: Event) => { if (!this.surfaceYielded) handler(event); };
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
      if (loopPickerFocus(this.picker()!, key)) return; // Tab stays inside the open picker.
      const target = event.target as HTMLElement, models = this.el('codex-model-options'), efforts = this.el('codex-picker-efforts');
      const inModels = models.contains(target), inEfforts = efforts.contains(target);
      const columns = models.dataset.layout === 'columns';
      if (inModels && columns && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key.key)) {
        event.preventDefault(); // Up/Down/Home/End within the column; Left/Right between the provider columns.
        const row = modelListMove(models, target, key.key); if (row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); }
        return;
      }
      if(inModels&&key.key==='ArrowRight'){event.preventDefault();(target as HTMLButtonElement).click();return;}
      if(inEfforts&&key.key==='ArrowLeft'){event.preventDefault();this.setReasoningOpen(false);this.reasoningTrigger()?.focus({preventScroll:true});return;}
      if (target === this.el('codex-model-search') && ['ArrowDown', 'ArrowUp'].includes(key.key)) {
        const row = modelListEntry(models, key.key);
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
        firstModelRow(this.el('codex-model-options'))?.click(); // Own models first; the other provider only when it alone matches.
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
    const popover = this.picker(); if (!popover || this.surfaceYielded) return;
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
    let crossGroups: readonly (ComposerModelGroup | null)[] = [];
    try { crossGroups = this.crossProvider ? (this.crossProvider.groups ? this.crossProvider.groups() : [this.crossProvider.group()]) : []; } catch { crossGroups = []; }
    const cross = crossGroups.some(Boolean) ? crossGroups : null;
    const signature = JSON.stringify([snapshot?.models ?? [], query, model, effort, enabled, cross]);
    if (signature !== this.pickerSignature) {
      this.pickerSignature = signature;
      const focused = this.doc.activeElement as HTMLElement | null;
      const focusModel = focused?.dataset.pickerModel, focusEffort = focused?.dataset.pickerEffort;
      const host = this.el('codex-model-options');
      const models = (snapshot?.models ?? []).filter(item => query.every(word => (item.displayName + ' ' + item.model + ' chatgpt').toLocaleLowerCase().includes(word)));
      const tabModel=models.find(item=>item.model===model)?.model??models[0]?.model;
      const own: HTMLElement[] = [];
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
        }); own.push(row);
      }
      // The other provider's section: choosing there switches provider explicitly through the cross-provider link.
      const others = crossProviderColumns(this.doc, this.crossProvider, query, (id, provider) => { if (!this.surfaceYielded && !this.picker()!.hidden) { this.closePicker(); this.crossProvider?.choose(id, provider); } });
      fillModelColumns(this.doc, host, { provider: 'codex', label: 'ChatGPT', rows: own, empty: snapshot?.models.length ? 'No matching models' : 'No models reported' }, others, query);
      this.el('codex-model-empty').hidden = !!cross || models.length > 0;
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
    installComposerCommands(this.doc);
    installToolGrouping(this.doc);
    this.on('codex-composer','keydown',event=>{
      const key=event as KeyboardEvent;
      // While the "/" or "@" menu is open, Enter picks from it instead of sending.
      if(event.defaultPrevented||composerMenuOpen(this.doc))return;
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
    this.timer=setTimeout(()=>{const active=!this.doc.hidden&&(this.el<HTMLDetailsElement>('codex-panel').open||this.pending.size>0||this.uncertain.size>0||!!this.confirmation);if(active&&!this.tabTransition)void this.refresh().finally(()=>this.schedule());else this.schedule();},1500); // Transition receipts carry their own state.
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
    // Only a definitive rejection may hand the cleared text back; pending/unknown sends never do (no duplicate sends).
    const sentDraft=input.action==='turn-start'?{text:this.value('codex-composer'),origins:structuredClone(this.workflowDraftOrigins),reviewed:this.reviewedDraftTarget,restored:this.restoredWorkflowDraft,tab:this.tabs?.active()?.key??null}:null;
    const restoreRejectedDraft=()=>{
      if(!sentDraft||!sentDraft.text||this.stopped||this.value('codex-composer')!==''||(this.tabs?.active()?.key??null)!==sentDraft.tab)return;
      this.setComposer(sentDraft.text);
      this.workflowDraftOrigins=sentDraft.origins;this.reviewedDraftTarget=sentDraft.reviewed;this.restoredWorkflowDraft=sentDraft.restored;this.stashTabDraft();
      this.text('codex-notice',(this.el('codex-notice').textContent??'')+' Your message text was restored to the composer.');
    };
    if(input.action==='turn-start'){this.transcript.messages.push({key:input.requestId,role:'human',threadId:input.threadId,scope:input.threadId,text:input.text,acknowledgement:'Awaiting native acknowledgement'});this.setComposer('');this.attachments?.clear();this.clearDraftOrigins();this.stashTabDraft();}
    this.render();this.publishState();
    let acknowledgedStateApplied=false;
    try {
      const outcome=await this.api.action(input,imageRequest?.signal);
      const current=this.snapshot()?.connectionId;
      const freshTask=input.action==='turn-start'&&!!outcome.record.nextConnectionId&&(current===input.connectionId||current===outcome.record.nextConnectionId)&&
        outcome.state.snapshot?.connectionId===outcome.record.nextConnectionId&&outcome.state.snapshot.thread?.threadId===input.threadId&&outcome.state.snapshot.thread.sessionId===this.snapshot()?.thread?.sessionId;
      const focusedTask=input.action==='task-focus'&&!!outcome.record.nextConnectionId&&(current===input.connectionId||current===outcome.record.nextConnectionId)&&
        this.state?.chatTasks?.some(task=>task.taskId===input.taskId&&task.retained===true&&task.threadId===input.threadId&&task.sessionId===outcome.state.snapshot?.thread?.sessionId&&task.connectionId===outcome.record.nextConnectionId);
      const fenced=this.stopped||epoch!==this.generation||((input.action==='grant-assets'||input.action==='revoke-assets')&&assetScope!==this.assetScope())||(input.action!=='connect'&&input.action!=='disconnect'&&current!==input.connectionId&&!freshTask&&!focusedTask)||(input.action==='disconnect'&&!!current&&current!==input.connectionId)||(input.action==='connect'&&!!current&&current!==outcome.record.connectionId);
      if(!fenced){this.readVersion++;this.applyState(outcome.state);this.fresh=true;
        acknowledgedStateApplied=outcome.record.state==='acknowledged';
        const acknowledged:Record<string,string>={connect:'Connected. Choose a model to continue.',disconnect:'Disconnected.',select:'Model updated.','thread-start':'Conversation ready.','thread-resume':'Conversation opened.','turn-start':'Message accepted. Waiting for a response.','turn-interrupt':'Stop requested.','task-stop':'Task stopped.','grant-writes':'Workspace editing enabled for this conversation.','revoke-writes':'Workspace editing disabled.','grant-assets':'Asset jobs enabled for this conversation.','revoke-assets':'Asset jobs disabled.',approval:'Your review was recorded.','history-load':'History loaded.'};
        this.text('codex-notice',outcome.record.state==='acknowledged'?(acknowledged[input.action]??'Request confirmed.'):(codexFailureHint(outcome.record.errorCode)?codexFailureHint(outcome.record.errorCode)+' ':'')+input.action+' · native acknowledgement '+outcome.record.state+' · '+input.requestId+'. Review recorded state before continuing.');}
      if(['pending','unknown'].includes(outcome.record.state))this.uncertain.set(input.requestId,{input,read:false});
      else if(outcome.record.state==='rejected')restoreRejectedDraft();
      const message=this.transcript.messages.find(m=>m.key===input.requestId);if(message)message.acknowledgement='Native acknowledgement: '+outcome.record.state;
      return fenced?undefined:outcome.record;
    } catch(error) {
      if(!(error instanceof CodexHttpError)||error.unknown)this.uncertain.set(input.requestId,{input,read:false});
      if(!this.stopped&&epoch===this.generation)this.text('codex-notice',(error instanceof Error?error.message:'Unknown native HTTP acknowledgement.')+' Request ID retained: '+input.requestId+'. No automatic retry.');
      if(error instanceof CodexHttpError&&!error.unknown)restoreRejectedDraft();
    } finally {
        if(this.imageRequest===imageRequest)this.imageRequest=null;
      this.pending.delete(input.requestId);
      if(!this.stopped){
        this.render();this.publishProviderState();this.publishState();
        // A validated acknowledgement already includes the current native state.
        // Let setup actions hand that state to the next action without an extra
        // blocking GET. Uncertain, failed and fenced outcomes still reconcile.
        if(!acknowledgedStateApplied)await this.refresh();
      }
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
    // A saved tool result keeps the live call's name and display arguments when this session saw it run.
    const liveCalls=new Map(this.transcript.messages.flatMap(m=>m.role==='tool'&&m.toolCall?[[m.key,m.toolCall] as const]:[]));
    if(liveCalls.size)for(const row of recorded){const live=row.role==='tool'?liveCalls.get(row.key):undefined;if(live)row.toolCall=live;}
    return [...recorded,...(this.tabs.bound(this.state)?this.transcript.messages.filter(row=>row.threadId===active.threadId&&!keys.has(row.key)):[])];
  }

  /** What is drawn for each transcript row, so an update rebuilds only from the first row whose rendering changed. */
  private transcriptRows:{sig:string;body:string;nodes:Node[];turn:string|null;change:ToolChange|null;role:string}[]=[];
  /** The conversation (tab key or thread) whose earlier messages were asked for. */
  private earlierView:string|null=null;
  /**
   * Draws the shared transcript. Rows before the first changed one keep their nodes (and listeners, open details and
   * selection); a reply that is still streaming patches only its open block. Studio changes are summarised once per
   * turn, after that turn's last message; a finished turn's usage line follows, inside its last reply when the turn ended
   * with one (as in the Claude chat). Choice buttons stay live only in replies after the last message the user sent.
   */
  private renderTranscript(messages:HTMLElement,all:ChatMessage[],view:string,running:boolean,reset:boolean):void {
    if(!all.length){
      this.transcriptRows=[];
      messages.replaceChildren(this.make('p',this.tabs?.active()?.kind==='draft'?'Local draft. Starting a conversation will not send your message.':this.tabs?.recording()?.recorded?'No public text entries in this saved recording.':'No public history has been loaded for this conversation.','empty'));
      return;
    }
    const turnOf=(message:ChatMessage)=>message.key.split('\0')[1]??null;
    const starts:number[]=[];all.forEach((message,index)=>{if(!index||turnOf(message)!==turnOf(all[index-1]!))starts.push(index);});
    const first=this.earlierView===view?0:transcriptWindowStart(starts);
    const lastHuman=all.findLastIndex(message=>message.role==='human'),nextHuman:(string|null)[]=new Array(all.length).fill(null);
    for(let index=all.length-2,answer:string|null=null;index>=0;index--){if(all[index+1]!.role==='human')answer=all[index+1]!.text;nextHuman[index]=answer;}
    const options=(index:number):ChoiceBlockOptions=>index>lastHuman?{choose:answer=>this.answerChoice(answer)}:{restored:true,answer:nextHuman[index]??null};
    interface Spec{message:ChatMessage;index:number;turn:string|null;last:boolean;line:HTMLElement|null;streaming:boolean;sig:string;body:string}
    const specs:Spec[]=[];let thread:string|null=null;
    for(let index=first;index<all.length;index++){
      const message=all[index]!,turn=turnOf(message),last=index===all.length-1||turnOf(all[index+1]!)!==turn;
      if(index===first||turn!==turnOf(all[index-1]!))thread=message.threadId??message.key.split('\0')[0]??null;
      const line=last&&turn&&thread?this.replyUsageLine(thread,turn):null,streaming=running&&index===all.length-1&&message.role==='codex';
      const extra=JSON.stringify([message.role==='codex'?index>lastHuman?'live':nextHuman[index]??null:'',last,line?[line.textContent,line.title]:null,streaming]);
      specs.push({message,index,turn,last,line,streaming,sig:JSON.stringify(message)+extra,body:JSON.stringify({...message,text:''})+extra});
    }
    const earlier=first>0?'earlier:'+first:null,offset=earlier?1:0,sigs=[...(earlier?[earlier]:[]),...specs.map(spec=>spec.sig)];
    // Rows drawn earlier are reused only while every one of their nodes is still in this transcript.
    const rows=this.transcriptRows,valid=!reset&&typeof messages.contains==='function'&&rows.every(row=>row.nodes.every(node=>messages.contains(node)));
    let keep=0;
    if(valid)while(keep<rows.length&&keep<sigs.length&&rows[keep]!.sig===sigs[keep])keep++;
    if(valid&&keep===sigs.length&&keep===rows.length)return;
    // Only the streaming reply changed: patch its open block in place.
    const tail=specs.at(-1)!,row=rows[keep];
    if(valid&&keep===rows.length-1&&keep===sigs.length-1&&row&&row.role==='codex'&&tail.message.role==='codex'&&row.body===tail.body){
      const card=row.nodes[0] as HTMLElement,body=card.querySelector<HTMLElement>('.message-text');
      if(body){const next=patchMessageText(this.doc,body,this.api.safe(tail.message.text),options(tail.index));if(next!==body)body.replaceWith(next);row.sig=tail.sig;return;}
    }
    if(keep===0)messages.replaceChildren();else for(const old of rows.slice(keep))for(const node of old.nodes)(node as ChildNode).remove();
    const out=rows.slice(0,keep);
    if(earlier&&keep===0){const button=renderEarlierButton(this.doc,first,()=>this.showEarlier(view));messages.append(button);out.push({sig:earlier,body:'',nodes:[button],turn:null,change:null,role:'earlier'});}
    const from=Math.max(0,keep-offset);
    let changes:ToolChange[]=[];
    for(let j=out.length-1;j>=offset&&from>0&&out[j]!.turn===specs[from]!.turn;j--)if(out[j]!.change)changes.unshift(out[j]!.change!);
    for(const spec of specs.slice(from)){
      const {message}=spec,nodes:Node[]=[];let element:HTMLElement,change:ToolChange|null=null;
      if(message.role==='tool'){const tool=renderCodexToolArticle(this.doc,message,value=>this.api.safe(value));change=tool.change??null;element=tool.article;}
      else{
        const card=element=this.make('article',undefined,'codex-message '+message.role);card.setAttribute('aria-label',message.role==='human'?'Your message':'Assistant message');
        // Only the reply being written is a live region; it is announced once it settles.
        if(spec.streaming){card.setAttribute('aria-busy','true');card.setAttribute('aria-live','polite');}
        card.append(message.role==='codex'?renderMessageText(this.doc,this.api.safe(message.text),options(spec.index)):this.make('pre',message.text,'message-text'));
        if(message.role==='human'&&message.text.trim())card.append(this.editAsNewButton(message.text));
        if(message.acknowledgement){const acknowledgement=message.acknowledgement==='Native acknowledgement: acknowledged'?'Accepted':message.acknowledgement==='Native acknowledgement: rejected'?'Not accepted':'Awaiting confirmation';card.append(this.make('p',acknowledgement,'message-acknowledgement'));}
        const metadata=this.make('details',undefined,'message-details');metadata.append(this.make('summary','Message details'),this.make('pre',message.scope+(message.acknowledgement?'\n'+message.acknowledgement:''),'hint mono'));card.append(metadata);
      }
      messages.append(element);nodes.push(element);if(change)changes.push(change);
      if(spec.last){
        const card=renderChangeCard(this.doc,changes);if(card){messages.append(card);nodes.push(card);}changes=[];
        if(spec.line){if(element.className.split(' ').includes('codex'))element.append(spec.line);else{messages.append(spec.line);nodes.push(spec.line);}}
      }
      out.push({sig:spec.sig,body:spec.body,nodes,turn:spec.turn,change,role:message.role});
    }
    this.transcriptRows=out;
  }
  private showEarlier(view:string):void {
    if(this.surfaceYielded)return;
    revealEarlier(this.el('codex-messages'),()=>{this.earlierView=view;this.render();});
  }

  private render() {
    const s=this.snapshot(),t=s?.thread;
    const notice=this.el('codex-notice').textContent??'';
    if(['Connect your local CLI when you’re ready.','No connection or model request is started automatically.','Choose a model to start this conversation.'].includes(notice)) this.text('codex-notice',s?.connected?(t?'Continue in this conversation.':s.selection?'Start your conversation when you’re ready.':'Choose a model to start this conversation.'):'Connect your local CLI when you’re ready.');
    const welcome=this.surfaceYielded?null:this.doc.getElementById('welcome-connect');if(welcome){welcome.hidden=!!s?.connected;welcome.textContent='Connect your local CLI';}
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
    const usage=this.replyUsage?this.replyUsageVersion+JSON.stringify([[...this.transcript.finishedTurns],[...this.transcript.turnUsage]]):'';
    // A long transcript shows its last turns until "Show earlier messages" is chosen for this conversation.
    const view=this.tabs?.active()?.key??'thread:'+(t?.threadId??'');
    // The build progress group stays live while this thread's turn runs (presentation only).
    if(!this.surfaceYielded){const box=this.doc.getElementById('codex-messages'),live=String(!!t&&['starting','inProgress'].includes(t.turnStatus));if(box?.dataset&&box.dataset.turnLive!==live)box.dataset.turnLive=live;}
    const displayedMessages=this.displayMessages(),messageSignature=JSON.stringify(displayedMessages)+usage+(this.earlierView===view?'\0all':'');
    if(!this.surfaceYielded&&messageSignature!==this.messageSignature){
    const reset=!this.messageSignature;this.messageSignature=messageSignature;
    const messages=this.el('codex-messages'),bottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;
    this.renderTranscript(messages,displayedMessages,view,!!t&&['starting','inProgress'].includes(t.turnStatus),reset);
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
    if(!this.surfaceYielded)this.el<HTMLTextAreaElement>('codex-composer').disabled=this.tabs?.persistenceStatus()==='native-loading';
    disable('codex-disconnect',this.stopped||!s||pending('disconnect'));
    const reportedPair=s?.models.some(model=>model.model===this.value('codex-model')&&model.efforts.includes(this.value('codex-effort')));
    disable('codex-select',!this.canSelectModel()||pair||!reportedPair);
    disable('codex-model',!this.canSelectModel());disable('codex-effort',!this.canSelectModel());
    const subscription=s?.account?.auth==='subscription'&&s.account.requiresOpenaiAuth;
    disable('codex-thread-start',this.preparingMessage||!this.canStartThread());disable('codex-thread-resume',this.preparingMessage||(this.tabs?!!this.tabBlockReason()||!this.tabs.saved().some(row=>row.threadId===this.value('codex-resume-id')):!normal||!!t||!pair||!subscription||!text(this.value('codex-resume-id'))));
    const start = this.surfaceYielded ? null : this.doc.getElementById('codex-conversation-start') as HTMLButtonElement | null;
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
    this.applyPendingSelection();
    this.autoReview();
  }
  /** The input hot path only validates the composer; no tabs, catalogue or state notifications. */
  private renderComposer():void {
    if(this.surfaceYielded)return;
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
    // Auto-approve mode: enabling workspace edits for this conversation needs no separate confirmation.
    if(this.autoApprove){void this.dispatch('grant-writes',{threadId:t.threadId});return;}
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
