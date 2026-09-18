import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET  /api/operations/accounting/accounts — the chart of accounts.
 * POST /api/operations/accounting/accounts — add an account, or seed a default chart.
 *
 * `isTrustAccount` is only ever set by the caller, never inferred from an
 * account's name. Guessing "is this client money" from a label is how deposits
 * end up reported as operating income.
 */

import { ensureOrganization } from "@/lib/integrations/organizations";
import { getApiIdentity } from "@/lib/integrations/session";
import { createGlAccount, listGlAccounts, seedDefaultChartOfAccounts } from "@/lib/operations/accounting";
import { operationsErrorResponse } from "@/lib/operations/errors";
import { GL_ACCOUNT_TYPES } from "@/lib/operations/types";
import { optionalBoolean, readJsonBody, requireEnum, requireString } from "@/lib/operations/validation";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  return Response.json({ accounts: await listGlAccounts(dbSession, identity.organizationId) });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  try {
    const body = await readJsonBody(request);
    if (body.seedDefaults === true) {
      // No-ops when a chart already exists, so calling this twice cannot
      // duplicate a workspace's accounts or overwrite a synced chart.
      return Response.json({ accounts: await seedDefaultChartOfAccounts(dbSession, identity.organizationId) }, { status: 201 });
    }

    const account = await createGlAccount(dbSession, identity.organizationId, {
      code: requireString(body, "code", 20),
      name: requireString(body, "name", 120),
      accountType: requireEnum(body, "accountType", GL_ACCOUNT_TYPES),
      isTrustAccount: optionalBoolean(body, "isTrustAccount"),
    });
    return Response.json({ account }, { status: 201 });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
