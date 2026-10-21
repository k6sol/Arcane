import test from 'node:test';
import assert from 'node:assert/strict';
import {createArcaneGateway, type GatewayStreamClosure} from '../../apps/daemon/src/arcane-gateway.js';

const request = {model:'fixture',messages:[{role:'user' as const,content:'test'}]};
const event = (value:unknown) => new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n');
function deferred<T>() {
  let resolve!: (value:T|PromiseLike<T>)=>void, reject!: (error?:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function gateway(fetcher:(input:URL|RequestInfo,init?:RequestInit)=>Promise<Response>) {
  return createArcaneGateway({config:null as never,vault:null,fetch:fetcher as typeof fetch,
    credential:async()=>({base:'https://gateway.fixture.test',token:'fixture-account-credential'})});
}
function observe() {
  const values:GatewayStreamClosure[]=[];
  return {values,onClosed(value:GatewayStreamClosure){assert.ok(Object.isFrozen(value));assert.deepEqual(Object.keys(value),['state']);values.push(value);}};
}

test('gateway closure: normal done awaits actual cancellation before its one closed witness',{timeout:5000},async()=>{
  const cancelling=deferred<void>(),cancelStarted=deferred<void>(),seen=observe();
  const g=gateway(async()=>new Response(new ReadableStream<Uint8Array>({
    start(c){c.enqueue(event({type:'done',creditsUsed:0}));},
    cancel(){cancelStarted.resolve();return cancelling.promise;}
  })));
  const iterator=g.streamChat(request,undefined,seen.onClosed);
  assert.equal((await iterator.next()).value?.type,'done');
  const ending=iterator.next();await cancelStarted.promise;assert.deepEqual(seen.values,[]);
  cancelling.resolve();assert.equal((await ending).done,true);assert.deepEqual(seen.values,[{state:'closed'}]);
  await iterator.return(undefined);assert.equal(seen.values.length,1);
});

test('gateway closure: early consumer return cancels and releases the actual reader',{timeout:5000},async()=>{
  let cancelled=0;const seen=observe(),g=gateway(async()=>new Response(new ReadableStream<Uint8Array>({
    start(c){c.enqueue(event({type:'delta',text:'hello'}));},cancel(){cancelled++;}
  })));
  const iterator=g.streamChat(request,undefined,seen.onClosed);
  assert.equal((await iterator.next()).value?.type,'delta');assert.deepEqual(seen.values,[]);
  await iterator.return(undefined);assert.equal(cancelled,1);assert.deepEqual(seen.values,[{state:'closed'}]);
});

test('gateway closure: consumer throw preserves the exact frozen original and drains cleanup',{timeout:5000},async()=>{
  const original=Object.freeze({fixture:'original'}),seen=observe();let cancelled=0;
  const g=gateway(async()=>new Response(new ReadableStream<Uint8Array>({
    start(c){c.enqueue(event({type:'delta',text:'hello'}));},cancel(){cancelled++;}
  })));
  const iterator=g.streamChat(request,undefined,seen.onClosed);await iterator.next();
  await assert.rejects(iterator.throw(original),error=>error===original);
  assert.equal(cancelled,1);assert.deepEqual(seen.values,[{state:'closed'}]);
});

test('gateway closure: rejected cancel reports unresolved and never manufactures closed',{timeout:5000},async()=>{
  const failure=Object.freeze({fixture:'cancel'}),seen=observe();
  const g=gateway(async()=>new Response(new ReadableStream<Uint8Array>({
    start(c){c.enqueue(event({type:'done',creditsUsed:0}));},cancel(){return Promise.reject(failure);}
  })));
  const iterator=g.streamChat(request,undefined,seen.onClosed);await iterator.next();
  await assert.rejects(iterator.next(),error=>error===failure);
  assert.deepEqual(seen.values,[{state:'unresolved'}]);await iterator.return(undefined);assert.equal(seen.values.length,1);
});

test('gateway closure: non-OK response cleanup remains owned and preserves its status error',{timeout:5000},async()=>{
  const cancelling=deferred<void>(),started=deferred<void>(),seen=observe();
  const g=gateway(async()=>new Response(new ReadableStream<Uint8Array>({
    cancel(){started.resolve();return cancelling.promise;}
  }),{status:402}));
  const next=g.streamChat(request,undefined,seen.onClosed).next();await started.promise;
  assert.deepEqual(seen.values,[]);cancelling.reject(Object.freeze({fixture:'cleanup'}));
  await assert.rejects(next,error=>!!error&&typeof error==='object'&&'code' in error&&error.code==='insufficient-credits');
  assert.deepEqual(seen.values,[{state:'unresolved'}]);
});

test('gateway closure: abort cannot close a still-held fetch; a late response is actually drained',{timeout:5000},async()=>{
  const fetched=deferred<Response>(),started=deferred<void>(),seen=observe();let cancelled=0;
  const g=gateway(async()=>{started.resolve();return fetched.promise;});
  const abort=new AbortController(),iterator=g.streamChat(request,abort.signal,seen.onClosed);
  const next=iterator.next();await started.promise;abort.abort();assert.deepEqual(seen.values,[]);
  fetched.resolve(new Response(new ReadableStream<Uint8Array>({
    start(c){c.enqueue(event({type:'done',creditsUsed:0}));},cancel(){cancelled++;}
  })));
  await next;assert.deepEqual(seen.values,[]);await iterator.return(undefined);
  assert.equal(cancelled,1);assert.deepEqual(seen.values,[{state:'closed'}]);
});

test('gateway closure: abort and queued return do not settle a held underlying read',{timeout:5000},async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const readStarted=deferred<void>(),seen=observe(),abort=new AbortController();
  const g=gateway(async()=>new Response(new ReadableStream<Uint8Array>({
    start(c){controller=c;},pull(){readStarted.resolve();}
  },{highWaterMark:0})));
  const iterator=g.streamChat(request,abort.signal,seen.onClosed),next=iterator.next();await readStarted.promise;
  abort.abort();const returning=iterator.return(undefined);assert.deepEqual(seen.values,[]);
  controller.enqueue(event({type:'delta',text:'late'}));await next;await returning;
  assert.deepEqual(seen.values,[{state:'closed'}]);
});

test('gateway closure: rejected fetch preserves thrown undefined and reports settled no-body ownership',{timeout:5000},async()=>{
  const seen=observe(),g=gateway(async()=>{throw undefined;});
  let caught=false;try{await g.streamChat(request,undefined,seen.onClosed).next();}catch(error){caught=true;assert.equal(error,undefined);}
  assert.equal(caught,true);assert.deepEqual(seen.values,[{state:'closed'}]);
});

test('gateway closure: observer faults cannot change a successful or failed stream',{timeout:5000},async()=>{
  const g=gateway(async()=>new Response(event({type:'done',creditsUsed:0})));
  for await(const chunk of g.streamChat(request,undefined,()=>{throw Object.freeze({fixture:'observer'});}))assert.equal(chunk.type,'done');
  const original=Object.freeze({fixture:'fetch'}),bad=gateway(async()=>{throw original;});
  await assert.rejects(bad.streamChat(request,undefined,()=>{throw 'observer';}).next(),error=>error===original);
});

test('gateway closure: a late old stream witness cannot close a separate new stream',{timeout:5000},async()=>{
  const first=deferred<Response>(),firstStarted=deferred<void>(),seenOld=observe(),seenNew=observe();let count=0;
  const g=gateway(async()=>{if(count++===0){firstStarted.resolve();return first.promise;}return new Response(event({type:'done',creditsUsed:0}));});
  const old=g.streamChat(request,undefined,seenOld.onClosed),pending=old.next();await firstStarted.promise;
  for await(const _ of g.streamChat(request,undefined,seenNew.onClosed)){/* drain */}
  assert.deepEqual(seenNew.values,[{state:'closed'}]);assert.deepEqual(seenOld.values,[]);
  first.resolve(new Response(event({type:'done',creditsUsed:0})));await pending;await old.return(undefined);
  assert.deepEqual(seenOld.values,[{state:'closed'}]);assert.equal(seenNew.values.length,1);
});
