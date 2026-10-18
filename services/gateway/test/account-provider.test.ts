import test from 'node:test';import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';import {createAccountProvider,AccountError} from '../src/account-provider.ts';import {readAccountsConfig} from '../src/account-config.ts';
const config=readAccountsConfig({SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+ 'p'.repeat(24),ACCOUNTS_SESSION_KEY:randomBytes(32).toString('base64url')})!;
const subject='11111111-2222-4333-8444-555555555555',now=100000;
const token=(claims:Record<string,unknown>={})=>'header.'+Buffer.from(JSON.stringify({sub:subject,iss:config.providerUrl+'/auth/v1',aud:'authenticated',exp:1000,aal:'aal2',...claims})).toString('base64url')+'.signature';
const user={id:subject,email:'Maker@example.com',email_confirmed_at:'2026-10-18T00:00:00Z',factors:[{id:subject,factor_type:'totp',status:'verified'}]};

test('identity claims are used only after the exact token is authenticated by the provider',async()=>{
 let calls=0;const jwt=token();
 const provider=createAccountProvider(config,(async(url,init)=>{calls++;assert.equal(url,config.providerUrl+'/auth/v1/user');assert.equal((init!.headers as Record<string,string>).Authorization,'Bearer '+jwt);assert.equal(init!.redirect,'error');return Response.json(user);}) as typeof fetch);
 const identity=await provider.identity(jwt,now);assert.equal(calls,1);assert.equal(identity.aal,'aal2');assert.equal(identity.email,'maker@example.com');
 const rejected=createAccountProvider(config,(async()=>Response.json({message:'private provider details'},{status:401})) as typeof fetch);
 await assert.rejects(()=>rejected.identity(jwt,now),(error:unknown)=>error instanceof AccountError&&!error.message.includes('private'));
});
test('unverified email, mismatched subject, issuer, audience and expired tokens cannot establish an account',async()=>{
 for(const claims of [{sub:'another-user'},{iss:'https://other.invalid/auth/v1'},{aud:'other'},{exp:10}]){
   const provider=createAccountProvider(config,(async()=>Response.json(user)) as typeof fetch);await assert.rejects(()=>provider.identity(token(claims),now),AccountError);
 }
 const unverified=createAccountProvider(config,(async()=>Response.json({...user,email_confirmed_at:null})) as typeof fetch);
 await assert.rejects(()=>unverified.identity(token(),now),AccountError);
});
test('provider responses are bounded and transport failures reveal no upstream text',async()=>{
 for(const answer of [()=>Promise.resolve(new Response('x'.repeat(129*1024))),()=>Promise.reject(Error('private-access-token'))]){
  const provider=createAccountProvider(config,answer as typeof fetch);
  await assert.rejects(()=>provider.request('GET','/user',null,'fixture-token'),(error:unknown)=>error instanceof AccountError&&!error.message.includes('private'));
 }
});
