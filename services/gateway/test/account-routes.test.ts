// Real loopback HTTP and SQLite; identity, email and payment providers are explicit in-memory doubles.
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes,createHash} from 'node:crypto';import type {AddressInfo} from 'node:net';
import {createGatewayServer} from '../src/server.ts';import {openDatabase} from '../src/db.ts';import {testConfig} from './helpers.ts';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
import {keyedHash} from '../src/auth.ts';
const OWNER='11111111-2222-4333-8444-555555555555',MEMBER='22222222-2222-4333-8444-555555555555',FACTOR='33333333-2222-4333-8444-555555555555',CHALLENGE='44444444-2222-4333-8444-555555555555';
async function fixture(t:import('node:test').TestContext){
 const config=testConfig({SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+ 'p'.repeat(24),ACCOUNTS_SESSION_KEY:randomBytes(32).toString('base64url'),ADMIN_BOOTSTRAP_EMAIL:'owner@example.com'}),db=openDatabase(':memory:');
 let time=Date.UTC(2026,9,18,12),sequence=0,refreshUnavailable=false;const calls:string[]=[],payments:{url:string;body:URLSearchParams}[]=[],logs:string[]=[];
 const factors=new Map<string,{id:string;factor_type:string;status:string;friendly_name:string}[]>(),tokens=new Map<string,{sub:string;aal:string}>(),refresh=new Map<string,{sub:string;aal:string}>();
 function issue(subject:string,aal='aal1'){
  const access='fixture.'+Buffer.from(JSON.stringify({sub:subject,aal,iss:config.accounts!.providerUrl+'/auth/v1',aud:'authenticated',exp:Math.floor(time/1000)+3600,jti:++sequence})).toString('base64url')+'.signature',r='refresh_fixture_'+sequence;
  tokens.set(access,{sub:subject,aal});refresh.set(r,{sub:subject,aal});return {access_token:access,refresh_token:r};
 }
 const accountFetch=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input)),method=init?.method??'GET',path=url.pathname.replace('/auth/v1','');calls.push(method+' '+path+(url.searchParams.has('grant_type')?'?'+url.searchParams.get('grant_type'):''));
  const body=init?.body?JSON.parse(String(init.body)): {},authorization=(init?.headers as Record<string,string>)?.Authorization,owned=tokens.get(authorization?.slice(7)??'');
  if(path==='/token'&&url.searchParams.get('grant_type')==='password')return Response.json(issue(body.email==='owner@example.com'?OWNER:MEMBER));
  if(path==='/token'&&url.searchParams.get('grant_type')==='refresh_token'){
   if(refreshUnavailable)return Response.json({message:'private upstream token information'},{status:503});const current=refresh.get(body.refresh_token);assert.ok(current);return Response.json(issue(current.sub,current.aal));
  }
  if(path==='/token'&&url.searchParams.get('grant_type')==='pkce'){assert.match(body.code_verifier,/^[A-Za-z0-9_-]{43}$/);return Response.json(issue(OWNER));}
  if(path==='/signup'||path==='/recover')return Response.json({});
  assert.ok(owned,'only provider-authenticated fixture tokens can read users or manage factors');
  if(path==='/user')return Response.json({id:owned.sub,email:owned.sub===OWNER?'owner@example.com':'member@example.com',email_confirmed_at:'2026-10-18T00:00:00Z',factors:factors.get(owned.sub)??[],user_metadata:{role:'owner'}});
  if(path==='/factors'&&method==='POST'){factors.set(owned.sub,[{id:FACTOR,factor_type:'totp',status:'unverified',friendly_name:'Authenticator'}]);return Response.json({id:FACTOR,totp:{secret:'JBSWY3DPEHPK3PXP',qr_code:'<svg xmlns="http://www.w3.org/2000/svg"></svg>'}});}
  if(path==='/factors/'+FACTOR+'/challenge')return Response.json({id:CHALLENGE});
  if(path==='/factors/'+FACTOR+'/verify'){
   if(body.code!=='123456')return Response.json({message:'private wrong code detail'},{status:400});assert.equal(body.challenge_id,CHALLENGE);factors.get(owned.sub)![0]!.status='verified';return Response.json(issue(owned.sub,'aal2'));
  }
  if(path==='/factors/'+FACTOR&&method==='DELETE'){factors.set(owned.sub,[]);return Response.json({id:FACTOR});}
  assert.fail('Unexpected provider operation: '+method+' '+path);
 }) as typeof fetch;
 const paymentFetch=(async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input);payments.push({url,body:new URLSearchParams(String(init?.body))});return Response.json(url.endsWith('/billing_portal/sessions')?{url:'https://billing.stripe.com/p/session/test_fixture'}:{id:'cs_test_fixture',url:'https://checkout.stripe.com/c/pay/cs_test_fixture'});}) as typeof fetch;
 const instance=createGatewayServer({config,db,now:()=>time,accountFetch,fetch:paymentFetch,log:line=>logs.push(line),sendMail:async()=>{assert.fail('Managed accounts never use the legacy email approval route');},upstream:async function*(){throw Error('No model request is allowed');}});
 await new Promise<void>(done=>instance.server.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+(instance.server.address() as AddressInfo).port;config.publicOrigin=base;config.publicUrl=base;
 t.after(async()=>{instance.close();instance.server.closeAllConnections();await new Promise<void>(done=>instance.server.close(()=>done()));db.close();});
 function browser(){let cookie='',csrf='';return {
  async request(path:string,body?:unknown,headers:Record<string,string>={}){const response=await fetch(base+path,{redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:base,'Content-Type':'application/json','X-Arcane-CSRF':csrf}),...headers},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0]!;const type=response.headers.get('content-type')??'';const value:Record<string,any>=type.includes('json')?await response.json() as Record<string,any>:{};const html=type.includes('json')?null:await response.text();if(typeof value==='object'&&typeof value.csrf==='string')csrf=value.csrf;return {response,value,html};},
  async open(){const page=await this.request('/account');assert.equal(page.response.status,200);assert.match(page.response.headers.get('content-security-policy')!,/frame-ancestors 'none'/);return this.request('/v1/account/session');},
  async login(email='owner@example.com'){await this.open();return this.request('/v1/account/login',{email,password:'fixture-password-value'});},
  cookie:()=>cookie,csrf:()=>csrf,
 };}
 return {base,db,config,calls,payments,logs,browser,advance:(ms:number)=>{time+=ms;},now:()=>time,refreshFailure:(value:boolean)=>{refreshUnavailable=value;}};
}

