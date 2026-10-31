/// <reference lib="dom" />
import {ConversationLibrary,type ConversationLibrarySnapshot,type ConversationProvider,type LibraryConversation,type LibraryTranscript,type LibraryDraftSource} from './conversation-library.js';
import {USER_ERRORS,userErrorText} from './user-errors.js';
type BeforeMessageSubmit=(draft:string)=>string|Promise<string>;
export interface SharedConversationSource {projectPath:string;localId:string}
export interface SharedConversationPeer {
  recordedTranscript():LibraryTranscript;
  conversationSource():SharedConversationSource|null;
  isDraftConversation():boolean;
  subscribeTranscriptChange(listener:()=>void):()=>void;
  setBeforeMessageSubmit(callback:BeforeMessageSubmit|null):void;
  showConversationNotice(text:string):void;
  open(id:string):Promise<boolean>;
  openDraftConversation(localId:string):Promise<boolean>;
  newChat():Promise<boolean>;
}
interface LibraryBridge {version:1;read():Promise<unknown>;save(value:ConversationLibrarySnapshot):Promise<unknown>}
interface LibraryRead {available:boolean;projectPath:string|null;preferences:unknown}
/** Measured folder totals for the sidebar. Absent fields are not shown; Arcane never estimates them. share: this chat's part of the folder's spend (0..1). */
export interface FolderTotals {cost:string|null;tokens:number|null;actions:number|null;share:number|null}
export interface SharedConversationsOptions {peers:Partial<Record<ConversationProvider,SharedConversationPeer>>;provider():ConversationProvider;requestProvider(provider:ConversationProvider):boolean;bridge?:LibraryBridge|null;
  /** Optional measured totals feed. Without one the folder rows and summaries show no cost, token or action figures. */
  folderTotals?:(conversations:readonly LibraryConversation[],activeId:string|null)=>FolderTotals|null}
