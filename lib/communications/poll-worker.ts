import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { communicationPollSources } from "@/db/postgres/schema";
import { pollInbox } from './polling';
/** Fair, bounded source rotation. The atomic timestamp claim also prevents overlapping ticks. */
export async function pollCommunicationSources(dbSession: DbSession) {
 const db=dbSession.db,now=new Date(),before=new Date(now.getTime()-60000);
 const due=await db.select().from(communicationPollSources).where(and(eq(communicationPollSources.enabled,true),or(isNull(communicationPollSources.lastAttemptAt),lt(communicationPollSources.lastAttemptAt,before)))).orderBy(asc(communicationPollSources.lastAttemptAt)).limit(4);
 for(const source of due){
  const claimed=await db.update(communicationPollSources).set({lastAttemptAt:now}).where(and(eq(communicationPollSources.id,source.id),eq(communicationPollSources.enabled,true),source.lastAttemptAt?eq(communicationPollSources.lastAttemptAt,source.lastAttemptAt):isNull(communicationPollSources.lastAttemptAt))).returning({id:communicationPollSources.id});
  if(!claimed.length)continue;
  try{await pollInbox(dbSession, source.organizationId,source.provider,source.resourceId||undefined);await db.update(communicationPollSources).set({lastSuccessAt:new Date(),error:null}).where(eq(communicationPollSources.id,source.id));}
  catch{await db.update(communicationPollSources).set({error:'Inbox refresh failed. Check connection access and the configured space or chat.'}).where(eq(communicationPollSources.id,source.id));}
 }
 return {checked:due.length};
}
