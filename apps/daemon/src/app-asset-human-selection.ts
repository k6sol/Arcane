import {types} from 'node:util';
import type {NativeConversation} from '../../../packages/storage/src/conversation-work-store.js';

export type AppAssetHumanSelection=null|Readonly<{provider:'codex'}>|Readonly<{provider:'claude-code'|'arcane';conversationId:string}>;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?![\s\S])/;
function refused():never{throw new Error('The selected chat is unavailable for model review.');}
function data(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))refused();
 const prototype=Object.getPrototypeOf(value),own=Reflect.ownKeys(value);
 if(prototype!==Object.prototype&&prototype!==null||own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))refused();
 const result:Record<string,unknown>={};
 for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))refused();result[key]=descriptor.value;}
 return result;
}
/** Parent-only selection input. This grants no native permission or actor. */
export function snapshotAppAssetHumanSelection(value:unknown):AppAssetHumanSelection{
 if(value===null)return null;
 if(!value||typeof value!=='object'||types.isProxy(value))refused();
 const descriptor=Object.getOwnPropertyDescriptor(value,'provider');
 if(!descriptor||!Object.hasOwn(descriptor,'value'))refused();
 const provider:unknown=descriptor.value;
 if(provider==='codex'){data(value,['provider']);return Object.freeze({provider});}
 const input=data(value,['provider','conversationId']);
 if(provider!=='claude-code'&&provider!=='arcane'||typeof input.conversationId!=='string'||!UUID.test(input.conversationId))refused();
 return Object.freeze({provider,conversationId:input.conversationId});
}

export interface AppAssetHumanSelectionHost {
 select(value:unknown):void;
 current():Readonly<NativeConversation>|null;
 epoch():object;
 close():void;
}
/** Human review follows an explicit parent selection. A new intent always gets
 * a fresh private epoch; A -> empty -> A cannot resurrect an old pending view. */
export function createAppAssetHumanSelection(options:{codexConversation:()=>NativeConversation|null}):AppAssetHumanSelectionHost{
 if(typeof options.codexConversation!=='function')refused();
 let selected:AppAssetHumanSelection=Object.freeze({provider:'codex'}),epoch:object=Object.freeze({}),closed=false;
 return Object.freeze({
  select(value:unknown){if(closed)refused();const snapshot=snapshotAppAssetHumanSelection(value);selected=snapshot;epoch=Object.freeze({});},
  current(){
   if(closed||selected===null)return null;
   if(selected.provider!=='codex')return Object.freeze({provider:selected.provider,threadId:'app:'+selected.conversationId,sessionId:null});
   const value=options.codexConversation();if(value===null)return null;
   const input=data(value,['provider','threadId','sessionId']);
   if(input.provider!=='codex'||typeof input.threadId!=='string'||!ID.test(input.threadId)||input.sessionId!==null&&(typeof input.sessionId!=='string'||!ID.test(input.sessionId)))refused();
   return Object.freeze({provider:'codex' as const,threadId:input.threadId,sessionId:input.sessionId});
  },
  epoch(){return epoch;},
  close(){if(closed)return;closed=true;selected=null;epoch=Object.freeze({});},
 });
}