const RECENT_CHATS=5;
const PROVIDER_NAMES:Record<ConversationProvider,string>={codex:'Codex',claude:'Claude',arcane:'Arcane'};
// The provider marks used by the chat tabs (codex-chat.ts PROVIDER_MARKS), single-colour.
const PROVIDER_PATHS:Record<ConversationProvider,string>={
  codex:'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  claude:'M4.7144 15.9555l4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
  arcane:'M12 1.5 1.5 21.375h4.875L12 10.5l5.625 10.875h4.875L12 1.5ZM10.125 15l7.125 4.875-2.25-4.875Z',
};
/** Shared-context glyph: two overlapping chat bubbles, 24px grid, drawn with the sidebar's 1.75 stroke. */
const CONTEXT_PATHS=['M14.5 9.5a2 2 0 0 1-2 2h-6l-3 3v-9a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2Z','M17.5 9.5h1a2 2 0 0 1 2 2v9l-3-3h-6a2 2 0 0 1-2-2v-1'];
const CONTEXT_TIP='Chats in this folder share memory and context';
const lastMessage=(c:LibraryConversation):number|null=>{for(let i=c.messages.length-1;i>=0;i--){const at=c.messages[i]!.at;if(at!==null){const t=Date.parse(at);if(Number.isFinite(t))return t;}}return null;};
const formatAge=(ms:number):string=>{const m=Math.max(0,Math.floor(ms/60000));return m<60?Math.max(1,m)+'m':m<1440?Math.floor(m/60)+'h':m<10080?Math.floor(m/1440)+'d':m<43200?Math.floor(m/10080)+'w':Math.floor(m/43200)+'mo';};
const compact=(n:number):string=>n>=1e9?(n/1e9).toFixed(1).replace(/\.0$/,'')+'B':n>=1e6?(n/1e6).toFixed(1).replace(/\.0$/,'')+'M':n>=1e3?(n/1e3).toFixed(1).replace(/\.0$/,'')+'k':String(Math.round(n));
/** A shared view of recorded public text; provider history and all native grants remain provider-owned. */
export class SharedConversations {
  private library:ConversationLibrary|null=null;
  private reading:Promise<void>;
  private queued:ConversationLibrarySnapshot|null=null;
  private saving:Promise<void>|null=null;
  private saveTimer:ReturnType<typeof setTimeout>|null=null;
  private persistenceError=false;
  private suspended=0;
  private stopped=false;
  private ready=false;
  private pendingNew:{provider:ConversationProvider;source:SharedConversationSource;revision:number;navigation:number}|null=null;
  private navigationRevision=0;
  private sourceKeys=new Map<ConversationProvider,string>();
  private sourceRevisions=new Map<ConversationProvider,number>();
  private providerSeen:ConversationProvider;
  private scheduled=false;
  private signature='';
  private historySignature='';
  private removers:(()=>void)[]=[];
  // Sidebar presentation state. Open folders persist in the library record; these stay in memory.
  private showAll=false;
  private creating=false;
  private folderDraft='';
  private renaming:string|null=null;
  private renameDraft='';
  private menuFor:string|null=null;
  private menuListener:(()=>void)|null=null;
  private pendingFocus:string|null=null;
  private rendering=false;
  private lastActive:string|null=null;
  private bridge:LibraryBridge|null;
  constructor(private readonly doc:Document,private readonly options:SharedConversationsOptions){
    this.providerSeen=options.provider();
    this.bridge=options.bridge??(doc.defaultView as unknown as {arcaneDesktop?:{conversationLibrary?:LibraryBridge}}|null)?.arcaneDesktop?.conversationLibrary??null;
    for(const [provider,peer] of Object.entries(options.peers) as [ConversationProvider,SharedConversationPeer][]){
      this.source(provider);
      this.removers.push(peer.subscribeTranscriptChange(()=>{this.source(provider);this.schedule();}));
      peer.setBeforeMessageSubmit(draft=>this.prepareMessage(provider,draft));
    }
    this.reading=this.initialize();
  }
  private async initialize():Promise<void>{
    if(!this.bridge){this.render();return;}
    try{
      const reply=await this.bridge.read() as LibraryRead;
      if(this.stopped)return;
      if(reply?.available!==true||typeof reply.projectPath!=='string'||!reply.projectPath)throw Error();
      this.library=new ConversationLibrary(reply.projectPath,reply.preferences===null?undefined:reply.preferences);
      this.lastActive=this.library.snapshot().activeId;
      this.ready=true;this.finishNewConversation();this.observe();
    }catch{this.persistenceError=true;}finally{this.render();}
  }
  private peer(provider=this.options.provider()):SharedConversationPeer|undefined{return this.options.peers[provider];}
  private source(provider:ConversationProvider):SharedConversationSource|null {
    const value=this.peer(provider)?.conversationSource()??null;
    const source=value&&typeof value.projectPath==='string'&&value.projectPath&&typeof value.localId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(value.localId)?{projectPath:value.projectPath,localId:value.localId}:null;
    const key=JSON.stringify(source),previous=this.sourceKeys.get(provider);
    if(previous!==undefined&&previous!==key)this.sourceRevisions.set(provider,(this.sourceRevisions.get(provider)??0)+1);
    this.sourceKeys.set(provider,key);
    const selected=this.options.provider();if(this.providerSeen!==selected){this.providerSeen=selected;this.navigationRevision++;}
    return source;
  }
  private draftSource(provider:ConversationProvider,source:SharedConversationSource|null):LibraryDraftSource|undefined {
    return source&&source.projectPath===this.library?.snapshot().projectPath?{provider,localId:source.localId}:undefined;
  }
  private notice(text:string):void{this.peer()?.showConversationNotice(text);}
  private schedule():void{if(this.stopped||this.scheduled)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;if(!this.stopped)this.observe();});}
  private observe():void{
    if(!this.library||this.suspended||this.stopped)return;
    this.finishNewConversation();
    const p=this.options.provider(),snapshot=this.peer(p)?.recordedTranscript(),source=this.source(p);if(!snapshot)return;
    const draft=this.draftSource(p,source);
    try{
      if(!snapshot.conversationId&&draft&&this.peer(p)?.isDraftConversation()===true){
        const linked=this.library.draftConversation(draft);if(linked&&linked.id!==this.library.active()?.id){this.library.select(linked.id);this.persist();}
      }else if(this.library.observe(snapshot,false,draft))this.persist();
    }catch(error){this.notice(error instanceof Error?error.message:'Shared history could not be saved.');}
    this.render();
  }
  private persist():void{if(!this.library)return;this.queued=this.library.snapshot();if(this.saveTimer===null)this.saveTimer=setTimeout(()=>{this.saveTimer=null;this.flush();},250);}
  private flush():void{
    if(this.saveTimer!==null){clearTimeout(this.saveTimer);this.saveTimer=null;}
    if(this.saving||!this.queued||!this.bridge||this.stopped)return;
    const value=this.queued;this.queued=null;
    this.saving=(async()=>{try{const ack=await this.bridge!.save(value) as {saved?:unknown};if(ack?.saved!==true)throw Error();this.persistenceError=false;}catch{if(!this.queued)this.queued=value;this.persistenceError=true;}})().finally(()=>{this.saving=null;this.render();if(this.queued&&!this.persistenceError&&this.saveTimer===null)this.saveTimer=setTimeout(()=>{this.saveTimer=null;this.flush();},250);});
  }
  async prepareForRestart():Promise<void>{
    await this.reading;if(!this.bridge)return;
    if(!this.ready)throw Error('Shared chat history could not be loaded. Keep this window open and retry.');
    this.observe();this.flush();if(this.saving)await this.saving;
    if(this.queued){this.persistenceError=false;this.flush();if(this.saving)await this.saving;}
    if(this.persistenceError||this.queued)throw Error('Shared chat history could not be saved. Keep this window open and retry.');
  }
  private async prepareMessage(provider:ConversationProvider,draft:string):Promise<string>{
    const source=this.source(provider),revision=this.sourceRevisions.get(provider)??0,navigation=this.navigationRevision;
    await this.reading;
    const current=this.source(provider);
    if(this.stopped||this.suspended||this.options.provider()!==provider||navigation!==this.navigationRevision||revision!==(this.sourceRevisions.get(provider)??0)||JSON.stringify(source)!==JSON.stringify(current))throw Error('Wait for this conversation to finish switching models.');
    if(!this.library)return draft;
    const exact=this.draftSource(provider,current);if(!exact)throw Error(userErrorText(USER_ERRORS[423])+' Your draft is retained.');
    this.observe();
    if(this.peer(provider)?.isDraftConversation()===true&&!this.library.draftConversation(exact)){this.library.newConversation(exact);this.persist();}
    this.observe();const library=this.library,rowId=library.active()?.id??null,prepared=library.contextFor(provider,draft);
    const transcript=this.peer(provider)!.recordedTranscript(),binding=JSON.stringify([transcript.projectPath,transcript.conversationId,transcript.sessionId]);
    const owned=()=>{
      const latest=this.source(provider),recorded=this.peer(provider)?.recordedTranscript();
      if(this.stopped||this.suspended||this.library!==library||this.options.provider()!==provider||navigation!==this.navigationRevision||revision!==(this.sourceRevisions.get(provider)??0)||
        JSON.stringify(current)!==JSON.stringify(latest)||library.snapshot().projectPath!==current!.projectPath||library.active()?.id!==rowId||
        !recorded||JSON.stringify([recorded.projectPath,recorded.conversationId,recorded.sessionId])!==binding)throw Error('This conversation changed while its draft was being saved. Your text is retained.');
    };
    // The exact draft link must reach the host before this hook releases any native effect.
    // Join an older write, then checkpoint the captured latest state without a debounce or retry.
    owned();this.flush();
    if(this.saving){await this.saving;owned();}
    if(this.persistenceError)throw Error('Shared chat history could not be saved. Your draft is retained.');
    if(this.queued){this.flush();if(this.saving){await this.saving;owned();}}
    if(this.persistenceError||this.queued)throw Error('Shared chat history could not be saved. Your draft is retained.');
    owned();return prepared;
  }
  /** Called only after the provider has actually selected the new local draft. */
  beginNewConversation(provider:ConversationProvider,source:SharedConversationSource):void{
    if(this.suspended||this.stopped)return;
    const current=this.source(provider);if(this.options.provider()!==provider||JSON.stringify(current)!==JSON.stringify(source)||this.peer(provider)?.isDraftConversation()!==true)return;
    this.navigationRevision++;this.pendingNew={provider,source:{...source},revision:this.sourceRevisions.get(provider)??0,navigation:this.navigationRevision};this.finishNewConversation();this.render();
  }
  private finishNewConversation():void {
    const pending=this.pendingNew;if(!pending||!this.library)return;
    this.pendingNew=null;const current=this.source(pending.provider),draft=this.draftSource(pending.provider,current);
    if(this.stopped||this.suspended||this.options.provider()!==pending.provider||pending.navigation!==this.navigationRevision||pending.revision!==(this.sourceRevisions.get(pending.provider)??0)||JSON.stringify(current)!==JSON.stringify(pending.source)||!draft||this.peer(pending.provider)?.isDraftConversation()!==true)return;
    try{const existing=this.library.draftConversation(draft);if(existing)this.library.select(existing.id);else this.library.newConversation(draft);this.persist();}
    catch(error){this.notice(error instanceof Error?error.message:'Shared history could not be saved.');}
  }
  /** Only an explicit model choice calls this. It never sends a message, replays tools or transfers grants. */
  async beforeProviderSwitch(from:ConversationProvider,to:ConversationProvider):Promise<boolean>{
    if(from==='arcane'||to==='arcane')return true;
    this.source(from);
    const navigation=++this.navigationRevision;
    await this.reading;
    if(this.stopped||this.suspended||from!==this.options.provider()||navigation!==this.navigationRevision)return false;
    if(!this.ready||!this.library)return !this.bridge;
    this.observe();
    const active=this.library.active(),activeId=active?.id??null,peer=this.peer(to);if(!peer)return false;
    const origin=this.source(from),originRevision=this.sourceRevisions.get(from)??0;
    const binding=active?.bindings.find(b=>b.provider===to);
    const linked=activeId?this.library.snapshot().draftLinks?.find(row=>row.libraryId===activeId&&row.provider===to):undefined;
    this.suspended++;
    try{
      const recorded=peer.recordedTranscript();
      const ok=binding?(recorded.projectPath===this.library.snapshot().projectPath&&recorded.conversationId===binding.conversationId||await peer.open(binding.conversationId))
        :linked?await peer.openDraftConversation(linked.localId):await peer.newChat();
      const currentOrigin=this.source(from);
      if(!ok||(this.library.active()?.id??null)!==activeId||this.stopped||navigation!==this.navigationRevision||from!==this.options.provider()||originRevision!==(this.sourceRevisions.get(from)??0)||JSON.stringify(origin)!==JSON.stringify(currentOrigin))return false;
      if(!binding&&activeId){const source=this.draftSource(to,this.source(to));if(!source||linked&&source.localId!==linked.localId||peer.isDraftConversation()!==true)return false;this.library.linkDraft(activeId,source);}
      this.persist();return true;
    }catch{return false;}finally{this.suspended--;}
  }
  private async open(id:string):Promise<void>{
    if(!this.library||this.suspended||this.stopped)return;
    this.source(this.options.provider());
    const navigation=++this.navigationRevision;
    this.observe();const previous=this.library.active()?.id??null;this.library.select(id);
    const restore=()=>{if(!this.stopped&&navigation===this.navigationRevision&&this.library?.active()?.id===id)this.library.select(previous);};
    const target=this.library.active()!,current=this.options.provider(),binding=target.bindings.find(b=>b.provider===current)??target.bindings[0];
    const link=!binding?this.library.snapshot().draftLinks?.find(row=>row.libraryId===id&&row.provider===current)??this.library.snapshot().draftLinks?.find(row=>row.libraryId===id):undefined;
    if(!binding&&!link){this.render();return;}
    this.suspended++;
    try{
      const provider=binding?.provider??link!.provider,peer=this.peer(provider),ok=!!peer&&(binding?await peer.open(binding.conversationId):await peer.openDraftConversation(link!.localId));
      const source=link?this.source(provider):null;
      if(this.stopped||navigation!==this.navigationRevision||this.options.provider()!==current||this.library.active()?.id!==id)return;
      if(!ok||link&&(source?.projectPath!==this.library.snapshot().projectPath||source.localId!==link.localId||peer?.isDraftConversation()!==true)){restore();this.notice('This saved conversation could not be opened. Your current chat and draft were retained.');return;}
      if(provider!==current&&!this.options.requestProvider(provider)){restore();return;}
      this.persist();
    }catch{if(!this.stopped&&navigation===this.navigationRevision&&this.library.active()?.id===id){restore();this.notice('This saved conversation could not be opened. Try again after checking the provider connection.');}}
    finally{this.suspended--;this.render();}
  }
  private dismissEmpty(id:string):void{
    if(!this.library||this.suspended||this.stopped)return;
    const active=this.library.active()?.id===id;
    if(!this.library.dismissEmpty(id))return;
    if(active){this.navigationRevision++;this.pendingNew=null;}
    this.persist();this.flush();this.render();
    const mount=this.doc.getElementById('conversation-library');
    const next=mount?.querySelector<HTMLButtonElement>('#library-chats .library-chat')??mount?.querySelector<HTMLElement>('.library-new-folder');
    next?.focus({preventScroll:true});
  }
  private edit(action:()=>void):void{if(!this.library||this.suspended)return;try{action();this.persist();this.flush();this.render();}catch(error){this.notice(error instanceof Error?error.message:'Chat organisation could not be saved.');}}
  private node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string):HTMLElementTagNameMap[K]{const node=this.doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
  private button(label:string,action:()=>void):HTMLButtonElement{const b=this.node('button',label);b.type='button';b.addEventListener('click',action);return b;}
  private svg(paths:string[],className:string,filled=false):SVGSVGElement{
    const ns='http://www.w3.org/2000/svg',icon=this.doc.createElementNS(ns,'svg');
    icon.setAttribute('class',className);icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');icon.setAttribute('focusable','false');
    if(filled)icon.setAttribute('fill','currentColor');else{icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.75');icon.setAttribute('stroke-linecap','round');icon.setAttribute('stroke-linejoin','round');}
    for(const d of paths){const path=this.doc.createElementNS(ns,'path');path.setAttribute('d',d);icon.append(path);}
    return icon;
  }
  /** Presentation only: open/closed folders and the folder actions menu. Nothing here starts native work. */
  private present(action:()=>void):void{if(!this.library||this.suspended)return;try{action();this.persist();this.render();}catch(error){this.notice(error instanceof Error?error.message:'Chat organisation could not be saved.');}}
  private focusLater(key:string):void{this.pendingFocus=key;}
  private toggleFolder(id:string):void{this.present(()=>{this.library!.setFolderExpanded(id,!this.library!.expanded(id));});}
  private openMenu(id:string):void{
    if(!this.library||this.suspended)return;
    this.closeMenuListener();this.menuFor=id;this.renaming=null;this.creating=false;this.render();
    this.doc.getElementById('library-folder-menu')?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const away=(event:Event)=>{const target=event.target as Node|null,menu=this.doc.getElementById('library-folder-menu'),more=menu?.closest('.library-folder')?.querySelector('.library-folder-more');if(target&&(menu?.contains(target)||more?.contains(target)))return;this.closeMenu(false);};
    this.doc.addEventListener('pointerdown',away,true);this.menuListener=()=>this.doc.removeEventListener('pointerdown',away,true);
  }
  private closeMenuListener():void{this.menuListener?.();this.menuListener=null;}
  private closeMenu(restoreFocus:boolean):void{
    const id=this.menuFor;if(id===null)return;
    this.closeMenuListener();this.menuFor=null;if(restoreFocus)this.focusLater('more:'+id);this.render();
  }
  private folderMenu(folder:{id:string;name:string},state:ConversationLibrarySnapshot):HTMLElement{
    const menu=this.node('div');menu.id='library-folder-menu';menu.className='library-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',folder.name+' folder actions');
    const item=(label:string,action:()=>void,detail?:string)=>{
      const b=this.button(label,()=>{this.closeMenuListener();this.menuFor=null;action();});b.className='library-menu-item';b.setAttribute('role','menuitem');b.tabIndex=-1;
      if(detail){const small=this.node('small',detail);b.append(small);b.setAttribute('aria-label',label+': '+detail.charAt(0).toLowerCase()+detail.slice(1));b.classList.add('library-menu-danger');}
      menu.append(b);
    };
    item('Rename folder',()=>{this.renaming=folder.id;this.renameDraft=folder.name;this.focusLater('rename:'+folder.id);this.render();});
    const active=state.conversations.find(c=>c.id===state.activeId);
    if(active&&active.folderId!==folder.id)item('Move current chat here',()=>this.edit(()=>{this.library!.move(active.id,folder.id);this.library!.setFolderExpanded(folder.id,true);}));
    if(active&&active.folderId===folder.id)item('Move current chat to Chats',()=>this.edit(()=>{this.library!.move(active.id,null);}));
    const rule=this.node('div');rule.className='library-menu-rule';rule.setAttribute('role','separator');menu.append(rule);
    item('Remove folder',()=>{this.focusLater('new-folder');this.edit(()=>{this.library!.removeFolder(folder.id);});},'Chats move to Chats');
    menu.addEventListener('keydown',event=>{
      const key=(event as KeyboardEvent).key,items=Array.from(menu.querySelectorAll<HTMLElement>('[role=menuitem]')),at=items.indexOf(this.doc.activeElement as HTMLElement);
      if(key==='Escape'){event.preventDefault();event.stopPropagation();this.closeMenu(true);return;}
      if(key==='Tab'){event.preventDefault();this.closeMenu(true);return;}
      const next=key==='ArrowDown'?(at+1)%items.length:key==='ArrowUp'?(at-1+items.length)%items.length:key==='Home'?0:key==='End'?items.length-1:-1;
      if(next>=0){event.preventDefault();items[next]?.focus();}
    });
    return menu;
  }
  private nameInput(value:string,label:string,focus:string,update:(value:string)=>void,commit:(value:string)=>void,cancel:()=>void):HTMLInputElement{
    const input=this.node('input');input.type='text';input.maxLength=80;input.value=value;input.placeholder='Folder name';input.className='library-input';input.setAttribute('aria-label',label);input.dataset.libraryFocus=focus;
    let done=false;const finish=(save:boolean)=>{if(done||this.rendering)return;done=true;if(save)commit(input.value.trim());else cancel();};
    input.addEventListener('input',()=>update(input.value));
    input.addEventListener('keydown',event=>{const key=(event as KeyboardEvent).key;if(key==='Enter'){event.preventDefault();finish(true);}else if(key==='Escape'){event.preventDefault();event.stopPropagation();finish(false);}});
    input.addEventListener('blur',()=>finish(true));
    return input;
  }
  private totals(state:ConversationLibrarySnapshot):Record<string,FolderTotals>{
    const out:Record<string,FolderTotals>={},read=this.options.folderTotals;if(!read)return out;
    for(const f of state.folders){try{const t=read(state.conversations.filter(c=>c.folderId===f.id),state.activeId);if(t)out[f.id]=t;}catch{/* Totals are optional presentation. */}}
    return out;
  }
  /** A chat opened from elsewhere reveals its folder once; a folder the person closes afterwards stays closed. */
  private followActive(state:ConversationLibrarySnapshot):boolean{
    if(state.activeId===this.lastActive)return false;this.lastActive=state.activeId;
    const folder=state.conversations.find(c=>c.id===state.activeId)?.folderId;
    if(!folder||!this.library||this.library.expanded(folder))return false;
    try{this.library.setFolderExpanded(folder,true);this.persist();return true;}catch{return false;}
  }
  private render():void{
    const mount=this.doc.getElementById('conversation-library');if(!mount)return;
    let state=this.library?.snapshot();
    if(state&&this.ready&&!this.suspended&&this.followActive(state))state=this.library!.snapshot();
    this.renderHistory();
    const totals=state?this.totals(state):{};
    const signature=JSON.stringify([state?.activeId,state?.folders,state?.expandedFolderIds,state?.conversations.map(c=>({id:c.id,title:c.title,folderId:c.folderId,bindings:c.bindings,last:lastMessage(c)})),this.persistenceError,this.ready,this.showAll,this.creating,this.renaming,this.menuFor,totals]);
    const focused=this.doc.activeElement as HTMLElement|null,focusKey=this.pendingFocus??focused?.dataset?.libraryFocus;this.pendingFocus=null;
    if(signature===this.signature){if(focusKey&&focusKey!==focused?.dataset?.libraryFocus)this.restoreFocus(mount,focusKey);return;}
    this.signature=signature;
    this.rendering=true;try{mount.replaceChildren();}finally{this.rendering=false;}
    if(!this.ready){const note=this.node('p',this.persistenceError?'Saved chats could not be loaded. Reopen Arcane to retry.':'Loading saved chats…');note.className='hint library-status';note.dataset.state=this.persistenceError?'error':'loading';note.setAttribute('role','status');mount.setAttribute('aria-busy',String(!this.persistenceError));mount.append(note);return;}
    mount.removeAttribute('aria-busy');
    if(this.persistenceError){const note=this.node('p','Chat organisation has not been saved.');note.className='hint library-status';note.dataset.state='error';note.setAttribute('role','status');const retry=this.button('Retry saving',()=>{this.persistenceError=false;this.flush();});retry.className='library-action';mount.append(note,retry);}
    const s=state!,active=s.activeId,open=new Set(s.expandedFolderIds??[]);
    const section=(id:string,label:string)=>{const node=this.node('section'),heading=this.node('h2',label);node.className='library-section';node.setAttribute('aria-labelledby',id);heading.id=id;heading.className='sidebar-label library-heading';return {node,heading};};
    const folders=section('library-folders-heading','Folders'),head=this.node('div');head.className='library-heading-row';
    const startFolder=()=>{this.closeMenuListener();this.menuFor=null;this.renaming=null;this.creating=true;this.folderDraft='';this.focusLater('folder-name');this.render();};
    const add=this.button('',startFolder);
    add.className='library-icon-button library-new-folder';add.setAttribute('aria-label','New folder');add.title='New folder';add.dataset.libraryFocus='new-folder';add.append(this.svg(['M12 6v12M6 12h12'],'library-icon'));
    head.append(folders.heading,add);folders.node.append(head);
    if(this.creating)folders.node.append(this.createRow());
    else if(!s.folders.length){
      // No folders yet: one designed row that starts a folder (the same action as the + in the heading).
      const start=this.button('',startFolder),text=this.node('span'),title=this.node('span','New folder'),hint=this.node('span','Chats in a folder share context');
      start.className='library-empty-action';start.dataset.libraryFocus='empty-new-folder';title.className='library-empty-title';hint.className='library-empty-hint';text.className='library-empty-text';
      const tile=this.node('span');tile.className='library-empty-tile';tile.setAttribute('aria-hidden','true');tile.append(this.svg(['M12 6v12M6 12h12'],'library-icon'));
      text.append(title,hint);start.append(tile,text);folders.node.append(start);
    }
    s.folders.forEach((folder,index)=>{
      const rows=s.conversations.filter(c=>c.folderId===folder.id),expanded=open.has(folder.id),current=rows.some(c=>c.id===active),total=totals[folder.id];
      const group=this.node('div');group.className='library-folder';group.setAttribute('role','group');group.setAttribute('aria-label',folder.name);group.dataset.expanded=String(expanded);group.dataset.current=String(current);
      const row=this.node('div'),bodyId='library-folder-'+index;row.className='library-folder-row';
      if(this.renaming===folder.id){
        row.append(this.nameInput(this.renameDraft,'Folder name','rename:'+folder.id,v=>{this.renameDraft=v;},name=>{this.renaming=null;this.focusLater('folder:'+folder.id);if(name&&name!==folder.name)this.edit(()=>{this.library!.renameFolder(folder.id,name);});else this.render();},()=>{this.renaming=null;this.focusLater('folder:'+folder.id);this.render();}));
      }else{
        const toggle=this.button('',()=>this.toggleFolder(folder.id)),name=this.node('span',folder.name);
        toggle.className='library-folder-toggle';toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-controls',bodyId);toggle.dataset.libraryFocus='folder:'+folder.id;name.className='library-folder-name';
        toggle.append(this.svg(['m10 7 5 5-5 5'],'library-chevron'),name);row.append(toggle);
      }
      // Shared context: two overlapping chat bubbles (the folder's chats share one memory), with a tooltip on hover.
      const meta=this.node('span'),wrap=this.node('span'),tip=this.node('span',CONTEXT_TIP),context=this.svg(CONTEXT_PATHS,'library-context');meta.className='library-folder-meta';
      wrap.className='library-context-wrap';tip.className='library-tip';tip.setAttribute('role','tooltip');tip.id='library-context-tip-'+index;
      context.setAttribute('role','img');context.removeAttribute('aria-hidden');context.setAttribute('aria-label','Shared context');context.setAttribute('aria-describedby',tip.id);
      wrap.append(context,tip);meta.append(wrap);if(total?.cost){const cost=this.node('span',total.cost);cost.className='library-folder-cost';meta.append(cost);}
      const more=this.button('',()=>{if(this.menuFor===folder.id)this.closeMenu(true);else this.openMenu(folder.id);});
      more.className='library-icon-button library-folder-more';more.setAttribute('aria-label','Actions for '+folder.name);more.title='Folder actions';more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded',String(this.menuFor===folder.id));more.dataset.libraryFocus='more:'+folder.id;
      if(this.menuFor===folder.id)more.setAttribute('aria-controls','library-folder-menu');
      more.append(this.svg(['M6 12h.01M12 12h.01M18 12h.01'],'library-icon library-more-icon'));
      row.append(meta,more);
      row.addEventListener('contextmenu',event=>{if(this.renaming===folder.id)return;event.preventDefault();this.openMenu(folder.id);});
      const body=this.node('div');body.id=bodyId;body.className='library-folder-body';body.hidden=!expanded;
      const measured=total?[total.cost,total.tokens===null?null:compact(total.tokens)+' tokens',total.actions===null?null:total.actions.toLocaleString('en-GB')+(total.actions===1?' action':' actions')].filter((v):v is string=>!!v):[];
      // Without a measured totals feed the summary still reads from the library: the chat count and the latest activity.
      const latest=rows.reduce<number|null>((max,c)=>{const at=lastMessage(c);return at!==null&&(max===null||at>max)?at:max;},null);
      const segments=measured.length?measured:rows.length?[rows.length+(rows.length===1?' chat':' chats'),...(latest===null?[]:['active '+formatAge(Date.now()-latest)+' ago'])]:[];
      if(segments.length||typeof total?.share==='number'){
        const summary=this.node('div');summary.className='library-folder-summary';
        if(segments.length){const line=this.node('p',segments.join(' · '));line.className='library-folder-totals';summary.append(line);}
        if(typeof total?.share==='number'&&Number.isFinite(total.share)){const share=Math.max(0,Math.min(1,total.share)),bar=this.node('span'),fill=this.node('span');bar.className='library-share';bar.setAttribute('role','img');bar.setAttribute('aria-label','This chat used '+Math.round(share*100)+'% of the folder’s spend');fill.className='library-share-fill';fill.style.setProperty('--share',String(share));bar.append(fill);summary.append(bar);}
        body.append(summary);
      }
      for(const c of rows)body.append(this.chatRow(c,active,false));
      if(!rows.length){const empty=this.node('p','No chats in this folder yet');empty.className='library-empty';body.append(empty);}
      group.append(row);if(this.menuFor===folder.id)group.append(this.folderMenu(folder,s));group.append(body);
      folders.node.append(group);
    });
    mount.append(folders.node);
    const unfiled=s.conversations.map((c,i)=>({c,i,at:lastMessage(c)})).filter(r=>r.c.folderId===null).sort((a,b)=>(b.at??-1)-(a.at??-1)||b.i-a.i).map(r=>r.c);
    if(unfiled.length||!s.conversations.length){
      const chats=section('library-chats-heading','Chats'),list=this.node('div');list.className='library-list';list.id='library-chats';chats.node.append(chats.heading,list);
      const visible=this.showAll?unfiled:unfiled.filter((c,i)=>i<RECENT_CHATS||c.id===active);
      for(const c of visible)list.append(this.chatRow(c,active,true));
      if(!unfiled.length){
        const empty=this.node('div'),tile=this.node('span'),text=this.node('span'),title=this.node('span','No chats yet'),hint=this.node('span','Your chats appear here');
        empty.className='library-empty-card';tile.className='library-empty-tile';tile.setAttribute('aria-hidden','true');text.className='library-empty-text';title.className='library-empty-title';hint.className='library-empty-hint';
        tile.append(this.svg(['M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z'],'library-icon'));text.append(title,hint);empty.append(tile,text);list.append(empty);
      }
      if(unfiled.length>RECENT_CHATS){
        const more=this.button('',()=>{this.showAll=!this.showAll;this.render();}),label=this.node('span',this.showAll?'Show fewer':'Show all '+unfiled.length);
        more.className='library-show-all';more.setAttribute('aria-expanded',String(this.showAll));more.setAttribute('aria-controls',list.id);more.dataset.libraryFocus='show-all';
        more.append(this.svg(['m7 10 5 5 5-5'],'library-chevron'),label);chats.node.append(more);
      }
      mount.append(chats.node);
    }
    if(focusKey)this.restoreFocus(mount,focusKey);
  }
  /** New folder: the name field with Create and Cancel. Enter creates, Escape cancels, an empty name never creates. */
  private createRow():HTMLElement{
    const row=this.node('div'),input=this.node('input');row.className='library-create';row.setAttribute('role','group');row.setAttribute('aria-label','New folder');
    input.type='text';input.maxLength=80;input.value=this.folderDraft;input.placeholder='Folder name';input.className='library-input library-create-input';
    input.setAttribute('aria-label','New folder name');input.autocomplete='off';input.spellcheck=false;input.dataset.libraryFocus='folder-name';
    let done=false;
    const finish=(save:boolean,refocus=true)=>{
      if(done||this.rendering)return;const name=input.value.trim();
      if(save&&!name){if(refocus)input.focus();return;}
      done=true;this.creating=false;this.folderDraft='';
      if(!save){if(refocus)this.focusLater('new-folder');this.render();return;}
      let id='';this.edit(()=>{id=this.library!.createFolder(name);});if(id&&refocus){this.focusLater('folder:'+id);this.render();}
    };
    const create=this.button('Create',()=>finish(true)),cancel=this.button('',()=>finish(false));
    create.className='library-create-submit';cancel.className='library-icon-button library-create-cancel';cancel.setAttribute('aria-label','Cancel new folder');cancel.title='Cancel';
    cancel.append(this.svg(['M7 7l10 10M17 7 7 17'],'library-icon'));
    const sync=()=>{const empty=!input.value.trim();create.setAttribute('aria-disabled',String(empty));row.dataset.empty=String(empty);};sync();
    input.addEventListener('input',()=>{this.folderDraft=input.value;sync();});
    input.addEventListener('keydown',event=>{const key=(event as KeyboardEvent).key;if(key==='Enter'){event.preventDefault();finish(true);}else if(key==='Escape'){event.preventDefault();event.stopPropagation();finish(false);}});
    row.addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='Escape'&&event.target!==input){event.preventDefault();event.stopPropagation();finish(false);}});
    // Focus leaving the row keeps a typed name (it is created, as rename saves on blur) and drops an empty one.
    row.addEventListener('focusout',event=>{const next=(event as FocusEvent).relatedTarget as Node|null;if(next&&row.contains(next))return;finish(!!input.value.trim(),false);});
    row.append(input,create,cancel);return row;
  }
  private restoreFocus(mount:HTMLElement,key:string):void{
    const target=Array.from(mount.querySelectorAll<HTMLElement>('[data-library-focus]')).find(n=>n.dataset.libraryFocus===key);if(!target)return;
    target.focus({preventScroll:true});if(target instanceof HTMLInputElement){const end=target.value.length;target.setSelectionRange(end,end);}
  }
  private chatRow(c:LibraryConversation,active:string|null,mark:boolean):HTMLElement{
    const b=this.button('',()=>{void this.open(c.id);}),title=this.node('span',c.title);
    b.className='library-chat';b.dataset.libraryFocus=c.id;b.setAttribute('aria-current',String(c.id===active));title.className='library-chat-title';
    const providers=c.bindings.map(x=>PROVIDER_NAMES[x.provider]);b.title=c.title+(providers.length?' · '+providers.join(' · '):'');
    const provider=c.messages.at(-1)?.provider??c.bindings.at(-1)?.provider;
    if(mark){const icon=provider?this.svg([PROVIDER_PATHS[provider]],'library-provider provider-logo',true):this.svg(['M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z'],'library-provider');if(provider)icon.setAttribute('data-provider',provider);b.append(icon);}
    b.append(title);
    const at=lastMessage(c);if(at!==null){const age=this.node('span',formatAge(Date.now()-at));age.className='library-chat-age';age.setAttribute('aria-hidden','true');b.append(age);}
    if(c.bindings.length||c.messages.length)return b;
    const row=this.node('div');row.className='library-chat-row';
    const close=this.button('×',()=>this.dismissEmpty(c.id));close.className='library-chat-close';close.title='Close empty chat';close.setAttribute('aria-label','Close empty chat: '+c.title);close.dataset.libraryFocus='close-empty:'+c.id;
    row.append(b,close);return row;
  }
  private renderHistory():void{
    const history=this.doc.getElementById('shared-conversation-history');if(!history)return;
    const c=this.library?.active();history.hidden=!c?.messages.length;if(!c)return;
    let detail=history.querySelector('details'),title=history.querySelector('summary'),list=history.querySelector('div');
    if(!detail||!title||!list){detail=this.node('details');title=this.node('summary');list=this.node('div');detail.className='shared-history';title.className='shared-history-summary';list.className='shared-history-list';list.setAttribute('role','list');detail.append(title,list);detail.addEventListener('toggle',()=>{if(detail!.open)this.renderHistory();});history.replaceChildren(detail);}
    title.textContent='Shared history · '+c.title;
    if(!detail.open)return;
    const signature=JSON.stringify([c.id,c.messages]);if(signature===this.historySignature)return;this.historySignature=signature;list.replaceChildren();
    for(const m of c.messages){const article=this.node('article');article.className='shared-history-message';article.setAttribute('role','listitem');article.dataset.role=m.role;const meta=this.node('small',(m.provider==='codex'?'Codex':m.provider==='claude'?'Claude':'Arcane')+' · '+m.role+(m.model?' · '+m.model:''));meta.className='shared-history-meta';article.append(meta,this.node('p',m.text));list.append(article);}
  }
  stop():void{this.flush();this.stopped=true;this.navigationRevision++;this.pendingNew=null;}
  resume():void{this.stopped=false;this.observe();this.flush();}
  cleanup():void{this.stop();this.closeMenuListener();for(const remove of this.removers)remove();for(const peer of Object.values(this.options.peers))peer.setBeforeMessageSubmit(null);}
}
