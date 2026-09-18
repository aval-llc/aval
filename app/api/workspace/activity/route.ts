import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { readActivity, recordActivity } from "@/lib/activity/store";
async function activity(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity || isGuestIdentity(identity))
    return Response.json({ error: "Authentication required" }, { status: 401 });
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && origin !== new URL(request.url).origin)
    )
      return Response.json({ error: "Invalid origin" }, { status: 403 });
  }
  try {
    await ensureOrganization(dbSession, identity);
    if (request.method === "POST") {
      // Server time only. Client timestamps and identities are never accepted.
      await recordActivity(dbSession, identity.organizationId, identity.userId);
      return Response.json(
        { ok: true },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      await readActivity(dbSession, identity.organizationId, identity.userId),
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Activity is temporarily unavailable" },
      { status: 503 },
    );
  }
}
export const GET = withApiSession(activity);
export const POST = withApiSession(activity);
