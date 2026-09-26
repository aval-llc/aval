import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { getEmployee, setEmployeeStatus } from "@/lib/agents/employees";

/**
 * Removing a custom persona, kept as a compatibility adapter.
 *
 * The persona is an employee now (migration 20260925000200), and employees are
 * archived, never deleted: their work history and audit attribution have to
 * keep something to point at.
 */
async function DELETEWithSession(dbSession: DbSession, request: Request, context: { params: Promise<{ id: string }> }) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only workspace owners can archive employees." }, { status: 403 });

  const { id } = await context.params;
  if (!(await getEmployee(dbSession, identity.organizationId, id))) return Response.json({ ok: true });
  await setEmployeeStatus(dbSession, identity.organizationId, id, "archived");
  return Response.json({ ok: true, archived: id });
}

export const DELETE = withApiSession(DELETEWithSession);
