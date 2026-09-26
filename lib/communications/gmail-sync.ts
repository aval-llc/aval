import { and, eq, sql } from "drizzle-orm";
import { wakeOnInboundMessage } from "@/lib/agents/waits";
import type { DbSession } from "@/db/postgres/session";
import { conversations, messages, integrationConnections } from "@/db/postgres/schema";
import { providerJson, ProviderHttpError, record, requiredString, safeSegment } from "@/lib/integrations/http";
import { queueInboundTask } from "./intake";
type Cursor = { historyId?: string; anchor?: string; pageToken?: string; mode?: "bootstrap" | "history" };
const root = "https://gmail.googleapis.com/gmail/v1/users/me";
export function gmailSender(from: string): string | null {
  const match = from.trim().match(/^(?:[^<>]*<)?([^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+)>?$/);
  return match ? match[1].toLowerCase() : null;
}
function plain(part: Record<string, unknown>): string {
  const body = part.body ? record(part.body) : undefined;
  if (part.mimeType === "text/plain" && typeof body?.data === "string") return new TextDecoder().decode(Uint8Array.from(atob(body.data.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0))).slice(0,10000);
  return Array.isArray(part.parts) ? part.parts.map(p => plain(record(p))).join("\n").slice(0,10000) : "";
}
export async function syncGmail(session: DbSession, org: string, connection: { id: string; externalAccountId: string | null }, accessToken: string) {
  if (!connection.externalAccountId) throw new Error("Gmail account identity unavailable");
  const state = await session.db.execute<{ account_id: string; cursor_json: Cursor }>(sql`select account_id, cursor_json from communication_inbox_state where organization_id = ${org} and connection_id = ${connection.id}`);
  if (state.rows[0] && state.rows[0].account_id !== connection.externalAccountId) throw new Error("Gmail account changed; reconcile the previous inbox before restarting");
  const originalCursor = JSON.stringify(state.rows[0]?.cursor_json ?? {});
  const cursor: Cursor = { ...state.rows[0]?.cursor_json };
  const page = await session.outsideTransaction(async () => {
    const get = async (path: string) => record(await providerJson(`${root}/${path}`, { headers: { authorization: `Bearer ${accessToken}` } }));
    if (!cursor.mode) { cursor.mode = "bootstrap"; cursor.anchor = requiredString((await get("profile")).historyId); }
    const query = new URLSearchParams({ maxResults: "20" });
    if (cursor.pageToken) query.set("pageToken", cursor.pageToken);
    let listing: Record<string, unknown>;
    if (cursor.mode === "bootstrap") { query.set("q", "in:inbox"); listing = await get(`messages?${query}`); }
    else {
      query.set("startHistoryId", requiredString(cursor.historyId)); query.set("historyTypes", "messageAdded");
      try { listing = await get(`history?${query}`); }
      catch (error) {
        if (!(error instanceof ProviderHttpError) || error.status !== 404) throw error;
        return { incoming: [], next: {} as Cursor, rescan: true };
      }
    }
    const ids = new Set<string>();
    if (cursor.mode === "bootstrap") for (const m of Array.isArray(listing.messages) ? listing.messages : []) ids.add(requiredString(record(m).id));
    else for (const h of Array.isArray(listing.history) ? listing.history : []) {
      const additions = record(h).messagesAdded;
      for (const added of Array.isArray(additions) ? additions : []) ids.add(requiredString(record(record(added).message).id));
    }
    const incoming: Record<string, unknown>[] = [];
    for (const id of ids) {
      try { incoming.push(await get(`messages/${safeSegment(id)}?format=full`)); }
      catch (error) { if (!(error instanceof ProviderHttpError) || error.status !== 404) throw error; }
    }
    const next: Cursor = listing.nextPageToken ? { ...cursor, pageToken: requiredString(listing.nextPageToken) }
      : { mode: "history", historyId: cursor.mode === "bootstrap" ? cursor.anchor : requiredString(listing.historyId) };
    return { incoming, next, rescan: false };
  });
  let imported = 0;
  await session.atomic(async () => {
    // The network phase releases our transaction. Recheck identity and serialize
    // checkpoints so a reconnect or slower concurrent poll cannot rewind it.
    const current = await session.db.execute<{ external_account_id: string; status: string }>(sql`select external_account_id, status from ${integrationConnections}
      where organization_id = ${org} and id = ${connection.id} for update`);
    if (current.rows[0]?.status !== "connected" || current.rows[0].external_account_id !== connection.externalAccountId) throw new Error("Gmail connection changed during synchronization");
    const latest = await session.db.execute<{ cursor_json: Cursor }>(sql`select cursor_json from communication_inbox_state where organization_id = ${org} and connection_id = ${connection.id}`);
    if (JSON.stringify(latest.rows[0]?.cursor_json ?? {}) !== originalCursor) throw new Error("Another Gmail poll advanced the checkpoint; retry from its saved cursor");
    for (const m of page.incoming) {
      if (!Array.isArray(m.labelIds) || !m.labelIds.includes("INBOX") || m.labelIds.includes("SENT")) continue;
      const payload = record(m.payload), headers = Array.isArray(payload.headers) ? payload.headers.map(record) : [];
      const header = (name: string) => String(headers.find(h => String(h.name).toLowerCase() === name)?.value ?? "");
      const sender = gmailSender(header("from")), body = plain(payload) || String(m.snippet ?? "");
      const now = new Date(), at = new Date(Number(m.internalDate));
      if (!Number.isFinite(at.getTime())) throw new Error("Gmail returned an invalid timestamp");
      const threadId = requiredString(m.threadId), messageId = requiredString(m.id);
      await session.db.insert(conversations).values({ id: crypto.randomUUID(), organizationId: org, channel: "gmail", externalThreadId: threadId, contactDisplayName: header("from") || "Unresolved sender", lastMessageAt: at, createdAt: now, updatedAt: now }).onConflictDoNothing();
      const [thread] = await session.db.select().from(conversations).where(and(eq(conversations.organizationId, org), eq(conversations.channel, "gmail"), eq(conversations.externalThreadId, threadId))).limit(1);
      if (!thread) throw new Error("Gmail conversation unavailable");
      const metadata = { sender, subject: header("subject"), rfcMessageId: header("message-id"), threadId, newsletter: Boolean(header("list-unsubscribe") || header("list-id") || /^(bulk|list|junk)$/i.test(header("precedence"))) };
      const inserted = await session.db.insert(messages).values({ id: crypto.randomUUID(), conversationId: thread.id, externalMessageId: messageId, direction: "inbound", body: body.slice(0,10000), payloadJson: JSON.stringify(metadata), createdAt: at }).onConflictDoNothing().returning({ id: messages.id });
      if (!inserted.length) continue;
      imported++;
      // Work waiting on whoever writes on this thread re-checks now.
      await wakeOnInboundMessage(session, org, thread.id);
      if (at > thread.lastMessageAt) await session.db.update(conversations).set({ lastMessageAt: at, updatedAt: now }).where(eq(conversations.id, thread.id));
      await queueInboundTask(session, org, thread.id, messageId, body);
    }
    await session.db.execute(sql`insert into communication_inbox_state (connection_id, organization_id, account_id, cursor_json)
      values (${connection.id}, ${org}, ${connection.externalAccountId}, ${JSON.stringify(page.next)}::jsonb)
      on conflict (connection_id) do update set cursor_json = excluded.cursor_json, updated_at = now()`);
  });
  return { imported, complete: false, note: page.rescan ? "Gmail history expired; durable inbox rescan queued" : "Checkpoint saved; continuous inbox synchronization enabled" };
}
