import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { createMeter, listMeters } from "@/lib/infrastructure/meters";
import type { UnitOfMeasure, UtilityType } from "@/lib/infrastructure/types";

import { mapMeter } from "@/lib/infrastructure/sites";
import { textField, utilityErrorResponse } from "@/lib/infrastructure/validation";
import { readUtilityBody } from "@/lib/infrastructure/validation";

const UTILITY_TYPES: UtilityType[] = ["electricity", "water", "gas"];
const UNITS_OF_MEASURE: UnitOfMeasure[] = ["kWh", "gal", "ccf", "therm", "m3"];
const MAX_LABEL_CHARS = 200;

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const utilityTypeParam = new URL(request.url).searchParams.get("utilityType");
  const utilityType = UTILITY_TYPES.includes(utilityTypeParam as UtilityType) ? (utilityTypeParam as UtilityType) : undefined;

  const meters = await listMeters(dbSession, identity.organizationId, utilityType);
  return Response.json({ meters });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({error:"Owner required"},{status:403});
  await ensureOrganization(dbSession, identity);

  try {
  const body = await readUtilityBody(request);

  if (!UTILITY_TYPES.includes(body.utilityType as UtilityType)) {
    return Response.json({ error: "utilityType must be one of: electricity, water, gas" }, { status: 400 });
  }
  const propertyLabel = typeof body.propertyLabel === "string" ? body.propertyLabel.trim().slice(0, MAX_LABEL_CHARS) : "";
  if (!body.siteId || typeof body.siteId !== "string") return Response.json({error:"siteId is required"},{status:400});
  if (!UNITS_OF_MEASURE.includes(body.unitOfMeasure as UnitOfMeasure)) {
    return Response.json({ error: `unitOfMeasure must be one of: ${UNITS_OF_MEASURE.join(", ")}` }, { status: 400 });
  }

  const meter = await createMeter(dbSession, identity.organizationId, {
    siteId: textField(body.siteId,"siteId"),
    parentMeterId: body.parentMeterId ? textField(body.parentMeterId,"parentMeterId") : null,
    utilityType: body.utilityType as UtilityType,
    propertyLabel,
    unitLabel: body.unitLabel == null ? undefined : textField(body.unitLabel,"unitLabel",MAX_LABEL_CHARS),
    meterNumber: body.meterNumber == null ? undefined : textField(body.meterNumber,"meterNumber",MAX_LABEL_CHARS),
    provider: body.provider == null ? undefined : textField(body.provider,"provider",MAX_LABEL_CHARS),
    unitOfMeasure: body.unitOfMeasure as UnitOfMeasure,
  });
  return Response.json({ meter }, { status: 201 });
  } catch(error) { return utilityErrorResponse(error); }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);

export const PATCH = withApiSession(async(s,request) => {
  const identity = await getApiIdentity(s,request);
  if (identity?.role !== "owner") return Response.json({error:"Owner required"},{status:403});
  try {
    const b = await readUtilityBody(request);
    const meter = await mapMeter(s,identity.organizationId,textField(b.meterId,"meterId"),textField(b.siteId,"siteId"),b.parentMeterId ? textField(b.parentMeterId,"parentMeterId") : null);
    return Response.json({meter});
  } catch(error) { return utilityErrorResponse(error); }
});
