import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {z} from 'zod';
import {validateCommandArgs} from '../../packages/core/src/studio-policy.js';
import {READ_METHODS,WRITE_METHODS,STUDIO_GUI_CAPABILITY,STUDIO_FEATURE_CAPABILITIES,type StudioSession,type Json,type InstanceRef} from '../../packages/protocol/src/studio.js';
import {compileSceneBuild,sceneBuildShape,type SceneBuildInput} from '../../apps/mcp/src/scene-build.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';

const FLEX='scene.gui.flex';
const session=(flex=false):StudioSession=>({id:'flex-session',protocolVersion:1,clientSessionId:'flex-window',placeId:0,universeId:0,name:'GUI fixture',pluginVersion:'0.2.0',allowedRoots:['StarterGui'],allowWrites:true,
 capabilities:[...READ_METHODS,...WRITE_METHODS,STUDIO_GUI_CAPABILITY,...(flex?[FLEX]:[])],connectedAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),revokedAt:null});
const ref=(className:string,pathSegments:string[]=[className]):InstanceRef=>({sessionId:'flex-session',instanceId:'opaque-'+className,root:'StarterGui',className,pathSegments});
const build=(input:Record<string,unknown>)=>compileSceneBuild(z.strictObject(sceneBuildShape).parse(input) as SceneBuildInput,ref('StarterGui',[]) as unknown as Json).args;
const create=(className:string,properties:Record<string,Json>,s=session())=>validateCommandArgs('scene.create',{className,name:'Responsive',parent:ref('Frame') as unknown as Json,properties},s);

test('flex classes and every list flex property require the loaded plugin feature, while basic GUI remains available',()=>{
 assert.ok(create('UIListLayout',{Padding:{type:'UDim',value:[0,8]}}));
 for(const [className,properties]of [['UIFlexItem',{}],['UIListLayout',{Wraps:false}],['UIListLayout',{HorizontalFlex:'SpaceBetween'}],['UIListLayout',{VerticalFlex:'Fill'}],['UIListLayout',{ItemLineAlignment:'Automatic'}]] as const){
  assert.throws(()=>create(className,properties),{code:'PLUGIN_UPDATE_REQUIRED'},className+' '+JSON.stringify(properties));
  assert.ok(create(className,properties,session(true)));
 }
 assert.throws(()=>create('UIFlexItem',{}, {...session(true),allowWrites:false}),{code:'READ_ONLY'});
 assert.throws(()=>create('UIFlexItem',{}, {...session(true),allowedRoots:['Workspace']}),{code:'SCOPE'});
});

test('batch GUI items, prototype children and stamp overrides cannot bypass the flex feature',()=>{
 const cases=[
  {name:'Direct',container:'ScreenGui',items:[{key:'Panel',className:'Frame',name:'Panel',ui:{}},{in:'Panel',className:'UIFlexItem',name:'Flex',ui:{FlexMode:'Grow'}}]},
  {name:'Prototype',container:'ScreenGui',prototypes:{Card:{ui:[{className:'Frame',name:'Card',ui:{}},{className:'UIListLayout',name:'Layout',in:'Card',ui:{Wraps:true}}]}},items:[{use:'Card',name:'Card'}]},
  {name:'Override',container:'ScreenGui',prototypes:{Layout:{ui:[{className:'UIListLayout',name:'Layout',ui:{}}]}},items:[{key:'Panel',className:'Frame',name:'Panel',ui:{}},{in:'Panel',use:'Layout',name:'Layout',ui:{HorizontalFlex:'SpaceEvenly'}}]}
 ];
 for(const input of cases){const args=build(input);assert.throws(()=>validateCommandArgs('scene.build',args,session()),{code:'PLUGIN_UPDATE_REQUIRED'},input.name);assert.ok(validateCommandArgs('scene.build',args,session(true)));}
});

test('an older paired plugin refuses flex before queueing any command and can still create ordinary UI',t=>{
 const directory=mkdtempSync(join(tmpdir(),'arcane-flex-store-')),store=new StudioStore({directory});
 t.after(()=>{store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())));rmSync(directory,{recursive:true,force:true});});
 const grant=store.createGrant({allowedRoots:['StarterGui'],allowWrites:true});
 const paired=store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'older-gui',placeId:0,universeId:0,name:'GUI fixture',pluginVersion:'0.2.0'},capabilities:session().capabilities});
 const parent={...ref('Frame'),sessionId:paired.sessionId};
 assert.throws(()=>store.enqueue({sessionId:paired.sessionId,requestId:'flex-denied-001',method:'scene.create',args:{parent,className:'UIFlexItem',name:'Flex',properties:{FlexMode:'Fill'}}}),{code:'PLUGIN_UPDATE_REQUIRED'});
 assert.equal(store.commands(paired.sessionId).length,0);
 const ordinary=store.enqueue({sessionId:paired.sessionId,requestId:'basic-gui-001',method:'scene.create',args:{parent,className:'UIListLayout',name:'Layout',properties:{}}});
 assert.equal(ordinary.state,'queued');assert.equal(store.commands(paired.sessionId).length,1);
 assert.ok(STUDIO_FEATURE_CAPABILITIES.includes(FLEX));
});
