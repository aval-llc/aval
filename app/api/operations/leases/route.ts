import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET   /api/operations/leases — leases, filterable by status, property or unit.
 * POST  /api/operations/leases — sign a lease (and occupy its unit).
 * PATCH /api/operations/leases — end a lease (and return its unit to the vacant pool).
 *
 * Creating and ending a lease both move the unit, deliberately: a unit with an
 * active lease is occupied, and letting the two drift apart puts a
 * contradiction into the rows every occupancy figure is computed from. See
 * `createLease` / `endLease`.
 */

import { ensureOrganization } from "@/lib/integrations/organizations";
import { getApiIdentity } from "@/lib/integrations/session";
import { operationsErrorResponse } from "@/lib/operations/errors";
import { attachResidentToLease, createLease, endLease, listLeases, residentsForLeases } from "@/lib/operations/leasing";
import { LEASE_RESIDENT_ROLES, LEASE_STATUSES } from "@/lib/operations/types";
import {
  optionalBoolean,
  optionalDate,
  optionalEnum,
  optionalInt,
  optionalString,
  readJsonBody,
  requireCents,
  requireDate,
  requireEnum,
  requireString,
} from "@/lib/operations/validation";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const leases = await listLeases(dbSession, identity.organizationId, {
    status: LEASE_STATUSES.includes(statusParam as (typeof LEASE_STATUSES)[number])
      ? (statusParam as (typeof LEASE_STATUSES)[number])
      : undefined,
    propertyId: url.searchParams.get("propertyId") ?? undefined,
    unitId: url.searchParams.get("unitId") ?? undefined,
  });

  // Residents are returned alongside rather than in a second round trip: every
  // surface that lists leases (collections, renewals, the inbox) needs a name
  // to show, and a lease id on its own is not something a person can act on.
  const residents = await residentsForLeases(dbSession, identity.organizationId, leases.map((lease) => lease.id));
  return Response.json({
    leases: leases.map((lease) => ({ ...lease, residents: residents.get(lease.id) ?? [] })),
  });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  try {
    const body = await readJsonBody(request);
    const lease = await createLease(dbSession, identity.organizationId, {
      unitId: requireString(body, "unitId", 64),
      status: optionalEnum(body, "status", LEASE_STATUSES),
      startDate: requireDate(body, "startDate"),
      endDate: optionalDate(body, "endDate"),
      isMonthToMonth: optionalBoolean(body, "isMonthToMonth"),
      moveInDate: optionalDate(body, "moveInDate"),
      rentCents: requireCents(body, "rentCents"),
      depositCents: optionalInt(body, "depositCents", 0) ?? 0,
      rentDueDay: optionalInt(body, "rentDueDay", 1, 31) ?? 1,
      renewalOfLeaseId: optionalString(body, "renewalOfLeaseId", 64),
    });

    const residentId = optionalString(body, "residentId", 64);
    if (residentId) {
      await attachResidentToLease(dbSession,
        identity.organizationId,
        lease.id,
        residentId,
        optionalEnum(body, "residentRole", LEASE_RESIDENT_ROLES) ?? "primary",
      );
    }
    return Response.json({ lease }, { status: 201 });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

async function PATCHWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  try {
    const body = await readJsonBody(request);
    const lease = await endLease(dbSession, identity.organizationId, requireString(body, "leaseId", 64), {
      status: requireEnum(body, "status", ["expired", "terminated", "renewed"] as const),
      moveOutDate: optionalDate(body, "moveOutDate") ?? undefined,
      unitStatus: optionalEnum(body, "unitStatus", ["vacant_ready", "vacant_not_ready"] as const),
    });
    return Response.json({ lease });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
export const PATCH = withApiSession(PATCHWithSession);
