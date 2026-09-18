import { eq } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections, leasingLeads, integrationEvents } from "@/db/postgres/schema";
import { connectedAccount } from '@/lib/communications/connection';
import { deliver } from '@/lib/communications/store';
import { connectionBlocker } from '@/lib/integrations/readiness';
import { metaLeadPage } from './providers';
import { record, requiredString } from '@/lib/integrations/http';
export async function marketingConnections(dbSession: DbSession, org:string) {
  const connections=await dbSession.db.select({provider:integrationConnections.provider,status:integrationConnections.status,account:integrationConnections.externalAccountName}).from(integrationConnections).where(eq(integrationConnections.organizationId,org));
  return ['meta','rightmove','zoopla','onthemarket'].map(provider=>({provider,connection:connections.find(c=>c.provider===provider)??null,blocker:connectionBlocker(provider),publication:provider==='meta'?'Facebook Page post, with approval':'Provider agreement and feed certification required'}));
}
export async function publishListing(dbSession: DbSession, org:string,provider:string,body:string,key:string) {
  if(provider!=='meta') throw new Error(connectionBlocker(provider) ?? 'This provider has no approved publication adapter.');
  const {credentials}=await connectedAccount(dbSession, org,'meta');
  return deliver(dbSession, org,{provider:'meta',to:credentials.pageId,body},key,'listing');
}
export async function importMetaLeadPage(dbSession: DbSession, org:string,formId?:string,after?:string) {
  const {connection,credentials,config}=await connectedAccount(dbSession, org,'meta');
  const { page, form } = await dbSession.outsideTransaction(async () => {
    const page = await metaLeadPage(credentials.pageId,credentials.accessToken,config.META_GRAPH_API_VERSION??'',formId,after);
    if (!formId) return { page, form: null };
    const form = record(await (await import('@/lib/integrations/http')).providerJson(`https://graph.facebook.com/${config.META_GRAPH_API_VERSION}/${encodeURIComponent(formId)}?fields=id,page`,{headers:{authorization:`Bearer ${credentials.accessToken}`}}));
    return { page, form };
  });
  if(!formId) return {forms:page.items,next:page.next};
  // A Page token itself restricts access; confirm the form belongs to this Page before import.
  if (!form) throw new Error('Meta did not return the requested lead form.');
  if (record(form.page).id !== credentials.pageId) throw new Error('This lead form belongs to another Page.');
  let imported=0;
  for (const value of page.items) {
    const lead=record(value), id=requiredString(lead.id), date=new Date(requiredString(lead.created_time));
    if(!Number.isFinite(date.getTime())) throw new Error('Meta returned an invalid lead timestamp.');
    const now=new Date();
    const inserted=await dbSession.db.insert(leasingLeads).values({id:crypto.randomUUID(),organizationId:org,channel:'Meta',stage:'inquiry',inquiredAt:date,sourceProvider:'meta',sourceConnectionId:connection.id,externalId:`${credentials.pageId}:${id}`,createdAt:now,updatedAt:now}).onConflictDoNothing().returning({id:leasingLeads.id});
    imported+=inserted.length;
    await dbSession.db.insert(integrationEvents).values({id:crypto.randomUUID(),provider:'meta',externalEventId:`${connection.id}:${id}`,eventType:'lead',payloadJson:JSON.stringify({connectionId:connection.id,formId,lead}),status:'processed',receivedAt:now}).onConflictDoNothing();
  }
  return {imported,next:page.next};
}
