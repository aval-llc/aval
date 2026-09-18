import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { appendAuditEvents } from "@/lib/audit/log";
import { digestPayload } from "@/lib/audit/chain";
import { approveFinancialPolicy, canManageFinancialPolicy, getFinancialPolicy, suspendFinancialPolicy } from "@/lib/agents/execution-policy";

const CONFIRMATION = "APPROVE FINANCIAL POLICY";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  if (isGuestIdentity(identity) || !(await canManageFinancialPolicy(dbSession, identity.organizationId, identity.userId))) {
    return Response.json({ error: "Workspace owner access required" }, { status: 403 });
  }
  return Response.json({ policy: present(await getFinancialPolicy(dbSession, identity.organizationId)) }, { headers: { "cache-control": "no-store" } });
}

async function PUTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  if (isGuestIdentity(identity) || !(await canManageFinancialPolicy(dbSession, identity.organizationId, identity.userId))) {
    return Response.json({ error: "Workspace owner access required" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.confirmation !== CONFIRMATION) {
    return Response.json({ error: `Explicit confirmation is required: ${CONFIRMATION}` }, { status: 400 });
  }
  const result = await approveFinancialPolicy(dbSession, identity.organizationId, identity.userId, {
    singleApprovalMaxCents: body.singleApprovalMaxCents as number,
    hardCeilingCents: body.hardCeilingCents as number,
    dailyLimitCents: body.dailyLimitCents as number,
    allowedCurrencies: Array.isArray(body.allowedCurrencies) ? body.allowedCurrencies.filter((value): value is string => typeof value === "string") : [],
    allowedAccountIds: Array.isArray(body.allowedAccountIds) ? body.allowedAccountIds.filter((value): value is string => typeof value === "string") : [],
  });
  if (!result.ok) return Response.json({ error: result.reason }, { status: 400 });
  await appendAuditEvents(dbSession, identity.organizationId, [{
    kind: "policy_decision",
    label: `financial_policy:v${result.policy.version}:approved`,
    payloadDigest: await digestPayload(present(result.policy)),
    count: result.policy.version,
  }]);
  return Response.json({ policy: present(result.policy) }, { headers: { "cache-control": "no-store" } });
}

async function DELETEWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  if (isGuestIdentity(identity) || !(await canManageFinancialPolicy(dbSession, identity.organizationId, identity.userId))) {
    return Response.json({ error: "Workspace owner access required" }, { status: 403 });
  }
  await suspendFinancialPolicy(dbSession, identity.organizationId);
  await appendAuditEvents(dbSession, identity.organizationId, [{ kind: "policy_decision", label: "financial_policy:suspended", payloadDigest: await digestPayload(identity.organizationId), count: 0 }]);
  return Response.json({ status: "suspended" }, { headers: { "cache-control": "no-store" } });
}

function present(policy: Awaited<ReturnType<typeof getFinancialPolicy>>) {
  return {
    status: policy.status,
    singleApprovalMaxCents: policy.singleApprovalMaxCents,
    hardCeilingCents: policy.hardCeilingCents,
    dailyLimitCents: policy.dailyLimitCents,
    allowedCurrencies: policy.allowedCurrencies,
    allowedAccountCount: policy.allowedAccountFingerprints.length,
    version: policy.version,
    approvedByUserId: policy.approvedByUserId,
    approvedAt: policy.approvedAt,
    updatedAt: policy.updatedAt,
    invariant: "Every payment, lease, destructive action, permission change, and external communication requires human approval.",
  };
}

export const GET = withApiSession(GETWithSession);
export const PUT = withApiSession(PUTWithSession);
export const DELETE = withApiSession(DELETEWithSession);
