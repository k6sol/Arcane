import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {GatewayConfig} from './config.ts';
import {AccountStore,type BrowserSession} from './account-store.ts';
import {AccountError,readTokens,type AccountIdentity,type ProviderTokens} from './account-provider.ts';
import {createAccountProvider} from './account-provider.ts';
import {tx} from './db.ts';

export function createBrowserSessions(config:GatewayConfig,store:AccountStore,provider:ReturnType<typeof createAccountProvider>,now:()=>number){
  const secure=new URL(config.publicOrigin).protocol==='https:';
  if(!secure&&(config.production||!['localhost','127.0.0.1','[::1]'].includes(new URL(config.publicOrigin).hostname)))throw Error('Account sessions require HTTPS.');
  const name=secure?'__Host-arcane-session':'arcane-session';
  function cookie(req:IncomingMessage):string|undefined {
    const matches=(req.headers.cookie??'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(name+'='));
    return matches.length===1?matches[0].slice(name.length+1):undefined;
  }
  function setCookie(res:ServerResponse,value:string,seconds:number):void {
    res.setHeader('Set-Cookie',name+'='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+seconds+(secure?'; Secure':''));
  }
  function read(req:IncomingMessage):BrowserSession|null{return store.read(cookie(req),now());}
  function begin(req:IncomingMessage,res:ServerResponse):BrowserSession {
    const current=read(req);if(current)return current;
    const fresh=store.create(now());setCookie(res,fresh.cookie,900);return fresh.session;
  }
  function csrf(req:IncomingMessage,session:BrowserSession):void {
    const value=req.headers['x-arcane-csrf'];
    if(req.headers.origin!==config.publicOrigin||typeof value!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(value)||!timingSafeEqual(Buffer.from(value),Buffer.from(session.data.csrf)))throw new AccountError(403,'request_rejected','Reload this page before trying again.');
    const site=req.headers['sec-fetch-site'];if(site&&site!=='same-origin'&&site!=='none')throw new AccountError(403,'request_rejected','This request must come from Arcane.');
  }
  function rotate(res:ServerResponse,previous:BrowserSession,tokens:ProviderTokens,identity:AccountIdentity,mfaAt?:number):BrowserSession {
    const fresh=tx(store.db,()=>{const created=store.create(now(),{csrf:randomBytes(32).toString('base64url'),createdAt:now(),accessToken:tokens.access_token,refreshToken:tokens.refresh_token,
      ...(previous.data.deviceCode?{deviceCode:previous.data.deviceCode}:{}),...(previous.data.checkoutOffer?{checkoutOffer:previous.data.checkoutOffer}:{}),
      ...(previous.data.recovery?{recovery:true}:{}),...(mfaAt!==undefined?{mfaAt}:{})},identity.subject);store.remove(previous.hash);return created;});
    setCookie(res,fresh.cookie,30*86400);return fresh.session;
  }
  async function authenticate(session:BrowserSession):Promise<AccountIdentity> {
    if(!session.data.accessToken||!session.data.refreshToken||!session.subject)throw new AccountError(401,'sign_in_required','Sign in to your Arcane account.');
    // An untrusted expiry is only a refresh hint. The resulting token is always authenticated through GET /user.
    let expiry=0;try{expiry=Number(JSON.parse(Buffer.from(session.data.accessToken.split('.')[1]??'','base64url').toString('utf8')).exp)*1000;}catch{}
    if(!Number.isFinite(expiry)||expiry<now()+30000){
      const tokens=readTokens(await provider.request('POST','/token?grant_type=refresh_token',{refresh_token:session.data.refreshToken}));
      const identity=await provider.identity(tokens.access_token,now());if(identity.subject!==session.subject)throw new AccountError(403,'session_changed','Start a new sign-in to continue.');
      session.data.accessToken=tokens.access_token;session.data.refreshToken=tokens.refresh_token;store.save(session,now());return identity;
    }
    const identity=await provider.identity(session.data.accessToken,now());if(identity.subject!==session.subject)throw new AccountError(403,'session_changed','Start a new sign-in to continue.');return identity;
  }
  function startFlow(session:BrowserSession,providerName:NonNullable<BrowserSession['data']['flow']>['provider']):{challenge:string;redirect:string}{
    const verifier=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url');
    session.data.flow={nonce,verifier,provider:providerName};store.save(session,now());
    return {challenge:createHash('sha256').update(verifier).digest('base64url'),redirect:config.publicOrigin+'/account/callback?flow='+nonce};
  }
  async function finishFlow(req:IncomingMessage,res:ServerResponse,url:URL):Promise<BrowserSession>{
    const session=read(req),flow=session?.data.flow;
    if(!session||!flow||url.searchParams.get('flow')!==flow.nonce)throw new AccountError(403,'flow_expired','Open the link in the browser where you started sign-in, or sign in again.');
    const code=url.searchParams.get('code');if(!code||code.length>512||! /^[A-Za-z0-9_-]+$/.test(code))throw new AccountError(400,'flow_expired','Sign-in was not completed. Start again.');
    delete session.data.flow;store.save(session,now()); // Consume before exchanging the one-time code.
    const tokens=readTokens(await provider.request('POST','/token?grant_type=pkce',{auth_code:code,code_verifier:flow.verifier}));
    const identity=await provider.identity(tokens.access_token,now());session.data.recovery=flow.provider==='recovery';
    return rotate(res,session,tokens,identity);
  }
  function clear(res:ServerResponse,session:BrowserSession):void{store.remove(session.hash);setCookie(res,'',0);}
  return {read,begin,csrf,rotate,authenticate,startFlow,finishFlow,clear};
}
