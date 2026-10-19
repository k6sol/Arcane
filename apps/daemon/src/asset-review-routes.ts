import type {IncomingMessage,ServerResponse} from 'node:http';
import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import {assertLearningHumanRequest,LearningHttpError} from './learning-service.js';
import {readAssetJson,discardRejectedAssetBody} from './asset-routes.js';
import type {AssetReviewHost} from './asset-review-host.js';

const PREFIX='/v1/assets/review/';
/** Human launcher control only. Native/provider/general agent bearers cannot
 * prepare a human review or submit an approval, even with a known review ID. */
export function assetReviewRoutes(host:AssetReviewHost){
  return async(request:IncomingMessage,response:ServerResponse,url:URL,controlToken:string,origin:string,agentToken:string):Promise<boolean>=>{
    if(!url.pathname.startsWith(PREFIX))return false;
    const send=async(status:number,value:unknown)=>{
      const drained=status<400||await discardRejectedAssetBody(request);if(response.destroyed||response.headersSent)return;
      if(!drained)response.setHeader('Connection','close');
      const text=JSON.stringify(value,(_key,item:unknown)=>{if(typeof item!=='string')return item;let redacted:string=item;for(const secret of [controlToken,agentToken])if(secret)redacted=redacted.replaceAll(secret,'[REDACTED]');return redacted;});
      response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});response.end(text);
    };
    try{
      assertLearningHumanRequest(request,controlToken,origin,agentToken);
      const counts=new Map<string,number>();for(let at=0;at<request.rawHeaders.length;at+=2){const key=request.rawHeaders[at]!.toLowerCase();counts.set(key,(counts.get(key)??0)+1);}
      for(const key of ['content-type','content-length','transfer-encoding'])if((counts.get(key)??0)>1)throw new LearningHttpError('HEADER',400);
      if(request.method!=='POST')throw new LearningHttpError('METHOD',405);
      if(url.origin!==origin||url.username||url.password||url.hash||url.search||request.url!==url.pathname)throw new LearningHttpError('TARGET',400);
      const route=url.pathname.slice(PREFIX.length);if(!['prepare','status','decide','receipt'].includes(route)){await send(404,{error:'NOT_FOUND',retry:false});return true;}
      const input=await readAssetJson(request,false),authority={controlToken,origin,agentToken};
      const result=route==='prepare'?await host.prepare(input,request,authority):route==='status'?await host.status(input,request,authority):
        route==='decide'?await host.decide(input,request,authority):await host.receipt(input,request,authority);
      await send(200,result);return true;
    }catch(error){
      if(error instanceof LearningHttpError){await send(error.status,{error:error.code,retry:false});return true;}
      if(error instanceof ArcaneError){
        const code=error.code;
        if(code==='ASSET_REVIEW_UNKNOWN'){await send(202,{state:'unknown',error:code,retry:false});return true;}
        const status=code.endsWith('_NOT_FOUND')?404:code.endsWith('_INPUT')||['INPUT','JSON','CONTENT_TYPE','BODY','BODY_LIMIT','BODY_TIMEOUT'].includes(code)?400:409;
        await send(status,{error:code,message:'Model review is unavailable, pending or changed.',retry:false});return true;
      }
      await send(503,{error:'ASSET_REVIEW_UNAVAILABLE',retry:false});return true;
    }
  };
}
