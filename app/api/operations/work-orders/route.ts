import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET   /api/operations/work-orders — the maintenance queue.
 * POST  /api/operations/work-orders — report work.
 * PATCH /api/operations/work-orders — assign, start, complete, or link a callback.
 *
 * Each PATCH action stamps its own timestamp rather than only moving a status,
 * because every maintenance metric is a difference between two of those stamps
 * (see `lib/operations/metrics/maintenance.ts`).
 */

import { ensureOrganization } from "@/lib/integrations/organizations";
import { getApiIdentity } from "@/lib/integrations/session";
import { operationsErrorResponse } from "@/lib/operations/errors";
import {
  assignWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  linkCallback,
  listWorkOrders,
  startWorkOrder,
} from "@/lib/operations/maintenance";
import { WORK_ORDER_CATEGORIES, WORK_ORDER_PRIORITIES, WORK_ORDER_STATUSES } from "@/lib/operations/types";
import {
  optionalCents,
  optionalDate,
  optionalEnum,
  optionalString,
  readJsonBody,
  requireEnum,
  requireString,
  MAX_SUMMARY_CHARS,
} from "@/lib/operations/validation";

const WORK_ORDER_ACTIONS = ["assign", "start", "complete", "link_callback"] as const;

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const workOrders = await listWorkOrders(dbSession, identity.organizationId, {
    status: WORK_ORDER_STATUSES.includes(statusParam as (typeof WORK_ORDER_STATUSES)[number])
      ? (statusParam as (typeof WORK_ORDER_STATUSES)[number])
      : undefined,
    openOnly: url.searchParams.get("open") === "true",
    propertyId: url.searchParams.get("propertyId") ?? undefined,
    vendorId: url.searchParams.get("vendorId") ?? undefined,
  });
  return Response.json({ workOrders });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  try {
    const body = await readJsonBody(request);
    const workOrder = await createWorkOrder(dbSession, identity.organizationId, {
      propertyId: requireString(body, "propertyId", 64),
      unitId: optionalString(body, "unitId", 64),
      leaseId: optionalString(body, "leaseId", 64),
      category: optionalEnum(body, "category", WORK_ORDER_CATEGORIES),
      priority: optionalEnum(body, "priority", WORK_ORDER_PRIORITIES),
      summary: requireString(body, "summary", MAX_SUMMARY_CHARS),
      reportedAt: optionalDate(body, "reportedAt") ?? undefined,
      vendorId: optionalString(body, "vendorId", 64),
      estimateCents: optionalCents(body, "estimateCents"),
      callbackOfWorkOrderId: optionalString(body, "callbackOfWorkOrderId", 64),
    });
    return Response.json({ workOrder }, { status: 201 });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

async function PATCHWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  try {
    const body = await readJsonBody(request);
    const workOrderId = requireString(body, "workOrderId", 64);
    const action = requireEnum(body, "action", WORK_ORDER_ACTIONS);
    const at = optionalDate(body, "at") ?? new Date();

    switch (action) {
      case "assign":
        return Response.json({
          workOrder: await assignWorkOrder(dbSession, identity.organizationId, workOrderId, requireString(body, "vendorId", 64), at),
        });
      case "start":
        return Response.json({ workOrder: await startWorkOrder(dbSession, identity.organizationId, workOrderId, at) });
      case "complete":
        return Response.json({
          workOrder: await completeWorkOrder(dbSession, identity.organizationId, workOrderId, {
            at,
            actualCostCents: optionalCents(body, "actualCostCents"),
          }),
        });
      case "link_callback":
        // Only ever on a person's say-so. Nothing links a callback
        // automatically — first-time-fix feeds vendor renewals, and an
        // inferred callback is a guess with a contract attached to it.
        return Response.json({
          workOrder: await linkCallback(dbSession,
            identity.organizationId,
            workOrderId,
            requireString(body, "originalWorkOrderId", 64),
          ),
        });
    }
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
export const PATCH = withApiSession(PATCHWithSession);
