/// <reference lib="dom" />
interface RuntimeState {version:1;state:'ready'|'stopped'|'saving'|'starting'|'unavailable';message:string}
interface CheckpointRequest {version:1;requestId:string}
export interface RuntimeRecoveryBridge {
  status():Promise<unknown>;retry():Promise<unknown>;ready():Promise<unknown>;
  acknowledge(value:{requestId:string;saved:boolean}):Promise<unknown>;
  onState(listener:(value:unknown)=>void):()=>void;
  onCheckpoint(listener:(value:CheckpointRequest)=>void):()=>void;
}
export interface RuntimeRecoveryOptions {checkpoint:()=>Promise<void>;bridge?:RuntimeRecoveryBridge|null}
const UNSAVED='Chat drafts could not be saved. Keep this window open, review your drafts and try again.';
function state(value:unknown):RuntimeState|null {
  if(!value||typeof value!=='object')return null;const row=value as Record<string,unknown>;
  return row.version===1&&['ready','stopped','saving','starting','unavailable'].includes(String(row.state))&&typeof row.message==='string'&&row.message.length<=400&&!/[\x00-\x1f\x7f]/.test(row.message)?row as unknown as RuntimeState:null;
}
/** The native host owns the restart. This page only saves presentation state and acknowledges that exact request. */
export function startRuntimeRecovery(doc:Document,options:RuntimeRecoveryOptions) {
  const bridge=Object.hasOwn(options,'bridge')?options.bridge:(doc.defaultView as unknown as {arcaneDesktop?:{runtimeRecovery?:RuntimeRecoveryBridge}}|null)?.arcaneDesktop?.runtimeRecovery;
  let stopped=false,epoch=0,lifecycle=0,revision=0,working=false,retrying=false,restore:(()=>void)|null=null;
  let removeState:(()=>void)|undefined,removeCheckpoint:(()=>void)|undefined;
  let current:RuntimeState={version:1,state:'ready',message:''};const completed=new Set<string>();
  const banner=doc.createElement('aside');banner.id='runtime-recovery-banner';banner.className='desktop-update-banner';banner.hidden=true;
  banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');banner.setAttribute('aria-label','Local service recovery');
  const text=doc.createElement('p'),retry=doc.createElement('button');retry.type='button';retry.textContent='Restart services';banner.append(text,retry);
  if(bridge)(doc.querySelector('.app-main')??doc.body).prepend(banner);
  const release=()=>{restore?.();restore=null;};
  function pause(){if(restore)return;const previous=new Map<HTMLElement,boolean>();let branch:Element=banner;
    while(branch.parentElement){for(const sibling of Array.from(branch.parentElement.children))if(sibling!==branch&&sibling instanceof doc.defaultView!.HTMLElement&&!['SCRIPT','STYLE'].includes(sibling.tagName)){previous.set(sibling,sibling.inert);sibling.inert=true;}
      branch=branch.parentElement;if(branch===doc.body)break;}
    restore=()=>{for(const[element,inert]of previous)element.inert=inert;};
  }
  function render(){banner.hidden=stopped||current.state==='ready'||current.state==='unavailable';text.textContent=current.message;
    retry.hidden=current.state!=='stopped';retry.disabled=working||retrying;banner.setAttribute('aria-busy',String(working||retrying));}
  function accept(value:unknown){const next=state(value);if(stopped||!next)return;revision++;
    if(next.state==='stopped')doc.dispatchEvent(new Event('workspace:runtimestopped'));
    if(next.state==='stopped'||next.state==='ready'||next.state==='unavailable'){epoch++;working=false;release();}
    else pause();current=next;render();
  }
  async function checkpoint(request:CheckpointRequest){
    if(!bridge||stopped||!request||request.version!==1||!/^[a-f0-9-]{36}$/.test(request.requestId)||completed.has(request.requestId))return;
    completed.add(request.requestId);if(completed.size>32)completed.delete(completed.values().next().value!);
    const generation=epoch;revision++;
    if(working){try{await bridge.acknowledge({requestId:request.requestId,saved:false});}catch{}return;}
    working=true;pause();current={version:1,state:'saving',message:'Saving chat drafts before restarting local services…'};render();
    let saved=false;
    try{await options.checkpoint();saved=true;}catch{}
    if(stopped||generation!==epoch)return;
    try{
      const reply=await bridge.acknowledge({requestId:request.requestId,saved}) as {acknowledged?:unknown};
      if(reply?.acknowledged!==true)throw new Error();
      if(!saved&&generation===epoch){current={version:1,state:'stopped',message:UNSAVED};release();}
    }catch{if(!stopped&&generation===epoch){current={version:1,state:'stopped',message:UNSAVED};release();}}
    finally{if(!stopped&&generation===epoch){working=false;render();}}
  }
  function connect(){
    const generation=++lifecycle;
    removeState=bridge?.onState(value=>{if(!stopped&&generation===lifecycle)accept(value);});
    removeCheckpoint=bridge?.onCheckpoint(request=>{if(!stopped&&generation===lifecycle)void checkpoint(request);});
    const before=revision;
    void bridge?.status().then(value=>{if(!stopped&&generation===lifecycle&&before===revision)accept(value);}).catch(()=>{});
  }
  retry.addEventListener('click',event=>{if(!bridge||!event.isTrusted||event.defaultPrevented||stopped||working||retrying||current.state!=='stopped')return;
    const generation=lifecycle;retrying=true;render();void bridge.retry().catch(()=>{if(!stopped&&generation===lifecycle){current={version:1,state:'stopped',message:'Local services could not restart. Keep this window open and try again.'};}}).finally(()=>{if(!stopped&&generation===lifecycle){retrying=false;render();}});
  });
  connect();
  return {
    async ready(){if(stopped||!bridge)return false;const generation=lifecycle,value=await bridge.ready() as {ready?:unknown};return !stopped&&generation===lifecycle&&value?.ready===true;},
    stop(){if(stopped)return;stopped=true;lifecycle++;epoch++;working=false;retrying=false;release();
      const removers=[removeState,removeCheckpoint];removeState=removeCheckpoint=undefined;
      for(const remove of removers){try{remove?.();}catch{/* Old callbacks remain fenced by the lifecycle. */}}render();},
    resume(){if(!stopped)return;stopped=false;epoch++;current={version:1,state:'ready',message:''};render();connect();},
  };
}
