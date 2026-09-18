import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET   /api/operations/units        — units, filterable by property or status.
 * POST  /api/operations/units        — add a unit.
 * PATCH /api/operations/units        — change a unit's status.
 *
 * PATCH goes through `setUnitStatus` rather than writing the column directly,
 * because that function also maintains `vacantSince` — the date every
 * days-vacant figure is measured from. A status written around it would leave
 * a re-leased unit reporting as vacant indefinitely.
 */

import { ensureOrganization } from "@/lib/integrations/organizations";
import { getApiIdentity } from "@/lib/integrations/session";
import { operationsErrorResponse } from "@/lib/operations/errors";
import { createUnit, listUnits, setUnitStatus } from "@/lib/operations/portfolio";
import { UNIT_STATUSES } from "@/lib/operations/types";
import {
  optionalCents,
  optionalEnum,
  optionalInt,
  optionalNumber,
  readJsonBody,
  requireEnum,
  requireString,
} from "@/lib/operations/validation";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const units = await listUnits(dbSession, identity.organizationId, {
    propertyId: url.searchParams.get("propertyId") ?? undefined,
    status: UNIT_STATUSES.includes(statusParam as (typeof UNIT_STATUSES)[number])
      ? (statusParam as (typeof UNIT_STATUSES)[number])
      : undefined,
  });
  return Response.json({ units });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  try {
    const body = await readJsonBody(request);
    const unit = await createUnit(dbSession, identity.organizationId, {
      propertyId: requireString(body, "propertyId", 64),
      unitNumber: requireString(body, "unitNumber", 40),
      bedrooms: optionalInt(body, "bedrooms", 0, 20),
      bathrooms: optionalNumber(body, "bathrooms", 0, 20),
      squareFeet: optionalInt(body, "squareFeet", 0),
      marketRentCents: optionalCents(body, "marketRentCents"),
      status: optionalEnum(body, "status", UNIT_STATUSES),
    });
    return Response.json({ unit }, { status: 201 });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

async function PATCHWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  try {
    const body = await readJsonBody(request);
    const unit = await setUnitStatus(dbSession,
      identity.organizationId,
      requireString(body, "unitId", 64),
      requireEnum(body, "status", UNIT_STATUSES),
    );
    return Response.json({ unit });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
export const PATCH = withApiSession(PATCHWithSession);
