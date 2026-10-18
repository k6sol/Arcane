import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {createAccountAccess} from '../src/account-access.ts';import {AccountStore} from '../src/account-store.ts';
import type {AccountIdentity} from '../src/account-provider.ts';import {readAccountsConfig} from '../src/account-config.ts';import {openDatabase} from '../src/db.ts';
import {startDevice} from '../src/auth.ts';import {testConfig} from './helpers.ts';
const owner='11111111-2222-4333-8444-555555555555',member='22222222-2222-4333-8444-555555555555',now=1000000;
function identity(subject=owner,aal:'aal1'|'aal2'='aal1',mfa=false):AccountIdentity{return {subject,email:subject===owner?'owner@example.com':'member@example.com',aal,expiresAt:now+600000,factors:mfa?[{id:owner,type:'totp',status:'verified',name:'Authenticator'}]:[]};}
function fixture(t:import('node:test').TestContext){const db=openDatabase(':memory:');t.after(()=>db.close());const config=readAccountsConfig({SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+ 'p'.repeat(24),ACCOUNTS_SESSION_KEY:randomBytes(32).toString('base64url'),ADMIN_BOOTSTRAP_EMAIL:'owner@example.com'})!,store=new AccountStore(db,config);return {db,config,store,access:createAccountAccess(db,config,store)};}
test('managed identities keep email encrypted and preserve the same account across email changes',t=>{
 const f=fixture(t),p=f.access.resolve(identity(),now),updated=f.access.resolve({...identity(),email:'changed@example.com'},now+1);
 assert.equal(updated.account.id,p.account.id);assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM accounts').all()).includes('example.com'));
 assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM account_identities').all()).includes('example.com'));
 assert.equal(f.store.open<{email:string}>('email',p.account.id,String(f.db.prepare('SELECT email_cipher FROM account_identities').get()!.email_cipher)).email,'changed@example.com');
});
test('owner bootstrap requires verified MFA and is bound permanently to the first approved subject',t=>{
 const f=fixture(t),plain=f.access.resolve(identity(),now);assert.equal(f.access.claimOwner(plain,now,now),false);
 const verified=f.access.resolve(identity(owner,'aal2',true),now);assert.equal(f.access.claimOwner(verified,NaN,now),false);assert.equal(f.access.claimOwner(verified,now,now),true);
 const current=f.access.resolve(identity(owner,'aal2',true),now);f.access.requireOwner(current,now,now);
 assert.throws(()=>f.access.requireOwner(current,now-16*60000,now));
 const other=f.access.resolve({...identity(member,'aal2',true),email:'owner@example.com'},now);assert.equal(f.access.claimOwner(other,now,now),false);assert.equal(other.owner,false);
});
test('enrolled MFA is enforced before device approval and enabling it revokes earlier device tokens',t=>{
 const f=fixture(t),plain=f.access.resolve(identity(),now);f.db.prepare('INSERT INTO tokens(hash,account_id,created_at) VALUES(?,?,?)').run('old-token',plain.account.id,now);
 const pending=f.access.resolve(identity(owner,'aal1',true),now+1);assert.equal(f.db.prepare('SELECT revoked_at FROM tokens').get()!.revoked_at,now+1);
 const gateway=testConfig(),device=startDevice(f.db,gateway,now+1);assert.throws(()=>f.access.approveDevice(pending,device.userCode,now+2));
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM account_device_approvals').get()!.n,0);
 const verified=f.access.resolve(identity(owner,'aal2',true),now+2);f.access.approveDevice(verified,device.userCode,now+3);
 assert.equal(f.db.prepare('SELECT aal FROM account_device_approvals').get()!.aal,'aal2');assert.throws(()=>f.access.approveDevice(verified,device.userCode,now+4));
});
test('only a recent owner session can suspend a member and suspension revokes access immediately',t=>{
 const f=fixture(t);f.access.claimOwner(f.access.resolve(identity(owner,'aal2',true),now),now,now);
 const admin=f.access.resolve(identity(owner,'aal2',true),now),user=f.access.resolve(identity(member),now);
 f.db.prepare('INSERT INTO tokens(hash,account_id,created_at) VALUES(?,?,?)').run('member-token',user.account.id,now);
 assert.throws(()=>f.access.administer(user,now,admin.account.id,'suspend',now));assert.throws(()=>f.access.administer(admin,now,admin.account.id,'suspend',now));
 f.access.administer(admin,now,user.account.id,'suspend',now+1);assert.throws(()=>f.access.resolve(identity(member),now+2));assert.equal(f.db.prepare("SELECT revoked_at FROM tokens WHERE hash='member-token'").get()!.revoked_at,now+1);
 f.access.administer(admin,now,user.account.id,'restore',now+3);assert.equal(f.access.resolve(identity(member),now+4).account.id,user.account.id);
 const view=f.access.dashboard(admin,now,'',now+4);assert.equal(view.accounts.length,2);assert.ok(view.events.some(event=>event.event==='admin.account_suspend'));
});
