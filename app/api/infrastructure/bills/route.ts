import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { listBills, recordBill, MeterNotFoundError } from "@/lib/infrastructure/meters";
import type { UtilityType } from "@/lib/infrastructure/types";

const UTILITY_TYPES: UtilityType[] = ["electricity", "water", "gas"];
// Generous upper bounds so a malformed or malicious payload can't hand an
// unbounded number to Drizzle/D1 — a single utility bill has no legitimate
// reason to exceed a nine-figure cost or usage reading.
const MAX_USAGE_AMOUNT = 100_000_000;
const MAX_COST_CENTS = 100_000_000_00;
const MAX_EXTRACTION_NOTE_CHARS = 1000;

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

  const body = (await request.json().catch(() => ({}))) as {
    meterId?: string;
    periodStart?: string;
    periodEnd?: string;
    usageAmount?: number;
    costCents?: number;
    currency?: string;
    extractionConfidence?: string;
    extractionNote?: string;
  };

  if (typeof body.meterId !== "string" || !body.meterId) return Response.json({ error: "meterId is required" }, { status: 400 });
  const periodStart = new Date(body.periodStart ?? "");
  const periodEnd = new Date(body.periodEnd ?? "");
  if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime()) || periodEnd <= periodStart) {
    return Response.json({ error: "periodStart and periodEnd must be valid dates with periodEnd after periodStart" }, { status: 400 });
  }
  if (typeof body.usageAmount !== "number" || !Number.isFinite(body.usageAmount) || body.usageAmount < 0 || body.usageAmount > MAX_USAGE_AMOUNT) {
    return Response.json({ error: `usageAmount must be a non-negative number no greater than ${MAX_USAGE_AMOUNT}` }, { status: 400 });
  }
  if (typeof body.costCents !== "number" || !Number.isFinite(body.costCents) || body.costCents < 0 || body.costCents > MAX_COST_CENTS) {
    return Response.json({ error: `costCents must be a non-negative number no greater than ${MAX_COST_CENTS}` }, { status: 400 });
  }
  const currency = body.currency === "MXN" ? "MXN" : "USD";

  try {
    // A row created through this route was reviewed and submitted by a
    // person, even when its fields were pre-filled from an /extract call —
    // "ai_extracted" is reserved for a row saved automatically, which this
    // app doesn't do yet (see bill-extraction.ts's doc comment).
    const bill = await recordBill(dbSession, identity.organizationId, {
      meterId: body.meterId,
      periodStart,
      periodEnd,
      usageAmount: body.usageAmount,
      costCents: Math.round(body.costCents),
      currency,
      source: "manual",
      extractionConfidence: body.extractionConfidence === "low" || body.extractionConfidence === "high" ? body.extractionConfidence : undefined,
      extractionNote: body.extractionNote?.trim().slice(0, MAX_EXTRACTION_NOTE_CHARS) || undefined,
    });
    return Response.json({ bill }, { status: 201 });
  } catch (err) {
    if (err instanceof MeterNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    throw err;
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
