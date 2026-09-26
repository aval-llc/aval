import { validateBill, utilityErrorResponse } from "@/lib/infrastructure/validation";
import { readUtilityBody } from "@/lib/infrastructure/validation";
import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { listBills, recordBill, MeterNotFoundError } from "@/lib/infrastructure/meters";
import type { UtilityType } from "@/lib/infrastructure/types";

const UTILITY_TYPES: UtilityType[] = ["electricity", "water", "gas"];
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const meterId = params.get("meterId") ?? undefined;
  const utilityTypeParam = params.get("utilityType");
  const utilityType = UTILITY_TYPES.includes(utilityTypeParam as UtilityType) ? (utilityTypeParam as UtilityType) : undefined;

  const bills = await listBills(dbSession, identity.organizationId, { meterId, utilityType });
  return Response.json({ bills });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  if (identity.role !== "owner") return Response.json({error:"Owner required"},{status:403});
  try {
    const input = validateBill(await readUtilityBody(request));
    const bill = await recordBill(dbSession,identity.organizationId,{...input,source:"manual"});
    return Response.json({bill},{status:201});
  } catch(error) {
    if (error instanceof MeterNotFoundError) return Response.json({error:error.message},{status:404});
    return utilityErrorResponse(error);
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
