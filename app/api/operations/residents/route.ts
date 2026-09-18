import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET  /api/operations/residents — residents in this workspace.
 * POST /api/operations/residents — add one.
 *
 * The only operations table holding personal contact data, so it is org-scoped
 * like the rest and deliberately never mirrored into `learned_preferences` or
 * `answer_audit_log`, which store tags and digests precisely so they cannot
 * become a second, indefinitely-retained copy of it.
 */

import { ensureOrganization } from "@/lib/integrations/organizations";
import { getApiIdentity } from "@/lib/integrations/session";
import { operationsErrorResponse } from "@/lib/operations/errors";
import { createResident, listResidents } from "@/lib/operations/leasing";
import { RESIDENT_STATUSES } from "@/lib/operations/types";
import { optionalEnum, optionalString, readJsonBody, requireString } from "@/lib/operations/validation";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const statusParam = new URL(request.url).searchParams.get("status");
  const residents = await listResidents(dbSession,
    identity.organizationId,
    RESIDENT_STATUSES.includes(statusParam as (typeof RESIDENT_STATUSES)[number])
      ? (statusParam as (typeof RESIDENT_STATUSES)[number])
      : undefined,
  );
  return Response.json({ residents });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  try {
    const body = await readJsonBody(request);
    const resident = await createResident(dbSession, identity.organizationId, {
      displayName: requireString(body, "displayName", 120),
      email: optionalString(body, "email", 200),
      phone: optionalString(body, "phone", 40),
      status: optionalEnum(body, "status", RESIDENT_STATUSES),
    });
    return Response.json({ resident }, { status: 201 });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
