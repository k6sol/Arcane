import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCommandArgs} from '../../packages/core/src/studio-policy.js';
import {READ_METHODS,WRITE_METHODS,STUDIO_GUI_CAPABILITY,STUDIO_FEATURE_CAPABILITIES,type StudioSession,type Json} from '../../packages/protocol/src/studio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../../apps/mcp/src/server.js';
import type {DaemonClient} from '../../apps/mcp/src/daemon-client.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const EDIT='scene.gui.edit',FLEX='scene.gui.flex';
const session=(edit=true):StudioSession=>({id:'gui-edit',protocolVersion:1,clientSessionId:'gui-editor',placeId:0,universeId:0,name:'GUI fixture',pluginVersion:'0.2.0',allowedRoots:['StarterGui'],allowWrites:true,
 capabilities:[...READ_METHODS,...WRITE_METHODS,STUDIO_GUI_CAPABILITY,FLEX,...(edit?[EDIT]:[])],connectedAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),revokedAt:null});
const update=(className:string,expected:Record<string,Json>,properties:Record<string,Json>,s=session())=>validateCommandArgs('scene.update',{ref:{sessionId:s.id,instanceId:'opaque-'+className,className,root:'StarterGui',pathSegments:[className]},expected,properties},s);
const u2=(...value:number[])=>({type:'UDim2',value});

test('GUI edits require their loaded plugin capability and preserve existing name-only edits',()=>{
 assert.throws(()=>update('Frame',{Size:u2(.5,0,.5,0)},{Size:u2(.75,0,.5,0)},session(false)),{code:'PLUGIN_UPDATE_REQUIRED'});
 assert.ok(update('Frame',{Name:'Before'},{Name:'After'},session(false)));
 assert.ok(STUDIO_FEATURE_CAPABILITIES.includes(EDIT));
 assert.throws(()=>update('Frame',{Visible:true},{Visible:false},{...session(),allowWrites:false}),{code:'READ_ONLY'});
 assert.throws(()=>update('Frame',{Visible:true},{Visible:false},{...session(),allowedRoots:['Workspace']}),{code:'SCOPE'});
});

test('GUI edits accept exact native observations beyond creation bounds while keeping new writes bounded',()=>{
 assert.ok(update('TextLabel',{TextSize:150.25},{TextSize:24}));
 assert.ok(update('Frame',{Size:u2(20,100001,.12345679104328156,-10001)},{Size:u2(.5,10,.5,10)}));
 assert.ok(update('TextLabel',{Font:'Unknown',FontFace:{type:'Font',family:'rbxassetid://123',weight:'Regular',style:'Normal'}},{Font:'Gotham'}));
 assert.ok(update('TextLabel',{Font:'Unknown',FontFace:{type:'Font',family:'rbxassetid://123',weight:'Regular',style:'Normal'}},{FontFace:{type:'Font',family:'BuilderSans'}}));
 assert.throws(()=>update('TextLabel',{TextSize:24},{TextSize:150.25}),{code:'INPUT'});
 assert.throws(()=>update('Frame',{Size:u2(.5,0,.5,0)},{Size:u2(20,0,.5,0)}),{code:'INPUT'});
 assert.throws(()=>update('TextLabel',{Font:'Unknown',FontFace:{type:'Font',family:'rbxassetid://123',weight:'Regular',style:'Normal'}},{FontFace:{type:'Font',family:'rbxassetid://456'}}),{code:'PROPERTY'});
});

test('GUI edits require both observed font aliases and constraint bounds before retaining a restoration receipt',()=>{
 assert.throws(()=>update('TextLabel',{Font:'Unknown'},{Font:'Gotham'}),{code:'BASELINE'});
 assert.throws(()=>update('UISizeConstraint',{MinSize:{type:'Vector2',value:[0,100]}},{MinSize:{type:'Vector2',value:[10,110]}}),{code:'BASELINE'});
 assert.ok(update('UISizeConstraint',{MinSize:{type:'Vector2',value:[0,100]},MaxSize:{type:'Vector2',value:[100,200]}},{MinSize:{type:'Vector2',value:[10,110]}}));
});

