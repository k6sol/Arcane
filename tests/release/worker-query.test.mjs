import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WORKER_QUERY_FILES,WORKER_QUERY_PIN,validateWorkerQueryFiles,verifyWorkerQuery} from '../../scripts/managed-worker-query.mjs';
const files=await Promise.all(WORKER_QUERY_FILES.map(async path=>({path,bytes:await readFile(path)})));
test('worker query has exact reviewed binary, canonical source and receipt pins',()=>{
  assert.doesNotThrow(()=>validateWorkerQueryFiles(files));
  assert.equal(verifyWorkerQuery(process.cwd()).sha256,WORKER_QUERY_PIN.sha256);
  const crlf=files.map(file=>file.path.endsWith('.cs')?{...file,bytes:Buffer.from(file.bytes.toString('utf8').replace(/\r?\n/g,'\r\n'))}:file);
  assert.doesNotThrow(()=>validateWorkerQueryFiles(crlf),'Git line endings preserve the same reviewed source');
});
for(const target of WORKER_QUERY_FILES)test('worker query refuses missing or changed '+target,()=>{
  assert.throws(()=>validateWorkerQueryFiles(files.filter(file=>file.path!==target)));
  const changed=files.map(file=>file.path===target?{...file,bytes:Buffer.concat([file.bytes,Buffer.from('changed')])}:file);
  assert.throws(()=>validateWorkerQueryFiles(changed));
});
test('declared native worker source cannot silently drop all helper payloads',()=>{
  assert.throws(()=>validateWorkerQueryFiles([{path:'packages/asset-pipeline/src/worker-identity.ts',bytes:Buffer.from('NATIVE_WORKER_QUERY_PIN')}]));
  assert.doesNotThrow(()=>validateWorkerQueryFiles([]),'Older unrelated fixtures retain their scope');
});
