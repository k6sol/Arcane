import test from 'node:test';
import assert from 'node:assert/strict';
import {assetConversationJobPageAsync,nativeAssetConversationJobPageAsync} from '../../apps/daemon/src/asset-conversation-page.js';
import type {AssetConversationHost,AssetConversationListing} from '../../apps/daemon/src/asset-conversation-host.js';
import type {NativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';
import {HISTORY_PAGE_BYTES,type AssetJobRecord,type AssetHistoryUnavailable} from '../../apps/daemon/src/asset-service.js';
import {ArcaneError} from '../../packages/protocol/src/providers.js';

const uuid=(n:number)=>n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111';
const conversation={provider:'codex' as const,threadId:'owned-thread',sessionId:'owned-session'};
const scope={projectId:'a'.repeat(64),projectPath:'C:/owned-synthetic-project',conversation};
const cursor=(n:number)=>'b'.repeat(64)+':'+n;
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const stale=(error:unknown)=>error instanceof ArcaneError&&error.code==='ASSET_CONVERSATION_STALE';
function job(n:number,padding=0):AssetJobRecord{
  return{schemaVersion:1,jobId:uuid(n),directory:'synthetic/'+uuid(n),manifestPath:null,
    request:{schemaVersion:1,template:'hero-prop',name:'crate',seed:1,sizeMeters:[1,1,1],color:[0,0,0],triangleBudget:5000,renderResolution:384,renderSamples:16},
    state:'failed',stage:'complete'+'x'.repeat(padding),startedAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:01.000Z',events:[],
    manifestAvailable:false,error:{code:'FIXTURE',message:'Saved failure'},retention:{status:'archived',archivedAt:'2026-10-16T00:00:02.000Z'}};
}
function fixture(ids:string[],records:AssetJobRecord[],missing:AssetHistoryUnavailable[]=[]){
  const queries:{limit:number;after?:string}[]=[],lookups:string[][]=[];
  let mutate:((listing:AssetConversationListing,observation:number)=>void)|undefined;
  let hydrate:((ids:readonly string[])=>Promise<{jobs:AssetJobRecord[];unavailable:AssetHistoryUnavailable[]}>)|undefined;
  const listing=(query:{limit:number;after?:string})=>{
    queries.push({...query});const offset=query.after?ids.findIndex((_,i)=>cursor(i+1)===query.after)+1:0;
    if(query.after&&offset===0)throw Error('foreign cursor');
    const end=Math.min(ids.length,offset+query.limit);
    const value:AssetConversationListing={...scope,conversation:{...conversation},
      items:ids.slice(offset,end).map(id=>({projectId:scope.projectId,kind:'asset-job',id,conversation:{...conversation}})),nextCursor:end<ids.length?cursor(end):null};
    mutate?.(value,queries.length);return value;
  };
  const service={projectPath:scope.projectPath,async lookupJobs(requested:readonly string[]){
    lookups.push([...requested]);return hydrate?hydrate(requested):{jobs:records.filter(record=>requested.includes(record.jobId)),unavailable:missing.filter(record=>requested.includes(record.jobId))};
  }};
  const host={listHuman:listing} as AssetConversationHost;
  return{queries,lookups,service,host,listing,mutate(fn:typeof mutate){mutate=fn;},hydrate(fn:typeof hydrate){hydrate=fn;},
    read(limit=32,after:string|null=null){return assetConversationJobPageAsync(service,host,{limit,after});}};
}

test('captured UUID hydration preserves archived records, unavailable identities and binding order',async()=>{
  const first=job(1),last=job(3),unavailable={jobId:uuid(2),name:'crate',status:'changed' as const};
  const f=fixture([uuid(1),'old-orphan',uuid(2),uuid(3)],[last,first],[unavailable]);
  const result=await f.read(3);assert.deepEqual(f.lookups,[[uuid(1),uuid(2)]]);
  assert.deepEqual(result.jobs,[first]);assert.deepEqual(result.unavailable,[unavailable]);assert.equal(result.nextCursor,cursor(3));
  assert.deepEqual(f.queries,[{limit:3},{limit:3}]);
  const next=await f.read(3,result.nextCursor);assert.deepEqual(next.jobs,[last]);assert.equal(next.nextCursor,null);assert.equal(next.unavailable,undefined);
});

test('unavailable-only pages advance the exact consumed cursor without inventing a job',async()=>{
  const f=fixture([uuid(1),uuid(2)],[],[{jobId:uuid(1),status:'missing'},{jobId:uuid(2),status:'conflict'}]);
  const first=await f.read(1);assert.deepEqual(first.jobs,[]);assert.equal(first.unavailable?.[0]?.jobId,uuid(1));assert.equal(first.nextCursor,cursor(1));
  assert.equal((await f.read(1,first.nextCursor)).nextCursor,null);
});

test('scope retirement during a filesystem await returns no retained metadata',async()=>{
  for(const field of ['project','thread','session','bindings','cursor'] as const){
    const f=fixture([uuid(1)],[job(1)]);let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});f.hydrate(async()=>{await held;return{jobs:[job(1)],unavailable:[]};});
    const pending=f.read();await Promise.resolve();
    f.mutate((value,observation)=>{if(observation<2)return;
      if(field==='project')value.projectPath='C:/replaced-project';
      if(field==='thread')value.conversation.threadId='replaced-thread';
      if(field==='session')value.conversation.sessionId='replaced-session';
      if(field==='bindings')value.items[0]!.id=uuid(2);
      if(field==='cursor')value.nextCursor=cursor(9);
    });release();await assert.rejects(pending,stale,field);
  }
});

