import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCANE_TOOL_NAMES, ARCANE_NATIVE_TOOL_NAMES, missingArcaneTools, ARCANE_TASK_INSTRUCTIONS } from '../../packages/protocol/src/arcane-tools.js';
import { CHOICE_BLOCK_LIMITS, parseChoiceBlock } from '../../apps/desktop/src/codex-chat.js';
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
test('shared instructions resolve the composer @selection mention with selection_read for both providers',()=>{
 assert.ok(ARCANE_TASK_INSTRUCTIONS.includes('@selection means the current Studio selection; read it with selection_read.'));
});
test('managed task instructions state the host-verified inventory and require tool search before reporting build tools missing',()=>{
 for(const text of ['This managed host verified before the turn','scene_create, scene_update and script_update','tool search','instead of reporting them missing or applying nothing',
   'If search is unavailable or fails, report that actual boundary and never fabricate a call'])assert.ok(ARCANE_TASK_INSTRUCTIONS.includes(text),text);
 assert.ok(!/report that exact inventory mismatch/.test(ARCANE_TASK_INSTRUCTIONS));
});
test('managed task instructions describe the optional arcane-choices and arcane-plan blocks in the shape the chat renderer accepts',()=>{
 const choices='fenced block in language arcane-choices holding only JSON {"question":"...","options":["...","..."]} with '+CHOICE_BLOCK_LIMITS.minOptions+' to '+CHOICE_BLOCK_LIMITS.options;
 const plan='fenced block in language arcane-plan holding only JSON {"steps":["...","..."]} with 1 to '+CHOICE_BLOCK_LIMITS.steps;
 for(const text of [choices,plan,'Use at most one such block per reply','an explicit in-scope build request needs no plan approval'])assert.ok(ARCANE_TASK_INSTRUCTIONS.includes(text),text);
 // The described shapes, filled in, are exactly what the shared renderer turns into buttons.
 assert.deepEqual(parseChoiceBlock('arcane-choices',JSON.stringify({question:'Which door?',options:['Wood','Glass']})),{kind:'choices',question:'Which door?',options:['Wood','Glass']});
 assert.deepEqual(parseChoiceBlock('arcane-plan',JSON.stringify({steps:['Build the frame','Add the hinge']})),{kind:'plan',steps:['Build the frame','Add the hinge']});
 // An option is sent verbatim when clicked: CLI slash/shell commands and invisible text never become buttons.
 for(const bad of ['/clear',' /some-command','!rm -rf .','Wood​','Glass\u{e0041}'])
  assert.equal(parseChoiceBlock('arcane-choices',JSON.stringify({question:'Which door?',options:['Wood',bad]})),null,JSON.stringify(bad));
 assert.ok(ARCANE_TASK_INSTRUCTIONS.indexOf('arcane-choices')>ARCANE_TASK_INSTRUCTIONS.indexOf('Do not claim an edit'),'existing evidence guarantees come first');
});

test('native asset readiness requires adoption, preparation, staging, detached reconstruction and historical status',()=>{
 assert.equal(Object.isFrozen(ARCANE_TOOL_NAMES),true);
 assert.equal(Object.isFrozen(ARCANE_NATIVE_TOOL_NAMES),true);
 assert.deepEqual(ARCANE_NATIVE_TOOL_NAMES,[...ARCANE_TOOL_NAMES,'assets_adopt_glb','assets_prepare_studio_import','assets_stage_studio_import','assets_studio_staging_status','assets_reconstruct_studio_import','assets_studio_reconstruction_status','assets_place_studio_import']);
 assert.equal(new Set(ARCANE_NATIVE_TOOL_NAMES).size,ARCANE_NATIVE_TOOL_NAMES.length);
 assert.deepEqual(missingArcaneTools(ARCANE_TOOL_NAMES,true),['assets_adopt_glb','assets_prepare_studio_import','assets_stage_studio_import','assets_studio_staging_status','assets_reconstruct_studio_import','assets_studio_reconstruction_status','assets_place_studio_import']);
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
test('managed task instructions keep builds fast, token-lean, natural and DataStore-safe',()=>{
 for(const text of ['scene_build','environment_apply','plan once','few large batches','never re-read unchanged state','never rings or grids','Terrain ground','PLUGIN_UPDATE_REQUIRED',
   'never wipe, rename or migrate existing keys','UpdateAsync','session locking','BindToClose'])assert.ok(ARCANE_TASK_INSTRUCTIONS.toLowerCase().includes(text.toLowerCase()),text);
 assert.ok(ARCANE_TOOL_NAMES.includes('scene_build')&&ARCANE_TOOL_NAMES.includes('environment_apply'));
 for(const text of ['conversation context','shorthand and follow-ups','Reply naturally','omit internal reviews'])assert.ok(ARCANE_TASK_INSTRUCTIONS.includes(text),text);
 assert.ok(ARCANE_TASK_INSTRUCTIONS.length<5200,'instructions stay concise');
});

test('native Studio asset tools remain available with original assets as the default',()=>{
 for(const name of ['studio_asset_search','studio_asset_insert','studio_asset_generate']){
  assert.ok(ARCANE_TOOL_NAMES.includes(name as never),name);assert.ok(ARCANE_NATIVE_TOOL_NAMES.includes(name as never),name);
  assert.deepEqual(missingArcaneTools(ARCANE_TOOL_NAMES.filter(item=>item!==name)),[name]);
 }
 assert.equal(new Set(ARCANE_TOOL_NAMES).size,ARCANE_TOOL_NAMES.length,'no name collisions with the assets_* pipeline');
 assert.match(ARCANE_TASK_INSTRUCTIONS,/Original assets by default/);
 assert.match(ARCANE_TASK_INSTRUCTIONS,/Do not search for or insert Toolbox\/Creator Store models unless the user explicitly requests them/);
 assert.doesNotMatch(ARCANE_TASK_INSTRUCTIONS,/studio_asset_search first|studio_asset_generate only when nothing suitable exists/);
});

test('the read-only viewport tool is a required build tool and the instructions bound visual checks',()=>{
 assert.ok(ARCANE_TOOL_NAMES.includes('studio_viewport_capture'));
 assert.ok(ARCANE_NATIVE_TOOL_NAMES.includes('studio_viewport_capture'));
 assert.deepEqual(missingArcaneTools(ARCANE_TOOL_NAMES.filter(name=>name!=='studio_viewport_capture')),['studio_viewport_capture']);
 assert.match(ARCANE_TASK_INSTRUCTIONS,/studio_viewport_capture[^.]*critique the image against the request[^.]*then fix what you see/);
 assert.match(ARCANE_TASK_INSTRUCTIONS,/at most 2–3 checks per task/);
});
