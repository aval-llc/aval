import { sql } from 'drizzle-orm';
import { withApiSession } from '@/lib/api/with-session';
import type { DbSession } from '@/db/postgres/session';
import { getApiIdentity, isGuestIdentity } from '@/lib/integrations/session';
// The same definition the panel mints its ids from, so the two cannot drift.
import { STORABLE_TURN_ID } from '@/lib/ask-aval/chat-turn';
const headers = { 'cache-control': 'no-store' };
async function GETWithSession(session: DbSession, request: Request) {
  const identity = await getApiIdentity(session, request);
  if (!identity || isGuestIdentity(identity)) return Response.json({ error: 'Authentication required' }, { status: 401, headers });
  const before = new URL(request.url).searchParams.get('before');
  const cursor = before && Number.isFinite(Date.parse(before)) ? new Date(before) : new Date('9999-01-01');
  const rows = await session.db.execute<{ payload: unknown; created_at: Date }>(sql`select payload, created_at from assistant_chat_entries where organization_id=${identity.organizationId} and user_id=${identity.userId} and created_at < ${cursor} order by created_at desc, id desc limit 100`);
  return Response.json({ messages: rows.rows.map(row => row.payload).reverse(), before: rows.rows.length === 100 ? rows.rows.at(-1)?.created_at : null }, { headers });
}
async function POSTWithSession(session: DbSession, request: Request) {
  const identity = await getApiIdentity(session, request);
  if (!identity || isGuestIdentity(identity)) return Response.json({ error: 'Authentication required' }, { status: 401, headers });
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid origin' }, { status: 403 });
  const raw = await request.text(); if (raw.length > 90000) return Response.json({ error: 'Too large' }, { status: 413 });
  let message: Record<string, unknown>; try { message = JSON.parse(raw); } catch { return Response.json({ error: 'Invalid message' }, { status: 400 }); }
  if (!message || typeof message.id !== 'string' || !STORABLE_TURN_ID.test(message.id) || !['user', 'assistant'].includes(String(message.role))) return Response.json({ error: 'Invalid message' }, { status: 400 });
  // Explicit public UI fields only. Never copy runtime transcripts or model notes.
  const payload = Object.fromEntries(['id', 'role', 'text', 'answer', 'taskId', 'taskAgentId', 'error', 'startedAt', 'finishedAt', 'activity'].filter(key => message[key] !== undefined).map(key => [key, message[key]]));
  // Append only: a stored entry is never rewritten by a later request, so a
  // client cannot revise what the record says happened. Retries stay honest
  // because a failed attempt is not written at all — see `submit` in
  // `aval-assistant.tsx`.
  await session.db.execute(sql`insert into assistant_chat_entries(organization_id,user_id,id,payload) values (${identity.organizationId},${identity.userId},${message.id},${JSON.stringify(payload)}::jsonb) on conflict do nothing`);
  return Response.json({ saved: true }, { headers });
}
export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
