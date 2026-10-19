/// <reference lib="dom" />
/** Human-only session choice. Reads never grant permission; chat tools have no setter. */
export function startToolboxPolicy(doc: Document, options: { token(): string; transport?: typeof fetch }) {
  const checkbox=doc.getElementById('toolbox-models-allow') as HTMLInputElement|null;
  const notice=doc.getElementById('toolbox-models-status');
  const picker=doc.getElementById('session-picker') as HTMLSelectElement|null;
  let stopped=false,busy=false,timer:ReturnType<typeof setTimeout>|undefined,epoch=0;
  let current:AbortController|null=null;
  const session=()=>picker?.value??'';
  const show=(text:string)=>{if(notice)notice.textContent=text;};
  async function sync(change?:boolean){
    if(stopped||!checkbox||!notice||busy)return;
    if(change===undefined&&checkbox.closest<HTMLElement>('[data-settings-section]')?.hidden)return;
    const selected=session(),token=options.token(),generation=epoch;
    checkbox.disabled=true;
    if(!selected||!token){checkbox.checked=false;show('Original models only. Connect Studio to change model sources.');return;}
    busy=true;const controller=new AbortController();current=controller;
    const deadline=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await (options.transport??fetch)('/v1/studio-native/toolbox-policy',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({sessionId:selected,...(change===undefined?{}:{allowModels:change})}),signal:controller.signal,cache:'no-store',redirect:'error',credentials:'omit'});
      const value:unknown=await response.json();
      if(stopped||generation!==epoch||selected!==session())return;
      if(!response.ok||!value||typeof value!=='object'||Array.isArray(value)||
        (value as {sessionId?:unknown}).sessionId!==selected||typeof (value as {allowModels?:unknown}).allowModels!=='boolean')throw Error('unavailable');
      checkbox.checked=(value as {allowModels:boolean}).allowModels;checkbox.disabled=false;
      show(checkbox.checked?'Toolbox models allowed for this session for up to 30 minutes.':'Original models only. Blender creates models; Toolbox imports are blocked.');
    }catch{if(!stopped&&generation===epoch&&selected===session()){checkbox.checked=false;show('Model source status unavailable. Retry after Studio reconnects.');}}
    finally{clearTimeout(deadline);if(current===controller)current=null;busy=false;}
  }
  const changed=()=>{if(!checkbox||checkbox.disabled||busy)return;void sync(checkbox.checked);};
  const selected=()=>{epoch++;current?.abort();if(checkbox){checkbox.checked=false;checkbox.disabled=true;}show('Reading model source settings...');};
  const poll=async()=>{await sync();if(!stopped)timer=setTimeout(()=>void poll(),2000);};
  checkbox?.addEventListener('change',changed);picker?.addEventListener('change',selected);
  if(checkbox)void poll();
  return {stop(){stopped=true;epoch++;current?.abort();clearTimeout(timer);},resume(){if(!stopped)return;stopped=false;epoch++;if(checkbox)void poll();}};
}
