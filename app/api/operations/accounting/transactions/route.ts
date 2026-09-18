import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET  /api/operations/accounting/transactions — posted amounts.
 * POST /api/operations/accounting/transactions — post one.
 *
 * A reporting ledger, not double-entry bookkeeping: one row per posted amount,
 * positive in its account's own natural direction. Aval reads books it does
 * not keep, and modeling debits and credits would imply it could be someone's
 * system of record.
 */

import { ensureOrganization } from "@/lib/integrations/organizations";
import { getApiIdentity } from "@/lib/integrations/session";
import { listGlTransactions, postGlTransaction } from "@/lib/operations/accounting";
import { operationsErrorResponse } from "@/lib/operations/errors";
import { optionalString, readJsonBody, requireCents, requireDate, requireString } from "@/lib/operations/validation";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const url = new URL(request.url);
  const transactions = await listGlTransactions(dbSession, identity.organizationId, {
    propertyId: url.searchParams.get("propertyId") ?? undefined,
    accountId: url.searchParams.get("accountId") ?? undefined,
  });
  return Response.json({ transactions });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  try {
    const body = await readJsonBody(request);
    const transaction = await postGlTransaction(dbSession, identity.organizationId, {
      accountId: requireString(body, "accountId", 64),
      propertyId: optionalString(body, "propertyId", 64),
      // Negative is allowed here and only here: a credit note or a reversal
      // against an income or expense account is a real posting, and rejecting
      // it would force callers to fake a second account to express a refund.
      amountCents: requireCents(body, "amountCents", { allowNegative: true }),
      postedAt: requireDate(body, "postedAt"),
      memo: optionalString(body, "memo", 300),
    });
    return Response.json({ transaction }, { status: 201 });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
