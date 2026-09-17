import { ProviderHttpError } from '@/lib/integrations/http';
import { isPhone } from './config';
import { publishMetaPost } from '@/lib/marketing/providers';
import { and, desc, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { communicationDeliveries, communicationSettings, conversations, messages } from "@/db/postgres/schema";
import { digestPayload } from "@/lib/audit/chain";
import { connectedAccount } from "./connection";
import { DEFAULT_COMMUNICATIONS, parseCommunicationsConfig } from "./config";
import { dispatchCall, dispatchMessage, validateOutbound, type OutboundMessage } from "./providers";
export async function readCommunicationsConfig(dbSession: DbSession, org: string) {
  const [row] = await dbSession.db.select().from(communicationSettings).where(eq(communicationSettings.organizationId, org)).limit(1);
  return row ? parseCommunicationsConfig(JSON.parse(row.configJson)) : structuredClone(DEFAULT_COMMUNICATIONS);
}
export async function deliver(dbSession: DbSession, org: string, input: OutboundMessage, requestKey: string, kind: 'message' | 'call' | 'listing' = 'message', routeId?: string) {
  if (!requestKey || requestKey.length > 200) throw new Error('A stable operation key is required.');
  if (kind === 'message') validateOutbound(input);
  const { connection, credentials, config } = await connectedAccount(dbSession, org, input.provider);
  const callConfig = await readCommunicationsConfig(dbSession, org);
  if (input.provider === 'twilio' && !isPhone(callConfig.fromNumber)) throw new Error('Configure your Twilio sending number first.');
  if (['whatsapp','meta'].includes(input.provider) && !/^v\d+\.\d+$/.test(config.META_GRAPH_API_VERSION ?? '')) throw new Error('Configure the Meta Graph API version first.');
  if (kind === 'call' && (!config.AVAL_PUBLIC_URL || new URL(config.AVAL_PUBLIC_URL).protocol !== 'https:')) throw new Error('Configure Aval’s public HTTPS URL before placing calls.');
  if (input.provider === 'whatsapp') {
    const [thread] = await dbSession.db.select({id:conversations.id}).from(conversations).where(and(eq(conversations.organizationId,org),eq(conversations.channel,'whatsapp'),eq(conversations.externalThreadId,input.to.replace(/^\+/,'')))).limit(1);
    const [lastInbound] = thread ? await dbSession.db.select({createdAt:messages.createdAt}).from(messages).where(and(eq(messages.conversationId,thread.id),eq(messages.direction,'inbound'))).orderBy(desc(messages.createdAt)).limit(1) : [];
    if (!lastInbound || lastInbound.createdAt.getTime() < Date.now()-86400000) throw new Error('WhatsApp free-text replies need an inbound message within the last 24 hours. Start a new conversation with an approved WhatsApp template outside Aval.');
  }
  if (kind === 'call' && (!callConfig.enabled || input.provider !== 'twilio')) throw new Error('Enable call handling and verify Twilio before placing calls.');
  const route = routeId ? callConfig.routes.find(r => r.id === routeId) : undefined;
  if (routeId && !route) throw new Error('Choose an existing team route.');
  const payloadDigest = await digestPayload({ ...input, kind, routeId: routeId ?? null });
  const db = dbSession.db, now = new Date(), id = crypto.randomUUID();
  const inserted = await db.insert(communicationDeliveries).values({ id, organizationId: org, connectionId: connection.id, requestKey, payloadDigest, kind, destination: input.to, body: input.body, status: 'sending', createdAt: now, updatedAt: now }).onConflictDoNothing().returning({ id: communicationDeliveries.id });
  if (!inserted.length) {
    const [existing] = await db.select().from(communicationDeliveries).where(and(eq(communicationDeliveries.organizationId, org), eq(communicationDeliveries.requestKey, requestKey))).limit(1);
    if (!existing || existing.payloadDigest !== payloadDigest) throw new Error('This operation key is already bound to a different request.');
    return { operationId: existing.id, providerId: existing.providerId, status: existing.status, duplicate: true };
  }
  try {
    const result = await dbSession.outsideTransaction(async () => {
      if (kind === 'call') {
        if (!config.AVAL_PUBLIC_URL || new URL(config.AVAL_PUBLIC_URL).protocol !== 'https:') throw new Error('Configure Aval’s public HTTPS URL before placing calls.');
        const callback = new URL('/api/communications/status', config.AVAL_PUBLIC_URL); callback.searchParams.set('operation', id);
        return dispatchCall(input.to, input.body, callConfig.fromNumber, credentials, callback.href, route?.phone);
      }
      if (kind === 'listing') return publishMetaPost(credentials.pageId, input.body, credentials.accessToken, config.META_GRAPH_API_VERSION ?? '');
      return dispatchMessage(input, credentials, config, id, callConfig.fromNumber);
    });
    // A provider acceptance is not proof that the recipient received it.
    await db.update(communicationDeliveries).set({ status: result.status, providerId: result.id, updatedAt: new Date() }).where(and(eq(communicationDeliveries.id, id), eq(communicationDeliveries.status, 'sending')));
    return { operationId: id, providerId: result.id, status: result.status, duplicate: false };
  } catch (error) {
    const status = error instanceof ProviderHttpError && error.status >= 400 && error.status < 500 ? 'failed' : 'unknown';
    // A signed callback can arrive before the original HTTP request finishes.
    // Preserve that evidence if the request later times out or loses its response.
    const changed = await db.update(communicationDeliveries).set({ status, error: 'The provider did not confirm acceptance. Reconcile before trying again.', updatedAt: new Date() }).where(and(eq(communicationDeliveries.id, id), eq(communicationDeliveries.status, 'sending'))).returning({ id: communicationDeliveries.id });
    if (!changed.length) {
      const [confirmed] = await db.select().from(communicationDeliveries).where(and(eq(communicationDeliveries.id, id), eq(communicationDeliveries.organizationId, org))).limit(1);
      if (confirmed) return { operationId: id, providerId: confirmed.providerId, status: confirmed.status, duplicate: false };
    }
    throw new Error('Delivery was not confirmed. Review the delivery record before retrying; the operation will not be sent twice automatically.');
  }
}
export async function replyToConversation(dbSession: DbSession, org: string, conversationId: string, body: string, key: string, messageId?: string) {
  const db = dbSession.db;
  const [thread] = await db.select().from(conversations).where(and(eq(conversations.organizationId, org), eq(conversations.id, conversationId))).limit(1);
  if (!thread) throw new Error('Conversation not found.');
  let input: OutboundMessage = { provider: thread.channel, to: thread.channel === 'whatsapp' && !thread.externalThreadId.startsWith('+') ? '+'+thread.externalThreadId : thread.externalThreadId, body };
  if (thread.channel === 'gmail') {
    const [original] = await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'inbound'), messageId ? eq(messages.externalMessageId, messageId) : undefined)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
    const metadata = original ? JSON.parse(original.payloadJson) : {};
    if (!metadata.sender || !metadata.threadId || !metadata.rfcMessageId) throw new Error('This Gmail message needs a verified sender and reply headers before replying');
    input = { provider: 'gmail', to: metadata.sender, body, subject: String(metadata.subject ?? ''), threadId: metadata.threadId, inReplyTo: metadata.rfcMessageId };
  }
  const result = await deliver(dbSession, org, input, key);
  if (['accepted', 'sent', 'delivered'].includes(result.status)) {
    const now = new Date();
    await db.insert(messages).values({ id: crypto.randomUUID(), conversationId, externalMessageId: result.operationId, direction: 'outbound', body, payloadJson: JSON.stringify(result), createdAt: now }).onConflictDoNothing();
    await db.update(conversations).set({ draftReply: null, draftReplyStatus: null, lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, conversationId));
  }
  return result;
}
export async function communicationHistory(dbSession: DbSession, org: string) {
  return dbSession.db.select({ id: communicationDeliveries.id, kind: communicationDeliveries.kind, status: communicationDeliveries.status, providerId: communicationDeliveries.providerId, error: communicationDeliveries.error, createdAt: communicationDeliveries.createdAt }).from(communicationDeliveries).where(eq(communicationDeliveries.organizationId, org)).orderBy(desc(communicationDeliveries.createdAt)).limit(50);
}
