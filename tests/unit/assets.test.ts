import {audit,glb,png,manifestFixture} from '../../packages/asset-pipeline/testing/fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssetPipeline, AssetError, normalizeRequest } from '../../packages/asset-pipeline/src/index.js';
import { discoverExecutables } from '../../packages/asset-pipeline/src/discovery.js';
import { runBounded, workerEnvironment } from '../../packages/asset-pipeline/src/process.js';
import { assetName, artifactPath, prepareOutputRoot, noLinks, within } from '../../packages/asset-pipeline/src/paths.js';
import { inspectGlb, inspectPng, validateAudit, validateManifestFiles, sha256, readJson } from '../../packages/asset-pipeline/src/validation.js';
import type { AssetAudit, AssetManifest, MeshMetrics, Artifact } from '../../packages/asset-pipeline/src/types.js';

const ROOT = resolve(process.cwd());
const TEMP = join(ROOT, 'packages', 'asset-pipeline', '.runtime', 'tests');
async function temporary(t: test.TestContext): Promise<string> {
  await mkdir(TEMP,{recursive:true}); const dir = await mkdtemp(join(TEMP, 'arcane-asset-test-'));
  t.after(async () => { assert.ok(within(TEMP, dir)); await noLinks(dir); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
const code = (expected: string) => (e: unknown): boolean => e instanceof AssetError && e.code === expected;
const request = () => normalizeRequest({ template: 'environment-kit', name: 'test-kit', renderResolution: 128 });

test('asset requests have explicit reusable defaults and reject executable/script parameters', () => {
  assert.deepEqual(request().sizeMeters, [3, 3, 2.8]);
  assert.equal(normalizeRequest({template:'hero-prop',name:'chest'}).triangleBudget, 5000);
  for (const input of [null, [], {template:'unknown',name:'valid'}, {template:'hero-prop',name:'valid',python:'arbitrary'}, {template:'hero-prop',name:'valid',sizeMeters:[1,NaN,1]}, {template:'hero-prop',name:'valid',seed:2.2}, {template:'hero-prop',name:'valid',triangleBudget:50001}, {template:'hero-prop',name:'valid',color:[1,0,2]}, {template:'hero-prop',name:'valid',renderResolution:4096}]) assert.throws(()=>normalizeRequest(input));
});
test('names and artifact paths refuse traversal, Windows devices, streams and shell-like names', () => {
  for (const name of ['../escape','C:/out','a:b','con','nul-file','aux','x & y','good\nname','a'.repeat(49)]) assert.throws(()=>assetName(name));
  for (const name of ['../asset.glb','/asset.glb','asset:secret','asset..glb','CON.glb','sub/asset.glb']) assert.throws(()=>artifactPath(ROOT,name));
  assert.equal(assetName('toolbox-42'),'toolbox-42');
});
test('output creation stays in the workspace or OS temp and refuses roots', async t => {
  const dir=await temporary(t); const allowed=join(dir,'new','assets');
  assert.equal(await prepareOutputRoot(ROOT,allowed),allowed);
  for (const path of [ROOT,tmpdir(),resolve(ROOT,'..','escape')]) await assert.rejects(()=>prepareOutputRoot(ROOT,path),code('OUTPUT_PATH'));
});
test('output path checks reject junction/symlink ancestors', async t => {
  const dir=await temporary(t), target=join(dir,'target'), link=join(dir,'link'); await mkdir(target);
  await symlink(target,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>prepareOutputRoot(ROOT,join(link,'out')),code('OUTPUT_PATH'));
  // Unlink the junction explicitly; cleanup never traverses the linked directory.
  await rm(link,{force:true});
});
test('discovery is bounded/read-only and ignores relative PATH entries and Store aliases', async t => {
  const dir=await temporary(t), name=process.platform==='win32'?'blender.exe':'blender';
  await writeFile(join(dir,name),'discovery-only fixture',{mode:0o755});
  const result=await discoverExecutables({knownProgramFiles:[],env:{PATH:'.'+(process.platform==='win32'?';':':')+dir}});
  assert.deepEqual(result.blender,[join(dir,name)]); assert.deepEqual(result.python,[]);
  await assert.rejects(()=>discoverExecutables({blenderExecutable:'blender'}),code('PROCESS_PATH'));
  const missing=await discoverExecutables({blenderExecutable:join(dir,'absent'),pythonExecutable:join(dir,'absent-python'),knownProgramFiles:[],env:{PATH:''}});
  assert.deepEqual(missing,{blender:[],python:[]});
});
test('native supervisor does not invoke a shell and captures split Unicode/event lines', async t => {
  const dir=await temporary(t), lines:string[]=[];
  const result=await runBounded({executable:process.execPath,args:['-e',`const b=Buffer.from('ARCANE_EVENT café 🧩\\n');process.stdout.write(b.subarray(0,b.length-3));setTimeout(()=>process.stdout.write(b.subarray(b.length-3)),10);console.error(process.argv[1]);`,'literal & $ no shell'],cwd:dir},{onLine:line=>lines.push(line)});
  assert.equal(result.exitCode,0);assert.match(result.stderr,/literal & \$ no shell/);assert.deepEqual(lines,['ARCANE_EVENT café 🧩']);
  assert.throws(()=>runBounded({executable:'node',args:[],cwd:dir}),code('PROCESS_PATH'));
  assert.throws(()=>runBounded({executable:join(dir,'run.cmd'),args:[],cwd:dir}),code('PROCESS_PATH'));
});
test('native environment excludes provider credentials and user Python/Blender configuration', async t => {
  const dir=await temporary(t), env=workerEnvironment(dir);
  assert.equal(env.HOME,dir);assert.equal(env.BLENDER_USER_CONFIG,dir); assert.equal(env.PYTHONNOUSERSITE,'1');
  for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','PYTHONPATH','BLENDER_SYSTEM_SCRIPTS','CODEX_HOME']) assert.equal(env[key],undefined);
});
test('supervisor bounds stdout plus stderr and kills/waits for timed out workers', async t => {
  const dir=await temporary(t);
  await assert.rejects(()=>runBounded({executable:process.execPath,args:['-e',"process.stdout.write('x'.repeat(400));process.stderr.write('y'.repeat(400));setTimeout(()=>{},10000)"],cwd:dir},{maxOutputBytes:512}),code('PROCESS_OUTPUT'));
  const marker=join(dir,'late.txt');
  const worker="setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'worker survived'),500);setTimeout(()=>{},10000)";
  await assert.rejects(()=>runBounded({executable:process.execPath,args:['-e',worker,marker],cwd:dir},{deadlineMs:100}),code('DEADLINE'));
  await new Promise(resolve=>setTimeout(resolve,550));
  await assert.rejects(()=>readFile(marker));
});
test('cancellation terminates an in-flight worker; a pre-aborted operation never launches', async t => {
  const dir=await temporary(t), controller=new AbortController();
  const pending=runBounded({executable:process.execPath,args:['-e','setTimeout(()=>{},10000)'],cwd:dir},{signal:controller.signal});
  controller.abort();await assert.rejects(()=>pending,code('CANCELLED'));
  await assert.rejects(()=>runBounded({executable:process.execPath,args:['-e','throw new Error("launched")'],cwd:dir},{signal:controller.signal}),code('CANCELLED'));
});
test('observer failures do not stop the worker and nonexistent native executables fail explicitly', async t => {
  const dir=await temporary(t);
  const result=await runBounded({executable:process.execPath,args:['-e',"console.log('line')"],cwd:dir},{onLine:()=>{throw new Error('observer')}});
  assert.equal(result.exitCode,0);
  await assert.rejects(()=>runBounded({executable:join(dir,'missing.exe'),args:[],cwd:dir}),code('PROCESS_START'));
});

test('mesh metrics gate non-manifold, normal, UV, transform and budget errors, even if errors array is empty', () => {
  assert.deepEqual(validateAudit(audit(),request()).totals,audit().totals);
  for(const field of ['nonManifoldEdges','looseVertices','looseEdges','duplicateVertices','duplicateFaces','degenerateFaces','inconsistentNormals','invertedComponents','invalidUVs','degenerateUVFaces']) {
    const a=audit(); (a.meshes[0] as unknown as Record<string,unknown>)[field]=1;assert.throws(()=>validateAudit(a,request()),code('MESH'));
  }
  const transform=audit(); transform.meshes[0]!.scale=[2,1,1];assert.throws(()=>validateAudit(transform,request()),code('MESH'));
  const uv=audit();uv.meshes[0]!.uvLoops=0;assert.throws(()=>validateAudit(uv,request()));
  const missing=audit();missing.savedSceneReopened=false;assert.throws(()=>validateAudit(missing,request()),code('MESH'));
  const totals=audit();totals.totals.renderTriangles=5;assert.throws(()=>validateAudit(totals,request()),code('MESH'));
  const exportAudit=audit();exportAudit.exports[0]!.triangles=3;assert.throws(()=>validateAudit(exportAudit,request()),code('EXPORT'));
});
test('uniform previews and a hero LOD that does not reduce triangles fail the audit', () => {
  const a=audit();a.renders[0]!.standardDeviation=0;assert.throws(()=>validateAudit(a,request()),code('RENDER'));
  const hero={...audit(),template:'hero-prop' as const};assert.throws(()=>validateAudit(hero,normalizeRequest({template:'hero-prop',name:'test'})),code('MESH'));
});

test('GLB validation reads actual positions, normals, indices and triangle areas', () => {
  assert.equal(inspectGlb(glb()).triangles,4);
  for(const corrupted of [glb((_d,b)=>b.writeFloatLE(NaN,0)),glb((_d,b)=>b.writeUInt8(99,96)),glb((_d,b)=>b.writeUInt8(0,97)),glb((_d,b)=>b.writeFloatLE(0,56)),glb((d)=>{(d.buffers as {uri?:string}[])[0]!.uri='https://external.invalid/data';}),glb((d)=>{(d.accessors as {count:number}[])[0]!.count=500000;})]) assert.throws(()=>inspectGlb(corrupted),code('EXPORT'));
  const truncated=glb().subarray(0,30);assert.throws(()=>inspectGlb(truncated),code('EXPORT'));
});
test('PNG decoder accepts nonuniform pixels and rejects uniform, truncated and wrong-size previews', () => {
  inspectPng(png(),128);
  for(const [bytes,size] of [[png(true),128],[png().subarray(0,100),128],[png(),256]] as const)assert.throws(()=>inspectPng(bytes,size),code('RENDER'));
});
test('manifest verification cross-checks hashes, files, metrics and independent GLB/PNG bytes', async t => {
  const dir=await temporary(t), m=await manifestFixture(dir);
  assert.equal((await validateManifestFiles(dir,m)).jobId,m.jobId);
  const missing=structuredClone(m);missing.artifacts=missing.artifacts.filter(a=>a.path!=='blockout.blend');await assert.rejects(()=>validateManifestFiles(dir,missing),code('MANIFEST'));
  const duplicate=structuredClone(m);duplicate.artifacts.push(duplicate.artifacts[0]!);await assert.rejects(()=>validateManifestFiles(dir,duplicate),code('MANIFEST'));
  const escape=structuredClone(m);escape.artifacts[0]!.path='../escape';await assert.rejects(()=>validateManifestFiles(dir,escape),code('OUTPUT_PATH'));
  await writeFile(join(dir,'asset.glb'),Buffer.alloc(m.artifacts.find(a=>a.path==='asset.glb')!.bytes));await assert.rejects(()=>validateManifestFiles(dir,m),code('HASH'));
});
test('manifest rejects a forged audit even when all file hashes are recomputed', async t => {
  const dir=await temporary(t),m=await manifestFixture(dir);m.validation.meshes[0]!.nonManifoldEdges=1;
  await writeFile(join(dir,'audit.json'),JSON.stringify(m.validation));const a=m.artifacts.find(a=>a.path==='audit.json')!,bytes=await readFile(join(dir,'audit.json'));a.bytes=bytes.length;a.sha256=sha256(bytes);
  await assert.rejects(()=>validateManifestFiles(dir,m),code('MESH'));
});
test('job cancellation/busy/failed-runtime states are truthful and recoverable without Blender', async t => {
  const dir=await temporary(t),output=join(dir,'assets'),config={workspaceRoot:ROOT,outputRoot:output,blenderExecutable:join(dir,'missing-blender'),pythonExecutable:join(dir,'missing-python')};
  const p=createAssetPipeline(config),events:string[]=[];
  const job=p.start({template:'hero-prop',name:'unavailable'},{onEvent:e=>events.push(e.stage)});
  assert.throws(()=>createAssetPipeline(config).start({template:'hero-prop',name:'second'}),code('BUSY'));
  const result=await job.completion;assert.equal(result.state,'failed');assert.equal(result.error?.code,'BLENDER_UNAVAILABLE');assert.equal(result.manifestPath,null);
  assert.ok(events.includes('complete'));const recovery=await p.recover(job.directory);assert.equal(recovery.result.state,'failed');assert.equal(recovery.checkpointPath,null);
  const cancelled=p.start({template:'hero-prop',name:'cancelled'});cancelled.cancel();assert.equal((await cancelled.completion).state,'cancelled');
});
test('recovery marks lost supervision without rerunning a job or trusting a stored outside path', async t => {
  const dir=await temporary(t), output=join(dir,'assets'),jobDir=join(output,'interrupted');await mkdir(jobDir,{recursive:true});
  await writeFile(join(jobDir,'job.json'),JSON.stringify({schemaVersion:1,jobId:'22222222-2222-4222-8222-222222222222',state:'running',directory:'/outside',manifestPath:'/outside',error:null}));await writeFile(join(jobDir,'blockout.blend'),'retained checkpoint');
  const p=createAssetPipeline({workspaceRoot:ROOT,outputRoot:output}),r=await p.recover(jobDir);
  assert.equal(r.result.state,'interrupted');assert.equal(r.result.error?.code,'SUPERVISION_LOST');assert.equal(r.result.directory,jobDir);assert.equal(r.checkpointPath,join(jobDir,'blockout.blend'));assert.equal((await readJson(join(jobDir,'job.json')) as {state:string}).state,'interrupted');
  await assert.rejects(()=>p.recover(dir),code('OUTPUT_PATH'));
});
test('worker scripts contain fixed-template audit, reopen, roundtrip and CPU-render gates', async () => {
  const worker=await readFile(join(ROOT,'workers','blender','asset_worker.py'),'utf8'),auditSource=await readFile(join(ROOT,'workers','blender','audit.py'),'utf8');
  for(const evidence of ['audit_scene','export_metrics','use_scripts=False','blockout.blend','scene.cycles.device = "CPU"'])assert.ok(worker.includes(evidence));
  for(const metric of ['is_manifold','is_contiguous','calc_area','degenerateUVFaces','invertedComponents'])assert.ok(auditSource.includes(metric));
  assert.ok(!/subprocess|urllib|requests\.|pip install/.test(worker+auditSource));
});

test('PNG CRC, manifest artifact roles and duplicate render evidence fail verification', async t => {
  const corrupted=png(); corrupted[corrupted.length-1]=corrupted[corrupted.length-1]!^1;
  assert.throws(()=>inspectPng(corrupted,128),code('RENDER'));
  const a=audit(); a.renders[1]!.path=a.renders[0]!.path;
  assert.throws(()=>validateAudit(a,request()),code('RENDER'));
  const dir=await temporary(t),m=await manifestFixture(dir);
  m.artifacts.find(a=>a.path==='preview-hero.png')!.role='worker';
  await assert.rejects(()=>validateManifestFiles(dir,m),code('MANIFEST'));
});

test('normalized input vectors are snapshots and recovery refuses forged terminal errors', async t => {
  const size:[number,number,number]=[1,2,3],input=normalizeRequest({template:'hero-prop',name:'snapshot',sizeMeters:size});
  size[0]=99;assert.deepEqual(input.sizeMeters,[1,2,3]);
  const dir=await temporary(t),output=join(dir,'assets'),jobDir=join(output,'bad-journal');
  await mkdir(jobDir,{recursive:true});
  await writeFile(join(jobDir,'job.json'),JSON.stringify({schemaVersion:1,jobId:'33333333-3333-4333-8333-333333333333',state:'failed',error:{code:7,message:'/outside'}}));
  const p=createAssetPipeline({workspaceRoot:ROOT,outputRoot:output});
  await assert.rejects(()=>p.recover(jobDir),code('RECOVERY'));
});
