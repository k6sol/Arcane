export type AssetConversationSelectionValue =
  | null
  | {readonly provider:'codex'}
  | {readonly provider:'claude-code'|'arcane';readonly conversationId:string};
type Acknowledgement={state:'selected'|'unavailable'};
interface Focus {
  readonly selection:AssetConversationSelectionValue;
  readonly focusKey:string|null;
}
interface PendingFocus extends Focus {
  readonly ready:Promise<void>;
  readonly resolve:()=>void;
  readonly reject:(error:Error)=>void;
  settled:boolean;
  selected:boolean;
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const unavailable=()=>new Error('The current conversation is not ready for model review.');
function record(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable();
  const prototype:unknown=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)throw unavailable();
  const result:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string')throw unavailable();
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)throw unavailable();
    result[key]=descriptor.value as unknown;
  }
  return result;
}
function snapshot(selection:unknown,focusKey:unknown):Focus {
  if(focusKey!==null&&(typeof focusKey!=='string'||!focusKey.length||focusKey.length>4096||/[\u0000-\u001f\u007f-\u009f]/.test(focusKey)))throw unavailable();
  if(selection===null)return {selection:null,focusKey:focusKey as string|null};
  const value=record(selection),keys=Object.keys(value);
  if(value.provider==='codex'&&keys.length===1&&focusKey!==null)
    return {selection:Object.freeze({provider:'codex'}),focusKey:focusKey as string};
  if((value.provider==='claude-code'||value.provider==='arcane')&&keys.length===2
    &&Object.hasOwn(value,'conversationId')&&typeof value.conversationId==='string'&&UUID.test(value.conversationId))
    return {selection:Object.freeze({provider:value.provider,conversationId:value.conversationId}),focusKey:focusKey as string|null};
  throw unavailable();
}
function same(a:Focus,b:Focus):boolean {
  if(a.focusKey!==b.focusKey)return false;
  if(a.selection===null||b.selection===null)return a.selection===b.selection;
  return a.selection.provider===b.selection.provider
    &&(a.selection.provider==='codex'||b.selection.provider!=='codex'&&a.selection.conversationId===b.selection.conversationId);
}
function acknowledged(value:unknown):boolean {
  const reply=record(value);return Object.keys(reply).length===1&&reply.state==='selected';
}

/** Coordinates human focus only; it never grants model/native asset authority.
 * App IDs must come from durable provider conversation state, not a shared tab
 * ID or a newly generated UUID. A Codex focusKey must come from genuine current
 * peer thread/session state and change when that thread changes. It is local
 * comparison data and never goes to select().
 *
 * select must be the bounded native bridge request. This class adds no retry,
 * timer or inference. One request may be active and only the latest pending
 * focus is retained. Every dispatched NEW focus requires a new private parent
 * selection epoch even if its wire payload repeats; coalescing can skip an
 * intermediate empty focus. Only an unchanged local focus is deduplicated.
 */
export class AssetConversationSelection {
  private readonly select:(selection:AssetConversationSelectionValue)=>Promise<Acknowledgement>;
  private readonly listeners=new Set<()=>void>();
  private current:PendingFocus|null=null;
  private pending:PendingFocus|null=null;
  private inFlight:PendingFocus|null=null;
  private disposed=false;
  constructor(options:{select:(selection:AssetConversationSelectionValue)=>Promise<Acknowledgement>}){
    if(!options||typeof options.select!=='function')throw unavailable();
    this.select=selection=>options.select(selection);
  }
  update(selection:AssetConversationSelectionValue,focusKey:string|null):void {
    if(this.disposed)return;
    let focus:Focus;
    try{focus=snapshot(selection,focusKey);}catch{focus={selection:null,focusKey:null};}
    if(this.current&&same(this.current,focus))return;
    this.invalidate(this.current);
    let resolve!:()=>void,reject!:(error:Error)=>void;
    const ready=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
    // An unused focus can be superseded without creating an unhandled rejection.
    void ready.catch(()=>{});
    const next:PendingFocus={...focus,ready,resolve,reject,settled:false,selected:false};
    this.current=next;this.pending=next;
    this.notify();this.pump();
  }
  async ready():Promise<()=>boolean>{
    const focus=this.current;
    if(this.disposed||!focus||focus.selection===null)throw unavailable();
    await focus.ready;
    if(!this.live(focus))throw unavailable();
    return ()=>this.live(focus);
  }
  subscribeInvalidate(callback:()=>void):()=>void {
    if(this.disposed)return ()=>{};
    this.listeners.add(callback);return ()=>{this.listeners.delete(callback);};
  }
  dispose():void {
    if(this.disposed)return;
    this.disposed=true;this.invalidate(this.current);this.current=null;
    // Preserve only a null clear the caller already requested (e.g. pagehide).
    // It can run once after the active bounded call settles; its ACK arms nothing.
    if(this.pending?.selection!==null){this.invalidate(this.pending);this.pending=null;}
    this.notify();this.listeners.clear();this.pump();
  }
  private live(focus:PendingFocus):boolean {
    return !this.disposed&&this.current===focus&&focus.selected&&focus.selection!==null;
  }
  private invalidate(focus:PendingFocus|null):void {
    if(!focus)return;focus.selected=false;
    if(!focus.settled){focus.settled=true;focus.reject(unavailable());}
  }
  private notify():void {
    for(const listener of [...this.listeners])if(this.listeners.has(listener)){
      try{listener();}catch{/* One view cleanup must not block the other invalidations. */}
    }
  }
  private pump():void {
    if(this.inFlight||!this.pending)return;
    const focus=this.pending;this.pending=null;
    if(this.disposed&&focus.selection!==null){this.invalidate(focus);return;}
    this.inFlight=focus;void this.dispatch(focus);
  }
  private async dispatch(focus:PendingFocus):Promise<void>{
    // Do not invoke user code from update(), or recursively drain synchronous
    // refusal. A same-tick obsolete focus can be coalesced before any IPC.
    await Promise.resolve();
    try{
      if(this.disposed?focus.selection!==null:this.current!==focus)return;
      const reply=await this.select(focus.selection);
      if(!this.disposed&&this.current===focus){
        if(focus.selection!==null&&acknowledged(reply)){
          focus.selected=true;focus.settled=true;focus.resolve();
        }else this.invalidate(focus);
      }
    }catch{this.invalidate(focus);}
    finally{
      if(this.inFlight===focus)this.inFlight=null;
      this.pump();
    }
  }
}
