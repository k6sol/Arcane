import type {DatabaseSync} from 'node:sqlite';
import {audit,getAccount,tx} from './db.ts';

/** A deliberate new redemption may reuse a code; a retried request never grants
 * twice. Permanent grant keys are separate from expiring HTTP idempotency rows. */
export function redeemCredits(db:DatabaseSync,accountId:string,code:string,requestId:string,now=Date.now()) {
 if(code.trim().toLowerCase()!=='test')return {ok:false as const,error:'invalid_code'};
 const key='promo:'+accountId+':'+requestId;
 return tx(db,()=>{
  const account=getAccount(db,accountId);if(!account)return {ok:false as const,error:'account_missing'};
  const prior=db.prepare('SELECT credits,actions,offer_id FROM grants WHERE key=? AND account_id=?').get(key,accountId);
  if(prior)return {ok:true as const,granted:1000,balance:account.credits,replayed:true};
  if(!Number.isSafeInteger(account.credits)||account.credits>Number.MAX_SAFE_INTEGER-1000)return {ok:false as const,error:'balance_limit'};
  db.prepare('INSERT INTO grants (key,account_id,offer_id,credits,actions,created_at) VALUES (?,?,?,1000,0,?)').run(key,accountId,'promo-test',now);
  db.prepare('UPDATE accounts SET credits=credits+1000 WHERE id=?').run(accountId);
  audit(db,accountId,'credits.redeemed',{requestId,code:'test',credits:1000,actions:0});
  return {ok:true as const,granted:1000,balance:account.credits+1000,replayed:false};
 });
}
