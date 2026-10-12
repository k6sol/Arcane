import { createHash } from 'node:crypto';
import type { CodexProductState } from './codex-service.js';
import { efforts, type Connection, type Effort } from '../../../packages/protocol/src/providers.js';
import type { NativeWorkflowModelProof } from '../../../packages/protocol/src/workflow-model.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);
const text=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const effort=(v:string):v is Effort=>efforts.includes(v as Effort);
/** Public in-memory observations only: no filesystem, process, provider probe or action. */
export function workflowNativeModel(state: CodexProductState | null): {proof:NativeWorkflowModelProof;connection:Connection}|null {
  const s=state?.snapshot,t=s?.thread;
  if(!state||state.provider!=='codex'||state.use!=='personal-local'||!text(state.projectPath,4096)||state.displayLimited||state.connecting||state.closing||
      !s||!s.connected||!s.ready||s.failureCode!==null||!UUID.test(s.connectionId)||!['installed-cli','spawned-node-fixture'].includes(s.provenance)||
      !t?.configured||!id(t.threadId)||(t.sessionId!==null&&!id(t.sessionId))||!Array.isArray(s.models)||s.models.length>512||
      !Array.isArray(s.operations)||s.operations.some(op=>['pending','unknown'].includes(op.state))||
      !Array.isArray(state.actions)||state.actions.some(a=>a.connectionId===s.connectionId&&['pending','unknown'].includes(a.state))||
      !s.account||s.account.auth!=='subscription'||s.account.requiresOpenaiAuth!==true) return null;
  const selected=t.selection;
  if(!selected||(!id(selected.model)||!text(selected.model,160))||!effort(selected.effort))return null;
  const names=new Set<string>();
  const models:Connection['models']=[];
  for(const m of s.models) {
    if((!id(m.model)||!text(m.model,160))||names.has(m.model)||!text(m.displayName)||m.entitlement!=='unverified'||!Array.isArray(m.efforts)||!m.efforts.length||m.efforts.length>16||new Set(m.efforts).size!==m.efforts.length)return null;
    names.add(m.model);
    const allowed=m.efforts.filter(effort).sort();
    if(!allowed.length)continue; // Unknown future efforts are not translated to a fallback.
    models.push({id:m.model,label:m.displayName,efforts:allowed,defaultEffort:m.defaultEffort!==null&&effort(m.defaultEffort)&&allowed.includes(m.defaultEffort)?m.defaultEffort:null,
      source:'runtime-catalogue',entitlement:'unverified',inputModalities:['text']});
  }
  models.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const current=models.find(m=>m.id===selected.model);
  if(!current?.efforts.includes(selected.effort))return null;
  const revision=createHash('sha256').update('arcane.workflow.native-catalogue.v1\0').update(JSON.stringify({connectionId:s.connectionId,provenance:s.provenance,
    projectPath:state.projectPath,threadId:t.threadId,sessionId:t.sessionId,account:{auth:s.account.auth,plan:s.account.plan,requiresOpenaiAuth:s.account.requiresOpenaiAuth},
    selected,models:models.map(m=>({id:m.id,efforts:m.efforts,defaultEffort:m.defaultEffort,inputModalities:m.inputModalities}))})).digest('hex');
  const proof:NativeWorkflowModelProof={version:1,source:'active-native-thread-catalogue',projectPath:state.projectPath,connectionId:s.connectionId,
    threadId:t.threadId,sessionId:t.sessionId,provenance:s.provenance,selection:{provider:'codex',model:selected.model,effort:selected.effort,connectionRevision:revision},entitlement:'unverified'};
  const connection:Connection={provider:'codex',installed:s.provenance==='installed-cli',version:null,auth:'subscription',plan:s.account.plan,models,
    features:[{id:'coding',label:'Native coding handoff',state:'native-handoff',route:'native-client',reason:'Exact reported catalogue and active native thread. Every turn still requires a separate human action.'}],
    warnings:['Model access remains unverified; catalogue metadata is not an inference result.'],observedAt:new Date().toISOString(),revision};
  return {proof,connection};
}
