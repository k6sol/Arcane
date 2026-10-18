import {randomBytes} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import type {GatewayConfig} from './config.ts';
import {findOffer} from './config.ts';
import {AccountStore,AccountStorageError,type BrowserSession} from './account-store.ts';
import {AccountError,createAccountProvider,providerId,readTokens} from './account-provider.ts';
import {createAccountAccess} from './account-access.ts';
import {createBrowserSessions} from './account-session.ts';
import {normalizeEmail,normalizeUserCode} from './auth.ts';
import {audit,tx,type Account} from './db.ts';
import {balanceOf} from './billing.ts';
import {RateLimiter} from './limits.ts';
import {createCustomerPortalSession} from './stripe.ts';
import {accountPage} from './account-ui.ts';

interface Dependencies {
 config:GatewayConfig;db:DatabaseSync;now:()=>number;providerFetch?:typeof fetch;paymentFetch?:typeof fetch;
 checkout(account:Account,offer:unknown,key:string|null):Promise<{status:number;body:unknown}>;
}
export function createAccountRoutes(deps:Dependencies){
 const {config,db,now}=deps;if(!config.accounts)return null;
 const settings=config.accounts,store=new AccountStore(db,settings),provider=createAccountProvider(settings,deps.providerFetch);
 const access=createAccountAccess(db,settings,store),sessions=createBrowserSessions(config,store,provider,now);
 const rate=new RateLimiter(20),loginRate=new RateLimiter(6),factorRate=new RateLimiter(6),locks=new Map<string,{tail:Promise<void>;count:number}>();
 function send(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
 function redirect(res:ServerResponse,url:string){res.writeHead(303,{Location:url,'Cache-Control':'no-store'});res.end();}
 function page(res:ServerResponse){const nonce=randomBytes(24).toString('base64');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
   'Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+"'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});res.end(accountPage(nonce));}
 async function json(req:IncomingMessage):Promise<Record<string,unknown>>{
  if(!/^application\/json\b/i.test(req.headers['content-type']??''))throw new AccountError(415,'bad_request','Send application/json.');
  let size=0;const chunks:Buffer[]=[];for await(const part of req){size+=part.length;if(size>16384)throw new AccountError(413,'bad_request','This request is too large.');chunks.push(Buffer.from(part));}
  try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,unknown>;}catch{throw new AccountError(400,'bad_request','Check the submitted details.');}
 }
 function password(value:unknown):string{if(typeof value!=='string'||value.length<12||Buffer.byteLength(value)>1024)throw new AccountError(400,'password_length','Use a password of at least 12 characters.');return value;}
 function email(value:unknown):string{const result=normalizeEmail(value);if(!result)throw new AccountError(400,'email_invalid','Enter a valid email address.');return result;}
 function factor(sessionIdentity:Awaited<ReturnType<typeof provider.identity>>,value:unknown){const found=sessionIdentity.factors.find(f=>f.id===value);if(!providerId(value)||!found)throw new AccountError(400,'factor_invalid','Choose an authenticator on this account.');return found;}
 async function serialized<T>(key:string,work:()=>Promise<T>):Promise<T>{
  let queue=locks.get(key);if(queue?.count===4||!queue&&locks.size>=128)throw new AccountError(429,'busy','An account request is already running. Try again shortly.');
  if(!queue){queue={tail:Promise.resolve(),count:0};locks.set(key,queue);}const previous=queue.tail;let release!:()=>void;queue.tail=new Promise<void>(done=>{release=done;});queue.count++;
  await previous;try{return await work();}finally{release();queue.count--;if(!queue.count)locks.delete(key);}
 }
 async function authenticated(session:BrowserSession){return access.resolve(await sessions.authenticate(session),now());}
 function freshMfa(session:BrowserSession){if(!Number.isSafeInteger(session.data.mfaAt)||Number(session.data.mfaAt)>now()||now()-Number(session.data.mfaAt)>15*60000)throw new AccountError(403,'step_up_required','Verify your authenticator again before changing security settings.');}
 async function view(session:BrowserSession){
  const basic={csrf:session.data.csrf,providers:settings.providers,authOrigin:settings.providerUrl,deviceCode:session.data.deviceCode??'',offer:session.data.checkoutOffer??''};
  if(!session.subject||!session.data.accessToken)return {...basic,signedIn:false};
  const principal=await authenticated(session),verified=!principal.mfaRequired||principal.identity.aal==='aal2';
  return {...basic,signedIn:true,email:principal.identity.email,owner:principal.owner,
    adminReady:principal.owner&&principal.identity.aal==='aal2'&&Number.isSafeInteger(session.data.mfaAt)&&now()-Number(session.data.mfaAt)<=15*60000,
    ownerSetup:settings.bootstrapEmail===principal.identity.email&&!db.prepare('SELECT 1 FROM account_bootstrap').get(),recovery:!!session.data.recovery,
    mfa:{enabled:principal.identity.factors.some(f=>f.status==='verified'),required:principal.mfaRequired,verified:principal.identity.aal==='aal2',factors:principal.identity.factors},
    ...(verified?{balance:balanceOf(principal.account),offers:config.catalog.filter(o=>o.price).map(o=>({id:o.id,kind:o.kind})),billingAvailable:!!principal.account.customer_id}:{} )};
 }
 async function handle(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>{
  const path=url.pathname,key=(req.method??'GET')+' '+path;
  const legacy=path==='/checkout'||path==='/v1/auth/verify'||path==='/v1/auth/confirm'||path==='/v1/checkout'&&!req.headers.authorization;
  if(!legacy&&path!=='/account'&&path!=='/admin'&&!path.startsWith('/account/')&&!path.startsWith('/v1/account/')&&!path.startsWith('/v1/admin/'))return false;
  res.setHeader('Cache-Control','no-store');
  try{
   const ip=config.trustProxy?String(req.headers['x-forwarded-for']??'').split(',')[0].trim()||req.socket.remoteAddress:req.socket.remoteAddress;
   if(!rate.take(String(ip)+':'+(req.method==='GET'?'read':'write'),now()))throw new AccountError(429,'rate_limited','Wait a moment before trying again.');
   store.sweep(now());
   if(key==='GET /account'||key==='GET /admin'){
    const session=sessions.begin(req,res),code=normalizeUserCode(url.searchParams.get('user_code')),offer=findOffer(config,url.searchParams.get('offer'));
    if(code||offer){if(code)session.data.deviceCode=code;if(offer)session.data.checkoutOffer=offer.id;store.save(session,now());}
    page(res);return true;
   }
   if(legacy){
    if(req.method!=='GET')throw new AccountError(401,'sign_in_required','Sign in through your Arcane account before continuing.');
    const params=new URLSearchParams(),code=normalizeUserCode(url.searchParams.get('user_code')),offer=findOffer(config,url.searchParams.get('offer'));
    if(code)params.set('user_code',code);if(offer)params.set('offer',offer.id);redirect(res,config.publicOrigin+'/account'+(params.size?'?'+params:''));return true;
   }
   const session=sessions.read(req);if(!session)throw new AccountError(401,'sign_in_required','Reload this page to sign in.');
   await serialized(session.hash,async()=>{
    const current=sessions.read(req);if(!current)throw new AccountError(401,'session_changed','Reload this page to continue.');
    if(key==='GET /account/callback'){
     const next=await sessions.finishFlow(req,res,url);await authenticated(next);redirect(res,config.publicOrigin+'/account');return;
    }
    if(key==='GET /v1/account/session'){send(res,200,await view(current));return;}
    if(key==='GET /v1/admin/overview'){const principal=await authenticated(current);send(res,200,access.dashboard(principal,current.data.mfaAt,url.searchParams.get('after')??'',now()));return;}
    if(req.method!=='POST')throw new AccountError(404,'not_found','Not found.');sessions.csrf(req,current);const body=await json(req);
    if(key==='POST /v1/account/login'){
     const address=email(body.email);if(!loginRate.take(store.hash('login',address),now()))throw new AccountError(429,'rate_limited','Wait a moment before trying to sign in again.');
     const tokens=readTokens(await provider.request('POST','/token?grant_type=password',{email:address,password:password(body.password)}));
     const identity=await provider.identity(tokens.access_token,now());access.resolve(identity,now());const next=sessions.rotate(res,current,tokens,identity);send(res,200,await view(next));return;
    }
    if(key==='POST /v1/account/signup'||key==='POST /v1/account/recover'){
     const recovery=key.endsWith('/recover'),flow=sessions.startFlow(current,recovery?'recovery':'signup');
     await provider.request('POST',(recovery?'/recover':'/signup')+'?redirect_to='+encodeURIComponent(flow.redirect),{email:email(body.email),...(!recovery?{password:password(body.password)}:{}),code_challenge:flow.challenge,code_challenge_method:'s256'});
     send(res,200,{message:'Check your email and open the link in this browser. You can then return to Arcane.'});return;
    }
    if(key==='POST /v1/account/social'){
     if(!settings.providers.includes(body.provider as 'google'|'apple'))throw new AccountError(400,'provider_invalid','Choose an available sign-in provider.');
     const name=body.provider as 'google'|'apple',flow=sessions.startFlow(current,name),target=new URL(settings.providerUrl+'/auth/v1/authorize');
     target.search=new URLSearchParams({provider:name,redirect_to:flow.redirect,code_challenge:flow.challenge,code_challenge_method:'s256'}).toString();send(res,200,{url:target.href});return;
    }
    if(key==='POST /v1/account/logout'){sessions.clear(res,current);send(res,200,{signedOut:true});return;}
    const principal=await authenticated(current),token=current.data.accessToken!;
    if(key==='POST /v1/account/mfa/enroll'){
     access.requireMfa(principal);const result=await provider.request('POST','/factors',{factor_type:'totp',friendly_name:'Arcane authenticator '+new Date(now()).toISOString().slice(0,10),issuer:'Arcane'},token);
     const totp=result.totp as Record<string,unknown>|undefined;if(!providerId(result.id)||!totp||typeof totp.secret!=='string'||! /^[A-Z2-7]{16,512}$/.test(totp.secret))throw new AccountError(502,'factor_reply','Authenticator setup could not be verified.');
     send(res,200,{id:result.id,secret:totp.secret,qrCode:typeof totp.qr_code==='string'&&totp.qr_code.length<65536?totp.qr_code:null});return;
    }
    if(key==='POST /v1/account/mfa/verify'){
     if(!factorRate.take(principal.identity.subject,now()))throw new AccountError(429,'rate_limited','Wait a moment before trying another verification code.');
     const selected=factor(principal.identity,body.factorId);if(selected.type!=='totp'||typeof body.code!=='string'||! /^\d{6}$/.test(body.code))throw new AccountError(400,'code_invalid','Enter the six-digit code from your authenticator.');
     const challenge=await provider.request('POST','/factors/'+selected.id+'/challenge',{},token);if(!providerId(challenge.id))throw new AccountError(502,'factor_reply','Verification could not be started.');
     const tokens=readTokens(await provider.request('POST','/factors/'+selected.id+'/verify',{challenge_id:challenge.id,code:body.code},token)),identity=await provider.identity(tokens.access_token,now());
     if(identity.subject!==principal.identity.subject||identity.aal!=='aal2')throw new AccountError(403,'factor_reply','Verification could not be confirmed.');
     const verified=access.resolve(identity,now());access.claimOwner(verified,now(),now());const next=sessions.rotate(res,current,tokens,identity,now());audit(db,principal.account.id,'auth.mfa_verified',{});send(res,200,await view(next));return;
    }
    access.requireMfa(principal);
    if(key==='POST /v1/account/mfa/remove'){
     const selected=factor(principal.identity,body.factorId);if(selected.status==='verified')freshMfa(current);
     if(principal.owner&&selected.status==='verified'&&principal.identity.factors.filter(f=>f.status==='verified'&&f.type!=='recovery_code').length<=1)throw new AccountError(409,'owner_mfa_required','Keep at least one authenticator on the owner account.');
     await provider.request('DELETE','/factors/'+selected.id,null,token);const tokens=readTokens(await provider.request('POST','/token?grant_type=refresh_token',{refresh_token:current.data.refreshToken}));
     const identity=await provider.identity(tokens.access_token,now());if(identity.subject!==principal.identity.subject)throw new AccountError(403,'session_changed','Start a new sign-in.');
     access.resolve(identity,now());db.prepare('UPDATE tokens SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').run(now(),principal.account.id);
     const next=sessions.rotate(res,current,tokens,identity);send(res,200,await view(next));return;
    }
    if(key==='POST /v1/account/password'){
     if(principal.mfaRequired)freshMfa(current);else if(!current.data.recovery)throw new AccountError(403,'reauth_required','Request a password reset email before changing your password.');
     await provider.request('PUT','/user',{password:password(body.password)},token);delete current.data.recovery;
     tx(db,()=>{
      db.prepare('UPDATE tokens SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').run(now(),principal.account.id);
      db.prepare('DELETE FROM account_browser_sessions WHERE subject=? AND hash<>?').run(principal.identity.subject,current.hash);
      audit(db,principal.account.id,'auth.password_changed',{});
     });
     const next=sessions.rotate(res,current,{access_token:token,refresh_token:current.data.refreshToken!},principal.identity,current.data.mfaAt);
     send(res,200,{...await view(next),message:'Password updated. Other browser and Arcane device sessions were signed out.'});return;
    }
    if(key==='POST /v1/account/approve-device'){access.approveDevice(principal,body.userCode,now());send(res,200,{message:'Device approved. Return to Arcane.'});return;}
    if(key==='POST /v1/account/checkout'){const offer=findOffer(config,body.offer);if(!offer)throw new AccountError(404,'offer_invalid','This offer is unavailable.');
     const result=await deps.checkout({...principal.account,email:principal.identity.email},offer.id,null);send(res,result.status,result.body);return;}
    if(key==='POST /v1/account/billing-portal'){const result=await createCustomerPortalSession(config,principal.account.customer_id,deps.paymentFetch);send(res,200,result);return;}
    if(key==='POST /v1/account/revoke-devices'){tx(db,()=>{db.prepare('UPDATE tokens SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').run(now(),principal.account.id);audit(db,principal.account.id,'auth.devices_revoked',{});});send(res,200,{message:'All Arcane device sessions were signed out.'});return;}
    if(key==='POST /v1/admin/account'){
     if(typeof body.accountId!=='string'||! /^acct_[a-f0-9]{32}$/.test(body.accountId)||!['suspend','restore','revoke'].includes(String(body.action)))throw new AccountError(400,'bad_request','Choose a valid account action.');
     access.administer(principal,current.data.mfaAt,body.accountId,body.action as 'suspend'|'restore'|'revoke',now());send(res,200,{updated:true});return;
    }
    throw new AccountError(404,'not_found','Not found.');
   });
  }catch(error){const known=error instanceof AccountError;send(res,known?error.status:error instanceof AccountStorageError?409:500,{error:known?error.code:'account_unavailable',message:known?error.message:'Account services are unavailable. Keep this page open and try again.'});}
  return true;
 }
 return handle;
}
