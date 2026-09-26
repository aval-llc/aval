import { env } from "cloudflare:workers";
import { wakeOnInboundMessage } from "@/lib/agents/waits";
import { and, eq, sql } from "drizzle-orm";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { conversations, integrationEvents, messages } from "@/db/postgres/schema";
import type { DbSession } from "@/db/postgres/session";
import { withSystemSession, withWorkerOrganizationSession } from "@/lib/api/with-session";
import { draftAutoReply } from "@/lib/ask-aval/auto-reply";
import type { AskAvalEnv } from "@/lib/ask-aval/model-types";
import { queueInboundTask } from "@/lib/communications/intake";
import { verifyTwilio } from "@/lib/communications/signature";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { parseInboundMessage, splitWhatsappPayload, type InboundMessage } from "@/lib/integrations/inbound";
import type { AvalRuntimeBindings } from "@/lib/runtime/bindings";
import { constantTimeEqual } from "@/lib/security/constant-time";

const encoder = new TextEncoder();
const supportedProviders = new Set(["slack", "whatsapp", "telegram", "apple_messages", "twilio"]);

type WebhookConnection = {
  organization_id: string;
  connection_id: string;
  encrypted_credentials: string | null;
  external_account_id: string | null;
};

class AmbiguousDestination extends Error {}