test('missing, duplicate or foreign hydration results are refused before scope recheck',async()=>{
  for(const result of [{jobs:[],unavailable:[]},{jobs:[job(2)],unavailable:[]},{jobs:[job(1),job(1)],unavailable:[]},
    {jobs:[job(1)],unavailable:[{jobId:uuid(1),status:'missing' as const}]}]){
    const f=fixture([uuid(1)],[job(1)]);f.hydrate(async()=>result);await assert.rejects(f.read(),stale);assert.equal(f.queries.length,1);
  }
});

test('byte-bound cuts include unavailable rows and use a verified interior cursor',async()=>{
  const large=job(1,300000),other=job(3,300000),missing={jobId:uuid(2),status:'missing' as const};
  const f=fixture([uuid(1),uuid(2),uuid(3)],[large,other],[missing]);
  const first=await f.read(3);assert.deepEqual(first.jobs,[large]);assert.deepEqual(first.unavailable,[missing]);
  assert.equal(first.nextCursor,cursor(2));assert.deepEqual(f.queries,[{limit:3},{limit:2}]);assert.ok(bytes(first)<=HISTORY_PAGE_BYTES);
  const last=await f.read(3,first.nextCursor);assert.deepEqual(last.jobs,[other]);assert.equal(last.nextCursor,null);
});

test('native hydration verifies the same captured actor twice and never calls the human host',async()=>{
  const f=fixture([uuid(1)],[job(1)]),actor=Object.freeze({}) as NativeAssetActor,seen:NativeAssetActor[]=[];
  const result=await nativeAssetConversationJobPageAsync(f.service,{listNative(captured,query){seen.push(captured);return f.listing(query as {limit:number;after?:string});}},actor,{limit:1,after:null});
  assert.deepEqual(result.jobs,[job(1)]);assert.deepEqual(seen,[actor,actor]);
});

test('an exactly fitting terminal page omits the empty optional array before byte accounting',async()=>{
  const record=job(1),expected={...scope,jobs:[record],nextCursor:null,byteLimit:HISTORY_PAGE_BYTES};
  record.stage+='x'.repeat(HISTORY_PAGE_BYTES-bytes(expected));
  assert.equal(bytes(expected),HISTORY_PAGE_BYTES);
  const f=fixture([uuid(1)],[record]),result=await f.read(1);
  assert.equal(result.unavailable,undefined);assert.deepEqual(result,expected);assert.equal(bytes(result),HISTORY_PAGE_BYTES);
});

test('invalid pagination refuses before service hydration or host access',async()=>{
  const f=fixture([uuid(1)],[job(1)]);
  await assert.rejects(assetConversationJobPageAsync(f.service,f.host,{limit:65,after:null}));
  let reads=0;await assert.rejects(assetConversationJobPageAsync(f.service,f.host,{get limit(){reads++;return 1;},after:null}));
  assert.equal(reads,0);assert.equal(f.queries.length,0);assert.equal(f.lookups.length,0);
});
