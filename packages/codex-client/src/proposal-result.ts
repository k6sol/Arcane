import { setTimeout as pause } from 'node:timers/promises';
import { CodexClientError, type Snapshot, type ThreadState } from './types.js';

export const PROPOSAL_OUTPUT_BYTES=64*1024;
export const PROPOSAL_DURATION_MS=60_000;
export interface ProposalResult {
  readonly threadId:string;readonly sessionId:string|null;readonly turnId:string;
  readonly text:string;readonly status:'proposed';
}
/** Private projection over one acknowledged worker turn; never an acceptance receipt. */
export async function collectProposalResult(input:{snapshot():Snapshot;ack:ThreadState;baseline:Snapshot;
  assertOwner():void;signal:AbortSignal;deadline:number}):Promise<ProposalResult>{
  const {ack,baseline}=input;
  function fail(code:string,message:string):never{throw new CodexClientError(code,message,true);}
  if(!ack.configured||!ack.turnId||baseline.droppedEvents!==0)
    fail('PROPOSAL_INCOMPLETE','The proposal turn cannot be projected completely.');
  let seq=baseline.lastEventSeq,text='',bytes=0,completed=false;
  const items=new Set<string>();let previousItem:string|null=null;
  for(;;){
    input.assertOwner();
    if(input.signal.aborted)fail('PARENT_SCOPE','The original task is no longer active.');
    if(Date.now()>=input.deadline)fail('PROPOSAL_TIMEOUT','The proposal exceeded its execution bound.');
    const snapshot=input.snapshot(),thread=snapshot.thread;
    if(!snapshot.connected||!snapshot.ready||snapshot.mcpIsolation!=='proposal-verified'||snapshot.failureCode||
        !thread?.configured||thread.threadId!==ack.threadId||thread.sessionId!==ack.sessionId||thread.turnId!==ack.turnId||
        thread.selection.model!==ack.selection.model||thread.selection.effort!==ack.selection.effort)
      fail('PROPOSAL_INCOMPLETE','The proposal worker no longer has its acknowledged scope.');
    const operations=snapshot.operations.filter(operation=>operation.method==='turn/start');
    if(operations.length!==1||operations[0]!.state!=='acknowledged'||operations[0]!.threadId!==ack.threadId||operations[0]!.turnId!==ack.turnId||
        snapshot.droppedEvents!==baseline.droppedEvents)
      fail('PROPOSAL_INCOMPLETE','The proposal event stream is incomplete.');
    for(const event of snapshot.events){
      if(event.seq<=seq)continue;
      if(event.seq!==seq+1)fail('PROPOSAL_INCOMPLETE','The proposal event stream has a gap.');
      seq=event.seq;
      if(event.type==='account-changed'||event.type==='error')fail('PROPOSAL_INCOMPLETE','The proposal scope changed or reported an error.');
      if('threadId' in event&&event.threadId!==ack.threadId||'turnId' in event&&event.turnId!==ack.turnId)
        fail('PROPOSAL_INCOMPLETE','The proposal event has a different scope.');
      if(event.type==='turn'){
        if(event.status==='completed')completed=true;
        else if(['failed','interrupted','unknown'].includes(event.status))fail('PROPOSAL_FAILED','The proposal turn did not complete.');
      }
      if(event.type!=='delta')continue;
      if(completed)fail('PROPOSAL_INCOMPLETE','Proposal output arrived after completion.');
      items.add(event.itemId);
      const separator=previousItem!==null&&previousItem!==event.itemId?'\n\n':'';
      const addition=separator+event.text;
      bytes+=Buffer.byteLength(addition);
      if(bytes>PROPOSAL_OUTPUT_BYTES||items.size>32)fail('PROPOSAL_OUTPUT','The proposal exceeded its output bound.');
      text+=addition;previousItem=event.itemId;
    }
    if(seq!==snapshot.lastEventSeq)fail('PROPOSAL_INCOMPLETE','The proposal event stream is incomplete.');
    if(thread.turnStatus==='completed'){
      if(!completed||!text.trim())fail('PROPOSAL_INCOMPLETE','The completed proposal has no complete text result.');
      input.assertOwner();
      return Object.freeze({threadId:ack.threadId,sessionId:ack.sessionId,turnId:ack.turnId,text,status:'proposed'});
    }
    if(thread.turnStatus!=='inProgress')fail('PROPOSAL_FAILED','The proposal turn did not complete.');
    try{await pause(Math.min(25,Math.max(1,input.deadline-Date.now())),undefined,{signal:input.signal});}
    catch{input.assertOwner();fail('PROPOSAL_INCOMPLETE','The proposal was interrupted.');}
  }
}
