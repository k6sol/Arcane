import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import {lstatSync} from 'node:fs';
import {workflowProjectIdentity} from '../../../packages/storage/src/workflow-store.js';
import type {StudioNativeCustodyPort,StudioNativeCustodyTicket,StudioNativeCustodyOperation,StudioNativeCustodyEvidence} from '../../../packages/storage/src/studio-store.js';
import type {NativeTestConnection} from './studio-test-service.js';
import {STUDIO_TEST_OWNED_CLOSE_MS,closeAfterStudioTestConnectFailure,type StudioTestOwnedClose} from './studio-test-owned-close.js';

export const SDK_CUSTODY_UNCONFIRMED_MESSAGE='Studio native operations are paused because Arcane could not confirm that an owned SDK connection closed. Saved playtest reports remain available. Edit-mode record repair cannot settle this connection. Do not retry native work or delete the retained records.';
export function nativeCustodyRefusal():never{throw new ArcaneError('SDK_CUSTODY_UNCONFIRMED',SDK_CUSTODY_UNCONFIRMED_MESSAGE);}

/** Original host project only. Checks are observations, not an atomic OS lock. */
export function captureStudioTestNativeProject(projectPath:string){
  const original=workflowProjectIdentity(projectPath),identity=lstatSync(original.projectPath,{bigint:true});
  const key=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
  if(!identity.isDirectory()||identity.isSymbolicLink())nativeCustodyRefusal();
  let lost=false;
  return Object.freeze({projectId:original.projectId,assertCurrent(){
    if(lost)nativeCustodyRefusal();
    try{
      const current=workflowProjectIdentity(projectPath),info=lstatSync(current.projectPath,{bigint:true});
      if(current.projectId!==original.projectId||key(current.projectPath)!==key(original.projectPath)||!info.isDirectory()||info.isSymbolicLink()||info.dev!==identity.dev||info.ino!==identity.ino)throw new Error();
    }catch{lost=true;nativeCustodyRefusal();}
  }});
}

/** Private default-launcher hooks. No callback or ticket comes from a request. */
export interface StudioTestNativeConnectAttempt {
  assertCurrent():void;
  launchAttempted():void;
  observePhysicalClose(closed:Promise<void>):void;
  noStart():void;
  closeFailed(error:unknown):void;
}
/** The actual default connector and controlled SDK fixtures share this path.
 * Close failure is sticky even if the original physical event arrived first. */
export function closeAfterStudioTestNativeConnectFailure(attempt:StudioTestNativeConnectAttempt,
  owned:StudioTestOwnedClose,error:unknown):Promise<never>{
  return closeAfterStudioTestConnectFailure({async close(){
    try{await owned.close();}catch(failure){attempt.closeFailed(failure);throw failure;}
  }},error);
}
type Entry={ticket:StudioNativeCustodyTicket;epoch:number;evidence:StudioNativeCustodyEvidence;
  attempted:boolean;observed:boolean;settled:boolean;closing:boolean;finished:boolean;
  raw:NativeTestConnection|null;close:()=>Promise<void>;pending:Promise<void>|null;
  done:Promise<void>;finish:()=>void;factoryFinished:boolean;quiescence:Promise<void>;resolveJoin:()=>void;rejectJoin:(error:unknown)=>void;
  joinSettled:boolean;failed:boolean;failure:unknown;settlement:'no-start'|'native-close'|'fixture-close'|null};

/** One fixed-project store port and original in-memory owners. Retained rows
 * never recreate a connection, a signal, a capability, or a settlement ticket. */
