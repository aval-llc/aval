import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { integrationEvents } from "@/db/postgres/schema";
import { withSystemSession, withWorkerOrganizationSession } from "@/lib/api/with-session";
import { voiceResponse } from "@/lib/communications/config";
import { readCommunicationsConfig } from "@/lib/communications/store";
import { verifyTwilio } from "@/lib/communications/signature";
import { decryptSecret } from "@/lib/integrations/crypto";
import type { AvalRuntimeBindings } from "@/lib/runtime/bindings";

type VoiceConnection = {
  organization_id: string;
  connection_id: string;
  encrypted_credentials: string | null;
  external_account_id: string | null;
};

export async function POST(request: Request) {
  const connectionId = new URL(request.url).searchParams.get("connection");
  if (!connectionId || connectionId.length > 256) return new Response("Unknown connection", { status: 404 });
  const bindings = env as unknown as AvalRuntimeBindings;
  const connection = await withSystemSession("worker", async (session) => {
    const result = await session.db.execute<VoiceConnection>(
      sql`select * from aval_private.webhook_connection('twilio', ${connectionId}, null)`,
    );
    return result.rows[0] ?? null;
  }, bindings);
  const encryptionKey = bindings.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!connection?.encrypted_credentials || typeof encryptionKey !== "string") return new Response("Unknown connection", { status: 404 });

  let credentials: Record<string, string>;
  try {
    credentials = JSON.parse(await decryptSecret(connection.encrypted_credentials, encryptionKey)) as Record<string, string>;
  } catch {
    return new Response("Invalid connection", { status: 503 });
  }
  const raw = await request.text();
  if (raw.length > 64_000 || !(await verifyTwilio(request, raw, credentials.authToken))) return new Response("Invalid signature", { status: 401 });
  const fields = new URLSearchParams(raw);
  if (fields.get("AccountSid") !== credentials.accountSid || !fields.get("CallSid")) return new Response("Invalid account", { status: 401 });

  return withWorkerOrganizationSession(connection.organization_id, async (dbSession) => {
    const url = new URL(request.url);
    const speech = (fields.get("SpeechResult") ?? "").slice(0, 2000);
    const digit = fields.get("Digits") ?? "";
    const stage = url.searchParams.get("stage") ?? "entry";
    const config = await readCommunicationsConfig(dbSession, connection.organization_id);
    await dbSession.db.insert(integrationEvents).values({
      id: crypto.randomUUID(),
      organizationId: connection.organization_id,
      connectionId: connection.connection_id,
      provider: "twilio",
      externalEventId: `${connection.connection_id}:${fields.get("CallSid")}:${stage}:${fields.get("DialCallStatus") ?? ""}`,
      eventType: "voice",
      payloadJson: JSON.stringify({ connectionId: connection.connection_id, callId: fields.get("CallSid"), speech, digit, stage, status: fields.get("DialCallStatus") }),
      status: "processed",
      receivedAt: new Date(),
      processedAt: new Date(),
    }).onConflictDoNothing();
    return new Response(voiceResponse(config, request.url, speech, digit, fields.get("DialCallStatus") ?? "", stage), {
      headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" },
    });
  }, bindings);
}
