import { and, asc, count, eq } from 'drizzle-orm';
import type { DbSession } from '@/db/postgres/session';
import { aiEmployees, integrationConnections, documents, organizations, properties } from '@/db/postgres/schema';
import { employeeScopes, listEmployees, openWorkCount } from '@/lib/agents/employees';
import { STARTER_TEMPLATES, employeeCandidates, listExpertiseCatalogue } from '@/lib/agents/expertise';
import { listMembers } from '@/lib/organizations/membership';
import { listPreferences } from '@/lib/ask-aval/preferences';
import { readOnboarding } from '@/lib/onboarding/storage';
import { resolvePersona } from '@/lib/ask-aval/personas';
import { TOOLS } from '@/lib/ask-aval/tools';
import { assembleToolset } from '@/lib/agents/toolset';
import { employeeEnvelope } from '@/lib/agents/policy';
import { implementedTools } from '@/lib/agents/registry';
import { integrationCatalog } from '@/lib/integrations/catalog';
import { PROVIDER_DASHBOARD_CAPABILITIES } from '@/lib/operations/dashboard-state';
import { resolveMatrix } from '@/lib/pms/capability';
import { PMS_PROVIDERS } from '@/lib/pms/providers';
import { openWork } from '@/lib/agents/read-model';

/** A projection only. No graph table, cached grants, or frontend authorization. */
export async function buildEffectiveWorkspaceGraph(session: DbSession, organizationId: string, userId: string, query: {search?: string; offset?: number; employeeId?: string; isGuest?: boolean} = {}) {
  const [workspace] = await session.db.select({id:organizations.id,name:organizations.name}).from(organizations).where(eq(organizations.id,organizationId));
  const connections = await session.db.select({id:integrationConnections.id,provider:integrationConnections.provider,category:integrationConnections.category,status:integrationConnections.status,authMode:integrationConnections.authMode,account:integrationConnections.externalAccountName,lastSyncAt:integrationConnections.lastSyncAt}).from(integrationConnections).where(eq(integrationConnections.organizationId,organizationId));
  const enrichedConnections = await Promise.all(connections.map(async c => ({...c, label:integrationCatalog.find(p=>p.id===c.provider)?.title ?? c.provider, reportingCapabilities:c.status==='connected' ? PROVIDER_DASHBOARD_CAPABILITIES[c.provider] ?? [] : [], matrix:PMS_PROVIDERS.some(p=>p.id===c.provider) ? Object.fromEntries(await resolveMatrix(session,organizationId,c.provider)) : null})));
  const employees = await listEmployees(session,organizationId,{search:query.search,offset:query.offset,limit:24});
  const [{total}] = await session.db.select({total:count()}).from(aiEmployees).where(eq(aiEmployees.organizationId,organizationId));
  const humans = await listMembers(session,organizationId);
  const memory = await listPreferences(session,organizationId);
  const policy = await readOnboarding(session,userId,organizationId);
  const persona = await resolvePersona(session,'general',organizationId);
  const describe = async (employee: typeof employees[number]) => {
    const scopes = await employeeScopes(session,organizationId,employee.id);
    const assembled = await assembleToolset(session,{organizationId,subject:{organizationId,userId,isGuest:query.isGuest===true},agentId:'general',persona,baseTools:TOOLS,finalToolName:'render_answer',employeeId:employee.id,employeeCapabilities:scopes.capability ?? [],employeePermissions:employeeEnvelope(scopes.capability ?? [],employee)});
    return { ...employee,scopes,tools:assembled.tools.filter(t=>t.name!=='render_answer').map(t=>t.name),excluded:assembled.excluded,openWork:await openWorkCount(session,organizationId,employee.id),expertise:await employeeCandidates(session,organizationId,employee.id)};
  };
  const actors=await Promise.all(employees.map(describe));
  let selected = actors.find(e=>e.id===query.employeeId) ?? null;
  if(query.employeeId && !selected) { const rows=await session.db.select().from(aiEmployees).where(and(eq(aiEmployees.organizationId,organizationId),eq(aiEmployees.id,query.employeeId))).limit(1); if(rows[0])selected=await describe(rows[0] as typeof employees[number]); }
  const sources=await session.db.select({id:documents.id,title:documents.title,kind:documents.kind}).from(documents).where(eq(documents.organizationId,organizationId)).orderBy(asc(documents.title)).limit(25);
  const resources=await session.db.select({id:properties.id,name:properties.name}).from(properties).where(eq(properties.organizationId,organizationId)).limit(200);
  const work=await openWork(session,organizationId);
  const edges=actors.flatMap(e=>(e.scopes.connection ?? []).map(id=>({id:`${e.id}:${id}`,from:e.id,to:id,kind:'connection_grant',active:e.status==='active'&&connections.some(c=>c.id===id&&c.status==='connected'),capabilities:e.tools,scopes:e.scopes.property ?? [],autonomy:e.autonomyMode})));
  return {templates:STARTER_TEMPLATES,workspace,employees:actors,selected,total:Number(total),humans,connections:enrichedConnections,channels:enrichedConnections.filter(c=>['gmail','outlook','twilio','slack','whatsapp','telegram','google_chat','microsoft_teams'].includes(c.provider)),knowledgeSources:sources,resources,edges,memory,policy,work,expertise:await listExpertiseCatalogue(session,organizationId),capabilities:implementedTools().map(t=>({name:t.name,summary:t.summary,mutates:t.mutates,risk:t.riskLevel})),attention:[...connections.filter(c=>c.status!=='connected').map(c=>({id:c.id,kind:'connection',label:enrichedConnections.find(x=>x.id===c.id)!.label,state:c.status})),...actors.filter(e=>e.status!=='archived'&&!e.tools.length).map(e=>({id:e.id,kind:'employee',label:e.name,state:'no_access'})),...work.filter(w=>w.state.startsWith('WAITING')||w.state==='BLOCKED').map(w=>({id:w.id,kind:'work',label:w.goal,state:w.state}))]};
}
export type WorkspaceGraph = Awaited<ReturnType<typeof buildEffectiveWorkspaceGraph>>;