export function createStudioTestNativeCustody(port:StudioNativeCustodyPort|undefined,assertProject?:()=>void){
  const entries=new Set<Entry>(),connections=new WeakMap<NativeTestConnection,Entry>();
  const preEntryFailures=new WeakMap<object,'not-admitted'|'ownership-uncertain'>();
  const classify=(error:unknown,kind:'not-admitted'|'ownership-uncertain')=>{if(error!==null&&(typeof error==='object'||typeof error==='function'))preEntryFailures.set(error,kind);return error;};
  const refuseBeforeEntry=():never=>{throw classify(new ArcaneError('SDK_CUSTODY_UNCONFIRMED',SDK_CUSTODY_UNCONFIRMED_MESSAGE),'ownership-uncertain');};
  let epoch=0,retired=false,fenced=false,opening=0,closing=0,shutdown:Promise<void>|null=null;
  const ready=()=>{
    if(retired||fenced||!port)nativeCustodyRefusal();
    try{assertProject?.();port.assertReady();}catch{
      const failure=new ArcaneError('SDK_CUSTODY_UNCONFIRMED',SDK_CUSTODY_UNCONFIRMED_MESSAGE);
      fenced=true;epoch++;
      for(const entry of entries){
        if(!entry.failed){entry.failed=true;entry.failure=failure;}
        checkJoin(entry);
        if(!entry.settled)try{port.quarantine(entry.ticket,'scope-lost');}catch{/* Keep the original pending row. */}
      }
      throw failure;
    }
  };
  const checkJoin=(entry:Entry)=>{
    if(entry.joinSettled)return;
    if(entry.failed){entry.joinSettled=true;entry.rejectJoin(entry.failure);}
    else if(entry.factoryFinished&&entry.finished&&entry.settled){entry.joinSettled=true;entry.resolveJoin();}
  };
  const quarantine=(entry:Entry,...failure:[]|[unknown])=>{
    if(!entry.failed){entry.failed=true;entry.failure=failure.length?failure[0]:new ArcaneError('SDK_CUSTODY_UNCONFIRMED',SDK_CUSTODY_UNCONFIRMED_MESSAGE);}
    checkJoin(entry);
    fenced=true;epoch++;
    // For an already-settled identical ticket the port latches only its local
    // fence and preserves the truthful row. Stale slot replay cannot mutate it.
    try{port?.quarantine(entry.ticket,'close-unconfirmed');}catch{/* Keep the original retained evidence and local fence. */}
  };
  const finish=(entry:Entry)=>{
    if(entry.finished)return;entry.finished=true;entry.finish();
    if(entry.settled)entries.delete(entry);checkJoin(entry);
  };
  const settle=(entry:Entry,kind:'no-start'|'native-close'|'fixture-close')=>{
    if(entry.settled){if(entry.settlement!==kind)quarantine(entry);return;}
    try{
      if(!port)nativeCustodyRefusal();
      if(kind==='no-start')port.settleNoStart(entry.ticket);
      else if(kind==='native-close')port.settleNativeClosed(entry.ticket);
      else port.settleFixtureClosed(entry.ticket);
      entry.settled=true;entry.settlement=kind;if(entry.finished)entries.delete(entry);checkJoin(entry);
    }catch(error){quarantine(entry,error);}
  };
  const assertEntry=(entry:Entry)=>{
    ready();if(entry.epoch!==epoch||entry.closing||entry.finished)nativeCustodyRefusal();
  };
  const beginClosing=(entry:Entry)=>{if(!entry.closing&&!entry.finished){entry.closing=true;closing++;}};
  const connect=async(operation:StudioNativeCustodyOperation,evidence:StudioNativeCustodyEvidence,
    factory:(attempt:StudioTestNativeConnectAttempt)=>Promise<NativeTestConnection>,
    validate:(connection:NativeTestConnection)=>void=()=>{},observeWorkJoin?:(quiescence:Promise<void>)=>void):Promise<NativeTestConnection>=>{
    try{ready();}catch(error){throw classify(error,'ownership-uncertain');}
    if(!port)refuseBeforeEntry();
    if(opening||closing)throw classify(new ArcaneError('BUSY','A native connection is opening or closing.'),'not-admitted');
    // The reserve is synchronous and committed before invoking any factory.
    let ticket:StudioNativeCustodyTicket;
    try{ticket=port.reserve(operation,evidence);}catch{fenced=true;epoch++;refuseBeforeEntry();}
    let resolveDone!:()=>void,resolveJoin!:()=>void,rejectJoin!:(error:unknown)=>void;
    const quiescence=new Promise<void>((resolve,reject)=>{resolveJoin=resolve;rejectJoin=reject;});void quiescence.catch(()=>{});
    const entry:Entry={ticket,epoch,evidence,attempted:false,observed:false,settled:false,closing:false,finished:false,
      raw:null,pending:null,done:new Promise<void>(resolve=>{resolveDone=resolve;}),finish:()=>resolveDone(),close:()=>Promise.resolve(),
      factoryFinished:false,quiescence,resolveJoin,rejectJoin,joinSettled:false,failed:false,failure:undefined,settlement:null};
    entries.add(entry);opening++;
    const attempt:StudioTestNativeConnectAttempt=Object.freeze({
      assertCurrent:()=>assertEntry(entry),
      launchAttempted(){assertEntry(entry);if(entry.attempted||entry.settled)nativeCustodyRefusal();entry.attempted=true;},
      observePhysicalClose(closed:Promise<void>){
        if(evidence!=='native'||entry.observed||entry.attempted||entry.settled)nativeCustodyRefusal();
        entry.observed=true;
        // Only the default launcher's original pre-connect observer enters here.
        // The callback is bounded synchronous storage work and cannot throw into SDK handling.
        void closed.then(()=>settle(entry,'native-close'),()=>quarantine(entry));
      },
      noStart(){if(entry.attempted||entry.settled)return;settle(entry,'no-start');},
      closeFailed(error:unknown){quarantine(entry,error);},
    });
    entry.close=()=>entry.pending??= (async()=>{
      beginClosing(entry);
      try{
        if(!entry.raw){quarantine(entry);nativeCustodyRefusal();}
        await entry.raw.close();
        if(evidence==='fixture'&&entry.raw.evidence==='fixture')settle(entry,'fixture-close');
        // Native close() must have observed and durably settled the actual event.
        if(!entry.settled){quarantine(entry);nativeCustodyRefusal();}
      }catch(error){quarantine(entry,error);throw error;}
      finally{closing--;finish(entry);}
    })();
    try{
      try{observeWorkJoin?.(quiescence);}catch(error){settle(entry,'no-start');finish(entry);throw error;}
      const raw=await factory(attempt);entry.raw=raw;
      validate(raw);
      if(raw.evidence!==evidence)nativeCustodyRefusal();
      assertEntry(entry);
      const wrapped:NativeTestConnection=Object.freeze({client:raw.client,evidence:raw.evidence,witness:raw.witness.bind(raw),close:entry.close});
      connections.set(wrapped,entry);return wrapped;
    }catch(error){
      // A rejected opaque fixture factory is not proof that it never launched.
      if(entry.raw)try{await entry.close();}catch{/* Preserve the factory/admission error object. */}
      if(!entry.settled)quarantine(entry);
      finish(entry);throw error;
    }finally{entry.factoryFinished=true;checkJoin(entry);opening--;}
  };
  const retireAdmissions=()=>{if(retired)return;retired=true;epoch++;try{port?.retireAdmissions();}catch{fenced=true;}};
  return Object.freeze({
    assertReady:ready,
    preEntryRefusal(error:unknown):'not-admitted'|'ownership-uncertain'|null{return error!==null&&(typeof error==='object'||typeof error==='function')?preEntryFailures.get(error)??null:null;},
    retireAdmissions,
    beginClosing(connection:NativeTestConnection){const entry=connections.get(connection);if(!entry)nativeCustodyRefusal();beginClosing(entry);},
    assertConnection(connection:NativeTestConnection){
      const entry=connections.get(connection);if(!entry)nativeCustodyRefusal();assertEntry(entry);
      // Another connection may be opening/closing while an older preparation
      // still exists. It cannot start a new effect through that preparation.
      if(opening||closing)throw new ArcaneError('BUSY','A native connection is opening or closing.');
    },
    connect,
    close():Promise<void>{
      if(shutdown)return shutdown;
      retireAdmissions();
      const owned=[...entries];
      // Returned clients get one original cached close. Held factories remain
      // observed and will close their result when the retired epoch is checked.
      for(const entry of owned)if(entry.raw)void entry.close().catch(()=>{});
      shutdown=(async()=>{
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{
          const done=Promise.all(owned.map(entry=>entry.done)).then(()=>true);
          const deadline=new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),STUDIO_TEST_OWNED_CLOSE_MS);});
          if(!await Promise.race([done,deadline]))for(const entry of owned)if(!entry.finished)quarantine(entry);
          if(fenced||owned.some(entry=>!entry.settled))nativeCustodyRefusal();
        }finally{if(timer!==undefined)clearTimeout(timer);}
      })();return shutdown;
    },
  });
}
