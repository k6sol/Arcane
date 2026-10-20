/// <reference lib="dom" />
import {ConversationLibrary,type ConversationLibrarySnapshot,type ConversationProvider,type LibraryTranscript} from './conversation-library.js';
type BeforeMessageSubmit=(draft:string)=>string|Promise<string>;
export interface SharedConversationPeer {
  recordedTranscript():LibraryTranscript;
  isDraftConversation():boolean;
  subscribeTranscriptChange(listener:()=>void):()=>void;
  setBeforeMessageSubmit(callback:BeforeMessageSubmit|null):void;
  showConversationNotice(text:string):void;
  open(id:string):Promise<boolean>;
  newChat():Promise<boolean>;
}
interface LibraryBridge {version:1;read():Promise<unknown>;save(value:ConversationLibrarySnapshot):Promise<unknown>}
interface LibraryRead {available:boolean;projectPath:string|null;preferences:unknown}
export interface SharedConversationsOptions {peers:Partial<Record<ConversationProvider,SharedConversationPeer>>;provider():ConversationProvider;requestProvider(provider:ConversationProvider):boolean;bridge?:LibraryBridge|null}
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
  private pendingAttach:ConversationProvider|null=null;
  private scheduled=false;
  private signature='';
  private historySignature='';
  private removers:(()=>void)[]=[];
  private bridge:LibraryBridge|null;
  constructor(private readonly doc:Document,private readonly options:SharedConversationsOptions){
    this.bridge=options.bridge??(doc.defaultView as unknown as {arcaneDesktop?:{conversationLibrary?:LibraryBridge}}|null)?.arcaneDesktop?.conversationLibrary??null;
    for(const peer of Object.values(options.peers)){
      this.removers.push(peer.subscribeTranscriptChange(()=>this.schedule()));
      peer.setBeforeMessageSubmit(draft=>this.prepareMessage(draft));
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
      this.ready=true;this.observe();
    }catch{this.persistenceError=true;}finally{this.render();}
  }
  private peer(provider=this.options.provider()):SharedConversationPeer|undefined{return this.options.peers[provider];}
  private notice(text:string):void{this.peer()?.showConversationNotice(text);}
  private schedule():void{if(this.stopped||this.scheduled)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;if(!this.stopped)this.observe();});}
  private observe():void{
    if(!this.library||this.suspended||this.stopped)return;
    const p=this.options.provider(),snapshot=this.peer(p)?.recordedTranscript();if(!snapshot)return;
    if(!snapshot.conversationId&&this.peer(p)?.isDraftConversation()===true&&this.pendingAttach!==p&&this.library.active()?.bindings.length){this.library.newConversation();this.persist();}
    try{if(this.library.observe(snapshot,this.pendingAttach===p)){if(snapshot.conversationId)this.pendingAttach=null;this.persist();}}catch(error){this.notice(error instanceof Error?error.message:'Shared history could not be saved.');}
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
  private async prepareMessage(draft:string):Promise<string>{
    await this.reading;
    if(this.stopped||this.suspended)throw Error('Wait for this conversation to finish switching models.');
    this.observe();return this.library?.contextFor(this.options.provider(),draft)??draft;
  }
  beginNewConversation():void{if(!this.library||this.suspended||this.stopped)return;this.observe();this.library.newConversation();this.pendingAttach=null;this.persist();this.render();}
  /** Only an explicit model choice calls this. It never sends a message, replays tools or transfers grants. */
  async beforeProviderSwitch(from:ConversationProvider,to:ConversationProvider):Promise<boolean>{
    if(from==='arcane'||to==='arcane')return true;
    await this.reading;if(!this.ready||!this.library)return !this.bridge;
    if(this.stopped||this.suspended||from!==this.options.provider())return false;
    this.observe();if(!this.library.active())this.library.newConversation();
    const activeId=this.library.active()!.id,peer=this.peer(to);if(!peer)return false;
    const binding=this.library.active()!.bindings.find(b=>b.provider===to);
    this.suspended++;
    try{
      const ok=binding?(peer.recordedTranscript().conversationId===binding.conversationId||await peer.open(binding.conversationId)):await peer.newChat();
      if(!ok||this.library.active()?.id!==activeId||this.stopped)return false;
      this.pendingAttach=to;this.persist();return true;
    }catch{return false;}finally{this.suspended--;}
  }
  private async open(id:string):Promise<void>{
    if(!this.library||this.suspended)return;
    this.observe();const previous=this.library.active()?.id;this.library.select(id);
    const target=this.library.active()!,current=this.options.provider(),binding=target.bindings.find(b=>b.provider===current)??target.bindings[0];
    if(!binding){this.render();return;}
    this.suspended++;
    try{
      const peer=this.peer(binding.provider),ok=!!peer&&await peer.open(binding.conversationId);
      if(!ok){if(previous)this.library.select(previous);this.notice('This saved conversation could not be opened. Your current chat and draft were retained.');return;}
      if(binding.provider!==current&&!this.options.requestProvider(binding.provider)){if(previous)this.library.select(previous);return;}
      this.pendingAttach=null;this.persist();
    }catch{if(previous)this.library.select(previous);this.notice('This saved conversation could not be opened. Try again after checking the provider connection.');}
    finally{this.suspended--;this.render();}
  }
  private edit(action:()=>void):void{if(!this.library||this.suspended)return;try{action();this.persist();this.flush();this.render();}catch(error){this.notice(error instanceof Error?error.message:'Chat organisation could not be saved.');}}
  private node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string):HTMLElementTagNameMap[K]{const node=this.doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
  private button(label:string,action:()=>void):HTMLButtonElement{const b=this.node('button',label);b.type='button';b.addEventListener('click',action);return b;}
  private render():void{
    const mount=this.doc.getElementById('conversation-library');if(!mount)return;
    const state=this.library?.snapshot();this.renderHistory();
    const signature=JSON.stringify([state?.activeId,state?.folders,state?.conversations.map(c=>({id:c.id,title:c.title,folderId:c.folderId,bindings:c.bindings})),this.persistenceError,this.ready]);if(signature===this.signature)return;this.signature=signature;
    const focused=this.doc.activeElement as HTMLElement|null,focusKey=focused?.dataset?.libraryFocus;
    mount.replaceChildren();
    const heading=this.node('p','Chats');heading.className='sidebar-label';mount.append(heading);
    if(!this.ready){const note=this.node('p',this.persistenceError?'Saved chats could not be loaded. Reopen Arcane to retry.':'Loading saved chats…');note.className='hint';mount.append(note);return;}
    if(this.persistenceError){const note=this.node('p','Chat organisation has not been saved.');note.className='hint';mount.append(note,this.button('Retry saving',()=>{this.persistenceError=false;this.flush();}));}
    const folders=this.node('details'),summary=this.node('summary','Manage folders');folders.append(summary);
    const input=this.node('input');input.type='text';input.maxLength=80;input.placeholder='Folder name';input.setAttribute('aria-label','Folder name');input.dataset.libraryFocus='folder-name';
    folders.append(input,this.button('New folder',()=>this.edit(()=>{this.library!.createFolder(input.value);})));
    mount.append(folders);
    const active=state!.activeId;
    for(const folder of [{id:null,name:'Unfiled'},...state!.folders]){
      const group=this.node('details'),name=this.node('summary',folder.name);group.open=folder.id===null||state!.conversations.some(c=>c.id===active&&c.folderId===folder.id);group.append(name);
      const rows=state!.conversations.filter(c=>c.folderId===folder.id);
      for(const c of rows){const b=this.button(c.title,()=>{void this.open(c.id);});b.className='library-chat';b.dataset.libraryFocus=c.id;b.setAttribute('aria-current',String(c.id===active));b.title=c.bindings.map(b=>b.provider==='codex'?'Codex':b.provider==='claude'?'Claude':'Arcane').join(' · ');group.append(b);}
      if(!rows.length)group.append(this.node('p','No chats'));
      if(folder.id!==null){group.append(this.button('Rename folder',()=>this.edit(()=>{this.library!.renameFolder(folder.id!,input.value);})),this.button('Remove folder',()=>this.edit(()=>{this.library!.removeFolder(folder.id!);})));}
      mount.append(group);
    }
    if(active){const label=this.node('label','Move current chat'),select=this.node('select');select.setAttribute('aria-label','Folder for current chat');select.dataset.libraryFocus='move-chat';for(const f of [{id:null,name:'Unfiled'},...state!.folders]){const o=this.node('option',f.name);o.value=f.id??'';o.selected=state!.conversations.find(c=>c.id===active)?.folderId===f.id;select.append(o);}select.addEventListener('change',()=>this.edit(()=>this.library!.move(active,select.value||null)));label.append(select);mount.append(label);}
    if(focusKey)Array.from(mount.querySelectorAll<HTMLElement>('[data-library-focus]')).find(n=>n.dataset.libraryFocus===focusKey)?.focus({preventScroll:true});
  }
  private renderHistory():void{
    const history=this.doc.getElementById('shared-conversation-history');if(!history)return;
    const c=this.library?.active();history.hidden=!c?.messages.length;if(!c)return;
    let detail=history.querySelector('details'),title=history.querySelector('summary'),list=history.querySelector('div');
    if(!detail||!title||!list){detail=this.node('details');title=this.node('summary');list=this.node('div');detail.append(title,list);detail.addEventListener('toggle',()=>{if(detail!.open)this.renderHistory();});history.replaceChildren(detail);}
    title.textContent='Shared history · '+c.title;
    if(!detail.open)return;
    const signature=JSON.stringify([c.id,c.messages]);if(signature===this.historySignature)return;this.historySignature=signature;list.replaceChildren();
    for(const m of c.messages){const article=this.node('article');article.className='shared-history-message';article.append(this.node('small',(m.provider==='codex'?'Codex':m.provider==='claude'?'Claude':'Arcane')+' · '+m.role+(m.model?' · '+m.model:'')),this.node('p',m.text));list.append(article);}
  }
  stop():void{this.flush();this.stopped=true;}
  resume():void{this.stopped=false;this.observe();this.flush();}
  cleanup():void{this.stop();for(const remove of this.removers)remove();for(const peer of Object.values(this.options.peers))peer.setBeforeMessageSubmit(null);}
}
