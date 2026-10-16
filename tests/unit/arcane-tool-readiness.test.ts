import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCANE_TOOL_NAMES, ARCANE_NATIVE_TOOL_NAMES, missingArcaneTools, ARCANE_TASK_INSTRUCTIONS } from '../../packages/protocol/src/arcane-tools.js';
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
test('managed task instructions state the host-verified inventory and require tool search before reporting build tools missing',()=>{
 for(const text of ['This managed host verified before the turn','scene_create, scene_update and script_update','tool search','instead of reporting them missing or applying nothing',
   'If search is unavailable or fails, report that actual boundary and never fabricate a call'])assert.ok(ARCANE_TASK_INSTRUCTIONS.includes(text),text);
 assert.ok(!/report that exact inventory mismatch/.test(ARCANE_TASK_INSTRUCTIONS));
});

test('native asset readiness requires adoption, preparation, staging, detached reconstruction and historical status',()=>{
 assert.equal(Object.isFrozen(ARCANE_TOOL_NAMES),true);
 assert.equal(Object.isFrozen(ARCANE_NATIVE_TOOL_NAMES),true);
 assert.deepEqual(ARCANE_NATIVE_TOOL_NAMES,[...ARCANE_TOOL_NAMES,'assets_adopt_glb','assets_prepare_studio_import','assets_stage_studio_import','assets_studio_staging_status','assets_reconstruct_studio_import','assets_studio_reconstruction_status']);
 assert.equal(new Set(ARCANE_NATIVE_TOOL_NAMES).size,ARCANE_NATIVE_TOOL_NAMES.length);
 assert.deepEqual(missingArcaneTools(ARCANE_TOOL_NAMES,true),['assets_adopt_glb','assets_prepare_studio_import','assets_stage_studio_import','assets_studio_staging_status','assets_reconstruct_studio_import','assets_studio_reconstruction_status']);
 assert.deepEqual(missingArcaneTools(ARCANE_NATIVE_TOOL_NAMES,true),[]);
 assert.doesNotThrow(()=>requireArcaneBuildTools([row(ARCANE_TOOL_NAMES)]));
 assert.doesNotThrow(()=>requireArcaneBuildTools([row(ARCANE_NATIVE_TOOL_NAMES)],true));
 assert.throws(()=>requireArcaneBuildTools([row(ARCANE_TOOL_NAMES)],true),{code:'MCP_CAPABILITIES'});
 for(const omitted of ARCANE_NATIVE_TOOL_NAMES){
  const partial:readonly string[]=ARCANE_NATIVE_TOOL_NAMES.filter(name=>name!==omitted);
  assert.deepEqual(missingArcaneTools(partial,true),[omitted]);
  assert.throws(()=>requireArcaneBuildTools([row(partial)],true),{code:'MCP_CAPABILITIES'});
 }
 const inherited={...row(['assets_adopt_glb','assets_prepare_studio_import','assets_stage_studio_import','assets_studio_staging_status','assets_reconstruct_studio_import','assets_studio_reconstruction_status']),name:'inherited',runtimeStatus:'disabled'};
 assert.throws(()=>requireArcaneBuildTools([row(ARCANE_TOOL_NAMES),inherited],true),{code:'MCP_CAPABILITIES'});
});
