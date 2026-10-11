import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DaemonClient} from '../dist/apps/mcp/src/daemon-client.js';
import {createMcpServer} from '../dist/apps/mcp/src/server.js';
const origin='http://127.0.0.1:45871';
const control=process.env.ARCANE_CONTROL_TOKEN;
const clientId=process.argv[2];if(!control||!clientId)throw new Error('Provide control token in env and exact plugin client session ID.');
const handoff=await fetch(origin+'/v1/product/mcp-token',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+control,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
if(!handoff.ok)throw new Error('Scoped-token handoff refused.');const {token}=await handoff.json();
const daemon=new DaemonClient({url:origin,token,pollIntervalMs:100});
let session;for(let i=0;i<80;i++){const list=await daemon.sessions({timeoutMs:4000});session=list.sessions.find(s=>s.clientSessionId===clientId&&!s.revokedAt);if(session)break;await sleep(250);}
if(!session)throw new Error('Exact native fixture client did not pair. Check fixture status, no fallback selected.');
const [a,b]=InMemoryTransport.createLinkedPair();const server=createMcpServer({client:daemon,projectRoot:process.cwd()});const client=new Client({name:'Arcane actual engine acceptance',version:'1.0.0'});await server.connect(a);await client.connect(b);
const report={schemaVersion:1,evidenceKind:'native-transport-http-sqlite-sdk',startedAt:new Date().toISOString(),clientSessionId:clientId,sessionId:session.id,placeId:session.placeId,checks:[],commands:[],huntedWrites:0,limitations:['Widget installation/reload is a separate acceptance gate.']};
async function call(name,args={}){const r=await client.callTool({name,arguments:{sessionId:session.id,timeoutMs:15000,...args}},undefined,{timeout:20000});const d=r.structuredContent??JSON.parse(r.content[0].text);if(d.commandId)report.commands.push(d.commandId);return{r,d};}
function requireSuccess(result,label){if(result.r.isError||result.d.state!=='succeeded')throw new Error(label+': '+JSON.stringify(result.d));report.checks.push({label,passed:true});return result.d.command.result;}
try{
 const root=requireSuccess(await call('scene_search',{root:'Workspace',query:'Workspace'}),'root-search').items.find(n=>n.ref.pathSegments.length===0).ref;
 const created=requireSuccess(await call('scene_create',{parent:root,className:'Part',name:'ArcaneHTTPProofPart',properties:{Anchored:true,Size:{type:'Vector3',value:[3,2,1]},Position:{type:'Vector3',value:[0,8,0]}}}),'create-part');
 const changed=await call('scene_update',{ref:created.ref,expected:{Transparency:0},properties:{Transparency:0.3}});
 const change=requireSuccess(changed,'float32-change');if(change.mutation.after.properties.Transparency!==Math.fround(0.3))throw new Error('Native float32 mismatch');
 requireSuccess(await call('receipt_restore',{commandId:changed.d.commandId}),'restore-property');
 const found=requireSuccess(await call('scene_search',{root:'ServerStorage',query:'EditorProbe'}),'probe-search');const probe=found.items.find(n=>n.name==='EditorProbe').ref;
 const source=requireSuccess(await call('script_read',{ref:probe}),'read-editor-source').source;
 const write=await call('script_update',{ref:probe,expectedSource:source,source:'return { fixture = true, revision = 2 }'});requireSuccess(write,'write-editor-source');
 const conflict=await call('script_update',{ref:probe,expectedSource:source,source:'return 99'});if(conflict.d.state!=='failed')throw new Error('Stale editor baseline accepted');report.checks.push({label:'stale-editor-baseline-refused',passed:true});
 requireSuccess(await call('receipt_restore',{commandId:write.d.commandId}),'restore-editor-source');
 const reread=requireSuccess(await call('script_read',{ref:probe}),'reread-restored-source');if(reread.source!==source)throw new Error('Source restoration mismatch');
 const createCmd=report.commands[1];requireSuccess(await call('receipt_restore',{commandId:createCmd}),'restore-created-part');
 report.finishedAt=new Date().toISOString();report.passed=true;
}catch(e){report.finishedAt=new Date().toISOString();report.passed=false;report.error=String(e.message).replaceAll(control,'[redacted]').replaceAll(token,'[redacted]');process.exitCode=1;}
finally{await client.close();await server.close();await fs.mkdir('docs/research',{recursive:true});await fs.writeFile('docs/research/native-bridge-checks.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
