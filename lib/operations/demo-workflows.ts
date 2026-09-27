import type {DbSession} from '@/db/postgres/session';
import {conversations,messages} from '@/db/postgres/schema';
import {desktopQuery as query} from '@/lib/agents/desktop-inference';
import {createTask,getTask,type NewTask} from '@/lib/agents/tasks';
import {maintenanceContext} from '@/lib/communications/maintenance-intake';
import {DEMO_GOALS} from './demo-portfolio';

/** Server-owned demo configuration; callers cannot choose tools, scope or resident. */
export async function startDemoWorkflow(session:DbSession,org:string,user:string,workflow:number,locale='en') {
  if(!Number.isInteger(workflow)||workflow<0||workflow>2)throw Error('Choose a demo workflow');
  await query(session,'SELECT pg_advisory_xact_lock(hashtext($1))',[`${org}:demo-workflow:${workflow}`]);
  const create=async(input:NewTask)=>{
    const existing=await query(session,"SELECT id FROM agent_tasks WHERE organization_id=$1 AND user_id=$2 AND goal=$3 AND status NOT IN ('COMPLETED','FAILED','CANCELLED','SUPERSEDED') ORDER BY created_at LIMIT 1",[org,user,input.goal]);
    if(existing.rows[0])return (await getTask(session,org,String(existing.rows[0].id)))!;
    const recent=await query(session,"SELECT count(*)::int AS count FROM agent_tasks WHERE organization_id=$1 AND created_at>now()-interval '1 hour'",[org]);
    if(Number(recent.rows[0].count)>=20)throw Error('Demo task limit reached; inspect existing work before starting more');
    return createTask(session,input);
  };
  let goal=DEMO_GOALS[workflow];
  if(workflow!==0)return create({organizationId:org,userId:user,agentId:workflow===1?'lead.renewals':'financial',goal:goal+(locale==='es-mx'?' Responde en español de México.':''),check:{kind:'evidence',tools:[workflow===1?'get_expiring_leases':'get_delinquent_accounts']},maxSteps:10,maxTokens:180000});
  const conversationId=`demo-maintenance-${org}`,messageId=`demo-maintenance-message-${org}`,now=new Date();
  await session.db.insert(conversations).values({id:conversationId,organizationId:org,channel:'gmail',externalThreadId:conversationId,contactDisplayName:'Fictional demo resident',lastMessageAt:now,createdAt:now,updatedAt:now}).onConflictDoNothing();
  await session.db.insert(messages).values({id:messageId,conversationId,externalMessageId:messageId,direction:'inbound',body:'FICTIONAL DEMO REQUEST: The bathroom drain in my apartment is draining slowly. Please arrange an internal maintenance inspection. No emergency symptoms reported; the cause is unknown.',payloadJson:JSON.stringify({sender:'resident-0-0@example.invalid',threadId:conversationId,dataClass:'synthetic_demo'}),createdAt:now}).onConflictDoNothing();
  const context=await maintenanceContext(session,org,conversationId,messageId);
  if(!context.match)throw Error('Demo resident needs human matching before work can start');
  goal=`Read the fictional maintenance message ${messageId} in conversation ${conversationId}. Confirm its matched resident/property/unit from read_maintenance_context. Create exactly one internal work order through approval. Describe symptoms without inventing a cause, cost or dispatch. Keep any resident reply as a draft in your final answer; do not send anything.`;
  return create({organizationId:org,userId:user,agentId:'maintenance',goal:goal+(locale==='es-mx'?' Responde en español de México.':''),check:{kind:'internal_maintenance',conversationId,messageId},executionScope:{source:'inbound',conversationId,messageId,maintenance:context.match,draftOnly:true},maxSteps:10,maxTokens:180000});
}