test('SQLite accepts exact GUI receipts, rejects forged linked values and builds restoration from the retained receipt',t=>{
 const directory=mkdtempSync(join(tmpdir(),'arcane-gui-edit-store-')),store=new StudioStore({directory});
 t.after(()=>{store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+'/')||resolve(directory).startsWith(resolve(tmpdir())+'\\'));rmSync(directory,{recursive:true,force:true});});
 const grant=store.createGrant({allowedRoots:['StarterGui'],allowWrites:true});
 const pair=store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'gui-native-fixture',placeId:0,universeId:0,name:'GUI fixture',pluginVersion:'0.2.0'},capabilities:session().capabilities});
 const face={type:'Font',family:'rbxassetid://123',weight:'SemiBold',style:'Italic'},v2=(...value:number[])=>({type:'Vector2',value});
 const cases=[
  {className:'Frame',expected:{Size:u2(.12345679104328156,0,.5,0)},properties:{Size:u2(.6,10,.5,10)},after:{Size:u2(Math.fround(.6),10,.5,10)},badAfter:{Size:u2(.8,10,.5,10)}},
  {className:'TextLabel',expected:{Font:'Unknown',FontFace:face},properties:{Font:'Gotham'},after:{Font:'Gotham',FontFace:{type:'Font',family:'rbxasset://fonts/families/GothamSSm.json',weight:'Regular',style:'Normal'}},badAfter:{Font:'Arial',FontFace:face}},
  {className:'TextLabel',expected:{Font:'Unknown',FontFace:face},properties:{FontFace:{type:'Font',family:'BuilderSans',weight:'Bold',style:'Italic'}},after:{Font:'Unknown',FontFace:{type:'Font',family:'rbxasset://fonts/families/BuilderSans.json',weight:'Bold',style:'Italic'}},badAfter:{Font:'Unknown',FontFace:face}},
  {className:'UIGradient',expected:{Transparency:{type:'NumberSequence',value:[[0,0,0],[1,1,0]]}},properties:{Transparency:{type:'NumberSequence',value:[[0,.25],[1,.75,.05]]}},after:{Transparency:{type:'NumberSequence',value:[[0,.25,0],[1,.75,Math.fround(.05)]]}},badAfter:{Transparency:{type:'NumberSequence',value:[[0,.25,0],[1,.75,.25]]}}},
  {className:'UISizeConstraint',expected:{MinSize:v2(0,100),MaxSize:v2(100,200)},properties:{MinSize:v2(10,110)},after:{MinSize:v2(10,110),MaxSize:v2(100,200)},badAfter:{MinSize:v2(10,110),MaxSize:v2(120,220)}}
 ] as const;
 let index=0;
 for(const sample of cases){
  const ref={sessionId:pair.sessionId,instanceId:'gui-'+index,className:sample.className,root:'StarterGui',pathSegments:[sample.className]};
  const command=store.enqueue({sessionId:pair.sessionId,requestId:'gui-edit-'+index,method:'scene.update',args:{ref,expected:sample.expected,properties:sample.properties}});store.poll(pair.sessionId);
  const mutation={kind:'scene.update',ref,before:{properties:sample.expected},after:{properties:sample.after}};
  const result=(value:unknown)=>({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:{ref,mutation:value}});
  assert.throws(()=>store.result(result({...mutation,after:{properties:sample.badAfter}})),{code:'RECEIPT'});
  assert.throws(()=>store.result(result({...mutation,before:{properties:{...sample.expected,Name:'forged'}}})),{code:'RECEIPT'});
  const key=Object.keys(sample.expected).find(name=>JSON.stringify((sample.expected as Record<string,unknown>)[name])!==JSON.stringify((sample.after as Record<string,unknown>)[name]))!;
  const forgedBefore={...sample.expected,[key]:(sample.after as Record<string,unknown>)[key]};
  assert.throws(()=>store.result(result({...mutation,before:{properties:forgedBefore}})),{code:'RECEIPT'});
  assert.throws(()=>store.result(result({...mutation,after:{properties:{...sample.after,Name:'extra'}}})),{code:'RECEIPT'});
  store.result(result(mutation));assert.equal(store.command(command.id).state,'succeeded');
  const restored=store.restore({commandId:command.id,requestId:'gui-restore-'+index});assert.equal(restored.method,'scene.restore');assert.deepEqual(restored.args.mutation,mutation);
  assert.throws(()=>store.enqueue({sessionId:pair.sessionId,requestId:'gui-forged-'+index,method:'scene.restore',args:restored.args}),{code:'RESTORE'});
  store.poll(pair.sessionId);store.result({sessionId:pair.sessionId,commandId:restored.id,state:'succeeded',result:{restored:true,ref}});index++;
 }
});

