import type {DatabaseSync} from 'node:sqlite';
import {audit,getAccount,tx} from './db.ts';

/** A deliberate new redemption may reuse a code; a retried request never grants
 * twice. Permanent grant keys are separate from expiring HTTP idempotency rows. */
export function redeemActions(db:DatabaseSync,accountId:string,code:string,requestId:string,now=Date.now()) {
 if(code.trim().toLowerCase()!=='test')return {ok:false as const,error:'invalid_code'};
 const key='promo-actions:'+accountId+':'+requestId;
 return tx(db,()=>{
  const account=getAccount(db,accountId);if(!account)return {ok:false as const,error:'account_missing'};
  const prior=db.prepare('SELECT credits,actions,offer_id FROM grants WHERE key=? AND account_id=?').get(key,accountId);
  if(prior)return {ok:true as const,granted:1000,balance:account.pack_actions,replayed:true};
  if(!Number.isSafeInteger(account.pack_actions)||account.pack_actions>Number.MAX_SAFE_INTEGER-1000)return {ok:false as const,error:'balance_limit'};
  db.prepare('INSERT INTO grants (key,account_id,offer_id,credits,actions,created_at) VALUES (?,?,?,0,1000,?)').run(key,accountId,'promo-test-actions',now);
  db.prepare('UPDATE accounts SET pack_actions=pack_actions+1000 WHERE id=?').run(accountId);
  audit(db,accountId,'actions.redeemed',{requestId,code:'test',credits:0,actions:1000});
  return {ok:true as const,granted:1000,balance:account.pack_actions+1000,replayed:false};
 });
}
