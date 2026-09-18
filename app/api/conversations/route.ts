import { withApiSession } from "@/lib/api/with-session";
import { asc, desc, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { conversations, messages } from "@/db/postgres/schema";
import { replyToConversation } from "@/lib/communications/store";
import { digestPayload } from "@/lib/audit/chain";
import { getApiIdentity } from "@/lib/integrations/session";

/** Real inbound/outbound threads for the signed-in org — populated by app/api/webhooks/[provider]/route.ts as real messages arrive. Empty until a real provider is connected and sends real traffic. */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const db = dbSession.db;
  const threads = await db.select().from(conversations).where(eq(conversations.organizationId, identity.organizationId)).orderBy(desc(conversations.lastMessageAt));
  const withMessages = await Promise.all(threads.map(async (thread) => {
    const rows = await db.select().from(messages).where(eq(messages.conversationId, thread.id)).orderBy(asc(messages.createdAt));
    return {
      id: thread.id,
      channel: thread.channel,
      contactDisplayName: thread.contactDisplayName,
      lastMessageAt: thread.lastMessageAt.getTime(),
      draftReply: thread.draftReply,
      draftReplyStatus: thread.draftReplyStatus,
      messages: rows.map((row) => ({ id: row.id, direction: row.direction, body: row.body, createdAt: row.createdAt.getTime() })),
    };
  }));

  return Response.json({ conversations: withMessages }, { headers: { "cache-control": "no-store" } });
}

/** Dispatch first; only provider-accepted replies enter the outbound transcript. */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role === "member") return Response.json({ error: "An owner or approver must send external messages." }, { status: 403 });
  if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const input: unknown = await request.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return Response.json({ error: 'A JSON object is required.' }, { status: 400 });
  const body = input as { conversationId?: string; body?: string; requestId?: string };
  if (typeof body.conversationId !== "string" || typeof body.body !== "string" || !body.body.trim() || body.body.length > 4000) return Response.json({ error: "A conversation and a message of at most 4,000 characters are required." }, { status: 400 });
  try {
    const result = await replyToConversation(dbSession, identity.organizationId, body.conversationId, body.body.trim(), `reply:${typeof body.requestId === 'string' ? body.requestId : await digestPayload({ conversation: body.conversationId, body: body.body.trim() })}`);
    return Response.json({ ok: ['accepted', 'sent', 'delivered'].includes(result.status), ...result }, { status: ['accepted','sent','delivered'].includes(result.status) ? 200 : 409 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not send the reply." }, { status: 422 }); }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