test('GUI observations have exact typed shapes and baselines cover only the requested keys',()=>{
 assert.throws(()=>update('Frame',{Size:u2(.5,0,.5,0),Visible:true},{Size:u2(.75,0,.5,0)}),{code:'BASELINE'});
 assert.throws(()=>update('Frame',{},{}),{code:'BASELINE'});
 for(const expected of [{Size:{type:'Vector3',value:[1,2,3]}},{Size:{type:'UDim2',value:[.5,0,.5]}},{Size:{type:'UDim2',value:[.5,.1,.5,0]}}])assert.throws(()=>update('Frame',expected,{Size:u2(.5,0,.5,0)}),{code:'PROPERTY'});
 assert.throws(()=>update('Frame',{Parent:'invented'},{Parent:'another'}),{code:'PROPERTY'});
 assert.throws(()=>update('Frame',{Visible:'true'},{Visible:false}),{code:'PROPERTY'});
 assert.throws(()=>update('TextLabel',{FontFace:{type:'Font',family:'rbxassetid://1',weight:'Regular'}},{FontFace:{type:'Font',family:'BuilderSans'}}),{code:'PROPERTY'});
});

test('actual MCP SDK preserves GUI observation precision and accepts typed edits without weakening physical validation',async t=>{
 const current=session(),reference={sessionId:current.id,instanceId:'opaque-frame',className:'Frame',root:'StarterGui',pathSegments:['Panel']};
 const observed={Size:u2(.12345679104328156,17,.4000000059604645,20)},calls:{method:string,args:Record<string,Json>}[]=[];
 // Explicit daemon/plugin double; SDK validation, compaction and the core write policy are real.
 const bridge={redact:(value:unknown)=>value,execute:async(_sessionId:string,method:string,args:Record<string,Json>)=>{
   validateCommandArgs(method as 'scene.inspect'|'scene.update',args,current);calls.push({method,args});
   return {terminal:true,state:'succeeded',command:{protocolVersion:1,id:'gui-command-'+calls.length,method,state:'succeeded',error:null,
    result:method==='scene.inspect'?{ref:reference,properties:observed}:{ref:reference,mutation:{kind:'scene.update',before:{properties:args.expected},after:{properties:args.properties}}}}};
 }} as unknown as DaemonClient;
 const server=createMcpServer({client:bridge,projectRoot:process.cwd()}),client=new Client({name:'gui-edit-fixture',version:'1.0.0'});
 t.after(async()=>{await client.close();await server.close();});
 const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();await server.connect(serverTransport);await client.connect(clientTransport);
 const inspected=await client.callTool({name:'scene_inspect',arguments:{sessionId:current.id,ref:reference}});
 const data=inspected.structuredContent as {command:{result:{ref:unknown,properties:typeof observed}}};
 assert.deepEqual(data.command.result.properties,observed);
 const edit=await client.callTool({name:'scene_update',arguments:{sessionId:current.id,ref:data.command.result.ref,expected:data.command.result.properties,properties:{Size:u2(.5,10,.5,10)}}});
 assert.notEqual(edit.isError,true);assert.equal(calls.length,2);assert.deepEqual(calls[1]!.args.expected,observed);
 const invalid=await client.callTool({name:'scene_update',arguments:{sessionId:current.id,ref:{...reference,className:'Part'},expected:{Size:{type:'Vector3',value:[4,1,2]}},properties:{Size:{type:'Vector3',value:[-1,1,2]}}}});
 assert.equal(invalid.isError,true);assert.equal(calls.length,2);
});
