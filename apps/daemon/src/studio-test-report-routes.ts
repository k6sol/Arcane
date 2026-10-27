import {createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {scenarioCaptureSchema,SCENARIO_LIMITS,type ScenarioCapture} from '../../../packages/studio-test-controller/src/scenario.js';
import {scenarioPng} from '../../../packages/studio-test-controller/src/scenario-image.js';
import type {StudioTestReportStore,StudioTestReportArchiveStatus} from './studio-test-report-store.js';
import {assertStudioTestHttpIngress,type StudioTestActorResolver} from './studio-test-routes.js';

export const STUDIO_TEST_REPORT_HTTP_LIMITS=Object.freeze({listBytes:32*1024,reportBytes:272*1024,deadlineMs:8000,cursorChars:100});
export interface StudioTestReportHttpScope {readonly projectId:string;readonly assertCurrent:()=>void}
export interface StudioTestReportRouteOptions {
  /** Captures the original project/daemon epoch. Equality after A?B?A is insufficient. */
  readonly captureScope:()=>StudioTestReportHttpScope;
  readonly readCapture:(image:ScenarioCapture,guard:()=>void)=>Promise<Buffer>;
  /** Root may combine independent store and live-service archival faults. */
  readonly archiveStatus?:()=>StudioTestReportArchiveStatus;
}
export type StudioTestReportRouteStore=Pick<StudioTestReportStore,'projectId'|'status'|'list'|'get'|'captureDescriptor'>;
const PREFIX='/v1/playtests/history',UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/,HASH=/^[a-f0-9]{64}(?![\s\S])/;
const CODES=['ARCHIVE_UNAVAILABLE','ARCHIVE_WRITE','ARCHIVE_CORRUPT','ARCHIVE_LIMIT','ARCHIVE_INPUT','ARCHIVE_CONFLICT'] as const;
class HistoryRouteError extends Error {constructor(readonly code:string){super(code);}}
function fail(code:string):never{throw new HistoryRouteError(code);}
function archive(value:StudioTestReportArchiveStatus):StudioTestReportArchiveStatus {
  if(!value||typeof value!=='object'||Object.keys(value).length!==2||!Object.hasOwn(value,'state')||!Object.hasOwn(value,'code')||
    (value.state==='ready'?value.code!==null:value.state!=='degraded'&&value.state!=='unavailable'||!CODES.some(code=>code===value.code)))fail('ARCHIVE_UNAVAILABLE');
  if(value.state==='ready')return Object.freeze({state:'ready',code:null});
  return Object.freeze({state:value.state,code:value.code});
}
const ERRORS:Readonly<Record<string,readonly[number,string]>>=Object.freeze({
  AUTH:[401,'An authenticated local human is required.'],HUMAN_AUTH_REQUIRED:[403,'Historical reports require the authenticated human panel.'],
  HOST:[403,'The exact configured loopback host is required.'],ORIGIN:[403,'The exact local panel Origin is required.'],SCOPE:[403,'The original project or daemon context changed.'],
  METHOD:[405,'Historical reports support GET only.'],QUERY:[400,'Supply only the bounded query for this historical endpoint.'],INVALID_REQUEST:[400,'The historical request is invalid.'],
  NOT_FOUND:[404,'The historical report was not found.'],CAPTURE_UNAVAILABLE:[404,'The retained image is unavailable.'],RESPONSE_LIMIT:[502,'The historical response exceeds its byte bound.'],
  TIMEOUT:[504,'The historical read exceeded its deadline.'],ARCHIVE_INPUT:[400,'The historical cursor or report identity is invalid.'],CURSOR_INVALID:[400,'The historical cursor is invalid or no longer available.'],
  ARCHIVE_UNAVAILABLE:[503,'Historical reports are unavailable.'],ARCHIVE_WRITE:[503,'Historical archival is degraded.'],ARCHIVE_CORRUPT:[503,'Historical reports require review.'],ARCHIVE_LIMIT:[503,'Historical archival reached its bound.'],ARCHIVE_CONFLICT:[503,'Historical reports require review.'],
});
/** Human-only retained reads; no live test, native connection, consent or actor
 * recovery capability is reachable through this fixed-project component. */
export function studioTestReportRoutes(store:StudioTestReportRouteStore,resolveActor:StudioTestActorResolver,options:StudioTestReportRouteOptions){
  return async(request:IncomingMessage,response:ServerResponse,url:URL,origin:string):Promise<boolean>=>{
    if(url.pathname!==PREFIX&&!url.pathname.startsWith(PREFIX+'/'))return false;
    const originalAuthorization=request.headers.authorization,credential=originalAuthorization?.startsWith('Bearer ')?originalAuthorization.slice(7):'';let expired=false,disconnected=false,timer:ReturnType<typeof setTimeout>|undefined,onClose:(()=>void)|undefined;
    const send=(status:number,value:unknown,limit:number)=>{
      if(response.destroyed||response.writableEnded||response.headersSent)return;
      const text=JSON.stringify(value);if(text===undefined||Buffer.byteLength(text)>limit)fail('RESPONSE_LIMIT');
      if(credential&&text.includes(JSON.stringify(credential).slice(1,-1)))fail('ARCHIVE_UNAVAILABLE');
      response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(text),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; sandbox",...(status>=400?{Connection:'close'}:{})});response.end(text);
    };
    const human=()=>{const actor=resolveActor(request);if(!actor)fail('AUTH');if(actor.kind!=='human'||actor.id!=='human')fail('HUMAN_AUTH_REQUIRED');};
    try{
      assertStudioTestHttpIngress(request,url,origin);human();
      if(request.method!=='GET'){response.setHeader('Allow','GET');fail('METHOD');}
      if(![PREFIX,PREFIX+'/report',PREFIX+'/capture'].includes(url.pathname))fail('NOT_FOUND');
      if(request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')fail('INVALID_REQUEST');
      const listing=url.pathname===PREFIX,allowed=listing?'cursor':'id',seen=new Set<string>();
      for(const key of url.searchParams.keys()){if(key!==allowed||seen.has(key))fail('QUERY');seen.add(key);}
      const parameter=url.searchParams.get(allowed);
      if(listing?parameter!==null&&(parameter.length===0||parameter.length>STUDIO_TEST_REPORT_HTTP_LIMITS.cursorChars):parameter===null||!UUID.test(parameter))fail('QUERY');
      const scope=options.captureScope(),projectId=store.projectId;
      if(!HASH.test(projectId)||scope.projectId!==projectId||typeof scope.assertCurrent!=='function')fail('SCOPE');
      const guard=()=>{
        if(expired||disconnected||request.aborted||response.destroyed||response.writableEnded||response.headersSent||request.headers.authorization!==originalAuthorization)fail('SCOPE');
        assertStudioTestHttpIngress(request,url,origin);try{human();scope.assertCurrent();}catch{fail('SCOPE');}if(scope.projectId!==projectId||store.projectId!==projectId)fail('SCOPE');
      };
      const status=()=>{guard();const result=archive(options.archiveStatus?options.archiveStatus():store.status());guard();return result;};
      guard();
      const deadline=new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{expired=true;reject(new HistoryRouteError('TIMEOUT'));},STUDIO_TEST_REPORT_HTTP_LIMITS.deadlineMs);
        onClose=()=>{disconnected=true;reject(new HistoryRouteError('SCOPE'));};response.once('close',onClose);
      });
      const operation=(async()=>{
        guard();
        if(listing){const page=store.list({cursor:parameter},guard);guard();if(page.projectId!==projectId||page.schemaVersion!==1)fail('ARCHIVE_UNAVAILABLE');return{kind:'json' as const,value:{...page,archive:status()},limit:STUDIO_TEST_REPORT_HTTP_LIMITS.listBytes};}
        if(parameter===null)fail('QUERY');
        if(url.pathname===PREFIX+'/report'){
          const report=store.get(parameter,guard);guard();if(!report)fail('NOT_FOUND');if(report.projectId!==projectId||report.jobId!==parameter)fail('ARCHIVE_UNAVAILABLE');
          return{kind:'json' as const,value:{schemaVersion:1,projectId,archive:status(),report,receiptScope:'historical-playtest',currentSource:'unobserved',readOnly:true},limit:STUDIO_TEST_REPORT_HTTP_LIMITS.reportBytes};
        }
        const report=store.get(parameter,guard);guard();if(!report)fail('NOT_FOUND');if(report.projectId!==projectId||report.jobId!==parameter)fail('ARCHIVE_UNAVAILABLE');
        const descriptor=store.captureDescriptor(parameter,guard);guard();if(!descriptor)fail('CAPTURE_UNAVAILABLE');
        const image=scenarioCaptureSchema.parse(descriptor);guard();let bytes:Buffer;
        try{bytes=await options.readCapture(image,guard);}catch{guard();throw new HistoryRouteError('CAPTURE_UNAVAILABLE');}guard();
        if(!Buffer.isBuffer(bytes)||bytes.length>SCENARIO_LIMITS.imageBytes||bytes.length!==image.bytes||createHash('sha256').update(bytes).digest('hex')!==image.sha256)fail('CAPTURE_UNAVAILABLE');
        try{const size=scenarioPng(bytes);if(size.width!==image.width||size.height!==image.height)fail('CAPTURE_UNAVAILABLE');}catch{fail('CAPTURE_UNAVAILABLE');}
        guard();return{kind:'image' as const,bytes};
      })();
      const result=await Promise.race([operation,deadline]);guard();
      if(result.kind==='json')send(200,result.value,result.limit);
      else{response.writeHead(200,{'Content-Type':'image/png','Content-Length':result.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; sandbox"});response.end(result.bytes);}
    }catch(error){
      const code=error instanceof Error&&'code'in error&&typeof error.code==='string'&&Object.hasOwn(ERRORS,error.code)?error.code:'ARCHIVE_UNAVAILABLE';
      const [status,message]=ERRORS[code]!;send(status,{error:code,message},STUDIO_TEST_REPORT_HTTP_LIMITS.listBytes);
    }finally{if(timer)clearTimeout(timer);if(onClose)response.off('close',onClose);}
    return true;
  };
}
