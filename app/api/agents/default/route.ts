import { withApiSession } from "@/lib/api/with-session";
import { eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { organizations } from "@/db/postgres/schema";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { getEmployee } from "@/lib/agents/employees";
import { builtInActor } from "@/lib/agents/organization";
import { PERSONAS } from "@/lib/ask-aval/persona-catalog";

/**
 * The built-in personas, read from the catalogue rather than copied.
 *
 * This was a hand-written list, and it had drifted: `leaseReview` was missing,
 * so the Setup picker offered a card that always failed to save. Deriving it
 * from PERSONAS means the list cannot fall behind the thing it describes.
 */
const builtInPersonaIds = (): Set<string> => new Set(Object.keys(PERSONAS));

/** GET: which persona Ask Aval opens with by default for this org. Null means the built-in "general" persona. */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const org = await ensureOrganization(dbSession, identity);
  return Response.json({ defaultPersonaId: org.defaultPersonaId ?? null });
}

/** POST { personaId }: sets the org-wide default. `{ personaId: null }` reverts to "general". */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { personaId?: string | null };
  const personaId = body.personaId ?? null;

  // A built-in agent, a Lead or Specialist of the organization, or one of the
  // workspace's own employees (which is also where every former custom persona
  // now lives, under the same id).
  if (personaId !== null && !builtInPersonaIds().has(personaId) && !builtInActor(personaId)) {
    const employee = await getEmployee(dbSession, identity.organizationId, personaId);
    if (!employee || employee.status === "archived") {
      return Response.json({ error: "Unknown agent" }, { status: 400 });
    }
  }

  await ensureOrganization(dbSession, identity);
  const db = dbSession.db;
  await db.update(organizations).set({ defaultPersonaId: personaId, updatedAt: new Date() }).where(eq(organizations.id, identity.organizationId));
  return Response.json({ defaultPersonaId: personaId });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
