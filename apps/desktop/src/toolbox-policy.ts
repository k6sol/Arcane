/// <reference lib="dom" />
/** Kept only in memory: a permission for this exact typed message, never a saved preference. */
export interface ModelSourceContext {readonly provider:'codex'|'claude'|'arcane';readonly projectPath:string;readonly localId:string;readonly fingerprint:string}
export interface ModelSourceAdmission {readonly scope:Readonly<{sessionId:string}>;current():boolean}
export interface ModelSourceTicket {readonly scope:Readonly<{sessionId:string}>;consume():ModelSourceAdmission|null}
export interface ModelSourceConsentPort {capture():ModelSourceTicket|null;pending():boolean;invalidate():void}
const sameContext=(a:ModelSourceContext|null,b:ModelSourceContext|null)=>!!a&&!!b&&a.provider===b.provider&&a.projectPath===b.projectPath&&a.localId===b.localId&&a.fingerprint===b.fingerprint;
/** The event's trusted bit is checked here as well as at the DOM boundary. Polls have no arming method. */
export function createModelSourceConsent(options:{context():ModelSourceContext|null;session():string;changed?():void}) {
  let epoch=0,pending:{context:ModelSourceContext;sessionId:string;epoch:number;ready:boolean}|null=null;
  const invalidate=()=>{epoch++;pending=null;options.changed?.();};
  const current=()=>{if(pending&&(!sameContext(pending.context,options.context())||pending.sessionId!==options.session()))invalidate();return pending;};
  return {
    arm(trusted:boolean):boolean {
      if(!trusted)return false;
      invalidate();const context=options.context(),sessionId=options.session();
      if(!context||!context.projectPath||!context.localId||!/^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(sessionId))return false;
      pending={context:Object.freeze({...context}),sessionId,epoch,ready:false};options.changed?.();return true;
    },
    confirm(allowed:boolean):void{const value=current();if(!allowed)invalidate();else if(value){value.ready=true;options.changed?.();}},
    pending():boolean{return !!current();},
    invalidate,
    port:Object.freeze<ModelSourceConsentPort>({
      invalidate,
      pending:()=>!!current(),
      capture(){
        const value=current();if(!value)return null;
        if(!value.ready)throw new Error('Wait for the Models setting to be confirmed. Your message is retained.');
        pending=null;options.changed?.();let used=false;
        return Object.freeze({scope:Object.freeze({sessionId:value.sessionId}),consume(){
          if(used)return null;used=true;
          if(value.epoch!==epoch||value.sessionId!==options.session()||!sameContext(value.context,options.context()))return null;
          return Object.freeze({scope:Object.freeze({sessionId:value.sessionId}),current:()=>value.epoch===epoch&&value.sessionId===options.session()});
        }});
      },
    }),
  };
}
/** Manual session browsing is separate from the one-message agent ticket. Reads never grant either permission. */
export function startToolboxPolicy(doc: Document, options: { token(): string; transport?: typeof fetch;context?():ModelSourceContext|null }) {
  const checkbox=doc.getElementById('toolbox-models-allow') as HTMLInputElement|null;
  const notice=doc.getElementById('toolbox-models-status');
  const picker=doc.getElementById('session-picker') as HTMLSelectElement|null;
  const revoke=doc.getElementById('toolbox-models-revoke') as HTMLButtonElement|null;
  let stopped=false,busy=false,timer:ReturnType<typeof setTimeout>|undefined,epoch=0;
  let current:AbortController|null=null,manualAllowed=false;
  const session=()=>picker?.value??'';
  const show=(text:string)=>{if(notice)notice.textContent=text;};
  const present=()=>{
    if(!checkbox)return;
    if(revoke){revoke.hidden=!manualAllowed;revoke.disabled=busy||stopped||!manualAllowed;}
    checkbox.checked=options.context?consent.pending():manualAllowed;
    show(options.context?(checkbox.checked?'Toolbox models allowed for this typed message only. Send this message to use them.':
      manualAllowed?'Manual Toolbox browsing is allowed. For a chat request, write the message, then enable Models again. Queued messages need review in the composer.':'Original models only. Blender creates models; Toolbox imports are blocked.'):
      manualAllowed?'Toolbox models allowed for this session for up to 30 minutes.':'Original models only. Blender creates models; Toolbox imports are blocked.');
  };
  const consent=createModelSourceConsent({context:()=>options.context?.()??null,session,changed:()=>{if(checkbox&&options.context)checkbox.checked=consent.pending();}});
  async function sync(change?:boolean){
    if(stopped||!checkbox||!notice||busy)return;
    if(change===undefined&&checkbox.closest<HTMLElement>('[data-settings-section]')?.hidden)return;
    const selected=session(),token=options.token(),generation=epoch;
    checkbox.disabled=true;
    if(revoke)revoke.disabled=true;
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
      manualAllowed=(value as {allowModels:boolean}).allowModels;
      if(change!==undefined||!manualAllowed)consent.confirm(manualAllowed);
      checkbox.disabled=false;present();
    }catch{if(!stopped&&generation===epoch&&selected===session()){manualAllowed=false;consent.invalidate();checkbox.checked=false;show('Model source status unavailable. Retry after Studio reconnects.');}}
    finally{clearTimeout(deadline);if(current===controller)current=null;busy=false;if(revoke)revoke.disabled=stopped||!manualAllowed;}
  }
  const changed=(event:Event)=>{if(!checkbox||checkbox.disabled||busy)return;if(!event.isTrusted){present();return;}
    const allowed=checkbox.checked;if(allowed&&options.context)consent.arm(true);else consent.invalidate();void sync(allowed);};
  const selected=()=>{epoch++;consent.invalidate();current?.abort();manualAllowed=false;if(revoke){revoke.hidden=true;revoke.disabled=true;}if(checkbox){checkbox.checked=false;checkbox.disabled=true;}show('Reading model source settings...');};
  const revoked=(event:Event)=>{if(!event.isTrusted||!revoke||revoke.disabled||busy||stopped)return;consent.invalidate();void sync(false);};
  const poll=async()=>{await sync();if(!stopped)timer=setTimeout(()=>void poll(),2000);};
  checkbox?.addEventListener('change',changed);picker?.addEventListener('change',selected);
  revoke?.addEventListener('click',revoked);
  if(checkbox)void poll();
  return {consent:consent.port,refreshContext(){consent.pending();present();},stop(){stopped=true;epoch++;consent.invalidate();current?.abort();clearTimeout(timer);},resume(){if(!stopped)return;stopped=false;epoch++;consent.invalidate();if(checkbox)void poll();}};
}
