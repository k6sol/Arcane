import test from 'node:test';import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';import {openDatabase} from '../src/db.ts';
import {readAccountsConfig} from '../src/account-config.ts';import {AccountStore,AccountStorageError} from '../src/account-store.ts';
const env=()=>({SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+ 'p'.repeat(24),ACCOUNTS_SESSION_KEY:randomBytes(32).toString('base64url')});

test('accounts require separate encryption material and a public provider key',()=>{
 assert.equal(readAccountsConfig({}),null);
 for(const bad of [{SUPABASE_URL:'http://project.supabase.co'},{SUPABASE_URL:'https://project.supabase.co/other'},{SUPABASE_PUBLISHABLE_KEY:'sb_secret_'+ 'p'.repeat(24)},{ACCOUNTS_SESSION_KEY:'weak'},{ACCOUNT_SOCIAL_PROVIDERS:'google,other'}])assert.throws(()=>readAccountsConfig({...env(),...bad}));
});
test('session records encrypt tokens, survive store recreation, expire and reject stale concurrent saves',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const config=readAccountsConfig(env())!,store=new AccountStore(db,config),now=100000;
 const created=store.create(now);created.session.data.accessToken='private-access';created.session.data.refreshToken='private-refresh';store.save(created.session,now);
 const row=db.prepare('SELECT * FROM account_browser_sessions').get()!;
 assert.ok(!JSON.stringify(row).includes('private-'));assert.ok(!JSON.stringify(row).includes(created.cookie));
 const restored=new AccountStore(db,config).read(created.cookie,now)!;assert.equal(restored.data.refreshToken,'private-refresh');
 const stale=store.read(created.cookie,now)!;store.save(restored,now);assert.throws(()=>store.save(stale,now),AccountStorageError);
 assert.equal(store.read(created.cookie,created.session.expiresAt),null);
 store.sweep(created.session.expiresAt);assert.equal(db.prepare('SELECT count(*) AS n FROM account_browser_sessions').get()!.n,0);
});
test('encrypted account data cannot be transplanted, modified or opened with another key',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const store=new AccountStore(db,readAccountsConfig(env())!);
 const sealed=store.seal('email','account-one',{email:'private@example.com'});
 assert.deepEqual(store.open('email','account-one',sealed),{email:'private@example.com'});
 for(const [kind,id,value]of [['email','account-two',sealed],['browser','account-one',sealed],['email','account-one',sealed.slice(0,-8)+'AAAAAAAA']])assert.throws(()=>store.open(kind,id,value),AccountStorageError);
 assert.throws(()=>new AccountStore(db,readAccountsConfig(env())!).open('email','account-one',sealed),AccountStorageError);
});
