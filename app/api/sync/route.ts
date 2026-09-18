import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { importStatus, scheduleImport, AUTOMATIC_IMPORT_PROVIDERS } from "@/lib/integrations/sync-worker";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const provider = new URL(request.url).searchParams.get("provider") ?? "";
  if (!AUTOMATIC_IMPORT_PROVIDERS.has(provider)) return Response.json({ error: "Unsupported automatic import" }, { status: 400 });
  try { return Response.json(await importStatus(dbSession, identity.organizationId, provider), { headers: { "cache-control": "no-store" } }); }
  catch { return Response.json({ error: "Import status could not be loaded" }, { status: 503 }); }
}
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only the workspace owner can manage imports" }, { status: 403 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("provider" in body) || typeof body.provider !== "string") return Response.json({ error: "Provider is required" }, { status: 400 });
  if (!AUTOMATIC_IMPORT_PROVIDERS.has(body.provider)) return Response.json({ error: "Automatic import is not available for this connection yet.", code: "sync_unavailable" }, { status: 409 });
  if ("enabled" in body && typeof body.enabled !== "boolean") return Response.json({ error: "Invalid import setting" }, { status: 400 });
  try { return Response.json(await scheduleImport(dbSession, identity.organizationId, body.provider, !("enabled" in body) || body.enabled === true), { status: 202 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Import could not be scheduled" }, { status: 409 }); }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
