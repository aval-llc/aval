import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";

/** Tells the client how (if at all) the current visitor is authenticated. */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ authenticated: false });
  return Response.json({ authenticated: true, mode: identity.source, email: identity.email, displayName: identity.displayName });
}

export const GET = withApiSession(GETWithSession);
