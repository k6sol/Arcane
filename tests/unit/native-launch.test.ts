import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { nativeLaunchPlan } from '../../packages/model-adapters/src/native-launch.js';
import type { Connection } from '../../packages/protocol/src/providers.js';
const root=resolve('.');
const codex:Connection={provider:'codex',installed:true,version:'fixture',auth:'subscription',plan:'fixture',models:[{id:'gpt-6.1-sol',label:'Sol',efforts:['high','ultra'],defaultEffort:'high',source:'runtime-catalogue',entitlement:'unverified',inputModalities:['text','image']}],features:[],warnings:[],observedAt:new Date().toISOString(),revision:'fixture-revision'};
const options={executable:join(root,'codex.exe'),nodePath:process.execPath,projectPath:root,arcanePath:root};
test('native Codex handoff preserves exact model/ultra effort and guarded tool configuration without token values',()=>{
 const plan=nativeLaunchPlan({provider:'codex',model:'gpt-6.1-sol',effort:'ultra',connectionRevision:codex.revision},[codex],options);
 assert.equal(plan.applied,false);assert.equal(plan.inferenceStarted,false);assert.ok(plan.args.includes('model_reasoning_effort="ultra"'));
 assert.ok(plan.args.includes('on-request'));assert.ok(plan.args.includes('workspace-write'));assert.equal(plan.args.some(a=>a.includes('bypass')||a.includes('fallback')),false);
 assert.ok(plan.args.includes('mcp_servers.arcane.env_vars=["ARCANE_DAEMON_URL","ARCANE_LOCAL_TOKEN"]'));
 assert.deepEqual(plan.environmentNames,['ARCANE_DAEMON_URL','ARCANE_LOCAL_TOKEN']);
});
test('native handoff refuses stale or unsupported choices, API-mode auth and relative executable paths',()=>{
 const input={provider:'codex',model:'gpt-6.1-sol',effort:'ultra',connectionRevision:codex.revision};
 assert.throws(()=>nativeLaunchPlan({...input,effort:'max'},[codex],options));
 assert.throws(()=>nativeLaunchPlan({...input,connectionRevision:'stale'},[codex],options));
 assert.throws(()=>nativeLaunchPlan(input,[{...codex,auth:'api-or-cloud'}],options));
 assert.throws(()=>nativeLaunchPlan(input,[codex],{...options,executable:'codex.exe'}));
});
