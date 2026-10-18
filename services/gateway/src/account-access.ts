import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {AccountsConfig} from './account-config.ts';
import {AccountError,type AccountIdentity} from './account-provider.ts';
import {AccountStore} from './account-store.ts';
import {accountByEmail,audit,getAccount,tx,type Account} from './db.ts';
import {normalizeUserCode} from './auth.ts';

export interface AccountPrincipal {identity:AccountIdentity;account:Account;mfaRequired:boolean;owner:boolean}
export function createAccountAccess(db:DatabaseSync,config:AccountsConfig,store:AccountStore){
  function resolve(identity:AccountIdentity,now:number):AccountPrincipal {
    const required=identity.factors.some(factor=>factor.status==='verified');
    return tx(db,()=>{
      let row=db.prepare('SELECT * FROM account_identities WHERE subject=?').get(identity.subject);
      if(row?.disabled)throw new AccountError(403,'account_suspended','This account is suspended. Contact Arcane support.');
      if(!row){
        // A verified legacy email may migrate once. New account rows contain an opaque alias, not cleartext email.
        let account=accountByEmail(db,identity.email);
        const id=account?.id??'acct_'+randomUUID().replaceAll('-','');
        if(!account)db.prepare('INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)').run(id,id+'@accounts.invalid',now);
        else db.prepare('UPDATE accounts SET email=? WHERE id=?').run(id+'@accounts.invalid',id);
        db.prepare('INSERT INTO account_identities(subject,account_id,email_hash,email_cipher,mfa_required) VALUES(?,?,?,?,?)')
          .run(identity.subject,id,store.hash('email',identity.email),store.seal('email',id,{email:identity.email}),required?1:0);
        audit(db,id,'account.identity_connected',{});row=db.prepare('SELECT * FROM account_identities WHERE subject=?').get(identity.subject)!;
      }else{
        if(required&&!row.mfa_required)db.prepare('UPDATE tokens SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').run(now,String(row.account_id));
        db.prepare('UPDATE account_identities SET email_hash=?,email_cipher=?,mfa_required=? WHERE subject=?')
          .run(store.hash('email',identity.email),store.seal('email',String(row.account_id),{email:identity.email}),required?1:0,identity.subject);
      }
      const account=getAccount(db,String(row.account_id));if(!account)throw new AccountError(503,'account_unavailable','Account details are unavailable.');
      const owner=!!db.prepare("SELECT 1 FROM account_roles WHERE subject=? AND role='owner'").get(identity.subject);
      return {identity,account,mfaRequired:required||owner,owner};
    });
  }
  function requireMfa(principal:AccountPrincipal):void {
    if(principal.mfaRequired&&principal.identity.aal!=='aal2')throw new AccountError(403,'mfa_required','Enter your two-step verification code to continue.');
  }
  function requireOwner(principal:AccountPrincipal,mfaAt:number|undefined,now:number):void {
    if(!principal.owner)throw new AccountError(403,'admin_required','Administrator access is required.');
    requireMfa(principal);
    if(principal.identity.aal!=='aal2'||!Number.isSafeInteger(mfaAt)||Number(mfaAt)>now||now-Number(mfaAt)>15*60000)throw new AccountError(403,'step_up_required','Verify your authenticator again to open administration.');
  }
  function claimOwner(principal:AccountPrincipal,mfaAt:number,now:number):boolean {
    if(!config.bootstrapEmail||principal.identity.email!==config.bootstrapEmail||principal.identity.aal!=='aal2'||!principal.identity.factors.some(f=>f.status==='verified')||!Number.isSafeInteger(mfaAt)||mfaAt>now||now-mfaAt>15*60000)return false;
    return tx(db,()=>{
      const current=db.prepare('SELECT subject FROM account_bootstrap WHERE singleton=1').get();
      if(current)return current.subject===principal.identity.subject;
      db.prepare('INSERT INTO account_bootstrap(singleton,subject,created_at) VALUES(1,?,?)').run(principal.identity.subject,now);
      db.prepare("INSERT INTO account_roles(subject,role,created_at) VALUES(?,'owner',?)").run(principal.identity.subject,now);
      audit(db,principal.account.id,'admin.owner_initialized',{});return true;
    });
  }
  function approveDevice(principal:AccountPrincipal,userCode:unknown,now:number):void {
    requireMfa(principal);const code=normalizeUserCode(userCode);
    if(!code)throw new AccountError(400,'invalid_device_code','Check the code shown in Arcane.');
    tx(db,()=>{
      const device=db.prepare("SELECT id FROM device_requests WHERE user_code=? AND status='pending' AND expires_at>?").get(code,now);
      if(!device)throw new AccountError(410,'device_expired','This code has expired or was already approved. Start again from Arcane.');
      db.prepare("UPDATE device_requests SET status='approved',account_id=? WHERE id=?").run(principal.account.id,String(device.id));
      db.prepare('INSERT INTO account_device_approvals(device_id,subject,aal,approved_at) VALUES(?,?,?,?)').run(String(device.id),principal.identity.subject,principal.identity.aal,now);
      audit(db,principal.account.id,'auth.device_approved',{});
    });
  }
  function revokeSessions(accountId:string,now:number):void {
    db.prepare('UPDATE tokens SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').run(now,accountId);
    db.prepare('DELETE FROM account_browser_sessions WHERE subject IN (SELECT subject FROM account_identities WHERE account_id=?)').run(accountId);
  }
  function administer(actor:AccountPrincipal,mfaAt:number|undefined,target:string,action:'suspend'|'restore'|'revoke',now:number):void {
    requireOwner(actor,mfaAt,now);
    tx(db,()=>{
      const identity=db.prepare('SELECT subject FROM account_identities WHERE account_id=?').get(target);
      if(!identity)throw new AccountError(404,'account_not_found','Account not found.');
      if(db.prepare('SELECT 1 FROM account_roles WHERE subject=?').get(String(identity.subject)))throw new AccountError(409,'owner_protected','Owner access cannot be changed here.');
      if(action!=='revoke')db.prepare('UPDATE account_identities SET disabled=? WHERE account_id=?').run(action==='suspend'?1:0,target);
      if(action!=='restore')revokeSessions(target,now);
      audit(db,actor.account.id,'admin.account_'+action,{target});
    });
  }
  function dashboard(actor:AccountPrincipal,mfaAt:number|undefined,after:string,now:number){
    requireOwner(actor,mfaAt,now);
    if(after&&!/^acct_[a-f0-9]{32}$/.test(after))throw new AccountError(400,'bad_cursor','Invalid page.');
    const rows=db.prepare('SELECT a.id,a.plan_id,a.credits,a.plan_actions,a.pack_actions,a.created_at,i.email_cipher,i.mfa_required,i.disabled,r.role FROM accounts a JOIN account_identities i ON i.account_id=a.id LEFT JOIN account_roles r ON r.subject=i.subject WHERE a.id>? ORDER BY a.id LIMIT 51').all(after);
    const accounts=rows.slice(0,50).map(row=>({id:String(row.id),email:store.open<{email:string}>('email',String(row.id),String(row.email_cipher)).email,
      plan:row.plan_id,credits:row.credits,actions:Number(row.plan_actions)+Number(row.pack_actions),createdAt:row.created_at,mfaEnabled:!!row.mfa_required,suspended:!!row.disabled,owner:row.role==='owner'}));
    const totals=db.prepare('SELECT count(*) AS accounts,coalesce(sum(disabled),0) AS suspended FROM account_identities').get();
    const events=db.prepare('SELECT at,account_id AS accountId,event FROM audit ORDER BY id DESC LIMIT 50').all();
    return {accounts,next:rows.length>50?accounts.at(-1)!.id:null,totals,events};
  }
  return {resolve,requireMfa,requireOwner,claimOwner,approveDevice,revokeSessions,administer,dashboard};
}
