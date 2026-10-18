/// <reference lib="dom" />
/** Presentation data only. A conversation id is a hint to the project-scoped chat host, never authority. */
export interface ClaudePreferenceRow {
  localId:string;title:string;provider:'claude';threadId:string|null;sessionId:null;draft:string;
  modelId:string|null;effort:string|null;tool:'all';previewOpen:false;
}
export interface ClaudePreferenceSnapshot {version:1;projectPath:string;provider:'claude';tabs:ClaudePreferenceRow[];activeTabId:string|null}
export interface ClaudePreferenceBridge {read():Promise<unknown>;save(value:ClaudePreferenceSnapshot):Promise<unknown>}
const ERROR='Claude chat preferences could not be saved. Keep this window open and try again.';
function fail():never{throw new Error(ERROR);}
const bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
function object(value:unknown):value is Record<string,unknown>{
  try{return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>{
    const d=Object.getOwnPropertyDescriptor(value,key);return typeof key==='string'&&!!d?.enumerable&&Object.hasOwn(d,'value');
  });}catch{return false;}
}
function exact(value:unknown,fields:string[]):value is Record<string,unknown>{return object(value)&&Reflect.ownKeys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));}
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!/[\uD800-\uDFFF]/u.test(value)&&bytes(value)<=max;
const id=(value:unknown,max:number):value is string=>text(value,max)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const nullable=(value:unknown,max:number)=>value===null||id(value,max);
const model=(value:unknown)=>value===null||text(value,256)&&value.length>0&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
export function readClaudePreferenceSnapshot(value:unknown,projectPath:string):ClaudePreferenceSnapshot{
  if(!exact(value,['version','projectPath','provider','tabs','activeTabId'])||value.version!==1||value.projectPath!==projectPath||value.provider!=='claude'||
    !Array.isArray(value.tabs)||value.tabs.length>16||Reflect.ownKeys(value.tabs).length!==value.tabs.length+1)fail();
  const ids=new Set<string>(),tabs:ClaudePreferenceRow[]=[];
  for(const raw of value.tabs as unknown[]){
    if(!exact(raw,['localId','title','provider','threadId','sessionId','draft','modelId','effort','tool','previewOpen'])||!id(raw.localId,128)||ids.has(raw.localId)||
      !text(raw.title,512)||/[\x00-\x1f\x7f]/.test(raw.title)||raw.provider!=='claude'||!nullable(raw.threadId,256)||raw.sessionId!==null||
      !text(raw.draft,131072)||!model(raw.modelId)||!nullable(raw.effort,64)||raw.tool!=='all'||raw.previewOpen!==false)fail();
    ids.add(raw.localId as string);tabs.push({...raw} as unknown as ClaudePreferenceRow);
  }
  if(value.activeTabId!==null&&(!id(value.activeTabId,128)||!ids.has(value.activeTabId)))fail();
  const result={version:1 as const,projectPath,provider:'claude' as const,tabs,activeTabId:value.activeTabId as string|null};
  if(bytes(JSON.stringify(result))>512*1024)fail();return result;
}
export function claudePreferenceBridge(win:unknown):ClaudePreferenceBridge|null{
  const value=(win as {arcaneDesktop?:{claudePreferences?:unknown}}|null)?.arcaneDesktop?.claudePreferences;
  return object(value)&&value.version===1&&typeof value.read==='function'&&typeof value.save==='function'?value as unknown as ClaudePreferenceBridge:null;
}

/** A serial save queue: only the exact native acknowledgement marks a desired snapshot saved. */
export class ClaudePreferenceStore{
  projectPath:string|null=null;
  private usable=false;
  private failed=false;
  private stopped=false;
  private reading:Promise<ClaudePreferenceSnapshot|null>|null=null;
  private writing:Promise<void>|null=null;
  private queued:{value:ClaudePreferenceSnapshot;serialized:string}|null=null;
  private saved:string|null=null;
  private desired:string|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  constructor(private readonly bridge:ClaudePreferenceBridge,private readonly changed:()=>void=()=>{}){}
  available():boolean{return this.usable&&!this.stopped;}
  error():boolean{return this.failed;}
  async read():Promise<ClaudePreferenceSnapshot|null>{
    if(this.stopped)return null;
    if(this.reading)return this.reading;
    this.reading=(async()=>{
      try{
        const result=await this.bridge.read();if(this.stopped)return null;
        if(!exact(result,['available','projectPath','preferences'])||typeof result.available!=='boolean')fail();
        if(!result.available){if(result.projectPath!==null||result.preferences!==null)fail();this.usable=false;return null;}
        if(!text(result.projectPath,4096)||!result.projectPath.length)fail();
        const project=result.projectPath as string,snapshot=result.preferences===null?null:readClaudePreferenceSnapshot(result.preferences,project);
        this.projectPath=project;this.usable=true;this.failed=false;this.saved=snapshot?JSON.stringify(snapshot):null;return snapshot;
      }catch{if(!this.stopped){this.failed=true;this.usable=false;}throw new Error(ERROR);}
      finally{this.reading=null;if(!this.stopped)this.changed();}
    })();return this.reading;
  }
  queue(value:ClaudePreferenceSnapshot,retry=false):void{
    if(!this.available()||this.projectPath===null)return;
    const copy=readClaudePreferenceSnapshot(value,this.projectPath),serialized=JSON.stringify(copy);
    if(serialized===this.desired&&(this.failed?!retry:!!this.queued||!!this.writing||this.saved===serialized))return;
    this.desired=serialized;if(serialized===this.saved&&!this.failed&&!this.writing&&!this.queued)return;
    this.queued={value:copy,serialized};if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.timer=null;void this.drain();},150);
  }
  private drain():Promise<void>{
    if(this.writing)return this.writing;
    this.writing=(async()=>{
      while(!this.stopped&&this.queued){
        const item=this.queued;this.queued=null;
        try{
          const result=await this.bridge.save(item.value);if(this.stopped)return;
          if(!exact(result,['saved'])||result.saved!==true)fail();this.saved=item.serialized;this.failed=false;
        }catch{if(!this.stopped){this.failed=true;if(!this.queued)this.queued=item;}break;}
      }
    })().finally(()=>{this.writing=null;if(!this.stopped)this.changed();});return this.writing;
  }
  async flush(value:ClaudePreferenceSnapshot):Promise<void>{
    if(!this.available())fail();this.queue(value,true);if(this.timer)clearTimeout(this.timer);this.timer=null;
    const wanted=this.desired;await this.drain();if(this.stopped||this.failed||this.saved!==wanted||this.desired!==wanted)fail();
  }
  dispose():void{this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;this.queued=null;}
}
