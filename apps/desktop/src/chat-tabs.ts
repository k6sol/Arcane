/// <reference lib="dom" />
import type { ChatState, CodexChat } from './codex-chat.js';
import { prependProviderLogo } from './codex-chat.js';
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
  /** Presentation-only navigation hook; never starts or grants native work. */
  beforeNewChat?: () => void;
  /** Runs only after the requested local draft exists, before its first publication. */
  afterNewChat?: (source: {projectPath:string;localId:string}) => void;
  /** Presentation-only notice hook: a native preference save failed or recovered. */
  onPersistenceChange?: () => void;
  /** Presentation-only routing: while another chat surface is active, New chat starts there instead of a Codex draft. */
  alternateNewChat?: { active(): boolean; start(): void };
}
export interface ChatTabPreferences {
  version: 1; projectPath: string; provider: 'codex'|'claude'; activeTabId: string | null;
  /** workflowDraft is optional on read: legacy rows omit it and are plain drafts. It is always written. */
  tabs: {localId:string;title:string;provider:'codex';threadId:string|null;sessionId:string|null;draft:string;modelId:string|null;effort:string|null;tool:'all'|'blender'|'roblox';previewOpen:boolean;workflowDraft?:boolean}[];
}
export interface ChatTabsCallbacks {
  select(key: string): Promise<boolean>; close(key: string): Promise<boolean>;
  newChat(): Promise<boolean>; openSaved(threadId: string): Promise<boolean>;
  /** Optional: the tab also holds unsent content its row has not stored yet (live composer text or attachments). */
  unsent?(key: string): boolean;
}
/** Closing an unsent draft: an empty one closes at once, one with text asks Discard/Keep first. Chats with sent turns keep their own close. */
export function draftCloseStep(tab: Pick<ChatTabView,'kind'|'draft'>, unsent = false): 'native'|'close'|'confirm' {
  return tab.kind!=='draft' ? 'native' : unsent || tab.draft.trim().length>0 ? 'confirm' : 'close';
}
/** The tab that takes over when one closes: its left neighbour, else its right one; null when it was the last tab. */
export function closeNeighbour(keys: readonly string[], key: string): string | null {
  const index = keys.indexOf(key); return index<0 ? null : keys[index-1] ?? keys[index+1] ?? null;
}
/** Arcane inline confirmation for closing a draft that holds text: Discard (red) and Keep. Presentation only; text via textContent. */
export function draftCloseConfirm(doc: Document, key: string, label: string, actions: { discard(): void; keep(): void }): HTMLElement {
  const group = doc.createElement('span'); group.className = 'chat-tab-confirm'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Discard draft? ' + label);
  const question = doc.createElement('span'); question.className = 'chat-tab-confirm-text'; question.textContent = 'Discard draft?';
  const make = (text: string, action: 'discard'|'keep', run: () => void) => {
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'chat-tab-' + action; button.textContent = text;
    button.dataset.confirmChat = key; button.dataset.confirmAction = action; button.addEventListener('click', run); return button;
  };
  group.append(question, make('Discard', 'discard', () => actions.discard()), make('Keep', 'keep', () => actions.keep()));
  return group;
}
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const localIdentifier = (value: unknown): value is string => id(value)&&value.length<=128;
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
const NATIVE_ROW = ['localId','title','provider','threadId','sessionId','draft','modelId','effort','tool','previewOpen'];
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
  private readonly unconfirmedOpenings = new Set<string>();
  private readonly preferredSelections = new Set<string>();
  private readonly observedSelections = new Set<string>();
  private readonly preferences = new Map<string,string>();
  private readonly cleanup: (()=>void)[] = [];
  private storage: Pick<Storage,'getItem'|'setItem'> | undefined;
  private signature = '';
  private savedSignature = '';
  private persistenceDirty = false;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private mounted = false;
  private newChatAllowed = false;
  private savedMenu: HTMLDetailsElement | null = null;
  /** The draft whose inline Discard/Keep question is showing, and the last render's block state for re-rendering it. */
  private confirmingKey: string | null = null;
  private lastBlocked = false;
  /** The last render's draft gate: drafts are local, so a host may hold them by less than it holds saved chats. */
  private lastDraftBlocked = false;
  private nativeReady = false;
  private nativeError = false;
  /** A save failed; its snapshot stays queued and is retried at the next persist boundary. */
  private nativeSaveFailed = false;
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
    return this.options.preferences ? this.nativeError||this.nativeSaveFailed?'native-error':this.nativeReady?'native':'native-loading' : this.storage?'browser-origin':'memory';
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
    this.nativeQueued=null;this.nativeSaveFailed=false;
    this.nativeReady=false;this.nativeError=false;
    try {
      const value=await this.options.preferences.read();
      if(generation!==this.nativeGeneration)return;
      if(value!==null) {
        if(!exact(value,['version','projectPath','provider','activeTabId','tabs'])||value.version!==1||!['codex','claude'].includes(String(value.provider))||value.projectPath!==projectPath||!(value.activeTabId===null||localIdentifier(value.activeTabId))||!Array.isArray(value.tabs)||value.tabs.length>CHAT_TAB_LIMITS.open||bytes(JSON.stringify(value))>CHAT_TAB_LIMITS.preferencesBytes||this.clean(JSON.stringify(value))!==JSON.stringify(value))throw new Error('Invalid native chat preferences.');
        this.preferredProvider=value.provider as 'codex'|'claude';
        const ids=new Set<string>(), rows:Tab[]=[];
        for(const row of value.tabs) {
          const flagged=plain(row)&&Object.hasOwn(row,'workflowDraft');
          if(!exact(row,[...NATIVE_ROW,...(flagged?['workflowDraft']:[])])||flagged&&typeof row.workflowDraft!=='boolean'||!localIdentifier(row.localId)||ids.has(row.localId)||row.provider!=='codex'||typeof row.title!=='string'||row.title.length>512||!tool(row.tool)||typeof row.previewOpen!=='boolean'||typeof row.draft!=='string'||bytes(row.draft)>CHAT_TAB_LIMITS.draftBytes||!(row.threadId===null||id(row.threadId))||!(row.sessionId===null||id(row.sessionId))||row.threadId===null&&row.sessionId!==null||!(row.modelId===null&&row.effort===null||pair({model:row.modelId,effort:row.effort})))throw new Error('Invalid native chat preference row.');
          ids.add(row.localId);
          const selection=row.modelId===null?null:{model:row.modelId as string,effort:row.effort as string};
          const binding={projectPath,threadId:row.threadId as string,sessionId:row.sessionId as string|null};
          // Only a row stored as a workflow draft keeps its review gate; legacy rows without the flag are plain typed text.
          rows.push({key:row.threadId===null?'draft:'+row.localId:nativeChatKey(binding),localId:row.localId,title:row.title,tool:row.tool,previewOpen:row.previewOpen,kind:row.threadId===null?'draft':'native',provider:'codex',projectPath,threadId:row.threadId as string|null,sessionId:row.sessionId as string|null,selection,draft:row.draft,workflowDraft:row.workflowDraft===true});
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
    // This predicate runs while typing; keep the full draft out of cloning work.
    const active = this.rows.find(row=>row.key===this.activeKey), thread = state?.snapshot?.thread;
    return !!active && !this.unconfirmedOpenings.has(active.key) && this.owns(active) && state?.projectPath===active.projectPath && !!thread?.configured && thread.threadId===active.threadId && thread.sessionId===active.sessionId;
  }
  needsOpening(key:string):boolean {return this.unconfirmedOpenings.has(key);}
  beginOpening(key:string):boolean {
    const tab=this.rows.find(row=>row.key===key);if(!tab||!this.owns(tab))return false;
    this.unconfirmedOpenings.add(key);return this.activate(key);
  }
  confirmOpening(key:string,state:ChatState|null):boolean {
    if(this.activeKey!==key)return false;
    const wasPending=this.unconfirmedOpenings.delete(key);
    if(this.bound(state))return true;
    if(wasPending)this.unconfirmedOpenings.add(key);return false;
  }
  recording(tab = this.active()): HistoryBinding | null { return tab && this.owns(tab) ? structuredClone(this.recordings.get(tab.key) ?? null) : null; }
  /** Display-only, from the host's existing project-scoped SQLite recording. Never binds a native connection. */
  cacheRecording(value:unknown):boolean {
    if(!this.projectPath)return false;
    const binding=validateHistoryBinding(value,this.projectPath);
    if(!binding)return false;
    const key=nativeChatKey(binding);
    if(!this.catalogueByKey.has(key)||!this.rows.some(row=>row.kind==='native'&&row.key===key))return false;
    const previous=this.recordings.get(key)?.recorded;
    if(previous&&(!binding.recorded||Date.parse(previous.loadedAt)>=Date.parse(binding.recorded.loadedAt)))return false;
    this.recordings.set(key,binding);return true;
  }
  sync(state: ChatState, followNative = false): boolean {
    const before = this.activeKey;
    const presentationBefore=this.presentationRevision;
    let selectionChanged=false;
    if (this.projectPath !== state.projectPath) {
      this.persist(); this.projectPath = state.projectPath; this.rows = []; this.activeKey = null; this.recordings.clear();
      this.preferredSelections.clear();this.observedSelections.clear();
      this.presentationRevision++;this.persistenceDirty=true;
      if(this.options.preferences&&this.nativeProject!==state.projectPath){this.nativeReady=false;this.nativeQueued=null;this.nativeSaveFailed=false;this.nativeGeneration++;}
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
      const recovered:Tab={...row,key:'draft:'+row.localId,kind:'draft',threadId:null,sessionId:null,title:'Recovered draft',workflowDraft:row.workflowDraft===true};
      this.presentationRevision++;this.persistenceDirty=true;
      if(this.activeKey===row.key)this.activeKey=recovered.key;this.rows[index]=recovered;
    }
    for (const row of this.rows) if (row.kind==='native') {
      const selection=this.catalogueByKey.get(row.key)!.selection;
      // Saved model/effort fields are per-chat preferences, never native proof.
      // Retain a restored/staged choice until its actual native ACK agrees.
      if(!this.observedSelections.has(row.key)&&row.selection&&!sameSelection(row.selection,selection))this.preferredSelections.add(row.key);
      this.observedSelections.add(row.key);
      if(this.preferredSelections.has(row.key)){
        if(sameSelection(row.selection,selection))this.preferredSelections.delete(row.key);
        else continue;
      }
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
    // This tab was created from an observed native selection, not restored prefs.
    this.observedSelections.add(key);
    this.rows.push(tab);this.presentationRevision++;this.persistenceDirty=true; return tab;
  }
  needsNativePreferences(projectPath:string):boolean {return !!this.options.preferences&&(!this.nativeReady||this.nativeProject!==projectPath)&&!this.nativeError;}
  reloadPreferences(state:ChatState):void {
    if(this.nativeProject!==state.projectPath)return;
    this.rows=[];this.activeKey=null;this.preferredSelections.clear();this.observedSelections.clear();this.presentationRevision++;this.persistenceDirty=true;this.restore(state.projectPath);this.sync(state);
  }
  createDraft(): ChatTabView | null {
    if (!this.projectPath || this.rows.length >= CHAT_TAB_LIMITS.open) return null;
    const localId=crypto.randomUUID();
    // Reuse the current chat's choice; native catalogue validation still owns admission.
    const selection=this.active()?.selection??this.rows.findLast(row=>row.selection!==null)?.selection??null;
    const tab: Tab = {key:'draft:'+localId,localId,title:'Draft',tool:'all',previewOpen:false,kind:'draft',provider:'codex',projectPath:this.projectPath,threadId:null,sessionId:null,selection:structuredClone(selection),draft:'',workflowDraft:false};
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
    this.observedSelections.add(replacement.key);this.preferredSelections.delete(replacement.key);
    this.activeKey = replacement.key;this.presentationRevision++;this.persistenceDirty=true; this.persist(); return true;
  }
  updateDraft(value: string, selection?: ChatSelection | null, workflowDraft?: boolean): void {
    const active = this.rows.find(row=>row.key===this.activeKey); if (!active) return;
    if(active.draft===value&&(selection===undefined||sameSelection(active.selection,selection))&&(workflowDraft===undefined||active.workflowDraft===workflowDraft))return;
    if(bytes(value)>CHAT_TAB_LIMITS.draftBytes)return;
    const selectionChanged=selection!==undefined&&!sameSelection(active.selection,selection);
    active.draft = value;
    if (selection!==undefined) {
      active.selection=structuredClone(selection);
      if(active.kind==='native'){
        if(sameSelection(selection,this.catalogueByKey.get(active.key)?.selection??null))this.preferredSelections.delete(active.key);
        else this.preferredSelections.add(active.key);
      }
    }
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
  hasPreferredSelection():boolean {return !!this.activeKey&&this.preferredSelections.has(this.activeKey);}
  remove(key: string): boolean {
    if (key===this.activeKey || !this.rows.some(row=>row.key===key)) return false;
    this.rows = this.rows.filter(row=>row.key!==key);this.presentationRevision++;this.persistenceDirty=true; this.persist(); return true;
  }
  /**
   * Removes an unsent local draft and its stored text. It never touches a native thread: an active draft hands over to its
   * left (else right) neighbour without resuming it (a saved chat resumes only on its own explicit gesture), and closing
   * the last tab leaves a fresh empty draft that keeps the closed draft's model choice.
   */
  closeDraft(key: string): boolean {
    const index=this.rows.findIndex(row=>row.key===key),row=this.rows[index];
    if(!row||row.kind!=='draft')return false;
    const neighbour=closeNeighbour(this.rows.map(row=>row.key),key);
    this.rows.splice(index,1);if(this.confirmingKey===key)this.confirmingKey=null;
    if(this.activeKey===key) {
      const next=[this.rows.find(row=>row.key===neighbour),...this.rows].find(row=>row!==undefined&&(row.kind==='draft'||this.owns(row)));
      if(next)this.activeKey=next.key;
      else {
        const localId=crypto.randomUUID(),fresh:Tab={key:'draft:'+localId,localId,title:'Draft',tool:'all',previewOpen:false,kind:'draft',provider:'codex',projectPath:row.projectPath,threadId:null,sessionId:null,selection:structuredClone(row.selection),draft:'',workflowDraft:false};
        this.rows.push(fresh);this.activeKey=fresh.key;
      }
    }
    this.presentationRevision++;this.persistenceDirty=true;this.persist();return true;
  }
  flushPreferences():void {
    if(this.nativeReady&&!this.nativeError&&this.nativeProject===this.projectPath)this.persistenceDirty=true;
    this.persist();
  }
  private persist() {
    if(this.draftTimer!==null){clearTimeout(this.draftTimer);this.draftTimer=null;}
    if(!this.persistenceDirty){if(this.nativeSaveFailed&&this.nativeQueued)void this.saveNative();return;}
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
        tabs:tabs.map(row=>({localId:row.localId,title:row.title,provider:'codex',threadId:row.threadId,sessionId:row.sessionId,draft:row.draft,modelId:row.selection?.model??null,effort:row.selection?.effort??null,tool:row.tool,previewOpen:row.previewOpen,workflowDraft:row.workflowDraft===true}))};
      const serialized=JSON.stringify(native);
      this.preferencesDirty=serialized!==this.nativeSaved;
      if(serialized!==this.nativeLast||this.nativeSaveFailed){this.nativeLast=serialized;this.nativeQueued={value:native,serialized,generation:this.nativeGeneration};void this.saveNative();}
    }
  }
  private async saveNative(): Promise<void> {
    if(this.nativeSaving)return;this.nativeSaving=true;
    try {while(this.nativeQueued){
      const queued=this.nativeQueued;this.nativeQueued=null;
      if(queued.generation!==this.nativeGeneration||!this.nativeReady||queued.value.projectPath!==this.nativeProject||queued.value.projectPath!==this.projectPath)continue;
      try {
        await this.options.preferences!.save(queued.value);
        if(queued.generation===this.nativeGeneration&&this.nativeReady&&queued.value.projectPath===this.nativeProject&&queued.value.projectPath===this.projectPath){this.nativeSaved=queued.serialized;this.preferencesDirty=this.persistenceDirty||this.nativeSaved!==this.nativeLast;
          if(this.nativeSaveFailed&&this.nativeQueued===null){this.nativeSaveFailed=false;this.notifyPersistence();}}
      } catch {if(queued.generation===this.nativeGeneration&&this.nativeReady&&queued.value.projectPath===this.nativeProject&&queued.value.projectPath===this.projectPath){
        // Keep the unsaved snapshot (or a newer one) queued; the next persist boundary retries it. Never retry in a loop.
        const first=!this.nativeSaveFailed;this.nativeSaveFailed=true;this.preferencesDirty=true;
        if(first)this.notifyPersistence();
        if(this.nativeQueued===null){this.nativeQueued=queued;break;}
      }}
    }}
    finally {this.nativeSaving=false;}
  }
  private notifyPersistence():void {try{this.options.onPersistenceChange?.();}catch{}
  }
  private restore(projectPath: string) {
    try {
      const raw = this.preferences.get(projectPath) ?? this.storage?.getItem(this.storageKey(projectPath));
      if (!raw || bytes(raw)>CHAT_TAB_LIMITS.preferencesBytes || this.clean(raw)!==raw) return;
      const value:unknown = JSON.parse(raw);
      if (!exact(value,['version','projectPath','provider','activeKey','tabs']) || value.version!==1 || !['codex','claude'].includes(String(value.provider)) || value.projectPath!==projectPath || !(value.activeKey===null||typeof value.activeKey==='string') || !Array.isArray(value.tabs) || value.tabs.length>CHAT_TAB_LIMITS.open) return;
      const seen = new Set<string>(),localIds=new Set<string>(), rows:Tab[]=[];
      for (const row of value.tabs) {
        if (!exact(row,['key','localId','title','tool','previewOpen','kind','provider','projectPath','threadId','sessionId','selection','draft','workflowDraft']) || !localIdentifier(row.localId)||localIds.has(row.localId)||typeof row.title!=='string'||row.title.length>512||!tool(row.tool)||typeof row.previewOpen!=='boolean'||row.projectPath!==projectPath || row.provider!=='codex' || typeof row.key!=='string' || seen.has(row.key) || typeof row.draft!=='string' || bytes(row.draft)>CHAT_TAB_LIMITS.draftBytes || typeof row.workflowDraft!=='boolean' || !(row.selection===null||pair(row.selection))) return;
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
    const listen = (el:HTMLElement,event:string,fn:(event:Event)=>void,capture=false)=>{el.addEventListener(event,fn,{capture});this.cleanup.push(()=>el.removeEventListener(event,fn,{capture}));};
    for (const name of ['workspace-new-chat',...(this.options.captureLegacyNewChat?['new-chat']:[])]) {
      const button = this.doc.getElementById(name); if (!button) continue;
      button.setAttribute('aria-label','New chat'); button.setAttribute('title','New chat');
      listen(button,'click',event=>{if(event.defaultPrevented)return;event.preventDefault();if(name==='new-chat')event.stopImmediatePropagation();this.requestNewChat();},name==='new-chat');
    }
    if (this.options.captureLegacyNewChat) {
      const shortcut = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey
          || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'n') return;
        event.preventDefault();
        this.requestNewChat();
      };
      this.doc.addEventListener('keydown', shortcut, {capture:true});
      this.cleanup.push(() => this.doc.removeEventListener('keydown', shortcut, {capture:true}));
    }
    listen(mount,'keydown',event=>{
      const input=event as KeyboardEvent, key=(input.target as HTMLElement)?.dataset?.chatKey;
      const confirming=(input.target as HTMLElement)?.dataset?.confirmChat;
      if (confirming && input.key==='Escape' && !input.altKey && !input.ctrlKey && !input.metaKey && !input.shiftKey) {event.preventDefault();this.keepDraft(confirming);return;}
      if (!key || input.altKey || input.ctrlKey || input.metaKey || input.shiftKey) return;
      const index = this.rows.findIndex(row=>row.key===key);
      if (index<0) return;
      if (input.key==='Delete') {event.preventDefault();this.requestClose(key);return;}
      const next = input.key==='Home'?0:input.key==='End'?this.rows.length-1:input.key==='ArrowRight'?(index+1)%this.rows.length:input.key==='ArrowLeft'?(index+this.rows.length-1)%this.rows.length:-1;
      if(next<0)return;event.preventDefault();const target=this.rows[next]!.key;
      void this.callbacks.select(target).then(ok=>{if(ok)Array.from(mount.querySelectorAll<HTMLElement>('[role=tab]')).find(button=>button.dataset.chatKey===target)?.focus();});
    });
    // The id lets provider setup hide Codex's saved list while another provider's chat owns the surface.
    this.savedMenu=this.doc.createElement('details');this.savedMenu.className='chat-tabs-history';this.savedMenu.id='workspace-saved-chats';
    if(mount.hidden===true)this.savedMenu.hidden=true;mount.after(this.savedMenu);
  }
  /**
   * `blocked` holds switching to saved chats (a native resume); `draftBlocked` (default: the same) holds New chat and
   * switching to a draft, which perform no native action. Closing a draft is never held here.
   */
  render(blocked: boolean, draftBlocked: boolean = blocked): void {
    if (!this.mounted) return;
    this.lastBlocked = blocked;this.lastDraftBlocked = draftBlocked;
    if (this.confirmingKey && !this.rows.some(row=>row.key===this.confirmingKey&&row.kind==='draft')) this.confirmingKey = null;
    this.newChatAllowed = !draftBlocked && this.rows.length < CHAT_TAB_LIMITS.open;
    const alternate = this.alternateNewChat();
    const selectBlocked = (row:Tab) => (row.kind==='draft'?draftBlocked:blocked) && row.key!==this.activeKey;
    const signature = JSON.stringify([this.presentationRevision,this.activeKey,blocked,draftBlocked,alternate,this.confirmingKey]);
    if (signature!==this.signature) {
      this.signature=signature;
      const mount = this.doc.getElementById('workspace-chat-tabs')!;
      const focused = this.doc.activeElement as HTMLElement|null, focusData = focused?.dataset ?? ({} as DOMStringMap), focusKey = focusData.chatKey;
      const focusInStrip = !!focused && typeof mount.contains==='function' && mount.contains(focused);
      mount.replaceChildren();
      for (const [index,row] of this.rows.entries()) {
        const wrap=this.doc.createElement('span');wrap.setAttribute('role','presentation');wrap.className='chat-tab';
        const button=this.doc.createElement('button');button.type='button';button.setAttribute('role','tab');button.dataset.chatKey=row.key;
        button.textContent=this.rowLabel(row,index);
        prependProviderLogo(this.doc,button,'codex'); // Codex tabs belong to ChatGPT.
        button.title=this.safe(row.kind==='draft'?'Unsent local draft':row.threadId!);
        button.setAttribute('aria-selected',String(row.key===this.activeKey));button.setAttribute('aria-controls','codex-messages');button.tabIndex=row.key===this.activeKey?0:-1;
        button.disabled=selectBlocked(row);button.addEventListener('click',()=>void this.callbacks.select(row.key));
        // An unsent draft is local text, so its close is never held by native work; a chat with sent turns keeps its rule.
        const closeDisabled=this.closeDisabled(row,blocked);
        if (row.key===this.confirmingKey) {
          wrap.dataset.confirming='true';
          wrap.append(button,draftCloseConfirm(this.doc,row.key,button.textContent??'',{discard:()=>void this.discardDraft(row.key,'strip'),keep:()=>this.keepDraft(row.key,'strip')}));
        } else {
          const close=this.doc.createElement('button');close.type='button';close.className='chat-tab-close';close.textContent='×';close.dataset.closeChat=row.key;
          close.setAttribute('aria-label','Close '+button.textContent);close.title='Close '+button.textContent;close.disabled=closeDisabled;
          close.addEventListener('click',()=>this.requestClose(row.key,'strip'));wrap.append(button,close);
        }
        // Middle-click closes a tab, as in browsers; the press itself must not start autoscroll.
        wrap.addEventListener('mousedown',event=>{if((event as MouseEvent).button===1)event.preventDefault();});
        wrap.addEventListener('auxclick',event=>{if((event as MouseEvent).button!==1)return;event.preventDefault();if(!closeDisabled&&row.key!==this.confirmingKey)this.requestClose(row.key);});
        mount.append(wrap);
      }
      if (focusKey) Array.from(mount.querySelectorAll<HTMLElement>('[role=tab]')).find(button=>button.dataset.chatKey===focusKey)?.focus({preventScroll:true});
      else if (focusInStrip && (focusData.closeChat||focusData.confirmChat)) this.focusStrip(node=>focusData.closeChat?node.dataset.closeChat===focusData.closeChat:node.dataset.confirmChat===focusData.confirmChat&&node.dataset.confirmAction===focusData.confirmAction);
      for (const id of ['workspace-new-chat', ...(this.options.captureLegacyNewChat ? ['new-chat'] : [])]) {
        const create=this.doc.getElementById(id) as HTMLButtonElement|null;
        if(create)create.disabled=!this.newChatAllowed&&!alternate;
      }
    }
    const savedSignature=JSON.stringify([this.catalogueRevision,blocked,draftBlocked,this.presentationRevision,this.activeKey,alternate,this.confirmingKey]);
    if (this.savedMenu&&savedSignature!==this.savedSignature) {
      this.savedSignature=savedSignature;const menu=this.savedMenu,focus=chatSwitchFocus(this.doc,menu);
      const active=this.rows.findIndex(row=>row.key===this.activeKey);
      menu.replaceChildren(chatSwitchSummary(this.doc,active<0?'Saved chats':this.rowLabel(this.rows[active]!,active),'codex'));
      // Narrow widths hide the tab strip; this sheet then lists the open chats and New chat above Saved chats.
      menu.append(chatSwitchOpenSection(this.doc,menu,this.rows.map((row,index)=>({key:row.key,label:this.rowLabel(row,index),current:row.key===this.activeKey,
        selectDisabled:selectBlocked(row),closeDisabled:this.closeDisabled(row,blocked),confirm:row.key===this.confirmingKey})),{
        select:key=>void this.callbacks.select(key),close:key=>this.requestClose(key,'switcher'),newChat:()=>this.requestNewChat(),newDisabled:!this.newChatAllowed&&!alternate,
        discard:key=>void this.discardDraft(key,'switcher'),keep:key=>this.keepDraft(key,'switcher')}));
      for(const saved of this.catalogue) {
        const button=this.doc.createElement('button');button.type='button';button.textContent=this.safe(saved.threadId);button.disabled=blocked;
        button.addEventListener('click',()=>void this.callbacks.openSaved(saved.threadId));this.savedMenu.append(button);
      }
      if(!this.catalogue.length){const empty=this.doc.createElement('p');empty.textContent='No saved native chats.';this.savedMenu.append(empty);}
      restoreChatSwitchFocus(menu,focus);
    }
  }
  private rowLabel(row:Tab,index:number):string{return this.safe(row.title==='Draft'?`Draft ${index+1}`:row.title==='Chat'?`Chat ${index+1}`:row.title);}
  private closeDisabled(row:Tab,blocked:boolean):boolean{return row.kind!=='draft'&&blocked&&row.key===this.activeKey;}
  /** Focus a control where the gesture came from (tab strip or open chat switcher), else in the other one when it is shown. */
  private focusStrip(match:(node:HTMLElement)=>boolean,from:'strip'|'switcher'='strip'):boolean {
    const strip=this.doc.getElementById('workspace-chat-tabs'),menu=this.savedMenu?.open?this.savedMenu:null;
    for (const root of from==='switcher'?[menu,strip]:[strip,menu]) {
      let nodes:HTMLElement[]=[];try{nodes=Array.from(root?.querySelectorAll<HTMLElement>('button')??[]);}catch{/* Focus is presentation only. */}
      const target=nodes.find(node=>match(node)&&!(node as HTMLButtonElement).disabled&&!(typeof node.getClientRects==='function'&&node.getClientRects().length===0));
      if(target){try{target.focus({preventScroll:true});return true;}catch{/* Focus is presentation only. */}}
    }
    return false;
  }
  /**
   * Every close gesture lands here (×, middle-click, Delete, and Ctrl+W through the selected tab's ×). A chat with sent
   * turns keeps its existing close. An empty draft closes at once; a draft with text first asks Discard draft? inline.
   */
  requestClose(key: string, from: 'strip'|'switcher' = 'strip'): void {
    const row=this.rows.find(row=>row.key===key);if(!row||!this.mounted)return;
    let unsent=false;try{unsent=this.callbacks.unsent?.(key)===true;}catch{unsent=true;}
    const step=draftCloseStep(row,unsent);
    if(step==='native'){void this.callbacks.close(key);return;}
    if(step==='close'){void this.discardDraft(key,from);return;}
    this.confirmingKey=key;this.render(this.lastBlocked,this.lastDraftBlocked);
    this.focusStrip(node=>node.dataset.confirmChat===key&&node.dataset.confirmAction==='keep',from);
  }
  /** Keep answers the question: the draft and its text stay, and focus returns to its close button. */
  keepDraft(key: string, from: 'strip'|'switcher' = 'strip'): void {
    if(this.confirmingKey!==key)return;
    this.confirmingKey=null;this.render(this.lastBlocked,this.lastDraftBlocked);
    if(!this.focusStrip(node=>node.dataset.closeChat===key,from))this.focusStrip(node=>node.dataset.chatKey===key||node.dataset.openChat===key,from);
  }
  /** Discard (or closing an empty draft) deletes the draft and its stored text; focus moves to the neighbouring chat. */
  private async discardDraft(key: string, from: 'strip'|'switcher'): Promise<void> {
    const row=this.rows.find(row=>row.key===key);if(!row||row.kind!=='draft')return;
    const neighbour=closeNeighbour(this.rows.map(row=>row.key),key);
    if(this.confirmingKey===key)this.confirmingKey=null;
    const closed=await this.callbacks.close(key);
    if(!this.mounted)return;
    this.render(this.lastBlocked,this.lastDraftBlocked);
    if(!closed){if(!this.focusStrip(node=>node.dataset.closeChat===key,from))this.focusStrip(node=>node.dataset.chatKey===key||node.dataset.openChat===key,from);return;}
    const next=this.rows.some(row=>row.key===neighbour)?neighbour:this.activeKey;
    if(next)this.focusStrip(node=>node.dataset.chatKey===next||node.dataset.openChat===next,from);
  }
  private alternateNewChat(): boolean { try { return this.options.alternateNewChat?.active()===true; } catch { return false; } }
  private requestNewChat(): void {
    if (!this.mounted) return;
    // The Claude surface owns New chat while it is shown; Codex busy/limit gates only apply to Codex drafts.
    const alternate = this.alternateNewChat();
    if (!alternate && !this.newChatAllowed) return;
    this.options.beforeNewChat?.();
    if (alternate) { try { this.options.alternateNewChat!.start(); } catch {} return; }
    void this.callbacks.newChat();
  }
  stop(): void {this.newChatAllowed=false;this.persist();for(const fn of this.cleanup.splice(0))fn();this.savedMenu?.remove();this.savedMenu=null;this.mounted=false;this.signature='';this.savedSignature='';}
}

/** One open chat in the narrow chat switcher (both providers). Presentation only. */
export interface ChatSwitchRow { key:string; label:string; current:boolean; selectDisabled:boolean; closeDisabled:boolean; /** Show the inline Discard draft? question in place of × */ confirm?:boolean }
export interface ChatSwitchActions { select(key:string):void; close(key:string):void; newChat():void; newDisabled:boolean; discard?(key:string):void; keep?(key:string):void }
/** Saved chats summary. Wide layouts show "Saved chats"; on narrow layouts studio.css shows the current chat instead, so the
 * summary becomes the chat switcher and the accessible name still starts with the visible title. */
export function chatSwitchSummary(doc:Document,current:string,provider:'codex'|'claude'|'arcane'):HTMLElement {
  const summary=doc.createElement('summary');
  const name=doc.createElement('span');name.className='chat-switch-current';name.textContent=current;prependProviderLogo(doc,name,provider);
  const label=doc.createElement('span');label.className='chat-switch-label';label.textContent='Saved chats';
  summary.append(name,label);return summary;
}
/** Open chats and New chat, listed in the Saved chats sheet; studio.css shows this group only on narrow layouts, where the tab strip is hidden. */
export function chatSwitchOpenSection(doc:Document,menu:HTMLDetailsElement,rows:readonly ChatSwitchRow[],actions:ChatSwitchActions):HTMLElement {
  const section=doc.createElement('div');section.className='chat-switch-open';section.setAttribute('role','group');section.setAttribute('aria-label','Open chats');
  const heading=doc.createElement('p');heading.className='chat-switch-heading';heading.textContent='Open chats';heading.setAttribute('aria-hidden','true');section.append(heading);
  for(const row of rows){
    const line=doc.createElement('div');line.className='chat-switch-row';
    const open=doc.createElement('button');open.type='button';open.className='chat-switch-select';open.textContent=row.label;open.dataset.openChat=row.key;
    open.setAttribute('aria-current',String(row.current));open.disabled=row.selectDisabled;
    open.addEventListener('click',()=>{menu.open=false;if(!row.current)actions.select(row.key);});
    const discard=actions.discard,keep=actions.keep;
    if(row.confirm&&discard&&keep){
      const confirm=draftCloseConfirm(doc,row.key,row.label,{discard:()=>discard(row.key),keep:()=>keep(row.key)});
      confirm.addEventListener('keydown',event=>{const key=event as KeyboardEvent;if(key.key==='Escape'&&!key.altKey&&!key.ctrlKey&&!key.metaKey&&!key.shiftKey){event.preventDefault();event.stopPropagation();keep(row.key);}});
      line.append(open,confirm);section.append(line);continue;
    }
    const close=doc.createElement('button');close.type='button';close.className='chat-switch-close';close.textContent='×';close.dataset.closeChat=row.key;
    close.setAttribute('aria-label','Close '+row.label);close.title='Close '+row.label;close.disabled=row.closeDisabled;
    close.addEventListener('click',()=>actions.close(row.key));
    line.append(open,close);section.append(line);
  }
  const create=doc.createElement('button');create.type='button';create.className='chat-switch-new';create.textContent='New chat';create.disabled=actions.newDisabled;
  create.addEventListener('click',()=>{menu.open=false;actions.newChat();});
  const saved=doc.createElement('p');saved.className='chat-switch-heading';saved.textContent='Saved chats';saved.setAttribute('aria-hidden','true');
  section.append(create,saved);return section;
}
/** Which control inside a rebuilt Saved chats menu had focus, so a re-render never drops keyboard focus to the page. */
export function chatSwitchFocus(doc:Document,menu:HTMLElement):((node:HTMLElement)=>boolean)|null {
  const node=doc.activeElement as HTMLElement|null;
  if(!node||typeof node.closest!=='function'||node.closest('details')!==menu)return null;
  if(node.tagName==='SUMMARY')return candidate=>candidate.tagName==='SUMMARY';
  const data=node.dataset??{};
  for(const key of ['openChat','closeChat','conversationId'] as const){const value=data[key];if(value)return candidate=>candidate.dataset?.[key]===value;}
  const name=node.className;return name?candidate=>candidate.tagName===node.tagName&&candidate.className===name:candidate=>candidate.tagName==='SUMMARY';
}
export function restoreChatSwitchFocus(menu:HTMLDetailsElement,match:((node:HTMLElement)=>boolean)|null):void {
  if(!match||typeof menu.querySelectorAll!=='function')return;
  const nodes=Array.from(menu.querySelectorAll<HTMLElement>('summary,button'));
  const target=(menu.open?nodes.find(node=>match(node)&&!(node as HTMLButtonElement).disabled):null)??nodes.find(node=>node.tagName==='SUMMARY');
  try{target?.focus({preventScroll:true});}catch{/* Focus is presentation only. */}
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
  await chat.enableChatTabs({...(preferences?{preferences}:{}),...(options.storage?{storage:options.storage}:{}),
    ...(options.captureLegacyNewChat!==undefined?{captureLegacyNewChat:options.captureLegacyNewChat}:{}),
    ...(options.beforeNewChat?{beforeNewChat:options.beforeNewChat}:{}),
    ...(options.afterNewChat?{afterNewChat:options.afterNewChat}:{}),
    ...(options.alternateNewChat?{alternateNewChat:options.alternateNewChat}:{})});
  return connectChatTabPreferences(doc,chat);
}
