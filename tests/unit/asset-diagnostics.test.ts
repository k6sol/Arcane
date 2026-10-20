import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {setImmediate as nextTurn,setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {AssetPipeline} from '../../packages/asset-pipeline/src/index.js';
import {createAssetService} from '../../apps/daemon/src/asset-service.js';
import type {DiagnosticEvent} from '../../packages/diagnostics/src/report.js';
import {assetJob} from '../../apps/mcp/src/asset-schemas.js';
test('asset failure retains its cause, attaches only the acknowledged report id and restores that display id on reload',async t=>{
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'arcane-diagnostic-job-')),workers=join(root,'workers'),outputRoot=join(root,'assets');
  t.after(async()=>{const actual=await realpath(root),child=relative(base,actual);assert.ok(!isAbsolute(child)&&child.startsWith('arcane-diagnostic-job-')&&!child.includes(sep)&&!child.includes('..'));await rm(actual,{recursive:true,force:true});});
  await mkdir(workers);for(const name of ['asset_worker.py','audit.py','probe.py'])await writeFile(join(workers,name),'# fixed fixture worker\n');
  const pipeline=new AssetPipeline({workspaceRoot:root,outputRoot,workerRoot:workers},{discover:async()=>({blender:[process.execPath],python:[]}),
    queryHost:{platform:'linux',systemRoot:undefined,execFile:()=>{throw Error('No process query is allowed');}},
    run:async(spec,options={})=>{await options.supervise?.spawned({pid:12345,exited:()=>true});options.supervise?.closed();
      if(!spec.args.includes('--mode'))return{exitCode:0,signal:null,stderr:'',stdout:'ARCANE_RESULT '+JSON.stringify({version:'4.5.0',pythonVersion:'3.11.0',background:true,capabilities:{glbExport:true,glbImport:true,fbxExport:true,fbxImport:true,cycles:true}})};
      return{exitCode:1,signal:null,stderr:'private raw worker message',stdout:'ARCANE_FAILURE '+JSON.stringify({schemaVersion:1,stage:'mesh-validation',reasonCode:'MESH_AUDIT',exceptionType:'ValueError',metrics:{renderTriangles:420,triangleBudget:100}})};
    }});
  const original=AssetPipeline.prototype.start;t.mock.method(AssetPipeline.prototype,'start',function(...args:Parameters<typeof original>){return original.apply(pipeline,args);});
  let release:(id:string|null)=>void=()=>{},reported:DiagnosticEvent|null=null,fixtureClosing=false;
  const service=await createAssetService({cwd:root,outputRoot,workerRoot:workers,reportFailure:async event=>{if(fixtureClosing)return null;reported=event;return new Promise<string|null>(done=>{release=done;});}});
  t.after(()=>{fixtureClosing=true;release(null);return service.close();});
  async function wait(predicate:()=>boolean){const end=Date.now()+1000;while(Date.now()<end){if(predicate())return;await delay(5);}assert.fail('Fixture transition did not complete');}
  const first=await service.start({template:'hero-prop',name:'crate'});await wait(()=>reported!==null);
  assert.equal(service.jobs()[0]!.state,'failed');assert.equal(service.jobs()[0]!.reportId,undefined);
  assert.equal((reported as DiagnosticEvent|null)?.stage,'mesh-validation');assert.ok(!JSON.stringify(reported).includes('private'));
  release(randomUUID());await wait(()=>service.jobs().find(job=>job.jobId===first.jobId)?.state==='failed');await nextTurn();
  assert.equal(service.jobs().find(job=>job.jobId===first.jobId)!.reportId,undefined,'an unrelated id is never attached');
  reported=null;const second=await service.start({template:'hero-prop',name:'crate'});await wait(()=>reported!==null);const accepted=(reported as DiagnosticEvent|null)!.eventId;
  release(accepted);await wait(()=>service.jobs().find(job=>job.jobId===second.jobId)?.reportId===accepted);
  const final=service.jobs().find(job=>job.jobId===second.jobId)!;assert.equal(final.error?.diagnostic?.reasonCode,'MESH_AUDIT');assert.match(final.error!.message,/420 is outside/);
  assert.equal(assetJob.parse(final).reportId,accepted);assert.throws(()=>assetJob.parse({...final,reportId:'not-a-report-id'}));
  await service.close();const reopened=await createAssetService({cwd:root,outputRoot,workerRoot:workers});
  try{assert.equal(reopened.jobs().find(job=>job.jobId===second.jobId)?.reportId,accepted);assert.equal(reopened.jobs().find(job=>job.jobId===second.jobId)?.state,'failed');}finally{await reopened.close();}
});