test('browser sessions survive reloads, rotate on login and reject cross-origin or missing-CSRF writes',async t=>{
 const h=await fixture(t),b=h.browser();const initial=await b.open();assert.equal(initial.value.signedIn,false);const anonymous=b.cookie();
 const login=await b.request('/v1/account/login',{email:'owner@example.com',password:'fixture-password-value'});assert.equal(login.response.status,200);assert.notEqual(b.cookie(),anonymous);assert.equal(login.value.signedIn,true);assert.equal(login.value.owner,false,'editable metadata cannot grant owner');
 const state=await b.request('/v1/account/session');assert.equal(state.value.email,'owner@example.com');assert.equal(state.response.headers.get('cache-control'),'no-store');
 const raw=JSON.stringify(h.db.prepare('SELECT * FROM account_browser_sessions').all());assert.ok(!raw.includes('refresh_fixture_'));assert.ok(!raw.includes('fixture-password-value'));assert.ok(!raw.includes('owner@example.com'));
 for(const headers of [{Origin:'https://other.example'},{'X-Arcane-CSRF':'wrong'},{'X-Arcane-CSRF':'é'.repeat(43)}] as Record<string,string>[])assert.equal((await b.request('/v1/account/revoke-devices',{},headers)).response.status,403);
 assert.ok(!h.logs.join('\n').includes('fixture-password-value'));
});
test('Google and Apple use cookie-bound PKCE; callback replay and unrelated flows are refused',async t=>{
 const h=await fixture(t),b=h.browser();await b.open();
 for(const provider of ['google','apple']){
  const start=await b.request('/v1/account/social',{provider}),target=new URL(start.value.url);assert.equal(target.origin,h.config.accounts!.providerUrl);assert.equal(target.searchParams.get('provider'),provider);assert.equal(target.searchParams.get('code_challenge_method'),'s256');assert.match(target.searchParams.get('code_challenge')!,/^[A-Za-z0-9_-]{43}$/);
  const callback=new URL(target.searchParams.get('redirect_to')!);assert.equal((await b.request('/account/callback?flow=wrong&code=fixture-code')).response.status,403);
  const before=b.cookie(),result=await b.request(callback.pathname+callback.search+'&code=fixture-code');assert.equal(result.response.status,303);assert.notEqual(b.cookie(),before);assert.equal((await b.request(callback.pathname+callback.search+'&code=fixture-code')).response.status,403);
  assert.equal((await b.request('/v1/account/session')).value.signedIn,true);
 }
 assert.equal(h.calls.filter(c=>c==='POST /token?pkce').length,2);
});
test('MFA enrollment, native device approval and owner administration are enforced by the server',async t=>{
 const h=await fixture(t),owner=h.browser(),member=h.browser();await owner.login();assert.equal((await owner.request('/v1/admin/overview')).response.status,403);
 const setup=await owner.request('/v1/account/mfa/enroll',{});assert.equal(setup.response.status,200);assert.equal(setup.value.secret,'JBSWY3DPEHPK3PXP');
 assert.equal((await owner.request('/v1/account/mfa/verify',{factorId:FACTOR,code:'000000'})).response.status,401);
 const old=owner.cookie(),verified=await owner.request('/v1/account/mfa/verify',{factorId:FACTOR,code:'123456'});assert.equal(verified.value.owner,true);assert.equal(verified.value.mfa.verified,true);assert.notEqual(owner.cookie(),old);
 assert.equal((await owner.request('/v1/admin/overview')).response.status,200);assert.equal((await owner.request('/v1/account/mfa/remove',{factorId:FACTOR})).response.status,409,'owner cannot remove the last authenticator');
 const device=await (await fetch(h.base+'/v1/auth/device',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json() as Record<string,any>;
 const partial=h.browser();const partialLogin=await partial.login();assert.equal(partialLogin.value.mfa.required,true);assert.equal(partialLogin.value.balance,undefined);
 assert.equal((await partial.request('/v1/account/approve-device',{userCode:device.userCode})).response.status,403);
 assert.equal((await owner.request('/v1/account/approve-device',{userCode:device.userCode})).response.status,200);h.advance(6000);
 const redeemed=await (await fetch(h.base+'/v1/auth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceCode:device.deviceCode})})).json() as Record<string,any>;assert.ok(redeemed.token);
 assert.equal((await fetch(h.base+'/v1/balance',{headers:{Authorization:'Bearer '+redeemed.token}})).status,200);
 await member.login('member@example.com');assert.equal((await member.request('/v1/admin/overview')).response.status,403);
 const list=await owner.request('/v1/admin/overview'),target=list.value.accounts.find((a:Record<string,unknown>)=>a.email==='member@example.com');
 assert.equal((await owner.request('/v1/admin/account',{accountId:target.id,action:'suspend'})).response.status,200);assert.equal((await member.request('/v1/account/session')).response.status,401);
 h.advance(16*60000);assert.equal((await owner.request('/v1/admin/overview')).response.status,403,'administration requires a recent factor check');
});
test('managed checkout requires verified session ownership and billing portal ignores browser customer overrides',async t=>{
 const h=await fixture(t),b=h.browser();
 assert.equal((await fetch(h.base+'/v1/checkout',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:h.base},body:'email=other@example.com&offer=pro'})).status,401);assert.equal(h.payments.length,0);
 await b.login('member@example.com');const checkout=await b.request('/v1/account/checkout',{offer:'pro',email:'other@example.com'});assert.equal(checkout.response.status,200);
 assert.equal(h.payments[0]!.body.get('customer_email'),'member@example.com');const account=h.db.prepare('SELECT id,credits FROM accounts').get()!;assert.equal(account.credits,0,'checkout creation does not grant payment credit');
 h.db.prepare('UPDATE accounts SET customer_id=? WHERE id=?').run('cus_OwnedFixture',String(account.id));
 const portal=await b.request('/v1/account/billing-portal',{customerId:'cus_OtherAccount'});assert.equal(portal.response.status,200);assert.equal(h.payments.at(-1)!.body.get('customer'),'cus_OwnedFixture');
 assert.equal(h.payments.at(-1)!.body.get('return_url'),h.base+'/account');
});
test('concurrent refresh is serialized and provider outages retain the existing encrypted session',async t=>{
 const h=await fixture(t),b=h.browser();await b.login();const cookie=b.cookie();h.advance(3600*1000);h.refreshFailure(true);
 const failed=await b.request('/v1/account/session');assert.equal(failed.response.status,503);assert.equal(b.cookie(),cookie);assert.equal(h.db.prepare('SELECT count(*) AS n FROM account_browser_sessions').get()!.n,1);
 h.refreshFailure(false);const before=h.calls.filter(c=>c==='POST /token?refresh_token').length;
 const results=await Promise.all([b.request('/v1/account/session'),b.request('/v1/account/session')]);assert.ok(results.every(r=>r.value.signedIn));assert.equal(h.calls.filter(c=>c==='POST /token?refresh_token').length,before+1);
});

test('managed native sessions reject legacy tokens, expired approvals and expired access',async t=>{
 const h=await fixture(t),b=h.browser();await b.login('member@example.com');
 const account=h.db.prepare('SELECT id FROM accounts').get()!,legacy='arc_'+randomBytes(32).toString('base64url');
 h.db.prepare('INSERT INTO tokens(hash,account_id,created_at) VALUES(?,?,?)').run(keyedHash(h.config,'token',legacy),String(account.id),h.now());
 const balance=(token:string)=>fetch(h.base+'/v1/balance',{headers:{Authorization:'Bearer '+token}});
 assert.equal((await balance(legacy)).status,401,'old bearer records cannot bypass managed identity');
 async function approve(){
  const response=await fetch(h.base+'/v1/auth/device',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const device=await response.json() as Record<string,string>;
  assert.equal((await b.request('/v1/account/approve-device',{userCode:device.userCode})).response.status,200);return device.deviceCode;
 }
 async function redeem(code:string){return fetch(h.base+'/v1/auth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceCode:code})});}
 const expired=await approve();h.advance(5*60000+1);
 assert.equal((await (await redeem(expired)).json() as Record<string,string>).error,'invalid_grant');
 const fresh=await approve();h.advance(6000);const token=(await (await redeem(fresh)).json() as Record<string,string>).token!;
 assert.equal((await balance(token)).status,200);h.advance(30*86400000);
 assert.equal((await balance(token)).status,401,'native account access has an absolute expiry');
});

test('account login and authenticator limits follow the account across browser sessions',async t=>{
 const h=await fixture(t),b=h.browser();await b.login();
 for(let attempt=1;attempt<6;attempt++)assert.equal((await b.request('/v1/account/login',{email:'owner@example.com',password:'fixture-password-value'})).response.status,200);
 const other=h.browser();await other.open();assert.equal((await other.request('/v1/account/login',{email:'owner@example.com',password:'fixture-password-value'})).response.status,429);
 h.advance(61000);assert.equal((await other.request('/v1/account/login',{email:'owner@example.com',password:'fixture-password-value'})).response.status,200);
 assert.equal((await b.request('/v1/account/mfa/enroll',{})).response.status,200);
 for(let attempt=0;attempt<6;attempt++)assert.equal((await b.request('/v1/account/mfa/verify',{factorId:FACTOR,code:'000000'})).response.status,401);
 assert.equal((await other.request('/v1/account/mfa/verify',{factorId:FACTOR,code:'123456'})).response.status,429);
 assert.equal(h.calls.filter(c=>c==='POST /factors/'+FACTOR+'/verify').length,6,'limited attempts never reach the provider');
});

test('password changes rotate the current browser and revoke other browser and native sessions',async t=>{
 const h=await fixture(t),b=h.browser(),other=h.browser();await b.login('member@example.com');await other.login('member@example.com');
 await b.request('/v1/account/mfa/enroll',{});await b.request('/v1/account/mfa/verify',{factorId:FACTOR,code:'123456'});
 const device=await (await fetch(h.base+'/v1/auth/device',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json() as Record<string,string>;
 await b.request('/v1/account/approve-device',{userCode:device.userCode});h.advance(6000);
 const token=(await (await fetch(h.base+'/v1/auth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceCode:device.deviceCode})})).json() as Record<string,string>).token!;
 assert.equal((await fetch(h.base+'/v1/balance',{headers:{Authorization:'Bearer '+token}})).status,200);
 const previous=b.cookie(),changed=await b.request('/v1/account/password',{password:'replacement-fixture-password'});
 assert.equal(changed.response.status,200);assert.notEqual(b.cookie(),previous);assert.equal(changed.value.signedIn,true);
 assert.equal((await other.request('/v1/account/session')).response.status,401);
 assert.equal((await fetch(h.base+'/v1/balance',{headers:{Authorization:'Bearer '+token}})).status,401);
 assert.equal((await b.request('/v1/account/session')).value.signedIn,true);
 assert.ok(!h.logs.join('\n').includes('replacement-fixture-password'));
});

test('real browser account settings enroll an authenticator and protect the administration page',{skip:!process.env.ARCANE_UI_BROWSER_MODULE,timeout:45000},async t=>{
 const h=await fixture(t),{chromium}=await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
 const browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE});t.after(()=>browser.close());
 const context=await browser.newContext(),page=await context.newPage(),errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
 await page.goto(h.base+'/account');await page.locator('#login').waitFor({state:'visible'});
 await page.locator('#email').fill('owner@example.com');await page.locator('#password').fill('fixture-password-value');await page.locator('#login-form button').click();
 await page.locator('#account').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>localStorage.length),0);assert.equal(await page.evaluate(()=>sessionStorage.length),0);
 const cookies=await context.cookies();assert.equal(cookies.find((cookie:{name:string})=>cookie.name==='arcane-session')?.httpOnly,true);assert.ok(!(await page.evaluate(()=>document.cookie)).includes('arcane-session'));
 await page.locator('#enroll').click();await page.locator('#secret').waitFor({state:'visible'});assert.equal(await page.locator('#secret').innerText(),'JBSWY3DPEHPK3PXP');
 await page.locator('#code').fill('123456');await page.locator('#mfa-form button').click();await page.locator('#admin-link').waitFor({state:'visible'});
 assert.equal(await page.locator('#secret').textContent(),'');assert.equal(await page.locator('#setup').isVisible(),false);
 await page.locator('#admin-link').click();await page.locator('#admin').waitFor({state:'visible'});assert.match(await page.locator('#users').innerText(),/owner@example.com/);
 assert.equal(await page.evaluate(async()=>{const response=await fetch('/v1/admin/account',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return response.status;}),403);
 if(process.env.ARCANE_ACCOUNT_SCREENSHOT)await page.screenshot({path:process.env.ARCANE_ACCOUNT_SCREENSHOT+'.desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 if(process.env.ARCANE_ACCOUNT_SCREENSHOT)await page.screenshot({path:process.env.ARCANE_ACCOUNT_SCREENSHOT+'.mobile.png',fullPage:true});
 const other=await browser.newContext(),memberPage=await other.newPage();await memberPage.goto(h.base+'/account');await memberPage.locator('#login').waitFor({state:'visible'});
 await memberPage.locator('#email').fill('member@example.com');await memberPage.locator('#password').fill('fixture-password-value');await memberPage.locator('#login-form button').click();await memberPage.locator('#account').waitFor({state:'visible'});
 await memberPage.goto(h.base+'/admin');await memberPage.waitForFunction(()=>document.getElementById('message')?.textContent?.includes('Owner access is required'));
 assert.equal(await memberPage.locator('#admin').isVisible(),false);assert.equal((await memberPage.locator('#users').textContent())?.trim(),'');assert.ok(!(await memberPage.content()).includes('owner@example.com'));
 assert.deepEqual(errors,[]);
});