async function quarantine(bindings: AvalRuntimeBindings, provider: string, raw: string, reason: string, verified: boolean) {
  const key = bindings.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (typeof key !== "string") throw new Error("Quarantine encryption unavailable");
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${provider}:${raw}`))));
  const ciphertext = await encryptSecret(raw, key);
  await withSystemSession("worker", session => session.db.execute(sql`select aval_private.quarantine_webhook(${digest},${provider},${ciphertext},${reason},${verified})`), bindings);
}

function textBindings(bindings: AvalRuntimeBindings): Record<string, string | undefined> {
  return bindings as unknown as Record<string, string | undefined>;
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, value: string, algorithm: "SHA-256" | "SHA-1" = "SHA-256") {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: algorithm }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function validLookup(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
}

async function lookupConnection(
  bindings: AvalRuntimeBindings,
  provider: string,
  connectionId?: string,
  externalAccountKey?: string,
): Promise<WebhookConnection | null> {
  if (!validLookup(connectionId) && !validLookup(externalAccountKey)) return null;
  return withSystemSession("worker", async (session) => {
    const result = await session.db.execute<WebhookConnection>(sql`
      select * from aval_private.webhook_connection(
        ${provider}, ${validLookup(connectionId) ? connectionId : null}, ${validLookup(externalAccountKey) ? externalAccountKey : null}
      )
    `);
    if (result.rows.length > 1) throw new AmbiguousDestination("Ambiguous webhook destination; event requires operator review");
    return result.rows[0] ?? null;
  }, bindings);
}

async function connectionCredentials(connection: WebhookConnection, bindings: AvalRuntimeBindings): Promise<Record<string, string>> {
  const encryptionKey = bindings.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!connection.encrypted_credentials || typeof encryptionKey !== "string") return {};
  const plaintext = await decryptSecret(connection.encrypted_credentials, encryptionKey);
  const parsed = JSON.parse(plaintext) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function verifySignature(
  provider: string,
  request: Request,
  raw: string,
  config: Record<string, string | undefined>,
  credentials: Record<string, string>,
): Promise<boolean> {
  if (provider === "slack") {
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
    const signature = request.headers.get("x-slack-signature") ?? "";
    if (!config.SLACK_SIGNING_SECRET || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    return constantTimeEqual(signature, `v0=${hex(await hmac(config.SLACK_SIGNING_SECRET, `v0:${timestamp}:${raw}`))}`);
  }
  if (provider === "whatsapp") {
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    if (!config.META_WHATSAPP_APP_SECRET) return false;
    return constantTimeEqual(signature, `sha256=${hex(await hmac(config.META_WHATSAPP_APP_SECRET, raw))}`);
  }
  if (provider === "telegram") {
    return Boolean(credentials.webhookSecret)
      && constantTimeEqual(request.headers.get("x-telegram-bot-api-secret-token") ?? "", credentials.webhookSecret);
  }
  if (provider === "apple_messages") {
    const signature = request.headers.get("x-aval-webhook-secret") ?? request.headers.get("x-portero-webhook-secret") ?? "";
    return Boolean(credentials.webhookSecret) && constantTimeEqual(signature, credentials.webhookSecret);
  }
  if (provider === "twilio") {
    return Boolean(credentials.authToken) && verifyTwilio(request, raw, credentials.authToken);
  }
  return false;
}

function whatsappAccountKey(payload: Record<string, unknown>): string | undefined {
  const entry = Array.isArray(payload.entry) ? payload.entry[0] : undefined;
  const changes = entry && typeof entry === "object" && Array.isArray((entry as Record<string, unknown>).changes)
    ? (entry as Record<string, unknown>).changes as unknown[]
    : [];
  const change = changes[0];
  const value = change && typeof change === "object" ? (change as Record<string, unknown>).value : undefined;
  const metadata = value && typeof value === "object" ? (value as Record<string, unknown>).metadata : undefined;
  const key = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).phone_number_id : undefined;
  return typeof key === "string" ? key : undefined;
}

function externalAccountKey(provider: string, payload: Record<string, unknown>, parsed: InboundMessage | null): string | undefined {
  if (parsed?.externalAccountKey) return parsed.externalAccountKey;
  if (provider === "slack" && typeof payload.team_id === "string") return payload.team_id;
  if (provider === "twilio" && typeof payload.AccountSid === "string") return payload.AccountSid;
  if (provider === "whatsapp") return whatsappAccountKey(payload);
  return undefined;
}

function providerResponse(provider: string): Response {
  return provider === "twilio"
    ? new Response("<Response/>", { headers: { "content-type": "text/xml" } })
    : Response.json({ received: true }, { status: 202 });
}

async function ingestInboundMessage(
  dbSession: DbSession,
  provider: string,
  organizationId: string,
  parsed: InboundMessage,
  bindings: AvalRuntimeBindings,
) {
  const now = new Date();
  await dbSession.db.insert(conversations).values({
    id: crypto.randomUUID(),
    organizationId,
    channel: provider,
    externalThreadId: parsed.externalThreadId,
    contactDisplayName: parsed.contactDisplayName,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [conversations.organizationId, conversations.channel, conversations.externalThreadId],
    set: { contactDisplayName: parsed.contactDisplayName, lastMessageAt: now, updatedAt: now },
  });
  const [conversation] = await dbSession.db.select({ id: conversations.id, locale: conversations.locale }).from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.channel, provider), eq(conversations.externalThreadId, parsed.externalThreadId)))
    .limit(1);
  if (!conversation) throw new Error("Inbound conversation was not stored");

  const inserted = await dbSession.db.insert(messages).values({
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    externalMessageId: parsed.externalMessageId,
    direction: "inbound",
    body: parsed.body,
    createdAt: now,
  }).onConflictDoNothing().returning({ id: messages.id });
  if (inserted.length === 0) return;

  // Work waiting on whoever writes on this thread re-checks now.
  await wakeOnInboundMessage(dbSession, organizationId, conversation.id);
  await queueInboundTask(dbSession, organizationId, conversation.id, parsed.externalMessageId, parsed.body);
  const draftWork = dbSession.afterCommit(() => withWorkerOrganizationSession(organizationId, async (workerSession) => {
    try {
      const result = await draftAutoReply(
        workerSession,
        bindings as AskAvalEnv,
        { orgId: organizationId, userId: "principal_aval_worker" },
        parsed.contactDisplayName,
        parsed.body,
        conversation.locale,
      );
      await workerSession.db.update(conversations).set({
        draftReply: result.ok ? (result.reply ?? null) : null,
        draftReplyStatus: result.ok ? "ready" : "failed",
        draftReplyAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(conversations.id, conversation.id), eq(conversations.organizationId, organizationId)));
    } catch (error) {
      await workerSession.db.update(conversations).set({ draftReplyStatus: "failed", draftReplyAt: new Date(), updatedAt: new Date() })
        .where(and(eq(conversations.id, conversation.id), eq(conversations.organizationId, organizationId)));
      console.error("auto_reply_draft_failed", provider, error instanceof Error ? error.message : error);
    }
  }, bindings));
  const guardedDraft = draftWork.catch((error) => console.error("auto_reply_session_failed", provider, error));
  const context = getRequestExecutionContext();
  if (context) context.waitUntil(guardedDraft);
}

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  const url = new URL(request.url);
  const config = textBindings(env as unknown as AvalRuntimeBindings);
  if (provider === "whatsapp" && config.META_WHATSAPP_VERIFY_TOKEN && url.searchParams.get("hub.mode") === "subscribe"
    && constantTimeEqual(url.searchParams.get("hub.verify_token") ?? "", config.META_WHATSAPP_VERIFY_TOKEN)) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Not found", { status: 404 });
}

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!supportedProviders.has(provider)) return new Response("Not found", { status: 404 });
  const raw = await request.text();
  if (raw.length > 1_000_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  let payload: Record<string, unknown>;
  try {
    payload = request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(raw))
      : JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Malformed payload" }, { status: 400 });
  }

  const bindings = env as unknown as AvalRuntimeBindings;
  const config = textBindings(bindings);
  const connectionId = ["telegram", "apple_messages"].includes(provider) ? new URL(request.url).searchParams.get("connection") : null;
  if (provider === "whatsapp") {
    if (!(await verifySignature(provider, request, raw, config, {}))) return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
    try {
      for (const item of splitWhatsappPayload(payload)) {
        const message = parseInboundMessage(provider, item, null);
        if (!message) continue;
        const destination = await lookupConnection(bindings, provider, undefined, message.externalAccountKey);
        if (!destination) {
          await quarantine(bindings, provider, raw, "unavailable_destination", true);
          return Response.json({ error: "Webhook destination unavailable; delivery retained for retry" }, { status: 503 });
        }
        await withWorkerOrganizationSession(destination.organization_id, async (session) => {
          const [event] = await session.db.insert(integrationEvents).values({
            id: crypto.randomUUID(), organizationId: destination.organization_id, connectionId: destination.connection_id,
            provider, externalEventId: message.externalMessageId, eventType: "message", payloadJson: JSON.stringify(item), status: "received", receivedAt: new Date(),
          }).onConflictDoNothing().returning({ id: integrationEvents.id });
          if (!event) return;
          await ingestInboundMessage(session, provider, destination.organization_id, message, bindings);
          await session.db.update(integrationEvents).set({ status: "processed", processedAt: new Date() }).where(eq(integrationEvents.id, event.id));
        }, bindings);
      }
    } catch (error) {
      if (error instanceof AmbiguousDestination) await quarantine(bindings, provider, raw, "ambiguous_destination", true);
      console.error("webhook_batch_failed", provider);
      return Response.json({ error: "Event storage or destination unavailable" }, { status: 503 });
    }
    return providerResponse(provider);
  }
  const parsed = parseInboundMessage(provider, payload, connectionId);
  const accountKey = externalAccountKey(provider, payload, parsed);
  let connection: WebhookConnection | null;
  try { connection = await lookupConnection(bindings, provider, connectionId ?? undefined, accountKey); }
  catch (error) {
    if (error instanceof AmbiguousDestination) await quarantine(bindings, provider, raw, "ambiguous_destination", false);
    return Response.json({ error: "Webhook destination requires review" }, { status: 503 });
  }
  let credentials: Record<string, string> = {};
  if (connection && ["telegram", "apple_messages", "twilio"].includes(provider)) {
    try { credentials = await connectionCredentials(connection, bindings); } catch { return Response.json({ error: "Invalid connection" }, { status: 503 }); }
  }
  if (!(await verifySignature(provider, request, raw, config, credentials))) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }
  if (provider === "slack" && payload.type === "url_verification") return Response.json({ challenge: payload.challenge });

  if (!connection) {
    await quarantine(bindings, provider, raw, "unavailable_destination", true);
    return Response.json({ error: "Webhook destination unavailable" }, { status: 503 });
  }
  if (provider === "twilio" && credentials.accountSid !== payload.AccountSid) {
    return Response.json({ error: "Invalid account" }, { status: 401 });
  }

  const externalEventId = String(
    payload.event_id ?? payload.update_id ?? payload.MessageSid ?? payload.CallSid
      ?? parsed?.externalMessageId ?? request.headers.get("x-request-id") ?? crypto.randomUUID(),
  ).slice(0, 512);
  const eventType = String(payload.type ?? (payload.event as Record<string, unknown> | undefined)?.type ?? "message").slice(0, 256);
  try {
    await withWorkerOrganizationSession(connection.organization_id, async (dbSession) => {
      const [event] = await dbSession.db.insert(integrationEvents).values({
        id: crypto.randomUUID(),
        organizationId: connection.organization_id,
        connectionId: connection.connection_id,
        provider,
        externalEventId,
        eventType,
        payloadJson: JSON.stringify(payload),
        status: "received",
        receivedAt: new Date(),
      }).onConflictDoNothing().returning({ id: integrationEvents.id });
      if (!event) return;
      if (parsed) await ingestInboundMessage(dbSession, provider, connection.organization_id, parsed, bindings);
      await dbSession.db.update(integrationEvents).set({ status: "processed", processedAt: new Date() })
        .where(eq(integrationEvents.id, event.id));
    }, bindings);
  } catch (error) {
    console.error("webhook_processing_failed", provider, error);
    return Response.json({ error: "Event storage unavailable" }, { status: 503 });
  }
  return providerResponse(provider);
}
