import { workflowNativeModel } from './workflow-native-model.js';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CodexClientError } from '../../../packages/codex-client/src/index.js';
import type { CodexService, CodexProductState } from './codex-service.js';
import { REFERENCE_IMAGE_LIMITS } from '../../../packages/codex-client/src/reference-images.js';
const MAX_BODY = 160 * 1024, MAX_RESPONSE = 4 * 1024 * 1024;
const byteLength = (text: string) => Buffer.byteLength(text,'utf8');
function matches(supplied: string, expected: string): boolean { return expected.length > 0 && byteLength(supplied)===byteLength(expected) && timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)); }
class RouteError extends Error { constructor(public code: string, public status: number) { super(code); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Exact {connectionId,threadId,taskId}; validated before any service or native access. */
function proposalScope(value: unknown): value is { connectionId: string; threadId: string; taskId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value).sort(), row = value as Record<string, unknown>;
  return keys.join(',') === 'connectionId,taskId,threadId' && typeof row.connectionId === 'string' && UUID.test(row.connectionId) &&
    typeof row.taskId === 'string' && UUID.test(row.taskId) && typeof row.threadId === 'string' && row.threadId.length > 0 &&
    row.threadId.length <= 256 && !/[\x00-\x1f\x7f]/.test(row.threadId);
}
async function body(request: IncomingMessage,maximum=MAX_BODY): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json' || request.headers['content-encoding']) throw new RouteError('CONTENT_TYPE',415);
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length)>maximum)) throw new RouteError('BODY_LIMIT',413);
  const chunks: Buffer[]=[]; let bytes=0;
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_,reject)=>{ timer=setTimeout(()=>{ request.destroy(); reject(new RouteError('BODY_TIMEOUT',408)); },8000); });
  try {
    await Promise.race([deadline,(async()=>{
      for await(const raw of request) {const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw as string);bytes+=chunk.length;if(bytes>maximum)throw new RouteError('BODY_LIMIT',413);chunks.push(chunk);}
    })()]);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RouteError('JSON',400); }
  } finally { clearTimeout(timer!); }
}
async function discard(request: IncomingMessage,response: ServerResponse): Promise<void> {
  if (request.complete || request.destroyed) return;
  // Drain only a small rejected body before answering; stalled/unbounded bodies
  // close after the response. Do not parse it or leave it on a reusable socket.
  const reusable = await new Promise<boolean>(resolve => {
    let bytes=0, done=false;
    const finish=(value:boolean)=>{if(done)return;done=true;clearTimeout(timer);request.off('data',data);request.off('end',end);request.off('error',failed);request.off('aborted',failed);resolve(value);};
    const data=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>65536)finish(false);};
    const end=()=>finish(true), failed=()=>finish(false);
    const timer=setTimeout(()=>finish(false),200);
    request.on('data',data);request.once('end',end);request.once('error',failed);request.once('aborted',failed);request.resume();
  });
  if(!reusable){response.setHeader('Connection','close');response.once('finish',()=>setTimeout(()=>request.socket.destroy(),25));}
}export function codexRoutes(service: CodexService, options: { workflowModels?: true } = {}) {
  const project = (state: CodexProductState): CodexProductState => options.workflowModels ? {...state,workflowModel:workflowNativeModel(state)?.proof??null} : state;
  return async(request: IncomingMessage,response: ServerResponse,url: URL,controlToken: string,origin: string,agentToken: string):Promise<boolean>=>{
    if(!url.pathname.startsWith('/v1/codex/'))return false;
    const compact = (state: CodexProductState): CodexProductState => {
      const strip = (snapshot: CodexProductState['snapshot']) => snapshot ? {...snapshot,approvals:[],events:[],droppedEvents:snapshot.droppedEvents+snapshot.events.length} : null;
      return {...state,...(options.workflowModels?{workflowModel:null}:{}),displayLimited:true,snapshot:strip(state.snapshot),lastSnapshot:strip(state.lastSnapshot)};
    };
    const send=(status:number,value:unknown)=>{
      if(response.destroyed||response.headersSent)return;
      let text=JSON.stringify(value);for(const secret of [controlToken,agentToken])if(secret)text=text.replaceAll(secret,'[REDACTED]');
      if(byteLength(text)>MAX_RESPONSE && typeof value==='object' && value!==null && 'state' in value) {
        const state=(value as {state:CodexProductState}).state;
        text=JSON.stringify({...value,state:compact(state)});
        for(const secret of [controlToken,agentToken])if(secret)text=text.replaceAll(secret,'[REDACTED]');
      }
      if(byteLength(text)>MAX_RESPONSE) {status=500;text=JSON.stringify({error:'STATE_LIMIT',message:'Native state cannot be displayed. This does not mean an action failed or was not accepted; inspect its request ID in the native client. Do not replay it.'});}
      response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(text);
    };
    try{
      if(request.headers.host!==new URL(origin).host)throw new RouteError('HOST',403);
      const supplied=request.headers.authorization?.startsWith('Bearer ')?request.headers.authorization.slice(7):'';
      if(!matches(supplied,controlToken))throw new RouteError(matches(supplied,agentToken)?'HUMAN_ONLY':'AUTH',matches(supplied,agentToken)?403:401);
      if(request.headers.origin&&request.headers.origin!==origin)throw new RouteError('ORIGIN',403);
      if(url.search&&url.pathname!=='/v1/codex/task-plan')throw new RouteError('QUERY',400);
      if(url.pathname==='/v1/codex/task-plan'){
        if(request.method!=='GET')throw new RouteError('METHOD',405);
        if(!service.taskPlan)throw new RouteError('TASK_PLAN_UNAVAILABLE',404);
        if(url.search.length>2048||[...url.searchParams.keys()].length!==3||
          !['connectionId','threadId','taskId'].every(key=>url.searchParams.getAll(key).length===1))throw new RouteError('QUERY',400);
        const input=Object.fromEntries(url.searchParams);
        if(!proposalScope(input))throw new RouteError('TASK_SCOPE',400);
        const view=await service.taskPlan(input);
        if(byteLength(JSON.stringify(view))>65536)throw new RouteError('TASK_PLAN_LIMIT',500);
        send(200,view);return true;
      }
      if(url.pathname==='/v1/codex/state'){
        if(request.method!=='GET')throw new RouteError('METHOD',405);
        send(200,{state:project(service.state())});return true;
      }
      if(url.pathname==='/v1/codex/history'){
        if(request.method!=='GET')throw new RouteError('METHOD',405);
        send(200,{nativeHistory:service.state().nativeHistory ?? null});return true;
      }
      if(url.pathname==='/v1/codex/usage'){
        if(request.method!=='POST')throw new RouteError('METHOD',405);
        if(request.headers.origin!==origin)throw new RouteError('ORIGIN',403);
        if(!service.refreshUsage)throw new RouteError('RATE_LIMITS_UNAVAILABLE',400);
        const input=await body(request,1024);
        send(200,{state:project(await service.refreshUsage(input))});return true;
      }
      if(url.pathname==='/v1/codex/proposals'){
        // Display-only read for one exact owned task; never journaled and never starts work.
        if(request.method!=='POST')throw new RouteError('METHOD',405);
        if(request.headers.origin!==origin)throw new RouteError('ORIGIN',403);
        if(!service.proposals)throw new RouteError('PROPOSALS_UNAVAILABLE',404);
        const input=await body(request,1024);
        if(!proposalScope(input))throw new RouteError('PROPOSAL_SCOPE',400);
        send(200,{proposals:service.proposals(input)});return true;
      }
      const referenceTurn=url.pathname==='/v1/codex/reference-turn';
      if(url.pathname!=='/v1/codex/action'&&!referenceTurn)throw new RouteError('NOT_FOUND',404);
      if(request.method!=='POST')throw new RouteError('METHOD',405);
      if(request.headers.origin!==origin)throw new RouteError('ORIGIN',403);
      const input=await body(request,referenceTurn?REFERENCE_IMAGE_LIMITS.actionBytes:MAX_BODY);
      if(referenceTurn&&(!input||typeof input!=='object'||Array.isArray(input)||(input as {action?:unknown}).action!=='turn-start'||!Object.hasOwn(input,'references'))||
        !referenceTurn&&!!input&&typeof input==='object'&&Object.hasOwn(input,'references'))throw new RouteError('REFERENCE_ENVELOPE',400);
      const outcome=await service.action(input);
      const status=outcome.record.state==='unknown'?202:outcome.record.state==='rejected'?409:outcome.record.state==='pending'?202:200;
      send(status,{...outcome,state:project(outcome.state)});
    }catch(error){
      await discard(request,response);
      const known=error instanceof RouteError||error instanceof CodexClientError;
      const code=known?error.code:'NATIVE_ERROR';
      const status=error instanceof RouteError?error.status:code==='IDEMPOTENCY'?409:code==='JOURNAL_LIMIT'?429:known?400:500;
      send(status,{error:code,message:'Native request was refused or failed. Inspect its recorded request ID before retrying; native account/process output is not exposed.'});
    }
    return true;
  };
}

