/** Supabase Auth REST adapter. Provider tokens stay in the server's encrypted session store. */
import type {AccountsConfig} from './account-config.ts';
export class AccountError extends Error {
  status:number;code:string;
  constructor(status:number,code:string,message:string){super(message);this.status=status;this.code=code;}
}
export interface ProviderTokens {access_token:string;refresh_token:string}
export interface AccountIdentity {
  subject:string;email:string;aal:'aal1'|'aal2';expiresAt:number;
  factors:{id:string;type:string;status:string;name:string}[];
}
export const providerId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function readTokens(value:unknown):ProviderTokens {
  if(!record(value)||typeof value.access_token!=='string'||value.access_token.length>16384||! /^[A-Za-z0-9._-]+$/.test(value.access_token)||typeof value.refresh_token!=='string'||! /^[A-Za-z0-9_-]{8,512}$/.test(value.refresh_token))throw new AccountError(502,'provider_reply','The sign-in response could not be verified.');
  return {access_token:value.access_token,refresh_token:value.refresh_token};
}

export function createAccountProvider(config:AccountsConfig,doFetch:typeof fetch=fetch){
  async function request(method:string,path:string,body:unknown=null,token?:string):Promise<Record<string,unknown>> {
    try{
      const response=await doFetch(config.providerUrl+'/auth/v1'+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{apikey:config.publishableKey,...(token?{Authorization:'Bearer '+token}:{}),...(body===null?{}:{'Content-Type':'application/json'})},
        ...(body===null?{}:{body:JSON.stringify(body)})});
      const reader=response.body?.getReader();let length=0;const chunks:Uint8Array[]=[];
      if(reader)try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>128*1024)throw new Error('Bounded provider response');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      if(!response.ok)throw new AccountError(response.status===429?429:response.status>=500?503:401,'sign_in_unavailable',response.status===429?'Wait a moment before trying again.':'Sign-in could not be completed. Check your details and try again.');
      if(!length)return {};
      const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!record(value))throw Error('Provider shape');return value;
    }catch(error){if(error instanceof AccountError)throw error;throw new AccountError(503,'sign_in_unavailable','Account services are temporarily unavailable. Try again shortly.');}
  }
  async function identity(token:string,now:number):Promise<AccountIdentity> {
    // getUser authenticates this exact JWT with the provider before any claims are used for access decisions.
    const user=await request('GET','/user',null,token);
    try{
      const claims:unknown=JSON.parse(Buffer.from(token.split('.')[1]??'','base64url').toString('utf8'));
      if(!record(claims)||!providerId(user.id)||claims.sub!==user.id||claims.iss!==config.providerUrl+'/auth/v1'||claims.aud!=='authenticated'||!Number.isSafeInteger(claims.exp)||Number(claims.exp)*1000<=now||typeof user.email!=='string'||!user.email_confirmed_at)throw Error('Identity');
      const email=user.email.trim().toLowerCase();if(email.length>254||! /^[^\s@<>"']+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email))throw Error('Email');
      if(user.factors!==undefined&&(!Array.isArray(user.factors)||user.factors.length>32))throw Error('Factors');
      const factors=(user.factors as unknown[]|undefined??[]).map(value=>{
        if(!record(value)||!providerId(value.id)||typeof value.factor_type!=='string'||!['verified','unverified'].includes(String(value.status)))throw Error('Factor');
        return {id:value.id,type:value.factor_type,status:String(value.status),name:typeof value.friendly_name==='string'?value.friendly_name.slice(0,80):'Authenticator'};
      });
      return {subject:user.id,email,aal:claims.aal==='aal2'?'aal2':'aal1',expiresAt:Number(claims.exp)*1000,factors};
    }catch{throw new AccountError(403,'identity_unverified','Verify your email before continuing.');}
  }
  return {request,identity};
}
