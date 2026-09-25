"use client";
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AgentApprovalPrompt, type ApprovalDecision } from './agent-approval-prompt';
import { AvalActivityTrace } from './agent-ui/activity';
import type { SafeStep, VisualActivity } from '@/lib/ask-aval/visual-activity';
import { visualActivity } from '@/lib/ask-aval/visual-activity';
import { approvalsForChat } from '@/lib/agents/chat-task-scope';

type Approval = {id:string;taskId:string;tool:string;evidence?:{review?:Record<string,unknown>;arguments?:Record<string,unknown>;reason?:string};requiredApprovals:number;approvalsReceived:number};
type Task = {id:string;status:string;goal:string;error?:string;result?:{headline?:string;narrative?:string};plan?:{nodes:{id:string;goal:string;status:string}[]};createdAt?:string|number;finishedAt?:string|number|null;trace?:(SafeStep & {sequence:number})[]};
const DONE = new Set(['COMPLETED','FAILED','CANCELLED','SUPERSEDED']);
export function AgentTaskConversation({taskId,onActivity}: {taskId:string;onActivity?:(id:string,activity:VisualActivity,status:string)=>void}) {
  const t = useTranslations('AgentExperience');
  const [task,setTask] = useState<Task|null>(null);
  const [approvals,setApprovals] = useState<Approval[]>([]);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [attempt,setAttempt] = useState(0);
  const deciding = useRef(false);
  const activityCallback = useRef(onActivity); useEffect(() => { activityCallback.current = onActivity; }, [onActivity]);
  useEffect(()=>{
    const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      let terminal=false;
      try {
        const [a,b]=await Promise.all([fetch(`/api/agents/tasks/${encodeURIComponent(taskId)}`,{signal:controller.signal,cache:'no-store'}),fetch(`/api/agents/approvals?rootTaskId=${encodeURIComponent(taskId)}`,{signal:controller.signal,cache:'no-store'})]);
        if(!a.ok||!b.ok)throw Error(t('loadError'));
        const next=await a.json() as Task;const pending=await b.json() as {approvals:Approval[]};
        if(controller.signal.aborted)return;
        terminal=DONE.has(next.status);setTask(next);activityCallback.current?.(taskId,visualActivity({status:next.status,steps:next.trace}),next.status);setApprovals(terminal?[]:approvalsForChat(taskId,next.plan,pending.approvals));setError('');
      }catch{if(!controller.signal.aborted)setError(t('loadError'));}
      if(!terminal&&!controller.signal.aborted)timer=setTimeout(poll,2500);
    };
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[taskId,attempt,t]);
  const decide=async(approval:Approval,decision:ApprovalDecision)=>{
    if(deciding.current)return;deciding.current=true;setBusy(true);setError('');
    try {
      const response=await fetch('/api/agents/approvals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({approvalId:approval.id,decision})});
      const result=await response.json() as {complete?:boolean;error?:string};
      if(!response.ok)throw Error(result.error||t('decisionError'));
      // A partial elevated approval stays visible but is refreshed from the server.
      if(result.complete)setApprovals(current=>current.filter(a=>a.id!==approval.id));
      setAttempt(n=>n+1);
    }catch(error){setError(error instanceof Error?error.message:t('decisionError'));}
    finally{deciding.current=false;setBusy(false);}
  };
  return <div className="aval-task-conversation">
    <AvalActivityTrace status={task?.status ?? 'QUEUED'} steps={(task?.trace ?? []).map(step=>({...step,id:String(step.sequence)}))} startedAt={task?.createdAt} finishedAt={task?.finishedAt}/>
    {error&&<p role="alert" className="onboarding-error">{error}<button type="button" className="text-button" onClick={()=>setAttempt(n=>n+1)}>{t('retry')}</button></p>}
    {task?.plan?.nodes?.length ? <details className="aval-task-plan"><summary>{t('windowTitle')}</summary>{task.plan.nodes.map(node=><p key={node.id}>{node.goal} · {t.has(`statuses.${node.status}`)?t(`statuses.${node.status}`):node.status}</p>)}</details> : null}
    {approvals.map(approval=><div key={approval.id}>{approval.evidence?.reason&&<p className="agent-window-message">{approval.evidence.reason}</p>}<AgentApprovalPrompt tool={approval.tool} review={approval.evidence?.review??approval.evidence?.arguments??{}} disabled={busy} onDecision={decision=>void decide(approval,decision)}/>{approval.requiredApprovals>1&&<p>{t('approvalCount',{received:approval.approvalsReceived,required:approval.requiredApprovals})}</p>}</div>)}
    {task?.result?.headline&&<p className="agent-window-message">{task.result.headline}</p>}
    {task?.result?.narrative&&<p>{task.result.narrative}</p>}
    {task?.error&&<p role="alert" className="onboarding-error">{task.error}</p>}
  </div>;
}
