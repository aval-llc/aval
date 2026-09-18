/**
 * Workspace-owned financial policy.
 *
 * The model never sees or edits this record. A workspace owner must publish a
 * policy explicitly, and every financial proposal is checked against the
 * current version both when approval is requested and immediately before the
 * side effect. Changing or suspending policy therefore invalidates stale
 * authority without rewriting an approval row.
 */

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { accessGrants, agentExecutionPolicies, agentFinancialOperations } from "@/db/postgres/schema";
import {
  DEFAULT_FINANCIAL_POLICY,
  approvalTierFor,
  requiredApprovalsFor,
  validateFinancialArguments,
  validatePolicy,
  withinDailyLimit,
  type ApprovalTier,
  type FinancialPolicy,
} from "./financial.ts";
import type { ToolDescriptor } from "./registry.ts";

export interface FinancialPolicyRecord extends FinancialPolicy {
  organizationId: string;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyDraft {
  singleApprovalMaxCents: number;
  hardCeilingCents: number;
  dailyLimitCents: number;
  allowedCurrencies: string[];
  /** Raw provider account ids are accepted only at this write boundary. */
  allowedAccountIds: string[];
}

export async function canManageFinancialPolicy(dbSession: DbSession, organizationId: string, userId: string): Promise<boolean> {
  const [row] = await dbSession.db
    .select({ id: accessGrants.id })
    .from(accessGrants)
    .where(and(
      eq(accessGrants.organizationId, organizationId),
      eq(accessGrants.principalId, userId),
      eq(accessGrants.role, "org_admin"),
      eq(accessGrants.organizationScope, true),
      isNull(accessGrants.revokedAt),
      or(isNull(accessGrants.expiresAt), gt(accessGrants.expiresAt, new Date())),
    ))
    .limit(1);
  return row !== undefined;
}

export async function getFinancialPolicy(dbSession: DbSession, organizationId: string): Promise<FinancialPolicyRecord> {
  const [row] = await dbSession.db
    .select()
    .from(agentExecutionPolicies)
    .where(eq(agentExecutionPolicies.organizationId, organizationId))
    .limit(1);
  const now = new Date(0);
  if (!row) {
    return {
      organizationId,
      ...DEFAULT_FINANCIAL_POLICY,
      approvedByUserId: null,
      approvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }
  return {
    organizationId: row.organizationId,
    status: asStatus(row.status),
    singleApprovalMaxCents: row.singleApprovalMaxCents,
    hardCeilingCents: row.hardCeilingCents,
    dailyLimitCents: row.dailyLimitCents,
    allowedCurrencies: parseStringArray(row.allowedCurrenciesJson),
    allowedAccountFingerprints: parseStringArray(row.allowedAccountFingerprintsJson),
    version: row.version,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Publish a new, owner-approved policy version. No draft silently becomes active. */
export async function approveFinancialPolicy(dbSession: DbSession,
  organizationId: string,
  administratorUserId: string,
  draft: PolicyDraft
): Promise<{ ok: true; policy: FinancialPolicyRecord } | { ok: false; reason: string }> {
  const normalized = {
    singleApprovalMaxCents: draft.singleApprovalMaxCents,
    hardCeilingCents: draft.hardCeilingCents,
    dailyLimitCents: draft.dailyLimitCents,
    allowedCurrencies: [...new Set(draft.allowedCurrencies.map((code) => code.trim().toUpperCase()))].sort(),
  };
  const problem = validatePolicy(normalized);
  if (problem) return { ok: false, reason: problem };
  const accountIds = [...new Set(draft.allowedAccountIds.map((id) => id.trim()).filter(Boolean))];
  if (accountIds.length === 0 || accountIds.some((id) => id.length > 200)) {
    return { ok: false, reason: "At least one provider account must be allowlisted." };
  }

  const current = await getFinancialPolicy(dbSession, organizationId);
  const now = new Date();
  const accountFingerprints = await Promise.all(accountIds.map(fingerprintAccount));
  await dbSession.db.insert(agentExecutionPolicies).values({
    organizationId,
    status: "approved",
    singleApprovalMaxCents: normalized.singleApprovalMaxCents,
    hardCeilingCents: normalized.hardCeilingCents,
    dailyLimitCents: normalized.dailyLimitCents,
    allowedCurrenciesJson: JSON.stringify(normalized.allowedCurrencies),
    allowedAccountFingerprintsJson: JSON.stringify(accountFingerprints),
    version: current.version + 1,
    approvedByUserId: administratorUserId,
    approvedAt: now,
    createdAt: current.createdAt.getTime() === 0 ? now : current.createdAt,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: agentExecutionPolicies.organizationId,
    set: {
      status: "approved",
      singleApprovalMaxCents: normalized.singleApprovalMaxCents,
      hardCeilingCents: normalized.hardCeilingCents,
      dailyLimitCents: normalized.dailyLimitCents,
      allowedCurrenciesJson: JSON.stringify(normalized.allowedCurrencies),
      allowedAccountFingerprintsJson: JSON.stringify(accountFingerprints),
      version: current.version + 1,
      approvedByUserId: administratorUserId,
      approvedAt: now,
      updatedAt: now,
    },
  });
  return { ok: true, policy: await getFinancialPolicy(dbSession, organizationId) };
}

export async function suspendFinancialPolicy(dbSession: DbSession, organizationId: string): Promise<void> {
  await dbSession.db.update(agentExecutionPolicies).set({
    status: "suspended",
    approvedByUserId: null,
    approvedAt: null,
    updatedAt: new Date(),
  }).where(eq(agentExecutionPolicies.organizationId, organizationId));
}

export type FinancialProposalDecision =
  | { ok: true; policy: FinancialPolicyRecord; tier: Exclude<ApprovalTier, "automatic" | "refused">; requiredApprovals: number; accountFingerprint: string; amountCents: number; currency: string }
  | { ok: false; reason: string };

/** Deterministic, storage-backed evaluation used at proposal and execution time. */
export async function evaluateFinancialProposal(dbSession: DbSession,
  organizationId: string,
  tool: ToolDescriptor,
  args: Record<string, unknown>,
): Promise<FinancialProposalDecision> {
  if (!tool.financial) return { ok: false, reason: `Tool "${tool.name}" has no financial contract.` };
  const policy = await getFinancialPolicy(dbSession, organizationId);
  if (policy.status !== "approved" || !policy.approvedByUserId || !policy.approvedAt) {
    return { ok: false, reason: "This workspace has no active, owner-approved financial policy." };
  }
  const problem = validateFinancialArguments(tool, args, policy);
  if (problem) return { ok: false, reason: problem };

  const amountCents = args[tool.financial.amountField] as number;
  const currency = args[tool.financial.currencyField] as string;
  const accountFingerprint = await fingerprintAccount(args[tool.financial.accountField] as string);
  if (!policy.allowedAccountFingerprints.includes(accountFingerprint)) {
    return { ok: false, reason: "The proposed destination is not on the workspace financial allowlist." };
  }

  const committed = await committedFinancialSpendCents(dbSession, organizationId);
  const daily = withinDailyLimit(committed, amountCents, policy.dailyLimitCents);
  if (!daily.ok) return { ok: false, reason: daily.reason ?? "The rolling daily limit would be exceeded." };

  const tier = approvalTierFor(amountCents, policy);
  if (tier === "refused" || tier === "automatic") return { ok: false, reason: "The proposal does not map to a permitted human-approval tier." };
  return { ok: true, policy, tier: tier as Exclude<ApprovalTier, "automatic" | "refused">, requiredApprovals: requiredApprovalsFor(tier), accountFingerprint, amountCents, currency };
}

export async function committedFinancialSpendCents(dbSession: DbSession, organizationId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [row] = await dbSession.db.select({ total: sql<number>`coalesce(sum(${agentFinancialOperations.amountCents}), 0)` })
    .from(agentFinancialOperations)
    .where(and(
      eq(agentFinancialOperations.organizationId, organizationId),
      gt(agentFinancialOperations.createdAt, since),
      inArray(agentFinancialOperations.status, ["reserved", "submitted", "settled", "unknown"]),
    ));
  return Number(row?.total ?? 0);
}

export async function fingerprintAccount(accountId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountId.trim())));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseStringArray(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function asStatus(value: string): FinancialPolicy["status"] {
  return value === "approved" || value === "suspended" ? value : "draft";
}
