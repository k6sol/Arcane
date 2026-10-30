import { types as nodeTypes } from 'node:util';
import type { McpToolFailureSummary, McpToolFailureCode, McpFailureTool } from './types.js';

// Public display classifications only. No provider message, payload or path is copied.
const SKILL_CODES = ['BUNDLE_INTEGRITY','INTEGRITY','REGISTRY','FRONTMATTER','DESCRIPTION','LICENCE','FILE_LIMIT','INVALID_PATH','PATH_ESCAPE',
  'BUDGET_EXCEEDED','UNKNOWN_SKILL','UNAPPROVED','REFERENCES','SKILL_ROUTE_INPUT','SKILL_CATALOGUE_LIMIT'] as const;
const VIEWPORT_CODES = ['VIEWPORT_TOOL_UNSUPPORTED','VIEWPORT_INVALID','VIEWPORT_FAILED','VIEWPORT_CAMERA_UNKNOWN',
  'BUSY','STALE_PROOF','BINDING_CHANGED','MODE_MISMATCH','DISCONNECTED','TIMEOUT','FENCED','SDK_CUSTODY_UNCONFIRMED'] as const;
const PAIRS: Record<Exclude<McpFailureTool,null>, readonly McpToolFailureCode[]> = {
  skills_recommend:SKILL_CODES,skills_list:SKILL_CODES,skills_get:SKILL_CODES,studio_viewport_capture:VIEWPORT_CODES,
  scene_build:['FOREST_SOURCES_REQUIRED'],
};
const plain = (value:unknown):value is Record<string,unknown> => value !== null && typeof value==='object' && !nodeTypes.isProxy(value)
  && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
function own(value:Record<string,unknown>,key:string):unknown {
  const d=Object.getOwnPropertyDescriptor(value,key);
  return d?.enumerable&&Object.hasOwn(d,'value')?d.value:undefined;
}
function object(value:unknown):Record<string,unknown>|null {return plain(value)?value:null;}
function knownTool(value:unknown):value is Exclude<McpFailureTool,null> {return typeof value==='string'&&Object.hasOwn(PAIRS,value);}
function knownCode(tool:Exclude<McpFailureTool,null>,value:unknown):value is McpToolFailureCode {
  return typeof value==='string'&&(PAIRS[tool] as readonly string[]).includes(value);
}
/** Validate/detach only the finite presentation object, never serialized authority. */
export function readMcpToolFailure(value:unknown):McpToolFailureSummary|null {
  try{
    if(!plain(value))return null;
    const keys=Reflect.ownKeys(value);
    if(keys.length!==4||keys.some(k=>typeof k!=='string'||!['schemaVersion','kind','tool','code'].includes(k)))return null;
    const schemaVersion=own(value,'schemaVersion'),kind=own(value,'kind'),tool=own(value,'tool'),code=own(value,'code');
    if(schemaVersion!==1||!(tool===null||knownTool(tool)))return null;
    if(kind==='arcane-code'){
      if(tool===null||!knownCode(tool,code))return null;
      return Object.freeze({schemaVersion:1,kind,tool,code});
    }
    if((kind==='mcp-error'||kind==='details-unavailable')&&code===null)return Object.freeze({schemaVersion:1,kind,tool,code:null});
    return null;
  }catch{return null;}
}
interface Candidate {present:boolean;code:McpToolFailureCode|null}
function candidate(value:unknown,tool:Exclude<McpFailureTool,null>):Candidate {
  const row=object(value),error=row?object(own(row,'error')):null;
  if(!error)return {present:false,code:null};
  const descriptor=Object.getOwnPropertyDescriptor(error,'code');
  if(!descriptor)return {present:false,code:null};
  const valueCode=own(error,'code');
  return {present:true,code:knownCode(tool,valueCode)?valueCode:null};
}
function textCandidate(result:Record<string,unknown>,tool:Exclude<McpFailureTool,null>):Candidate {
  const content=own(result,'content');
  if(nodeTypes.isProxy(content)||!Array.isArray(content))return {present:false,code:null};
  const size=Object.getOwnPropertyDescriptor(content,'length');
  if(!size||!Object.hasOwn(size,'value')||size.value!==1)return {present:false,code:null};
  const block=object(own(content as unknown as Record<string,unknown>,'0'));
  if(!block||own(block,'type')!=='text')return {present:false,code:null};
  const text=own(block,'text');
  // Same ceiling as the existing desktop detail parser; no frame/history budget increase.
  if(typeof text!=='string'||text.length>65536||Buffer.byteLength(text)>65536)return {present:false,code:null};
  try{return candidate(JSON.parse(text) as unknown,tool);}catch{return {present:false,code:null};}
}
/** Failed supported items only. Success/private metadata and arbitrary error messages stay unread. */
export function summarizeMcpToolFailure(value:unknown):McpToolFailureSummary|null {
  try{
    if(!plain(value)||own(value,'status')!=='failed')return null;
    const tool=own(value,'server')==='arcane'&&knownTool(own(value,'tool'))?own(value,'tool') as Exclude<McpFailureTool,null>:null;
    const result=object(own(value,'result'));
    if(tool!==null&&result){
      const structured=candidate(own(result,'structuredContent'),tool),text=textCandidate(result,tool);
      if(structured.present||text.present){
        const code=structured.present?structured.code:text.code;
        if(code!==null&&(!structured.present||!text.present||structured.code===text.code))return Object.freeze({schemaVersion:1,kind:'arcane-code',tool,code});
        return Object.freeze({schemaVersion:1,kind:'details-unavailable',tool,code:null});
      }
    }
    const error=object(own(value,'error'));
    const kind=own(value,'result')==null&&error&&typeof own(error,'message')==='string'?'mcp-error':'details-unavailable';
    return Object.freeze({schemaVersion:1,kind,tool,code:null});
  }catch{return null;}
}
/** Canonical bounded text fits the unchanged historical entry schema. */
export function mcpToolFailureEnvelope(value:unknown):string|null {
  const failure=readMcpToolFailure(value);
  return failure?JSON.stringify({toolFailure:failure}):null;
}
