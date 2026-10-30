import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../../apps/mcp/src/server.js';
import {DaemonClient} from '../../apps/mcp/src/daemon-client.js';
import {productInstructions} from '../../apps/mcp/src/skill-router.js';
import {ARCANE_TASK_INSTRUCTIONS} from '../../packages/protocol/src/arcane-tools.js';

function assetScaleGuidance(text:string):void {
  // Keep the exception attached to the asset-scoped default: an explicit NPC,
  // character or mannequin request remains within the user's chosen scene.
  assert.match(text,/No unrequested people\/mannequins\/scale figures; measure dimensions\./);
}

test('managed asset guidance uses measured dimensions and keeps requested characters and human review available',()=>{
  assetScaleGuidance(ARCANE_TASK_INSTRUCTIONS);
  assert.ok(ARCANE_TASK_INSTRUCTIONS.length<5200);
  assert.ok(Buffer.byteLength(ARCANE_TASK_INSTRUCTIONS,'utf8')<5200,'instruction budget is UTF-8 bytes as well as characters');
  assert.ok(ARCANE_TASK_INSTRUCTIONS.includes('Human Approve in 3D before import; agents cannot approve.'));
  assert.ok(ARCANE_TASK_INSTRUCTIONS.includes('Start up to two independent Blender jobs before polling.'));
  assert.ok(ARCANE_TASK_INSTRUCTIONS.includes('No Studio AI, buying/publishing.'));
});

test('standalone MCP initialize delivers the same asset-scoped default without daemon or provider access',async t=>{
  const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('Instruction discovery must stay offline.');});
  const server=createMcpServer({client:new DaemonClient({url:'http://127.0.0.1:1',token:'offline-guidance-fixture'}),projectRoot:process.cwd()});
  const client=new Client({name:'no-scale-figures-guidance-fixture',version:'1.0.0'});
  t.after(async()=>{try{await client.close();}finally{await server.close();}});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  const instructions=client.getInstructions();assert.equal(instructions,productInstructions());assetScaleGuidance(instructions!);
  assert.equal(network.mock.callCount(),0);
});
