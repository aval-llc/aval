/**
 * What this workspace has turned on — the fourth layer.
 *
 * A row in `pms_write_authorizations` is the only thing that makes `enabled`
 * true, and the only thing that can satisfy a descriptor's
 * `override: 'signed_authorization'`. Absence reads as `off`, never as
 * permitted: a workspace that has never been asked has not consented.
 */

import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { pmsWriteAuthorizations } from "@/db/postgres/schema";
import { ABSENT_ENABLEMENT, enablementFor, type Enablement, type PmsAction } from "./types.ts";

export async function readEnablement(
  dbSession: DbSession,
  organizationId: string,
  providerId: string,
  action: PmsAction,
): Promise<Enablement> {
  const [row] = await dbSession.db
    .select()
    .from(pmsWriteAuthorizations)
    .where(
      and(
        eq(pmsWriteAuthorizations.organizationId, organizationId),
        eq(pmsWriteAuthorizations.provider, providerId),
        eq(pmsWriteAuthorizations.action, action),
      ),
    )
    .limit(1);

  if (!row) return ABSENT_ENABLEMENT;

  const status = row.status === "approved" || row.status === "suspended" ? row.status : "draft";
  return {
    // Only `approved` enables. A draft is someone mid-conversation, and a
    // suspended row is a revocation that deliberately keeps its own history.
    enabled: status === "approved",
    // An unapproved row cannot carry a valid signature, whatever the column says:
    // the approver's identity is the control, so it has to be present to count.
    signedAuthorization: status === "approved" && row.signedAuthorization === true && Boolean(row.approvedByUserId),
    approvedByUserId: row.approvedByUserId ?? null,
    approvedAt: row.approvedAt ?? null,
    status,
    authorizationReference: row.authorizationReference ?? null,
  };
}

/** Every authorization row for an org, for the settings matrix to render in one query. */
export async function readAllEnablements(dbSession: DbSession, organizationId: string): Promise<Map<string, Enablement>> {
  const rows = await dbSession.db
    .select()
    .from(pmsWriteAuthorizations)
    .where(eq(pmsWriteAuthorizations.organizationId, organizationId));

  const byKey = new Map<string, Enablement>();
  for (const row of rows) {
    const status = row.status === "approved" || row.status === "suspended" ? row.status : "draft";
    byKey.set(`${row.provider}:${row.action}`, {
      enabled: status === "approved",
      signedAuthorization: status === "approved" && row.signedAuthorization === true && Boolean(row.approvedByUserId),
      approvedByUserId: row.approvedByUserId ?? null,
      approvedAt: row.approvedAt ?? null,
      status,
      authorizationReference: row.authorizationReference ?? null,
    });
  }
  return byKey;
}


export { enablementFor };
export type { Enablement };
