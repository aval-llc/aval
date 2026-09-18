import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET  /api/operations/accounting/ledger — resident ledger entries.
 * POST /api/operations/accounting/ledger — post a charge, payment, credit or refund.
 *
 * `amountCents` is always positive; direction lives in `entryType`. A signed
 * amount would say the same thing twice and lets a sign bug turn a payment
 * into a charge with nothing to catch it.
 */

import { ensureOrganization } from "@/lib/integrations/organizations";
import { getApiIdentity } from "@/lib/integrations/session";
import { leaseBalanceCents, listLedgerEntries, postLedgerEntry } from "@/lib/operations/accounting";
import { operationsErrorResponse } from "@/lib/operations/errors";
import { LEDGER_CATEGORIES, LEDGER_ENTRY_TYPES } from "@/lib/operations/types";
import {
  optionalDate,
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
  const leaseId = url.searchParams.get("leaseId") ?? undefined;
  const entries = await listLedgerEntries(dbSession, identity.organizationId, {
    leaseId,
    propertyId: url.searchParams.get("propertyId") ?? undefined,
  });
  return Response.json({
    entries,
    // Only meaningful for a single lease — a balance across several residents
    // is a number nobody can act on, so it is omitted rather than summed.
    balanceCents: leaseId ? await leaseBalanceCents(dbSession, identity.organizationId, leaseId) : null,
  });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  try {
    const body = await readJsonBody(request);
    const entry = await postLedgerEntry(dbSession, identity.organizationId, {
      leaseId: requireString(body, "leaseId", 64),
      entryType: requireEnum(body, "entryType", LEDGER_ENTRY_TYPES),
      category: requireEnum(body, "category", LEDGER_CATEGORIES),
      amountCents: requireCents(body, "amountCents"),
      postedAt: requireDate(body, "postedAt"),
      // Charges only. A payment is not owed on a date, and inventing a due
      // date for one would put it into the aging buckets.
      dueAt: optionalDate(body, "dueAt"),
      memo: optionalString(body, "memo", 300),
    });
    return Response.json({ entry }, { status: 201 });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
