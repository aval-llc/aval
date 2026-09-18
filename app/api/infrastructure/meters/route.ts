import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { createMeter, listMeters } from "@/lib/infrastructure/meters";
import type { UnitOfMeasure, UtilityType } from "@/lib/infrastructure/types";

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
  await ensureOrganization(dbSession, identity);

  const body = (await request.json().catch(() => ({}))) as {
    utilityType?: string;
    propertyLabel?: string;
    unitLabel?: string;
    meterNumber?: string;
    provider?: string;
    unitOfMeasure?: string;
  };

  if (!UTILITY_TYPES.includes(body.utilityType as UtilityType)) {
    return Response.json({ error: "utilityType must be one of: electricity, water, gas" }, { status: 400 });
  }
  const propertyLabel = typeof body.propertyLabel === "string" ? body.propertyLabel.trim().slice(0, MAX_LABEL_CHARS) : "";
  if (!propertyLabel) return Response.json({ error: "propertyLabel is required" }, { status: 400 });
  if (!UNITS_OF_MEASURE.includes(body.unitOfMeasure as UnitOfMeasure)) {
    return Response.json({ error: `unitOfMeasure must be one of: ${UNITS_OF_MEASURE.join(", ")}` }, { status: 400 });
  }

  const meter = await createMeter(dbSession, identity.organizationId, {
    utilityType: body.utilityType as UtilityType,
    propertyLabel,
    unitLabel: body.unitLabel?.trim().slice(0, MAX_LABEL_CHARS) || undefined,
    meterNumber: body.meterNumber?.trim().slice(0, MAX_LABEL_CHARS) || undefined,
    provider: body.provider?.trim().slice(0, MAX_LABEL_CHARS) || undefined,
    unitOfMeasure: body.unitOfMeasure as UnitOfMeasure,
  });
  return Response.json({ meter }, { status: 201 });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
