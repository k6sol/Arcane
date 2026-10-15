import { z } from 'zod';
import { digest } from '../../../packages/studio-test-controller/src/contracts.js';
import { ROOTS, type StudioRoot } from '../../../packages/protocol/src/studio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const source=z.strictObject({root:z.enum(ROOTS),path:z.array(z.string().max(256)).min(1).max(64),identity:z.string().min(1).max(128),
  className:z.enum(['Script','LocalScript','ModuleScript']),enabled:z.boolean(),source:z.string().max(32768),editorSource:z.string().max(32768)});
const snapshot=z.strictObject({schemaVersion:z.literal(1),sessionId:z.string().min(1).max(128),clientLifetimeId:z.string().min(1).max(128),pluginArtifactHash:z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
  nodes:z.number().int().min(0).max(1024),sourceCount:z.number().int().min(0).max(64),sources:z.record(z.string().regex(/^s[1-9][0-9]{0,2}(?![\s\S])/),source)});
/** Host-only bounded read program. Callers never submit this source, roots or
 * source digests through the playtest request. Persisted AND editor source are
 * observed, so an unsaved buffer cannot inherit the last applied patch's proof. */
export function scenarioSubjectProgram(marker:string,roots:readonly StudioRoot[]):string {
  if(!/^ArcaneTestProof_[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(marker)||!roots.length||roots.some(root=>!ROOTS.includes(root)))throw new Error('Invalid trusted subject scope.');
  return `local storage=game:GetService("ServerStorage"); local marker=storage:FindFirstChild(${JSON.stringify(marker)}); assert(game.PlaceId==0 and game.GameId==0 and marker and marker.ClassName=="Folder","Unavailable scenario subjects")
local sessionId=marker:GetAttribute("SessionId");local lifetime=marker:GetAttribute("ClientLifetimeId");local artifact=marker:GetAttribute("PluginArtifactHash")
local editor=game:GetService("ScriptEditorService");local sources={};local count=0;local nodes=0;local bytes=0
for _,rootName in ipairs({${roots.map(root=>JSON.stringify(root)).join(',')}}) do
 local stack={{node=game:GetService(rootName),path={}}}
 while #stack>0 do
  local item=table.remove(stack);local node=item.node;nodes+=1;assert(nodes<=1024,"Subject node limit")
  if node:IsA("LuaSourceContainer") then
   count+=1;assert(count<=64,"Subject source limit")
   local persisted=node.Source;local current=editor:GetEditorSource(node);bytes+=#persisted+#current
   assert(#persisted<=32768 and #current<=32768 and bytes<=131072,"Subject byte limit")
   sources["s"..tostring(count)]={root=rootName,path=item.path,identity=node:GetDebugId(32),className=node.ClassName,enabled=if node:IsA("BaseScript") then not node.Disabled else false,source=persisted,editorSource=current}
  end
  local children=node:GetChildren();assert(#children<=1024 and #item.path<64,"Subject hierarchy limit")
  for _,child in ipairs(children) do local path=table.clone(item.path);path[#path+1]=child.Name;stack[#stack+1]={node=child,path=path};assert(#stack<=1024,"Subject traversal limit") end
  if nodes%32==0 then task.wait() end
 end
end
assert(marker.Parent==storage and marker:GetAttribute("SessionId")==sessionId and marker:GetAttribute("ClientLifetimeId")==lifetime and marker:GetAttribute("PluginArtifactHash")==artifact,"Subject mapping changed")
return {schemaVersion=1,sessionId=sessionId,clientLifetimeId=lifetime,pluginArtifactHash=artifact,nodes=nodes,sourceCount=count,sources=sources}`;
}
export function scenarioSubjectDigest(result:CallToolResult, expected:{sessionId:string;clientLifetimeId:string;pluginArtifactHash:string;allowedRoots:readonly StudioRoot[]}, receipts:readonly unknown[]):string {
  if(result.isError||result.content.length!==1||result.content[0]?.type!=='text'||Buffer.byteLength(result.content[0].text)>256*1024)throw new Error('Invalid scenario source observation.');
  const value=snapshot.parse(JSON.parse(result.content[0].text));
  const entries=Object.values(value.sources);
  if(value.sessionId!==expected.sessionId||value.clientLifetimeId!==expected.clientLifetimeId||value.pluginArtifactHash!==expected.pluginArtifactHash||entries.length!==value.sourceCount||value.sourceCount>value.nodes||
    new Set(entries.map(entry=>entry.identity)).size!==entries.length||entries.some(entry=>!expected.allowedRoots.includes(entry.root))||
    entries.reduce((sum,entry)=>sum+Buffer.byteLength(entry.source)+Buffer.byteLength(entry.editorSource),0)>131072)throw new Error('Scenario source mapping changed.');
  // Native traversal order is not a source revision. Retain observed engine IDs
  // and exact source bytes in the hash, while only the hash leaves this closure.
  const sources=entries.sort((a,b)=>{const left=JSON.stringify([a.root,a.path,a.identity]),right=JSON.stringify([b.root,b.path,b.identity]);return left<right?-1:left>right?1:0;});
  return digest({scope:'observed-script-editor-source-and-applied-script-receipts-v1',sources,receipts});
}
