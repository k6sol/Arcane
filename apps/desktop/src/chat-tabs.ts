/// <reference lib="dom" />
import type { ChatState, CodexChat } from './codex-chat.js';
import type { CodexSavedThread } from '../../daemon/src/codex-service.js';
import { validateHistoryBinding, type HistoryBinding } from './codex-history.js';

export const CHAT_TAB_LIMITS = Object.freeze({ open: 16, saved: 256, draftBytes: 131072, preferencesBytes: 512 * 1024 });
export interface ChatSelection { model: string; effort: string }
export interface ChatTabView {
  readonly key: string; readonly localId: string; readonly title: string; readonly tool: 'all'|'blender'|'roblox'; readonly previewOpen: boolean;
  readonly kind: 'draft' | 'native'; readonly provider: 'codex';
  readonly projectPath: string; readonly threadId: string | null; readonly sessionId: string | null;
  readonly selection: ChatSelection | null; readonly draft: string; readonly workflowDraft: boolean;
}
interface Tab extends ChatTabView { selection: ChatSelection | null; draft: string; workflowDraft: boolean }
export interface ChatTabsOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  preferences?: { read(): Promise<unknown>; save(value: ChatTabPreferences): Promise<unknown> };
  /** Opt in only when the parent has settled the legacy WorkspaceShell handshake. */
  captureLegacyNewChat?: boolean;
}
export interface ChatTabPreferences {
  version: 1; projectPath: string; provider: 'codex'|'claude'; activeTabId: string | null;
  tabs: {localId:string;title:string;provider:'codex';threadId:string|null;sessionId:string|null;draft:string;modelId:string|null;effort:string|null;tool:'all'|'blender'|'roblox';previewOpen:boolean}[];
}
export interface ChatTabsCallbacks {
  select(key: string): Promise<boolean>; close(key: string): Promise<boolean>;
  newChat(): Promise<boolean>; openSaved(threadId: string): Promise<boolean>;
}
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const uuid = (value: unknown): value is string => typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
function plain(v:unknown):v is Record<string,unknown> {
  try{return !!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).every(k=>{
    const descriptor=Object.getOwnPropertyDescriptor(v,k);return typeof k==='string'&&!!descriptor?.enumerable&&Object.hasOwn(descriptor,'value');
  });}catch{return false;}
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => plain(v) && Reflect.ownKeys(v).length === keys.length && keys.every(k=>Object.hasOwn(v,k));
const tool = (v:unknown):v is ChatTabView['tool'] => v==='all'||v==='blender'||v==='roblox';
const pair = (v: unknown): v is ChatSelection => exact(v,['model','effort']) && typeof v.model === 'string' && v.model.length > 0 && v.model.length <= 256 && typeof v.effort === 'string' && v.effort.length > 0 && v.effort.length <= 64 && !/[\x00-\x1f]/.test(v.model+v.effort);
const sameSelection = (a: ChatSelection | null, b: ChatSelection | null) => a?.model===b?.model&&a?.effort===b?.effort;
const DRAFT_SAVE_DELAY_MS = 150;
export const nativeChatKey = (binding: Pick<CodexSavedThread,'projectPath'|'threadId'|'sessionId'>) => JSON.stringify([binding.projectPath,'codex',binding.threadId,binding.sessionId]);

