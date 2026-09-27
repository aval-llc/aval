"use client";
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { AgentTaskConversation } from './agent-task-conversation';
type DemoState={sampleData:boolean;goals:string[];tasks:{id:string;goal:string}[];counts:Record<string,number>};

export function DemoPortfolioPanel() {
  const es=useLocale()==='es-mx';
  const [demo,setDemo]=useState<DemoState|null>(null);
  const [task,setTask]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();void fetch('/api/organizations/demo',{signal:controller.signal,cache:'no-store'}).then(r=>r.ok?r.json():null).then(data=>setDemo(data as DemoState|null)).catch(()=>{});return()=>controller.abort();},[]);
  if(!demo?.sampleData)return null;
  const start=async(workflow:number)=>{
    setBusy(true);setError('');
    try {const response=await fetch('/api/organizations/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'start',workflow,locale:es?'es-mx':'en'})});const result=await response.json() as {error?:string;taskId:string};if(!response.ok)throw Error(result.error||'Could not start task');setTask(result.taskId);}
    catch(e){setError(e instanceof Error?e.message:'Task failed');}finally{setBusy(false);}
  };
  return <section className="surface-card" aria-label="Aval Demo">
    <h2>Aval Demo · {es?'Datos ficticios':'Fictional data'}</h2>
    <p>{Object.entries(demo.counts).map(([k,n])=>`${n} ${k}`).join(' · ')} · USD</p>
    <p>{es?'Abre Aval Desktop y activa agentes con Luna. Los mensajes son borradores; las acciones internas requieren aprobación.':'Open Aval Desktop and enable agents with Luna. Messages stay as drafts; internal actions require approval.'}</p>
    <div className="dialog-actions">{demo.goals.map((goal,i)=><button key={goal} className="soft-button" disabled={busy} onClick={()=>void start(i)}>{(es?['Mantenimiento','Vencimientos de contratos','Saldos vencidos']:['Maintenance triage','Lease follow-ups','Overdue balances'])[i]}</button>)}</div>
    {demo.tasks.length>0&&<label>{es?'Historial':'History'}<select value={task} onChange={e=>setTask(e.target.value)}><option value="">—</option>{demo.tasks.map(t=><option key={t.id} value={t.id}>{t.goal.slice(0,80)}</option>)}</select></label>}
    {error&&<p role="alert">{error}</p>}{task&&<AgentTaskConversation key={task} taskId={task}/>}
  </section>;
}
