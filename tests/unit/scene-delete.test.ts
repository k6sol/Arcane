import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {validateCommandArgs} from '../../packages/core/src/studio-policy.js';
import {READ_METHODS,WRITE_METHODS,type StudioSession,type Json} from '../../packages/protocol/src/studio.js';
import {createMcpServer} from '../../apps/mcp/src/server.js';
import {DaemonClient} from '../../apps/mcp/src/daemon-client.js';
const session:StudioSession={id:'delete-session',protocolVersion:1,clientSessionId:'life',placeId:0,universeId:0,name:'Fixture',pluginVersion:'0.2.0',allowedRoots:['Workspace'],allowWrites:true,capabilities:[...READ_METHODS,...WRITE_METHODS],connectedAt:'',lastSeenAt:'',revokedAt:null};
const ref={instanceId:'existing',sessionId:session.id,root:'Workspace',pathSegments:['Existing'],className:'Model'};
test('deletion requires exact scoped refs or explicit Workspace reset and updated writable plugin',()=>{
 assert.deepEqual(validateCommandArgs('scene.remove',{mode:'refs',refs:[ref]},session),{mode:'refs',refs:[ref]});
 assert.deepEqual(validateCommandArgs('scene.remove',{mode:'workspace'},session),{mode:'workspace'});
 for(const args of [{mode:'refs',refs:[]},{mode:'refs',refs:[ref,ref]},{mode:'workspace',refs:[ref]},{mode:'all'},{mode:'refs',refs:[{...ref,pathSegments:[]}]},{mode:'refs',refs:[{...ref,className:'Terrain'}]},{mode:'refs',refs:[{...ref,sessionId:'other'}]},{mode:'refs',refs:Array(65).fill(ref)}])assert.throws(()=>validateCommandArgs('scene.remove',args as Record<string,Json>,session));
 assert.throws(()=>validateCommandArgs('scene.remove',{mode:'workspace'},{...session,allowWrites:false}));
 assert.throws(()=>validateCommandArgs('scene.remove',{mode:'workspace'},{...session,allowedRoots:['ServerStorage']}));
 assert.throws(()=>validateCommandArgs('scene.remove',{mode:'workspace'},{...session,capabilities:session.capabilities.filter(x=>x!=='scene.remove')}),{code:'PLUGIN_UPDATE_REQUIRED'});
});
test('store validates bounded deletion receipts and directs restoration to Studio Undo',t=>{
 const directory=mkdtempSync(join(tmpdir(),'arcane-delete-store-'));const store=new StudioStore({directory});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const grant=store.createGrant({allowedRoots:['Workspace'],allowWrites:true});const pair=store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'delete-life',placeId:0,universeId:0,name:'Fixture',pluginVersion:'fixture'},capabilities:[...READ_METHODS,...WRITE_METHODS]});
 const target={...ref,sessionId:pair.sessionId};const c=store.enqueue({sessionId:pair.sessionId,requestId:'remove-one',method:'scene.remove',args:{mode:'refs',refs:[target]}});assert.equal(store.poll(pair.sessionId)[0]!.id,c.id);
 const root={...target,instanceId:'workspace',pathSegments:[],className:'Workspace'};
 const receipt=(removed:number,terrainCleared=false)=>({ref:root,mutation:{kind:'scene.remove',ref:root,before:{targetCount:removed,descendants:removed},after:{removed,descendants:removed,terrainCleared,undo:'studio'}}});
 for(const bad of [receipt(2),receipt(1,true),receipt(100001)])assert.throws(()=>store.result({sessionId:pair.sessionId,commandId:c.id,state:'succeeded',result:bad}),{code:'RECEIPT'});
 store.result({sessionId:pair.sessionId,commandId:c.id,state:'succeeded',result:receipt(1)});
 assert.throws(()=>store.restore({sessionId:pair.sessionId,commandId:c.id,requestId:'restore-removal'}),{code:'RESTORE'});
});
test('MCP advertises explicit deletion choices, rejects ambiguous input and sends one removal command',async t=>{
 const daemon=new DaemonClient({url:'http://127.0.0.1:1',token:'synthetic-delete-test'});const posted:unknown[]=[];
 daemon.execute=async (sessionId,method,args)=>{posted.push({sessionId,method,args});return {state:'succeeded',result:{removed:1}} as never;};
 const server=createMcpServer({client:daemon,projectRoot:process.cwd()});const client=new Client({name:'deletion-test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
 const tool=(await client.listTools()).tools.find(x=>x.name==='scene_delete')!;assert.ok(tool);assert.equal(tool.annotations?.destructiveHint,true);
 for(const args of [{},{targets:[ref],clearWorkspace:true},{targets:[]},{clearWorkspace:false}]){const r=await client.callTool({name:'scene_delete',arguments:{sessionId:session.id,...args}});assert.equal(r.isError,true);}
 assert.equal(posted.length,0);
 const r=await client.callTool({name:'scene_delete',arguments:{sessionId:session.id,targets:[ref]}});assert.notEqual(r.isError,true,JSON.stringify(r));assert.equal(posted.length,1);assert.equal((posted[0] as {method:string}).method,'scene.remove');
});