/** Public host evidence only. Browser preferences and names never create ownership. */
export function validateSavedThreads(value: unknown, projectPath: string): CodexSavedThread[] {
  if (!Array.isArray(value) || value.length > CHAT_TAB_LIMITS.saved || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('Invalid saved native chat catalogue.');
  const seen = new Set<string>();
  return value.map(row => {
    if (!exact(row,['provider','projectPath','threadId','sessionId','selection']) || row.provider !== 'codex' || row.projectPath !== projectPath || !id(row.threadId) || !(row.sessionId === null || id(row.sessionId)) || !(row.selection === null || pair(row.selection)) || seen.has(row.threadId)) throw new Error('Invalid exact saved native chat binding.');
    seen.add(row.threadId); return structuredClone(row) as unknown as CodexSavedThread;
  });
}

/** Local draft/preferences controller. It has no transport, native calls or grant fields. */
export class ChatTabs {
  private rows: Tab[] = [];
  private activeKey: string | null = null;
  private projectPath: string | null = null;
  private catalogue: CodexSavedThread[] = [];
  private catalogueByKey = new Map<string,CodexSavedThread>();
  private presentationRevision = 0;
  private catalogueRevision = 0;
  private readonly recordings = new Map<string, HistoryBinding>();
  private readonly preferences = new Map<string,string>();
  private readonly cleanup: (()=>void)[] = [];
  private storage: Pick<Storage,'getItem'|'setItem'> | undefined;
  private signature = '';
  private savedSignature = '';
  private persistenceDirty = false;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private mounted = false;
  private savedMenu: HTMLDetailsElement | null = null;
  private nativeReady = false;
  private nativeError = false;
  private nativeQueued: {value:ChatTabPreferences;serialized:string;generation:number} | null = null;
  private nativeGeneration = 0;
  private nativeSaving = false;
  private nativeLast = '';
  private nativeSaved = '';
  private preferencesDirty = false;
  private nativeProject: string | null = null;
  private preferredProvider: 'codex'|'claude' = 'codex';
  constructor(private readonly doc: Document, private readonly safe: (text:string)=>string, private readonly callbacks: ChatTabsCallbacks, private readonly options: ChatTabsOptions = {}) {
    this.storage = options.storage;
    if((doc.getElementById('provider-setup-provider') as HTMLSelectElement|null)?.value==='claude')this.preferredProvider='claude';
    if (!this.storage && !options.preferences) { try { this.storage = doc.defaultView?.localStorage; } catch {} }
  }
  persistenceStatus(): 'native'|'native-loading'|'native-error'|'browser-origin'|'memory' {
    return this.options.preferences ? this.nativeError?'native-error':this.nativeReady?'native':'native-loading' : this.storage?'browser-origin':'memory';
  }
  providerPreference(): 'codex'|'claude' {return this.preferredProvider;}
  preferencesSaved():boolean {return !this.preferencesDirty&&!this.persistenceDirty&&!this.nativeSaving&&this.nativeQueued===null&&!this.nativeError&&this.persistenceStatus()!=='native-loading'&&this.persistenceStatus()!=='memory';}
  setProviderPreference(provider:'codex'|'claude'):void {
    if(provider!=='codex'&&provider!=='claude')return;
    if(this.preferredProvider!==provider){this.preferredProvider=provider;this.persistenceDirty=true;}this.persist();
  }
  async initializePreferences(projectPath: string): Promise<void> {
    if (!this.options.preferences) return;
    const generation=++this.nativeGeneration;
    this.nativeQueued=null;
    this.nativeReady=false;this.nativeError=false;
    try {
      const value=await this.options.preferences.read();
      if(generation!==this.nativeGeneration)return;
      if(value!==null) {
        if(!exact(value,['version','projectPath','provider','activeTabId','tabs'])||value.version!==1||!['codex','claude'].includes(String(value.provider))||value.projectPath!==projectPath||!(value.activeTabId===null||uuid(value.activeTabId))||!Array.isArray(value.tabs)||value.tabs.length>CHAT_TAB_LIMITS.open||bytes(JSON.stringify(value))>CHAT_TAB_LIMITS.preferencesBytes||this.clean(JSON.stringify(value))!==JSON.stringify(value))throw new Error('Invalid native chat preferences.');
        this.preferredProvider=value.provider as 'codex'|'claude';
        const ids=new Set<string>(), rows:Tab[]=[];
        for(const row of value.tabs) {
          if(!exact(row,['localId','title','provider','threadId','sessionId','draft','modelId','effort','tool','previewOpen'])||!uuid(row.localId)||ids.has(row.localId)||row.provider!=='codex'||typeof row.title!=='string'||row.title.length>160||!tool(row.tool)||typeof row.previewOpen!=='boolean'||typeof row.draft!=='string'||bytes(row.draft)>CHAT_TAB_LIMITS.draftBytes||!(row.threadId===null||id(row.threadId))||!(row.sessionId===null||id(row.sessionId))||row.threadId===null&&row.sessionId!==null||!(row.modelId===null&&row.effort===null||pair({model:row.modelId,effort:row.effort})))throw new Error('Invalid native chat preference row.');
          ids.add(row.localId);
          const selection=row.modelId===null?null:{model:row.modelId as string,effort:row.effort as string};
          const binding={projectPath,threadId:row.threadId as string,sessionId:row.sessionId as string|null};
          rows.push({key:row.threadId===null?'draft:'+row.localId:nativeChatKey(binding),localId:row.localId,title:row.title,tool:row.tool,previewOpen:row.previewOpen,kind:row.threadId===null?'draft':'native',provider:'codex',projectPath,threadId:row.threadId as string|null,sessionId:row.sessionId as string|null,selection,draft:row.draft,workflowDraft:!!row.draft});
        }
        const keys=new Set(rows.map(row=>row.key));if(keys.size!==rows.length)throw new Error('Duplicate native chat preferences.');
        const activeKey=rows.find(row=>row.localId===value.activeTabId)?.key??rows[0]?.key??null;
        this.preferences.set(projectPath,JSON.stringify({version:1,projectPath,provider:this.preferredProvider,activeKey,tabs:rows}));
      }
      this.nativeReady=true;this.nativeProject=projectPath;this.nativeLast='';this.nativeSaved='';this.persistenceDirty=true;
    } catch {if(generation===this.nativeGeneration)this.nativeError=true;}
  }
  private clean(value: string) {
    // Launcher capabilities are sometimes bare 64-character keys; never persist those either.
    return this.safe(value).replace(/\b[a-f0-9]{64}\b/gi,'[REDACTED]');
  }
  private storageKey(projectPath: string) { return 'arcane.chat-tabs.v1:' + encodeURIComponent(projectPath); }
  views(): readonly ChatTabView[] { return structuredClone(this.rows); }
  active(): ChatTabView | null { return structuredClone(this.rows.find(row=>row.key===this.activeKey) ?? null); }
  saved(): readonly CodexSavedThread[] { return structuredClone(this.catalogue); }
  owns(tab: ChatTabView): boolean { return tab.kind === 'native' && tab.projectPath === this.projectPath && this.catalogueByKey.has(tab.key); }
  bound(state: ChatState | null): boolean {
    const active = this.active(), thread = state?.snapshot?.thread;
    return !!active && this.owns(active) && state?.projectPath===active.projectPath && !!thread?.configured && thread.threadId===active.threadId && thread.sessionId===active.sessionId;
  }
  recording(tab = this.active()): HistoryBinding | null { return tab && this.owns(tab) ? structuredClone(this.recordings.get(tab.key) ?? null) : null; }
  sync(state: ChatState, followNative = false): boolean {
    const before = this.activeKey;
    const presentationBefore=this.presentationRevision;
    let selectionChanged=false;
    if (this.projectPath !== state.projectPath) {
      this.persist(); this.projectPath = state.projectPath; this.rows = []; this.activeKey = null; this.recordings.clear();
      this.presentationRevision++;this.persistenceDirty=true;
      if(this.options.preferences&&this.nativeProject!==state.projectPath){this.nativeReady=false;this.nativeQueued=null;this.nativeGeneration++;}
      this.restore(state.projectPath);
    }
    const binding = state.nativeHistory ? validateHistoryBinding(state.nativeHistory,state.projectPath) : null;
    const catalogue = state.nativeThreads !== undefined ? validateSavedThreads(state.nativeThreads,state.projectPath) : binding ? [{provider:'codex' as const,projectPath:state.projectPath,threadId:binding.threadId,sessionId:binding.sessionId,selection:state.snapshot?.thread?.threadId===binding.threadId?state.snapshot.thread.selection:null}] : [];
    if(catalogue.length!==this.catalogue.length||catalogue.some((row,index)=>row.threadId!==this.catalogue[index]?.threadId))this.catalogueRevision++;
    if(catalogue.length!==this.catalogue.length||catalogue.some((row,index)=>{
      const previous=this.catalogue[index];return !previous||nativeChatKey(row)!==nativeChatKey(previous)||!sameSelection(row.selection,previous.selection);
    })) {
      this.catalogue=catalogue;this.catalogueByKey=new Map(catalogue.map(row=>[nativeChatKey(row),row]));
    }
    for(const [index,row] of this.rows.entries()) {
      if(row.kind==='draft'||this.owns(row))continue;
      // An advisory ID that cannot be confirmed never authorizes resume, but its unsent text is retained.
      const recovered:Tab={...row,key:'draft:'+row.localId,kind:'draft',threadId:null,sessionId:null,title:'Recovered draft',workflowDraft:!!row.draft};
      this.presentationRevision++;this.persistenceDirty=true;
      if(this.activeKey===row.key)this.activeKey=recovered.key;this.rows[index]=recovered;
    }
    for (const row of this.rows) if (row.kind==='native') {
      const selection=this.catalogueByKey.get(row.key)!.selection;
      if(!sameSelection(row.selection,selection)){row.selection=structuredClone(selection);this.persistenceDirty=true;selectionChanged=true;}
    }
    if (binding) this.recordings.set(nativeChatKey(binding),binding);
    const live = state.snapshot?.thread;
    const ownedLive = live?.configured ? this.catalogue.find(row=>row.threadId===live.threadId&&row.sessionId===live.sessionId) : null;
    if (ownedLive && (followNative || !this.rows.length)) {
      const visible=this.ensureNative(ownedLive);
      if(!visible&&followNative)throw new Error('The native chat needs attention. Close an inactive tab to show its tab; active native operations and approvals remain visible below.');
      this.activeKey=visible?.key??this.activeKey;
    }
    if (!this.rows.some(row=>row.key===this.activeKey)) this.activeKey = this.rows[0]?.key ?? null;
    if (!this.rows.length) {
      const recorded = binding && this.catalogue.find(row=>nativeChatKey(row)===nativeChatKey(binding));
      if (recorded) this.activeKey = this.ensureNative(recorded)!.key;
      else this.createDraft();
    }
    if(before!==this.activeKey)this.persistenceDirty=true;
    // A poll must not flush a draft debounce unless it changes persisted tab state.
    if((this.persistenceDirty&&this.draftTimer===null)||before!==this.activeKey||presentationBefore!==this.presentationRevision||selectionChanged)this.persist();
    return before !== this.activeKey;
  }
  private ensureNative(saved: CodexSavedThread): Tab | null {
    const key = nativeChatKey(saved), existing = this.rows.find(row=>row.key===key);
    if (existing) return existing;
    if (this.rows.length >= CHAT_TAB_LIMITS.open) return null;
    const tab: Tab = {key,localId:crypto.randomUUID(),title:'Chat',tool:'all',previewOpen:false,kind:'native',provider:'codex',projectPath:saved.projectPath,threadId:saved.threadId,sessionId:saved.sessionId,selection:structuredClone(saved.selection),draft:'',workflowDraft:false};
    this.rows.push(tab);this.presentationRevision++;this.persistenceDirty=true; return tab;
  }
  needsNativePreferences(projectPath:string):boolean {return !!this.options.preferences&&(!this.nativeReady||this.nativeProject!==projectPath)&&!this.nativeError;}
  reloadPreferences(state:ChatState):void {
    if(this.nativeProject!==state.projectPath)return;
    this.rows=[];this.activeKey=null;this.presentationRevision++;this.persistenceDirty=true;this.restore(state.projectPath);this.sync(state);
  }
  createDraft(): ChatTabView | null {
    if (!this.projectPath || this.rows.length >= CHAT_TAB_LIMITS.open) return null;
    const localId=crypto.randomUUID();
    const tab: Tab = {key:'draft:'+localId,localId,title:'Draft',tool:'all',previewOpen:false,kind:'draft',provider:'codex',projectPath:this.projectPath,threadId:null,sessionId:null,selection:null,draft:'',workflowDraft:false};
    this.rows.push(tab); this.activeKey = tab.key;this.presentationRevision++;this.persistenceDirty=true; this.persist(); return structuredClone(tab);
  }
  ensureSaved(threadId: string): ChatTabView | null {
    const saved = this.catalogue.find(row=>row.threadId===threadId);
    return saved ? structuredClone(this.ensureNative(saved)) : null;
  }
  activate(key: string): boolean {
    const row = this.rows.find(row=>row.key===key);
    if (!row || row.kind==='native'&&!this.owns(row)) return false;
    if(this.activeKey!==key){this.activeKey = key;this.persistenceDirty=true;} this.persist(); return true;
  }
  bindDraft(state: ChatState): boolean {
    const active = this.rows.find(row=>row.key===this.activeKey), thread = state.snapshot?.thread;
    if (!active || active.kind!=='draft' || state.projectPath!==active.projectPath || !thread?.configured) return false;
    const saved = this.catalogue.find(row=>row.threadId===thread.threadId&&row.sessionId===thread.sessionId);
    if (!saved) return false;
    const replacement: Tab = {...active,key:nativeChatKey(saved),kind:'native',threadId:saved.threadId,sessionId:saved.sessionId,selection:structuredClone(thread.selection)};
    this.rows = this.rows.filter(row=>row.key!==replacement.key); this.rows[this.rows.findIndex(row=>row.key===active.key)] = replacement;
    this.activeKey = replacement.key;this.presentationRevision++;this.persistenceDirty=true; this.persist(); return true;
  }
  updateDraft(value: string, selection?: ChatSelection | null, workflowDraft?: boolean): void {
    const active = this.rows.find(row=>row.key===this.activeKey); if (!active) return;
    if(active.draft===value&&(selection===undefined||sameSelection(active.selection,selection))&&(workflowDraft===undefined||active.workflowDraft===workflowDraft))return;
    if(bytes(value)>CHAT_TAB_LIMITS.draftBytes)return;
    const selectionChanged=selection!==undefined&&!sameSelection(active.selection,selection);
    active.draft = value;
    if (selection!==undefined) active.selection=structuredClone(selection);
    if (workflowDraft!==undefined) active.workflowDraft=workflowDraft;
    this.persistenceDirty=true;this.preferencesDirty=true;
    // Preserve the first edit immediately; coalesce subsequent edits until a pause.
    // Every tab/project/presentation/lifecycle boundary calls persist synchronously.
    const continuing=this.draftTimer!==null&&!selectionChanged;
    if(!continuing)this.persist();else clearTimeout(this.draftTimer!);
    this.draftTimer=setTimeout(()=>{this.draftTimer=null;this.persist();},DRAFT_SAVE_DELAY_MS);
  }
  updatePresentation(value:{tool?:ChatTabView['tool'];previewOpen?:boolean}):void {
    if(!plain(value)||Reflect.ownKeys(value).some(key=>key!=='tool'&&key!=='previewOpen')||value.tool!==undefined&&!tool(value.tool)||value.previewOpen!==undefined&&typeof value.previewOpen!=='boolean')return;
    const active=this.rows.find(row=>row.key===this.activeKey);if(!active)return;
    if((value.tool===undefined||value.tool===active.tool)&&(value.previewOpen===undefined||value.previewOpen===active.previewOpen)){this.persist();return;}
    const replacement={...active,...value};this.rows[this.rows.indexOf(active)]=replacement;this.persistenceDirty=true;this.persist();
  }
  remove(key: string): boolean {
    if (key===this.activeKey || !this.rows.some(row=>row.key===key)) return false;
    this.rows = this.rows.filter(row=>row.key!==key);this.presentationRevision++;this.persistenceDirty=true; this.persist(); return true;
  }
  private persist() {
    if(this.draftTimer!==null){clearTimeout(this.draftTimer);this.draftTimer=null;}
    if(!this.persistenceDirty)return;
    this.persistenceDirty=false;
    this.preferencesDirty=true;
    if (!this.projectPath || this.clean(this.projectPath)!==this.projectPath) return;
    const tabs = this.rows.map(row=>({...row,draft:this.clean(row.draft)}));
    if (tabs.some(row=>[row.key,row.projectPath,row.title,row.tool,row.threadId ?? '',row.sessionId ?? '',row.selection?.model ?? '',row.selection?.effort ?? ''].some(v=>this.clean(v)!==v))) return;
    const value = JSON.stringify({version:1,projectPath:this.projectPath,provider:this.preferredProvider,activeKey:this.activeKey,tabs});
    if (bytes(value)>CHAT_TAB_LIMITS.preferencesBytes) return;
    this.preferences.set(this.projectPath,value);
    while(this.preferences.size>8)this.preferences.delete(this.preferences.keys().next().value!);
    try { if(this.storage){this.storage.setItem(this.storageKey(this.projectPath),value);if(!this.options.preferences)this.preferencesDirty=false;} } catch {this.persistenceDirty=true;}
    if(this.options.preferences&&this.nativeReady&&!this.nativeError&&this.nativeProject===this.projectPath) {
      const native:ChatTabPreferences={version:1,projectPath:this.projectPath,provider:this.preferredProvider,activeTabId:this.rows.find(row=>row.key===this.activeKey)?.localId??null,
        tabs:tabs.map(row=>({localId:row.localId,title:row.title,provider:'codex',threadId:row.threadId,sessionId:row.sessionId,draft:row.draft,modelId:row.selection?.model??null,effort:row.selection?.effort??null,tool:row.tool,previewOpen:row.previewOpen}))};
      const serialized=JSON.stringify(native);
      this.preferencesDirty=serialized!==this.nativeSaved;
      if(serialized!==this.nativeLast){this.nativeLast=serialized;this.nativeQueued={value:native,serialized,generation:this.nativeGeneration};void this.saveNative();}
    }
  }
  private async saveNative(): Promise<void> {
    if(this.nativeSaving)return;this.nativeSaving=true;
    try {while(this.nativeQueued){
      const queued=this.nativeQueued;this.nativeQueued=null;
      if(queued.generation!==this.nativeGeneration||!this.nativeReady||queued.value.projectPath!==this.nativeProject||queued.value.projectPath!==this.projectPath)continue;
      try {
        await this.options.preferences!.save(queued.value);
        if(queued.generation===this.nativeGeneration&&this.nativeReady&&queued.value.projectPath===this.nativeProject&&queued.value.projectPath===this.projectPath){this.nativeSaved=queued.serialized;this.preferencesDirty=this.persistenceDirty||this.nativeSaved!==this.nativeLast;}
      } catch {if(queued.generation===this.nativeGeneration&&this.nativeReady&&queued.value.projectPath===this.nativeProject&&queued.value.projectPath===this.projectPath){this.nativeError=true;this.nativeQueued=null;}}
    }}
    finally {this.nativeSaving=false;}
  }
  private restore(projectPath: string) {
    try {
      const raw = this.preferences.get(projectPath) ?? this.storage?.getItem(this.storageKey(projectPath));
      if (!raw || bytes(raw)>CHAT_TAB_LIMITS.preferencesBytes || this.clean(raw)!==raw) return;
      const value:unknown = JSON.parse(raw);
      if (!exact(value,['version','projectPath','provider','activeKey','tabs']) || value.version!==1 || !['codex','claude'].includes(String(value.provider)) || value.projectPath!==projectPath || !(value.activeKey===null||typeof value.activeKey==='string') || !Array.isArray(value.tabs) || value.tabs.length>CHAT_TAB_LIMITS.open) return;
      const seen = new Set<string>(),localIds=new Set<string>(), rows:Tab[]=[];
      for (const row of value.tabs) {
        if (!exact(row,['key','localId','title','tool','previewOpen','kind','provider','projectPath','threadId','sessionId','selection','draft','workflowDraft']) || !uuid(row.localId)||localIds.has(row.localId)||typeof row.title!=='string'||row.title.length>160||!tool(row.tool)||typeof row.previewOpen!=='boolean'||row.projectPath!==projectPath || row.provider!=='codex' || typeof row.key!=='string' || seen.has(row.key) || typeof row.draft!=='string' || bytes(row.draft)>CHAT_TAB_LIMITS.draftBytes || typeof row.workflowDraft!=='boolean' || !(row.selection===null||pair(row.selection))) return;
        if (row.kind==='draft' ? row.key!=='draft:'+row.localId||row.threadId!==null||row.sessionId!==null : row.kind!=='native'||!id(row.threadId)||!(row.sessionId===null||id(row.sessionId))||row.key!==nativeChatKey(row as unknown as CodexSavedThread)) return;
        seen.add(row.key);localIds.add(row.localId); rows.push(row as unknown as Tab);
      }
      this.rows = rows; this.activeKey = value.activeKey as string|null;this.preferredProvider=value.provider as 'codex'|'claude';
      this.presentationRevision++;this.persistenceDirty=true;
    } catch {} // Storage is optional; corrupt preferences never dispatch native work.
  }
  mount(): void {
    if (this.mounted) return;
    const mount = this.doc.getElementById('workspace-chat-tabs');
    if (!mount || mount.getAttribute('role')!=='tablist') throw new Error('The workspace chat tablist is missing.');
    this.mounted = true;
    const listen = (el:HTMLElement,event:string,fn:(event:Event)=>void,capture=false)=>{el.addEventListener(event,fn,capture);this.cleanup.push(()=>el.removeEventListener(event,fn,capture));};
    for (const name of ['workspace-new-chat',...(this.options.captureLegacyNewChat?['new-chat']:[])]) {
      const button = this.doc.getElementById(name); if (!button) continue;
      button.setAttribute('aria-label','New chat'); button.setAttribute('title','New chat');
      listen(button,'click',event=>{if(event.defaultPrevented)return;event.preventDefault();if(name==='new-chat')event.stopImmediatePropagation();void this.callbacks.newChat();},name==='new-chat');
    }
    listen(mount,'keydown',event=>{
      const input=event as KeyboardEvent, key=(input.target as HTMLElement)?.dataset?.chatKey;
      if (!key || input.altKey || input.ctrlKey || input.metaKey || input.shiftKey) return;
      const index = this.rows.findIndex(row=>row.key===key);
      if (index<0) return;
      if (input.key==='Delete') {event.preventDefault();void this.callbacks.close(key);return;}
      const next = input.key==='Home'?0:input.key==='End'?this.rows.length-1:input.key==='ArrowRight'?(index+1)%this.rows.length:input.key==='ArrowLeft'?(index+this.rows.length-1)%this.rows.length:-1;
      if(next<0)return;event.preventDefault();const target=this.rows[next]!.key;
      void this.callbacks.select(target).then(ok=>{if(ok)Array.from(mount.querySelectorAll<HTMLElement>('[role=tab]')).find(button=>button.dataset.chatKey===target)?.focus();});
    });
    this.savedMenu=this.doc.createElement('details');this.savedMenu.className='chat-tabs-history';mount.after(this.savedMenu);
  }
  render(blocked: boolean): void {
    if (!this.mounted) return;
    const signature = JSON.stringify([this.presentationRevision,this.activeKey,blocked]);
    if (signature!==this.signature) {
      this.signature=signature;
      const mount = this.doc.getElementById('workspace-chat-tabs')!;
      const focusKey = (this.doc.activeElement as HTMLElement|null)?.dataset.chatKey;
      mount.replaceChildren();
      for (const [index,row] of this.rows.entries()) {
        const wrap=this.doc.createElement('span');wrap.setAttribute('role','presentation');wrap.className='chat-tab';
        const button=this.doc.createElement('button');button.type='button';button.setAttribute('role','tab');button.dataset.chatKey=row.key;
        button.textContent=this.safe(row.title==='Draft'?`Draft ${index+1}`:row.title==='Chat'?`Chat ${index+1}`:row.title);button.title=this.safe(row.kind==='draft'?'Unsent local draft':row.threadId!);
        button.setAttribute('aria-selected',String(row.key===this.activeKey));button.setAttribute('aria-controls','codex-messages');button.tabIndex=row.key===this.activeKey?0:-1;
        button.disabled=blocked&&row.key!==this.activeKey;button.addEventListener('click',()=>void this.callbacks.select(row.key));
        const close=this.doc.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','Close '+button.textContent);close.disabled=blocked&&row.key===this.activeKey;
        close.addEventListener('click',()=>void this.callbacks.close(row.key));wrap.append(button,close);mount.append(wrap);
      }
      if (focusKey) Array.from(mount.querySelectorAll<HTMLElement>('[role=tab]')).find(button=>button.dataset.chatKey===focusKey)?.focus({preventScroll:true});
      const create=this.doc.getElementById('workspace-new-chat') as HTMLButtonElement|null;
      if(create)create.disabled=blocked||this.rows.length>=CHAT_TAB_LIMITS.open;
    }
    const savedSignature=JSON.stringify([this.catalogueRevision,blocked]);
    if (this.savedMenu&&savedSignature!==this.savedSignature) {
      this.savedSignature=savedSignature;
      this.savedMenu.replaceChildren();const summary=this.doc.createElement('summary');summary.textContent='Saved chats';this.savedMenu.append(summary);
      for(const saved of this.catalogue) {
        const button=this.doc.createElement('button');button.type='button';button.textContent=this.safe(saved.threadId);button.disabled=blocked;
        button.addEventListener('click',()=>void this.callbacks.openSaved(saved.threadId));this.savedMenu.append(button);
      }
      if(!this.catalogue.length){const empty=this.doc.createElement('p');empty.textContent='No saved native chats.';this.savedMenu.append(empty);}
    }
  }
  stop(): void {this.persist();for(const fn of this.cleanup.splice(0))fn();this.savedMenu?.remove();this.savedMenu=null;this.mounted=false;this.signature='';this.savedSignature='';}
}

export interface WorkspacePreferencesBridge {
  readonly version:1; read():Promise<unknown>; save(value:ChatTabPreferences):Promise<unknown>;
}
export interface StartChatTabsOptions extends ChatTabsOptions {
  chat: Pick<CodexChat,'enableChatTabs'|'currentStateView'|'setChatProviderPreference'|'subscribeStateChange'>;
  nativeBridge?: unknown;
}
export interface ChatTabsController { stop():void;resume():void;cleanup():void }
function ownData(value:unknown,key:string):unknown {
  if(!value||typeof value!=='object')return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
}
/** Capture frozen own data methods without invoking getters, reads, saves or native tools. */
export function readWorkspacePreferencesBridge(doc:Document,options:{nativeBridge?:unknown}={}):WorkspacePreferencesBridge|null {
  try {
    const supplied=Object.getOwnPropertyDescriptor(options,'nativeBridge');
    const candidate=supplied?('value' in supplied?supplied.value:undefined):ownData(ownData(doc.defaultView,'arcaneDesktop'),'workspacePreferences');
    if(!exact(candidate,['version','read','save'])||!Object.isFrozen(candidate)||candidate.version!==1||typeof candidate.read!=='function'||typeof candidate.save!=='function')return null;
    const read=candidate.read as WorkspacePreferencesBridge['read'],save=candidate.save as WorkspacePreferencesBridge['save'];
    return Object.freeze({version:1,read:()=>Reflect.apply(read,candidate,[]),save:(value:ChatTabPreferences)=>Reflect.apply(save,candidate,[value])});
  }catch{return null;}
}
export const CHAT_PREFERENCES_RESTORED_EVENT='workspace:preferencesrestored';
export function workspacePreferencesAdapter(doc:Document,options:{nativeBridge?:unknown}={}):ChatTabsOptions['preferences'] {
  const native=readWorkspacePreferencesBridge(doc,options);
  return native?{read:async()=>{
    const result=await native.read();
    if(!exact(result,['available','preferences'])||typeof result.available!=='boolean'||!result.available&&result.preferences!==null)throw new Error('Invalid native chat preference read acknowledgement.');
    if(!result.available)throw new Error('Native encrypted chat preferences are unavailable.');
    return result.preferences;
  },save:async(value:ChatTabPreferences)=>{
    const acknowledgement=await native.save(value);
    if(!exact(acknowledgement,['saved'])||acknowledgement.saved!==true)throw new Error('Native chat preference save was not acknowledged.');
  }}:undefined;
}
const preferenceControllers=new WeakMap<Document,{chat:StartChatTabsOptions['chat'];controller:ChatTabsController}>();
/** Provider restore is presentation only, never authentication. One listener owner per chat. */
export function connectChatTabPreferences(doc:Document,chat:StartChatTabsOptions['chat']):ChatTabsController {
  const existing=preferenceControllers.get(doc);if(existing?.chat===chat)return existing.controller;existing?.controller.cleanup();
  let stopped=false,disposed=false,restoring=false,handling=false,signature='';let unsubscribe:(()=>void)|null=null;
  let restoreTimer:ReturnType<typeof setTimeout>|null=null;
  const cancelRestore=()=>{if(restoreTimer!==null){clearTimeout(restoreTimer);restoreTimer=null;}};
  const restore=()=>{
    if(stopped||disposed||handling)return;
    const view=chat.currentStateView();if(!view.fresh||view.persistence==='native-loading'||view.persistence==='native-error')return;
    const next=JSON.stringify([view.state?.projectPath,view.preferredProvider]);if(next===signature)return;signature=next;
    const EventType=doc.defaultView?.CustomEvent;if(!EventType)return;
    restoring=true;
    try{for(const name of ['workspace:providerpreference',CHAT_PREFERENCES_RESTORED_EVENT])doc.dispatchEvent(new EventType(name,{detail:{provider:view.preferredProvider}}));}finally{restoring=false;}
  };
  // State notifications include every composer edit. Read the large public snapshot
  // at most once per window; explicit choice and lifecycle mount remain immediate.
  const scheduleRestore=()=>{
    if(stopped||disposed||handling||restoreTimer!==null)return;
    restoreTimer=setTimeout(()=>{restoreTimer=null;try{restore();}catch{}},100);
  };
  const choose=(event:Event)=>{
    if(stopped||disposed||restoring)return;
    const detail=(event as CustomEvent).detail;
    if(!exact(detail,['provider'])||detail.provider!=='codex'&&detail.provider!=='claude')return;
    cancelRestore();
    handling=true;try{chat.setChatProviderPreference(detail.provider);const view=chat.currentStateView();signature=JSON.stringify([view.state?.projectPath,view.preferredProvider]);}finally{handling=false;}
  };
  const mount=()=>{doc.addEventListener('workspace:providerpreference',choose);unsubscribe=chat.subscribeStateChange(scheduleRestore);restore();};
  const stop=()=>{if(stopped)return;stopped=true;cancelRestore();doc.removeEventListener('workspace:providerpreference',choose);unsubscribe?.();unsubscribe=null;};
  const controller:ChatTabsController={stop,resume(){if(disposed||!stopped)return;stopped=false;mount();},cleanup(){stop();disposed=true;if(preferenceControllers.get(doc)?.controller===controller)preferenceControllers.delete(doc);}};
  preferenceControllers.set(doc,{chat,controller});mount();return controller;
}
/** Parent boot/controller seam; enable also autodetects the native bridge when called directly. */
export async function startChatTabs(doc:Document,options:StartChatTabsOptions):Promise<ChatTabsController> {
  const preferences=options.preferences??workspacePreferencesAdapter(doc,options),chat=options.chat;
  await chat.enableChatTabs({...(preferences?{preferences}:{}),...(options.storage?{storage:options.storage}:{}),...(options.captureLegacyNewChat!==undefined?{captureLegacyNewChat:options.captureLegacyNewChat}:{})});
  return connectChatTabPreferences(doc,chat);
}
