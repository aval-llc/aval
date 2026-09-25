import { and, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { withApiSession } from '@/lib/api/with-session';
import type { DbSession } from '@/db/postgres/session';
import { integrationConnections } from '@/db/postgres/schema';
import { getApiIdentity, isGuestIdentity } from '@/lib/integrations/session';
import { decryptSecret } from '@/lib/integrations/crypto';
import { isRateLimited, recordAttempt } from '@/lib/security/rate-limit';

async function POSTWithSession(session: DbSession, request: Request) {
  const identity = await getApiIdentity(session, request);
  if (!identity || isGuestIdentity(identity)) return Response.json({ code: 'unauthorized' }, { status: 401 });
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ code: 'origin' }, { status: 403 });
  const scope = `transcribe:${identity.organizationId}:${identity.userId}`;
  const rule = { limit: 30, windowMs: 3600000 };
  if (await isRateLimited(session, scope, rule)) return Response.json({ code: 'limited' }, { status: 429 });
  await recordAttempt(session, scope);
  // Bound the stream before multipart parsing, even without Content-Length.
  const reader = request.body?.getReader(); if (!reader) return Response.json({ code: 'audio_required' }, { status: 400 });
  const parts: Uint8Array[] = []; let length = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 8_100_000) { await reader.cancel(); return Response.json({ code: 'too_large' }, { status: 413 }); } parts.push(value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  let form: FormData; try { form = await new Response(bytes, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData(); } catch { return Response.json({ code: 'invalid_audio' }, { status: 400 }); }
  const audio = form.get('audio');
  if (!(audio instanceof File) || !audio.size || audio.size > 8_000_000 || !/^audio\/(webm|mp4|mpeg|wav|ogg)(;|$)/.test(audio.type)) return Response.json({ code: 'invalid_audio' }, { status: 400 });
  // Use only the workspace's explicitly connected OpenAI API credential.
  // Subscription credentials are never repurposed for transcription.
  const [connection] = await session.db.select().from(integrationConnections).where(and(eq(integrationConnections.organizationId, identity.organizationId), eq(integrationConnections.provider, 'openai'), eq(integrationConnections.status, 'connected'))).limit(1);
  const key = (env as unknown as { INTEGRATION_TOKEN_ENCRYPTION_KEY?: string }).INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!connection?.accessTokenCiphertext || !key) return Response.json({ code: 'provider_required' }, { status: 409 });
  try {
    const credential = JSON.parse(await decryptSecret(connection.accessTokenCiphertext, key)) as { apiKey?: string };
    if (!credential.apiKey) return Response.json({ code: 'provider_required' }, { status: 409 });
    const payload = new FormData(); payload.append('file', audio); payload.append('model', 'whisper-1');
    const response = await session.outsideTransaction(() => fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${credential.apiKey}` }, body: payload, signal: AbortSignal.timeout(60000) }));
    if (!response.ok) return Response.json({ code: 'transcription_failed' }, { status: 502 });
    const result = await response.json() as { text?: string };
    return Response.json({ text: typeof result.text === 'string' ? result.text.slice(0, 1200) : '' }, { headers: { 'cache-control': 'no-store' } });
  } catch { return Response.json({ code: 'transcription_failed' }, { status: 502 }); }
}
export const POST = withApiSession(POSTWithSession);
