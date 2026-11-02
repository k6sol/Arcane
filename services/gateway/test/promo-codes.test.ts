import test from 'node:test';
import assert from 'node:assert/strict';
import {bearer,postJson,signIn,startHarness} from './helpers.ts';

test('test grants 1000 API credits per deliberate redemption, with permanent request dedup and no actions',async()=>{
 const h=await startHarness();try{
  const token=await signIn(h),headers={...bearer(token),'Idempotency-Key':'redeem-request-0001'};
  h.db.prepare('UPDATE accounts SET plan_actions=7,pack_actions=3').run();
  const redeem=(key=headers['Idempotency-Key'])=>postJson(h.base+'/v1/credits/redeem',{code:'test'},{...headers,'Idempotency-Key':key});
  assert.deepEqual(await (await redeem()).json(),{granted:1000,balance:1000,replayed:false});
  assert.deepEqual(await (await redeem()).json(),{granted:1000,balance:1000,replayed:true});
  assert.deepEqual(await (await redeem('redeem-request-0002')).json(),{granted:1000,balance:2000,replayed:false});
  assert.deepEqual(await (await redeem()).json(),{granted:1000,balance:2000,replayed:true});
  const balance=await(await fetch(h.base+'/v1/balance',{headers:bearer(token)})).json() as any;
  assert.equal(balance.credits,2000);assert.equal(balance.actionsRemaining,10);
  assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM grants WHERE offer_id=?').get('promo-test') as any).n,2);
 }finally{await h.close();}
});

test('redemption requires an authenticated account, valid code and request ID; forged amounts never grant',async()=>{
 const h=await startHarness();try{
  assert.equal((await postJson(h.base+'/v1/credits/redeem',{code:'test'},{'Idempotency-Key':'redeem-request-0001'})).status,401);
  const token=await signIn(h),headers={...bearer(token),'Idempotency-Key':'redeem-request-0001'};
  for(const input of [{code:'wrong'},{code:'test',amount:999999},{code:1000},null])assert.equal((await postJson(h.base+'/v1/credits/redeem',input,headers)).status,400);
  assert.equal((await postJson(h.base+'/v1/credits/redeem',{code:'test'},bearer(token))).status,400);
  const balance=await(await fetch(h.base+'/v1/balance',{headers:bearer(token)})).json() as any;assert.equal(balance.credits,0);
 }finally{await h.close();}
});

test('same redemption request is scoped to its account and simultaneous retries grant only once',async()=>{
 const h=await startHarness();try{
  const first=await signIn(h),second=await signIn(h,'other@example.com');
  const redeem=(token:string)=>postJson(h.base+'/v1/credits/redeem',{code:'test'},{...bearer(token),'Idempotency-Key':'shared-request-0001'});
  const replies=await Promise.all([redeem(first),redeem(first),redeem(second)]);
  assert.ok(replies.every(r=>r.status===200));
  for(const token of [first,second])assert.equal((await(await fetch(h.base+'/v1/balance',{headers:bearer(token)})).json() as any).credits,1000);
 }finally{await h.close();}
});
