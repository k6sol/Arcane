import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCANE_TOOL_NAMES, missingArcaneTools, ARCANE_TASK_INSTRUCTIONS } from '../../packages/protocol/src/arcane-tools.js';
import { requireArcaneBuildTools, arcaneThreadIsIsolated, type McpInventoryRow } from '../../packages/codex-client/src/mcp-isolation.js';

const row=(toolNames:readonly string[]):McpInventoryRow=>({name:'arcane',runtimeStatus:'connected',toolNames:[...toolNames],toolsError:false,plugin:false,pluginId:null});
test('a connected read-only bridge is not build-ready',()=>{
 const readonly=row(['sessions','scene_children']);
 assert.equal(arcaneThreadIsIsolated([readonly]),true);
 assert.throws(()=>requireArcaneBuildTools([readonly]),{code:'MCP_CAPABILITIES'});
});
test('every reviewed build, recovery, skills and asset tool is required',()=>{
 assert.equal(new Set(ARCANE_TOOL_NAMES).size,ARCANE_TOOL_NAMES.length);
 assert.deepEqual(missingArcaneTools(ARCANE_TOOL_NAMES),[]);
 assert.doesNotThrow(()=>requireArcaneBuildTools([row(ARCANE_TOOL_NAMES)]));
 for(const omitted of ARCANE_TOOL_NAMES){
  assert.deepEqual(missingArcaneTools(ARCANE_TOOL_NAMES.filter(name=>name!==omitted)),[omitted]);
  assert.throws(()=>requireArcaneBuildTools([row(ARCANE_TOOL_NAMES.filter(name=>name!==omitted))]),{code:'MCP_CAPABILITIES'});
 }
});
test('native task instructions require automatic choice and evidence, not invented verification',()=>{
 for(const text of ['skills_recommend','scene_create','scene_update','script_update','user should not choose','exact session/root/edit-mode','mutation receipts'])assert.ok(ARCANE_TASK_INSTRUCTIONS.includes(text));
 assert.ok(!ARCANE_TASK_INSTRUCTIONS.includes('approvalPolicy=never'));
});
