import type { ToolSchema } from '@/lib/ask-aval/model-types';
import { marketingConnections, publishListing } from "@/lib/marketing/service";
import { and, eq, desc } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { conversations, messages, integrationConnections } from "@/db/postgres/schema";
import { deliver, readCommunicationsConfig, replyToConversation } from './store';
import { SEND_PROVIDERS } from './providers';
const text = { type:'string' };
export const COMMUNICATION_TOOLS: ToolSchema[] = [
 {name:'read_conversation',description:'Read messages in one known workspace conversation.',input_schema:{type:'object',properties:{conversation_id:{type:'string',minLength:1,maxLength:100}},required:['conversation_id']}},
 {name:'get_marketing_channels',description:'Read marketing connection readiness and remaining partner requirements.',input_schema:{type:'object',properties:{}}},
 {name:'publish_listing',description:'Publish an approved organic Facebook Page post through Meta. Read property facts first; no paid ads or budget changes. Property portals remain blocked until their partner contracts and adapters are certified.',input_schema:{type:'object',properties:{provider:{type:'string',enum:['meta','rightmove','zoopla','onthemarket']},body:{type:'string',minLength:1,maxLength:4000}},required:['provider','body']}},
  { name:'get_communication_channels', description:'Read connected communication providers and configured team route IDs before sending messages or placing a call. Missing connections cannot be invented.', input_schema:{type:'object',properties:{}} },
  { name:'list_conversations', description:'Read up to 30 recent conversation IDs and real channel destinations in this workspace.', input_schema:{type:'object',properties:{}} },
  { name:'request_execution_plan', description:'Ask a person to approve a concrete plan before executing its exact actions in Assisted mode. Include the evidence, selected specialist, and exact arguments. Approval never authorizes changed arguments, money movement, or publication.', input_schema:{type:'object',properties:{ summary:{type:'string',maxLength:1200}, actions:{type:'array',minItems:1,maxItems:10,items:{type:'object',properties:{tool:{type:'string',enum:['send_external_message','place_call','record_preference']},args:{type:'object'}},required:['tool','args'],additionalProperties:false}} },required:['summary','actions']} },
  { name:'send_external_message', description:'Send a real message. Prefer conversation_id from list_conversations; otherwise supply provider and to from a verified record. Must run in a durable task. Provider acceptance is not proof of delivery.', input_schema:{type:'object',properties:{conversation_id:text,provider:{type:'string',enum:[...SEND_PROVIDERS]},to:text,body:{type:'string',minLength:1,maxLength:4000},subject:{type:'string',maxLength:200}},required:['body']} },
  { name:'place_call', description:'Place a Twilio call with a short spoken script, optionally bridging to a configured team route. Read route IDs first. Requires enabled call routing, a connected account and a known international destination.', input_schema:{type:'object',properties:{to:text,script:{type:'string',maxLength:1200},team_route_id:text},required:['to','script']} },
];
export async function runCommunicationTool(dbSession: DbSession, name:string,args:Record<string,unknown>,org:string,key?:string) {
  if (name === 'read_conversation') {
    const [thread]=await dbSession.db.select().from(conversations).where(and(eq(conversations.organizationId,org),eq(conversations.id,String(args.conversation_id)))).limit(1);
    if(!thread)throw Error('Conversation not found.');
    const recent = await dbSession.db.select({direction:messages.direction,body:messages.body,createdAt:messages.createdAt}).from(messages).where(eq(messages.conversationId,thread.id)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(30);
    return {id:thread.id,provider:thread.channel,messages:recent.reverse()};
  }
  if (name === 'get_marketing_channels') return marketingConnections(dbSession, org);
  if (name === 'publish_listing') { if (!key) throw new Error('Publication requires a durable task.'); return publishListing(dbSession, org, String(args.provider), String(args.body), key); }
  if (name === 'get_communication_channels') {
    const connections = await dbSession.db.select({provider:integrationConnections.provider,status:integrationConnections.status,account:integrationConnections.externalAccountName}).from(integrationConnections).where(eq(integrationConnections.organizationId,org));
    const config = await readCommunicationsConfig(dbSession, org);
    return { connections:connections.filter(c => (SEND_PROVIDERS as readonly string[]).includes(c.provider)), callsEnabled:config.enabled, routes:config.routes.map(r => ({id:r.id,label:r.label})) };
  }
  if (name === 'list_conversations') return dbSession.db.select({id:conversations.id,provider:conversations.channel,destination:conversations.externalThreadId,contact:conversations.contactDisplayName,draft:conversations.draftReply}).from(conversations).where(and(eq(conversations.organizationId,org),eq(conversations.status,'open'))).orderBy(desc(conversations.lastMessageAt), desc(conversations.id)).limit(30);
  if (name === 'request_execution_plan') return { approved:true, instruction:'Execute only the exact approved actions. Changes require another approval.' };
  if (!key) throw new Error('External actions require a durable operation key.');
  if (name === 'send_external_message') {
    if (typeof args.conversation_id === 'string') return replyToConversation(dbSession, org,args.conversation_id,String(args.body),key);
    return deliver(dbSession, org,{provider:String(args.provider),to:String(args.to),body:String(args.body),...(typeof args.subject === 'string' ? {subject:args.subject} : {})},key);
  }
  if (name === 'place_call') return deliver(dbSession, org,{provider:'twilio',to:String(args.to),body:String(args.script)},key,'call',typeof args.team_route_id === 'string' ? args.team_route_id : undefined);
  throw new Error('Unknown communication tool.');
}
