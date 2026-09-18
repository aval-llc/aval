import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET  /api/operations/vendors — vendors in this workspace.
 * POST /api/operations/vendors — add one.
 *
 * `insuranceExpiresAt` is stored because an expired certificate on an assigned
 * vendor is a liability an operator wants surfaced before work is booked — the
 * insight rules flag it (`vendor_insurance_lapsed`).
 */

import { ensureOrganization } from "@/lib/integrations/organizations";
import { getApiIdentity } from "@/lib/integrations/session";
import { operationsErrorResponse } from "@/lib/operations/errors";
import { createVendor, listVendors } from "@/lib/operations/maintenance";
import { optionalBoolean, optionalDate, optionalString, readJsonBody, requireString } from "@/lib/operations/validation";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const activeOnly = new URL(request.url).searchParams.get("active") === "true";
  return Response.json({ vendors: await listVendors(dbSession, identity.organizationId, activeOnly) });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  try {
    const body = await readJsonBody(request);
    const vendor = await createVendor(dbSession, identity.organizationId, {
      name: requireString(body, "name", 120),
      trade: optionalString(body, "trade", 60),
      email: optionalString(body, "email", 200),
      phone: optionalString(body, "phone", 40),
      insuranceExpiresAt: optionalDate(body, "insuranceExpiresAt"),
      isActive: optionalBoolean(body, "isActive"),
    });
    return Response.json({ vendor }, { status: 201 });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
