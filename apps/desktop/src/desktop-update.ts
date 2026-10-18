/// <reference lib="dom" />
interface UpdateStatus {version:1;state:'current'|'available'|'unavailable';buildId:string|null;message:string}
interface UpdateBridge {status():Promise<unknown>;restart():Promise<unknown>}
export interface DesktopUpdateOptions {beforeRestart?:()=>Promise<void>;pollMs?:number}
const message=(value:unknown,fallback:string)=>typeof value==='string'&&value.length<=400&&!/[\u0000-\u0008\u000e-\u001f]/u.test(value)?value:fallback;
function readStatus(value:unknown):UpdateStatus|null{
  if(!value||typeof value!=='object')return null;
  const row=value as Record<string,unknown>;
  if(row.version!==1||!['current','available','unavailable'].includes(String(row.state))||!(row.buildId===null||typeof row.buildId==='string'&&/^[a-f0-9-]{1,128}$/.test(row.buildId)))return null;
  return {version:1,state:row.state as UpdateStatus['state'],buildId:row.buildId as string|null,message:message(row.message,'An update is ready. Restart Arcane to use it.')};
}
/** Installed-build observation only. Restart is always a separate, trusted button click. */
export function startDesktopUpdates(doc:Document,options:DesktopUpdateOptions={}){
  const bridge=(doc.defaultView as unknown as {arcaneDesktop?:{updates?:UpdateBridge}}|null)?.arcaneDesktop?.updates;
  let stopped=false,epoch=0,timer:ReturnType<typeof setTimeout>|null=null,inflight:Promise<void>|null=null,pending=false;
  let available=false,notice='',restarting=false;
  const banner=doc.createElement('aside');banner.id='desktop-update-banner';banner.className='desktop-update-banner';banner.hidden=true;
  banner.setAttribute('aria-label','Arcane update');banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');
  const text=doc.createElement('p'),button=doc.createElement('button');button.type='button';button.textContent='Restart to update';banner.append(text,button);
  if(bridge)(doc.querySelector('.app-main')??doc.body).prepend(banner);
  function render(){banner.hidden=!available&&!notice&&!restarting;text.textContent=notice||(restarting?'Restarting Arcane…':'An update is ready. Restart Arcane to use it.');button.hidden=!available||restarting;button.disabled=pending;banner.setAttribute('aria-busy',String(pending));}
  function pauseWorkspace(){const previous=new Map<HTMLElement,boolean>();let branch:Element=banner;
    while(branch.parentElement){for(const sibling of Array.from(branch.parentElement.children))if(sibling!==branch&&sibling instanceof doc.defaultView!.HTMLElement&&!['SCRIPT','STYLE'].includes(sibling.tagName)){previous.set(sibling,sibling.inert);sibling.inert=true;}
      branch=branch.parentElement;if(branch===doc.body)break;}
    return ()=>{for(const [element,inert] of previous)element.inert=inert;};
  }
  function schedule(){if(timer)clearTimeout(timer);timer=null;if(!stopped&&bridge)timer=setTimeout(()=>{if(!doc.hidden)void check();else schedule();},options.pollMs??15000);}
  async function check():Promise<void>{
    if(stopped||!bridge||pending)return;
    if(inflight)return inflight;
    const generation=epoch;
    inflight=(async()=>{try{const state=readStatus(await bridge.status());if(stopped||generation!==epoch||pending)return;
      available=state?.state==='available';if(!available&&!restarting)notice='';render();
    }catch{if(!stopped&&generation===epoch&&!pending){available=false;if(!restarting)notice='';render();}}
    })().finally(()=>{inflight=null;if(generation!==epoch&&!stopped)void check();else schedule();});return inflight;
  }
  button.addEventListener('click',event=>{if(!event.isTrusted||event.defaultPrevented||pending||stopped||!bridge||!available)return;
    pending=true;notice='Saving your workspace…';render();const generation=epoch,restore=pauseWorkspace();
    void(async()=>{try{
      await options.beforeRestart?.();if(stopped||generation!==epoch)return;
      const result=await bridge.restart() as {state?:unknown;message?:unknown};if(stopped||generation!==epoch)return;
      restarting=result?.state==='restarting';notice=message(result?.message,'Arcane could not restart. Try again when your work is saved.');
    }catch(error){if(!stopped&&generation===epoch)notice=error instanceof Error?message(error.message,'Save your work before restarting.'): 'Save your work before restarting.';}
    finally{restore();pending=false;if(!stopped&&generation===epoch){render();schedule();}}})();
  });
  const visible=()=>{if(!doc.hidden)void check();};doc.addEventListener('visibilitychange',visible);doc.defaultView?.addEventListener('focus',visible);
  void check();
  return {check,stop(){stopped=true;epoch++;if(timer)clearTimeout(timer);timer=null;banner.hidden=true;doc.removeEventListener('visibilitychange',visible);doc.defaultView?.removeEventListener('focus',visible);},
    resume(){if(!stopped)return;stopped=false;epoch++;doc.addEventListener('visibilitychange',visible);doc.defaultView?.addEventListener('focus',visible);void check();}};
}
