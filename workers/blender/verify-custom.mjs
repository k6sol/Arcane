
/** Native custom recipe acceptance: installed Blender and real HTTP bytes, no synthetic asset fixtures. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compiled=join(root,'packages/asset-pipeline/.runtime/compiled');
const {createAssetPipeline, normalizeRequest}=await import(pathToFileURL(join(compiled,'packages/asset-pipeline/src/index.js')));
const {preflightRecipe,expectedSockets}=await import(pathToFileURL(join(compiled,'packages/asset-pipeline/src/recipe.js')));
const {createAssetService}=await import(pathToFileURL(join(compiled,'apps/daemon/src/asset-service.js')));
const {assetRoutes}=await import(pathToFileURL(join(compiled,'apps/daemon/src/asset-routes.js')));
const input=JSON.parse(await readFile(join(root,'workers/blender/custom-machine.json'),'utf8'));
const request=normalizeRequest(input), planned=preflightRecipe(request.recipe, request.triangleBudget);
const outputRoot=join(root,'packages/asset-pipeline/.runtime/custom-verification-'+randomUUID());
await mkdir(outputRoot);
const service=await createAssetService({cwd:root,outputRoot,jobDeadlineMs:300000});
const pipeline=createAssetPipeline({workspaceRoot:root,outputRoot});
const control=randomBytes(32).toString('hex'),agent=randomBytes(32).toString('hex');
const routes=assetRoutes(service);
let origin='';
const server=createServer(async(req,res)=>{if(!await routes(req,res,new URL(req.url??'/',origin),control,origin,agent)){res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
const call=(path,method='GET',body,token=agent)=>fetch(origin+'/v1/assets/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Origin:origin},...(body===undefined?{}:{body:JSON.stringify(body)})});
const evidence={schemaVersion:1,observedAt:new Date().toISOString(),outputRoot,planned,checks:{}};
try {
  const probe=await call('probe','POST',{});assert.equal(probe.status,200);evidence.probe=(await probe.json()).probe;assert.equal(evidence.probe.available,true);
  console.log(JSON.stringify({stage:'native-custom-probe',runtime:evidence.probe.blender,planned}));
  const response=await call('start','POST',input);assert.equal(response.status,202,await response.clone().text());
  const {job}=await response.json();assert.deepEqual(job.request,request);
  let current, lastStage;const end=Date.now()+330000;
  while(Date.now()<end){
    const listing=await call('jobs?limit=1');assert.equal(listing.status,200);
    const text=await listing.text();assert.ok(Buffer.byteLength(text)<=512*1024);
    const page=JSON.parse(text);assert.equal(page.total,1);assert.equal(page.nextCursor,null);
    current=page.jobs[0];assert.equal(current.jobId,job.jobId);assert.deepEqual(current.request.recipe,request.recipe);
    if(current.stage!==lastStage){console.log(JSON.stringify({jobId:job.jobId,state:current.state,stage:current.stage}));lastStage=current.stage;}
    if(current.state!=='running')break;
    await new Promise(r=>setTimeout(r,250));
  }
  assert.equal(current.state,'succeeded',JSON.stringify(current.error));
  const manifestResponse=await call('manifest?jobId='+job.jobId);assert.equal(manifestResponse.status,200);
  const manifest=(await manifestResponse.json()).manifest;
  assert.deepEqual(manifest.request,request);
  const deep=await pipeline.validate(current.manifestPath,{deep:true,deadlineMs:120000});
  assert.deepEqual(deep,manifest);
  assert.equal(manifest.validation.savedSceneReopened,true);
  assert.equal(manifest.validation.meshes.length,request.recipe.parts.length);
  assert.equal(manifest.validation.totals.materials,4);
  assert.ok(manifest.validation.totals.lod1Triangles>0&&manifest.validation.totals.lod1Triangles<manifest.validation.totals.renderTriangles);
  assert.equal(manifest.assembly.sockets.length,2);
  for(const role of ['render','collision','lod1'])assert.deepEqual(manifest.validation.meshes.filter(m=>m.role===role).map(m=>m.name).sort(),request.recipe.parts.filter(p=>p.role===role).map(p=>(role==='collision'?'COL_':'SM_')+p.name).sort());
  assert.deepEqual(manifest.validation.exports.map(e=>e.path).sort(),['asset.glb','asset.fbx','collision.glb','asset-lod1.glb'].sort());
  // Verify numeric PBR factors from the actual GLB document independently of the worker's scene audit.
  const glb=await readFile(join(current.directory,'asset.glb'));
  const doc=JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString().trim());
  for (const [path,role] of [['asset.glb','render'],['collision.glb','collision'],['asset-lod1.glb','lod1']]) {
    const bytes=await readFile(join(current.directory,path));
    const document=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString().trim());
    const nodes=document.nodes.filter(n=>n.mesh!==undefined);
    assert.deepEqual(nodes.map(n=>n.name).sort(),request.recipe.parts.filter(p=>p.role===role).map(p=>(role==='collision'?'COL_':'SM_')+p.name).sort());
    assert.ok(nodes.every(n=>n.extras?.arcane_role===role&&request.recipe.parts.some(p=>p.name===n.extras?.arcane_part_id&&p.role===role)));
    if(role==='collision')assert.equal(document.materials?.length??0,0);
  }
  const near=(a,b)=>assert.ok(Math.abs(a-b)<0.0001,JSON.stringify({actual:a,expected:b}));
  for(const wanted of request.recipe.materials){
    const mat=doc.materials.find(m=>m.name==='MAT_'+wanted.id);assert.ok(mat);
    mat.pbrMetallicRoughness.baseColorFactor.slice(0,3).forEach((n,i)=>near(n,wanted.color[i]));
    near(mat.pbrMetallicRoughness.metallicFactor??1,wanted.metallic);
    near(mat.pbrMetallicRoughness.roughnessFactor??1,wanted.roughness);
    if(wanted.emission){const strength=mat.extensions?.KHR_materials_emissive_strength?.emissiveStrength??1;mat.emissiveFactor.forEach((n,i)=>near(n*strength,wanted.emission.color[i]*wanted.emission.strength));}
  }
  for(const token of [control,agent])for(const path of ['preview-hero.png','preview-side.png']){
    const png=await call('preview?jobId='+job.jobId+'&path='+path,'GET',undefined,token);assert.equal(png.status,200);
    assert.deepEqual(Buffer.from(await png.arrayBuffer()),await readFile(join(current.directory,path)));
  }
  const changedPath=join(current.directory,'preview-hero.png'),original=await readFile(changedPath);
  try{const corrupt=Buffer.from(original);corrupt[corrupt.length-1]^=1;await writeFile(changedPath,corrupt);assert.equal((await call('preview?jobId='+job.jobId+'&path=preview-hero.png')).status,422);}finally{await writeFile(changedPath,original);}
  evidence.job=current;evidence.manifestPath=current.manifestPath;evidence.totals=manifest.validation.totals;evidence.parts=manifest.validation.meshes;
  evidence.exports=manifest.validation.exports;evidence.sockets=manifest.assembly.sockets;evidence.runtime=manifest.runtime;evidence.artifacts=manifest.artifacts;
  evidence.checks={nativeHttpRecipe:'passed',savedSceneReopen:'passed',deepValidation:'passed',glbPbrFactors:'passed',namedGlbRoleNodes:'passed',bothBearerPreviewBytes:'passed',tamperedPreviewRefused:'passed'};
} finally {server.closeAllConnections();await new Promise((r,j)=>server.close(e=>e?j(e):r()));await service.close();}
const restarted=await createAssetService({cwd:root,outputRoot});
try{const page=restarted.jobPage();assert.equal(page.jobs.length,1);assert.equal(page.jobs[0].state,'succeeded');assert.deepEqual(page.jobs[0].request.recipe,request.recipe);assert.deepEqual((await restarted.manifest(page.jobs[0].jobId)).request.recipe,request.recipe);evidence.checks.recoveredFullRecipe='passed';}finally{await restarted.close();}
await writeFile(join(outputRoot,'acceptance.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({nativeCustomAcceptance:'passed',evidencePath:join(outputRoot,'acceptance.json'),manifestPath:evidence.manifestPath,totals:evidence.totals}));
