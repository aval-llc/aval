import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { deleteCustomPersona } from "@/lib/ask-aval/custom-personas";

async function DELETEWithSession(dbSession: DbSession, request: Request, context: { params: Promise<{ id: string }> }) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const { id } = await context.params;
  await deleteCustomPersona(dbSession, identity.organizationId, id);
  return Response.json({ ok: true });
}

export const DELETE = withApiSession(DELETEWithSession);
