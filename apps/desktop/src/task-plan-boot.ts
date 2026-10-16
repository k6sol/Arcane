/// <reference lib="dom" />
import { TaskPlanCard, type TaskPlanSelection } from './codex-task-plan.js';
import type { CodexChat, CodexChatApi } from './codex-chat.js';

/** Product composition only. Selection comes from the real chat controller and
 * review navigation from the workbench; no native action or review is invoked. */
export function startTaskPlanCard(doc:Document,options:{
  chat:Pick<CodexChat,'currentStateView'|'subscribeStateChange'>;
  api:Pick<CodexChatApi,'taskPlan'|'safe'>;
  openReview(runId:string,isCurrent:()=>boolean):Promise<void>;
}){
  const host=doc.getElementById('codex-task-plan');if(!host)return{stop(){},resume(){},sync(){}};
  let stopped=false,key='',read:AbortController|null=null,lastRead=-Infinity,timer:ReturnType<typeof setTimeout>|null=null;
  const cancelTimer=()=>{if(timer!==null){clearTimeout(timer);timer=null;}};
  const selection=():{scope:TaskPlanSelection;key:string}|null=>{
    const view=options.chat.currentStateView(),state=view.state,snapshot=state?.snapshot,thread=snapshot?.thread;
    if(!view.fresh||view.switching||!view.nativeBoundToActiveChat||view.preferredProvider!=='codex'||state?.connecting||state?.closing||state?.displayLimited||!snapshot?.connected||!snapshot.ready||
      snapshot.account?.auth!=='subscription'||snapshot.mcpIsolation!=='arcane-only-verified'||!thread?.configured)return null;
    const task=state?.chatTasks?.findLast(task=>task.connectionId===snapshot.connectionId&&task.threadId===thread.threadId&&task.sessionId===thread.sessionId);if(!task)return null;
    return{scope:{connectionId:snapshot.connectionId,threadId:thread.threadId,taskId:task.taskId},
      key:JSON.stringify([state!.projectPath,view.activeChat?.key??null,snapshot.connectionId,thread.threadId,thread.sessionId,thread.selection.model,thread.selection.effort,task.taskId])};
  };
  const mount=()=>TaskPlanCard.mount(doc,host,{safe:text=>options.api.safe(text),
    read:async scope=>{read?.abort();const controller=new AbortController();read=controller;
      try{return await options.api.taskPlan(scope,controller.signal);}finally{if(read===controller)read=null;}},
    navigateReview:runId=>{
      const expected=key,isCurrent=()=>!stopped&&key===expected&&selection()?.key===expected;
      if(!isCurrent())return;
      void options.openReview(runId,isCurrent).finally(()=>{
        // End this navigation view so a later visit can reopen evidence. The
        // card's one-flight guard still blocks duplicate clicks during navigation.
        if(isCurrent()){card.setSelection(null);key='';}
      }).catch(()=>{});
    }});
  let card=mount();
  const sync=()=>{
    if(stopped)return;const next=selection(),nextKey=next?.key??'';
    if(nextKey!==key){cancelTimer();lastRead=-Infinity;read?.abort();read=null;card.setSelection(null);key=nextKey;}
    card.setSelection(next?.scope??null);if(!next)return;
    // State notifications also include typing. Rechecking current evidence should
    // follow the status cadence, rather than hashing files for every keystroke.
    const wait=1000-(Date.now()-lastRead);
    if(wait>0){if(timer===null)timer=setTimeout(()=>{timer=null;sync();},wait);return;}
    cancelTimer();lastRead=Date.now();void card.refresh();
  };
  let remove=options.chat.subscribeStateChange(sync);sync();
  return{sync,stop(){if(stopped)return;stopped=true;cancelTimer();lastRead=-Infinity;read?.abort();read=null;remove();card.dispose();key='';},
    resume(){if(!stopped)return;stopped=false;card=mount();remove=options.chat.subscribeStateChange(sync);sync();}};
}
