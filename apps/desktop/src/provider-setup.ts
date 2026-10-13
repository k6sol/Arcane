/// <reference lib="dom" />
import type {ProviderConnectionStatus} from './codex-chat.js';
export type SetupProvider='codex'|'claude';
export interface ProviderSetupState {version:1;provider:SetupProvider;installed:boolean;auth:'unknown'|'signed-out'|'subscription'|'api-or-cloud';cliVersion:string|null;busy:boolean;message:string|null}
export interface ProviderSetupBridge {version:1;status(provider:SetupProvider):Promise<unknown>;login(provider:SetupProvider):Promise<unknown>;install(provider:SetupProvider):Promise<unknown>;launch(provider:SetupProvider):Promise<unknown>}
export interface ProviderSetupOptions {chat:{providerConnectionStatus():ProviderConnectionStatus|null;subscribeProviderStateChange(listener:()=>void):()=>void};nativeBridge?:unknown}
const providers=(v:unknown):v is SetupProvider=>v==='codex'||v==='claude';
function data(value:unknown,keys:string[]):Record<string,unknown>|null {if(!value||typeof value!=='object'||Array.isArray(value))return null;try{const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)return null;const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))return null;for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))return null;}return value as Record<string,unknown>;}catch{return null;}}
export function readProviderSetupState(value:unknown,provider:SetupProvider):ProviderSetupState {
 const s=data(value,['version','provider','installed','auth','cliVersion','busy','message']);
 const bounded=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(v);
 if(!s||s.version!==1||s.provider!==provider||typeof s.installed!=='boolean'||typeof s.busy!=='boolean'||(typeof s.auth!=='string'||!['unknown','signed-out','subscription','api-or-cloud'].includes(s.auth))||!(s.cliVersion===null||bounded(s.cliVersion,100))||!(s.message===null||bounded(s.message,2048))||(!s.installed&&(s.cliVersion!==null||s.auth!=='unknown')))throw Error('Native provider status unavailable.');
 return Object.freeze({...s}) as unknown as ProviderSetupState;
}
function bridge(doc:Document,options:ProviderSetupOptions):ProviderSetupBridge|null {
 try{let v=options.nativeBridge;if(!Object.hasOwn(options,'nativeBridge')){const w=doc.defaultView;if(!w)return null;const root=Object.getOwnPropertyDescriptor(w,'arcaneDesktop');if(!root||!Object.hasOwn(root,'value'))return null;const d=Object.getOwnPropertyDescriptor(root.value,'providerSetup');if(!d||!Object.hasOwn(d,'value'))return null;v=d.value;}
 const a=data(v,['version','status','login','install','launch']);return a&&Object.isFrozen(v)&&a.version===1&&['status','login','install','launch'].every(k=>typeof a[k]==='function')?v as ProviderSetupBridge:null;
 }catch{return null;}
}
/** Native setup is explicit human intent. Mount/render/poll do not probe or launch anything. */
export function startProviderSetup(doc:Document,options:ProviderSetupOptions) {
 const panel=doc.getElementById('provider-setup-panel'),gate=doc.getElementById('provider-login-gate'),select=doc.getElementById('provider-setup-provider') as HTMLSelectElement|null;
 if(!panel||!gate||!select)return {stop(){},resume(){},cleanup(){}};
 const native=bridge(doc,options),states=new Map<SetupProvider,ProviderSetupState>(),removers:(()=>void)[]=[];let provider:SetupProvider='codex',epoch=0,stopped=false,disposed=false,busy=false,actionError:string|null=null;
 const el=(id:string)=>doc.getElementById(id),button=(id:string)=>el(id) as HTMLButtonElement|null;
 const set=(id:string,value:string)=>{const n=el(id);if(n)n.textContent=value;};
 const status=()=>states.get(provider),needsDisconnect=()=>{const c=options.chat.providerConnectionStatus();return provider==='codex'&&c?.fresh&&c.connected&&(c.auth!=='subscription'||!c.ready)&&status()?.auth==='subscription';},connected=()=>{const c=options.chat.providerConnectionStatus();return provider==='codex'&&c?.fresh&&c.ready&&c.connected&&c.auth==='subscription';};
 const render=()=>{const s=status(),c=options.chat.providerConnectionStatus();select.value=provider;panel.setAttribute('aria-busy',String(busy));
 gate.hidden=!!connected();
 const name=provider==='codex'?'Codex':'Claude Code';
 const text=s?(s.message??(s.auth==='subscription'?name+' is signed in.':s.auth==='signed-out'?'Sign in to '+name+' to continue.':s.auth==='api-or-cloud'?name+' uses API or cloud billing. Arcane has started no request.':'Login status is unknown. Check status.')):native?'Check '+name+' status, or connect your existing CLI.':'Native CLI setup is available in the desktop app. You can still connect an already signed-in Codex CLI.';
 set('provider-setup-status',(actionError??text)+(s?.cliVersion?' Version '+s.cliVersion+'.':''));
 set('provider-login-message',connected()?'':needsDisconnect()?'Codex is signed in now. Disconnect the old session, then connect again to load your current account and models.':provider==='claude'?'Claude subscription work stays in the native Claude Code terminal. Sign in there, then open the client.':c?.connected&&c.auth==='signed-out'?'Sign in to Codex to use this conversation. Complete login in the native terminal or browser, then reconnect.':s?.auth==='subscription'?'Codex is signed in. Connect it to load your model catalogue.':'Choose a provider and sign in or connect before sending a message. Your draft stays here.');
 for(const id of ['provider-setup-refresh','provider-setup-login','provider-setup-install','provider-setup-launch']){const b=button(id);if(b)b.disabled=stopped||disposed||busy||!native;}
 const launch=button('provider-setup-launch');if(launch)launch.hidden=provider!=='claude';
 const login=button('provider-login-start');if(login){login.hidden=false;login.textContent=needsDisconnect()?'Disconnect old session':provider==='codex'?'Connect / sign in to Codex':'Sign in to Claude Code';login.disabled=stopped||disposed||busy||(!native&&provider==='claude');}
 const refresh=button('provider-login-refresh');if(refresh){refresh.hidden=false;refresh.disabled=stopped||disposed||busy||!native;}
 };
 const choose=(next:SetupProvider)=>{if(next!==provider){provider=next;epoch++;actionError=null;}render();};
 const listen=(target:EventTarget,event:string,fn:(e:Event)=>void)=>{target.addEventListener(event,fn);removers.push(()=>target.removeEventListener(event,fn));};
 const trusted=(event:Event)=>{const e=event as MouseEvent;return event.isTrusted===true&&!event.defaultPrevented&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey;};
 const invoke=async(action:'status'|'login'|'install'|'launch')=>{if(!native||busy||stopped||disposed)return;const target=provider,generation=epoch;busy=true;actionError=null;render();try{const value=readProviderSetupState(await native[action](target),target);if(!stopped&&!disposed&&generation===epoch)states.set(target,value);}catch{if(!stopped&&!disposed&&generation===epoch){states.delete(target);actionError='Provider setup unavailable. No login or installation was confirmed.';}}finally{busy=false;if(!disposed)render();}};
 for(const [id,action] of [['provider-setup-refresh','status'],['provider-setup-login','login'],['provider-setup-install','install'],['provider-setup-launch','launch'],['provider-login-refresh','status']] as const){const b=button(id);if(b)listen(b,'click',e=>{if(trusted(e)&&!b.disabled)void invoke(action);});}
 for(const [id,next] of [['provider-login-codex','codex'],['provider-login-claude','claude']] as const){const b=button(id);if(b)listen(b,'click',e=>{if(trusted(e))choose(next);});}
 listen(select,'change',e=>{if(e.isTrusted&&providers(select.value))choose(select.value);});
 const login=button('provider-login-start');if(login)listen(login,'click',e=>{if(!trusted(e)||login.disabled||busy)return;if(needsDisconnect()){const disconnect=button('codex-disconnect');if(disconnect&&!disconnect.disabled)disconnect.click();return;}if(provider==='codex'&&(status()?.auth==='subscription'||options.chat.providerConnectionStatus()?.auth!=='signed-out'&&status()?.auth!=='signed-out')){const connect=button('codex-connect');if(connect&&!connect.disabled)connect.click();else{doc.getElementById('native-conversation-settings')?.scrollIntoView({block:'nearest'});}}else void invoke('login');});
 // This event only changes presentation/selection, never status probes or login.
 listen(doc,'workspace:providersetup',event=>{const value=data((event as CustomEvent).detail,['provider']);if(value&&providers(value.provider)){choose(value.provider);let p:HTMLElement|null=panel.parentElement;while(p){if(p.tagName==='DETAILS')(p as HTMLDetailsElement).open=true;p=p.parentElement;}panel.scrollIntoView({block:'nearest'});select.focus();}});
 const remove=options.chat.subscribeProviderStateChange(render);removers.push(remove);render();
 return {stop(){stopped=true;epoch++;render();},resume(){if(disposed)return;stopped=false;epoch++;render();},cleanup(){if(disposed)return;disposed=true;stopped=true;epoch++;for(const remove of removers.splice(0))remove();}};
}
