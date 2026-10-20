/** Unsubmitted chat text only. Native identifiers are retained context, never execution authority. */
export type ChatQueueProvider='codex'|'claude';
export interface StoredChatQueueRow {
  id:number;localId:string;conversationId:string|null;sessionId:string|null;text:string;
  modelId:string|null;effort:string|null;connectionId:string|null;requestId:string|null;createdAt:string;
  state:'pending'|'unknown'|'rejected';attachmentState:'none'|'missing';
}
export interface ChatQueueSnapshot {version:1;projectPath:string;provider:ChatQueueProvider;rows:StoredChatQueueRow[]}
export interface ChatQueueRead {available:boolean;projectPath:string|null;rows:StoredChatQueueRow[]}
export interface ChatQueueBridge {
  version:1;
  read(provider:ChatQueueProvider):Promise<ChatQueueRead>;
  save(snapshot:ChatQueueSnapshot):Promise<{saved:true}>;
}
export const CHAT_QUEUE_LIMITS=Object.freeze({rows:64,perChat:5,textBytes:128*1024,providerBytes:1024*1024});
const fail=():never=>{throw new Error('Queued messages could not be saved securely. They are retained in this window.');};
const bytes=(value:string)=>new TextEncoder().encode(value).length;
function fields(value:unknown,names:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==names.length)fail();
  const result:Record<string,unknown>={};
  for(const name of names){const descriptor=Object.getOwnPropertyDescriptor(value,name);if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail();result[name]=descriptor.value;}
  return result;
}
function plainText(value:unknown,max:number,nonempty=false):string{
  if(typeof value!=='string'||!value.isWellFormed()||bytes(value)>max||nonempty&&!value.trim())fail();return value;
}
function identifier(value:unknown,max:number):string{
  const result=plainText(value,max,true);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result))fail();return result;
}
const nullableId=(value:unknown,max:number)=>value===null?null:identifier(value,max);
const uuid=(value:unknown)=>value===null?null:typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)?value:fail();
export function readChatQueueSnapshot(value:unknown,provider?:ChatQueueProvider,projectPath?:string):ChatQueueSnapshot{
  const input=fields(value,['version','projectPath','provider','rows']),project=plainText(input.projectPath,4096,true);
  if(input.version!==1||input.provider!=='codex'&&input.provider!=='claude'||provider!==undefined&&input.provider!==provider||projectPath!==undefined&&project!==projectPath)fail();
  const list=input.rows;if(!Array.isArray(list)||Object.getPrototypeOf(list)!==Array.prototype||list.length>CHAT_QUEUE_LIMITS.rows||Reflect.ownKeys(list).length!==list.length+1)fail();
  const seen=new Set<number>(),perChat=new Map<string,number>(),rows:StoredChatQueueRow[]=[];
  for(let index=0;index<list.length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(list,String(index));if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail();
    const row=fields(descriptor.value,['id','localId','conversationId','sessionId','text','modelId','effort','connectionId','requestId','createdAt','state','attachmentState']);
    if(typeof row.id!=='number'||!Number.isSafeInteger(row.id)||row.id<1||row.id>2147483647||seen.has(row.id))fail();seen.add(row.id);
    const localId=identifier(row.localId,128),conversationId=nullableId(row.conversationId,256),sessionId=nullableId(row.sessionId,256),body=plainText(row.text,CHAT_QUEUE_LIMITS.textBytes,true);
    const modelId=row.modelId===null?null:plainText(row.modelId,256,true);if(modelId!==null&&(/[\x00-\x1f\x7f]/.test(modelId)||modelId.trim()!==modelId))fail();
    const effort=nullableId(row.effort,64),connectionId=uuid(row.connectionId),requestId=uuid(row.requestId),createdAt=plainText(row.createdAt,40,true);
    if(!Number.isFinite(Date.parse(createdAt))||(row.state!=='pending'&&row.state!=='unknown'&&row.state!=='rejected')||(row.attachmentState!=='none'&&row.attachmentState!=='missing'))fail();
    const key=JSON.stringify([conversationId===null?localId:conversationId,sessionId]),count=(perChat.get(key)??0)+1;if(count>CHAT_QUEUE_LIMITS.perChat)fail();perChat.set(key,count);
    rows.push({id:row.id,localId,conversationId,sessionId,text:body,modelId,effort,connectionId,requestId,createdAt,state:row.state as StoredChatQueueRow['state'],attachmentState:row.attachmentState as StoredChatQueueRow['attachmentState']});
  }
  const result:ChatQueueSnapshot={version:1,projectPath:project,provider:input.provider,rows};if(bytes(JSON.stringify(result))>CHAT_QUEUE_LIMITS.providerBytes)fail();return result;
}
export function readChatQueueRead(value:unknown,provider:ChatQueueProvider):ChatQueueRead{
  const input=fields(value,['available','projectPath','rows']);if(typeof input.available!=='boolean')fail();
  if(!input.available){if(input.projectPath!==null||!Array.isArray(input.rows)||Object.getPrototypeOf(input.rows)!==Array.prototype||Reflect.ownKeys(input.rows).length!==1||input.rows.length!==0)fail();return{available:false,projectPath:null,rows:[]};}
  const snapshot=readChatQueueSnapshot({version:1,projectPath:input.projectPath,provider,rows:input.rows},provider);
  return{available:true,projectPath:snapshot.projectPath,rows:snapshot.rows};
}
