/**
 * Does an executable path exist for (provider, action)? — the `unlearned` state.
 *
 * Two mechanisms, one question. For a `ui` provider the path is a recorded flow
 * in `pms_action_flows`, discovered once and replayed thereafter. For an `api`
 * provider it is a registered adapter in code. Either way the operator-facing
 * answer is the same shape: everything permits this, and Aval has not built it
 * yet. That is our backlog, not a policy refusal, and the settings matrix says
 * so in different words with a different owner.
 */

import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { pmsActionFlows } from "@/db/postgres/schema";
import type { PmsAction } from "./types.ts";
import { canonicalize } from "../agents/canonical-payload.ts";
import { flowDigest, parseFlowSteps } from "./browser/steps.ts";

/** An adapter that performs one action against one provider's API. */
export type WriteAdapter = (dbSession: DbSession, input: {
  organizationId: string;
  providerId: string;
  action: PmsAction;
  payload: unknown;
}) => Promise<{ ok: true; externalId?: string } | { ok: false; error: string }>;

const ADAPTERS = new Map<string, WriteAdapter>();

function adapterKey(providerId: string, action: PmsAction): string {
  return `${providerId}:${action}`;
}

export function registerWriteAdapter(providerId: string, action: PmsAction, adapter: WriteAdapter): void {
  ADAPTERS.set(adapterKey(providerId, action), adapter);
}

export function writeAdapter(providerId: string, action: PmsAction): WriteAdapter | undefined {
  return ADAPTERS.get(adapterKey(providerId, action));
}

export function hasWriteAdapter(providerId: string, action: PmsAction): boolean {
  return ADAPTERS.has(adapterKey(providerId, action));
}

export interface ActiveFlow {
  id: string;
  version: number;
  digest: string;
  steps: unknown;
}

/**
 * The newest `active` flow for this org, provider and action.
 *
 * `candidate` rows are excluded: a flow the agent proposed but nobody approved
 * is not a path, and treating it as one would let discovery enable itself. A
 * retired row is excluded for the same reason it is kept — history, not use.
 */
export async function activeFlow(
  dbSession: DbSession,
  organizationId: string,
  providerId: string,
  action: PmsAction,
): Promise<ActiveFlow | null> {
  const rows = await dbSession.db
    .select({
      id: pmsActionFlows.id,
      organizationId: pmsActionFlows.organizationId,
      version: pmsActionFlows.version,
      digest: pmsActionFlows.digest,
      stepsJson: pmsActionFlows.stepsJson,
    })
    .from(pmsActionFlows)
    .where(
      and(
        or(isNull(pmsActionFlows.organizationId), eq(pmsActionFlows.organizationId, organizationId)),
        eq(pmsActionFlows.provider, providerId),
        eq(pmsActionFlows.action, action),
        eq(pmsActionFlows.status, "active"),
      ),
    )
    .orderBy(desc(pmsActionFlows.version));

  // A workspace's own version wins over the one Aval ships, whatever the
  // version numbers say. The two are separate lineages: a customer on version 1
  // of their own flow has deliberately departed from the shipped one, and
  // silently preferring a higher shipped number would undo that decision.
  const row = rows.find((candidate) => candidate.organizationId !== null) ?? rows[0];
  if (!row) return null;
  try {
    return { id: row.id, version: row.version, digest: row.digest, steps: JSON.parse(row.stepsJson) };
  } catch {
    // A flow whose steps will not parse is not a flow. Reporting null sends the
    // action back to exploration rather than replaying something unreadable.
    return null;
  }
}

/**
 * Whether a path exists, without loading it.
 *
 * Kept separate from `activeFlow` because the resolver runs on every registry
 * assembly and only needs the boolean; pulling step JSON for fourteen actions to
 * answer "is this learned" would make tool assembly quadratic in flow size.
 */
export async function hasExecutablePath(
  dbSession: DbSession,
  organizationId: string,
  providerId: string,
  action: PmsAction,
  mechanism: "api" | "ui",
): Promise<boolean> {
  if (mechanism === "api") return hasWriteAdapter(providerId, action);
  const [row] = await dbSession.db
    .select({ id: pmsActionFlows.id })
    .from(pmsActionFlows)
    .where(
      and(
        eq(pmsActionFlows.organizationId, organizationId),
        eq(pmsActionFlows.provider, providerId),
        eq(pmsActionFlows.action, action),
        eq(pmsActionFlows.status, "active"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Every action that has an active flow for this org and provider, in one query.
 *
 * The settings matrix and the per-request registry assembly both need this for
 * all fourteen actions at once; calling `hasExecutablePath` in a loop would put
 * fourteen round-trips on the hot path of every agent turn.
 */
export async function learnedFlowActions(dbSession: DbSession, organizationId: string, providerId: string): Promise<ReadonlySet<PmsAction>> {
  const rows = await dbSession.db
    .select({ action: pmsActionFlows.action })
    .from(pmsActionFlows)
    .where(
      and(
        or(isNull(pmsActionFlows.organizationId), eq(pmsActionFlows.organizationId, organizationId)),
        eq(pmsActionFlows.provider, providerId),
        eq(pmsActionFlows.status, "active"),
      ),
    );
  return new Set(rows.map((row) => row.action as PmsAction));
}

/* ── authoring and lifecycle ──────────────────────────────────────────────── */

/**
 * Where a workflow is in its life.
 *
 * `degraded` and `disabled` are deliberately not the same state. One is a thing
 * that happened — the provider moved its screen and a replay broke — and the
 * other is a decision somebody made. Collapsing them would lose the difference
 * between "this stopped working, look at it" and "we turned this off".
 */
export const WORKFLOW_STATUSES = ["draft", "testing", "active", "degraded", "disabled"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/**
 * How far a workflow has actually been proven. Never how far we hope.
 *
 * Ordered, so a surface can render progress, and separate from `status`
 * because they answer different questions: certification is what has been
 * demonstrated, status is whether it may run.
 */
export const CERTIFICATIONS = [
  "unimplemented", "unit_tested", "simulator_e2e_tested",
  "customer_authorized_ui_tested", "sandbox_tested", "live_provider_tested",
] as const;
export type Certification = (typeof CERTIFICATIONS)[number];

/**
 * Which transitions are allowed, as an explicit table.
 *
 * A closed table rather than a set of `if`s, because the interesting property
 * is what is *absent*: nothing reaches `active` except from `testing`. A
 * workflow cannot go from somebody's draft straight into driving a customer's
 * PMS, and the way to be sure of that is to be unable to write it.
 */
const TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  draft: ["testing", "disabled"],
  testing: ["active", "draft", "disabled"],
  // A live workflow can degrade on its own, or be taken out by a person.
  active: ["degraded", "disabled"],
  // Degraded goes back for work; it never returns straight to service.
  degraded: ["testing", "disabled"],
  disabled: ["draft"],
};

export function transitionAllowed(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export interface WorkflowMetadata {
  accessMode?: string;
  requiredRole?: string | null;
  riskClass?: "low" | "medium" | "high" | "critical";
  verificationStrategy?: "read_after_write" | "external_id_lookup" | "none";
  reconciliationStrategy?: "external_id" | "field_match" | "none";
  fallback?: "email" | "human_handoff" | "aval_native" | "none";
  certification?: Certification;
  knownIssues?: string | null;
}

/**
 * Record a workflow for one (provider, action) in this workspace, as a draft.
 *
 * Draft rather than active, always. A workflow drives a customer's own PMS as
 * their own user, so discovering one and putting it into service are
 * deliberately different acts — `promoteFlow` is the second, and it will not go
 * straight there. Nothing here can produce something replayable on its own.
 *
 * Versions accumulate rather than overwrite. A provider that changes its UI
 * gets a new version beside the old one, so a flow that stops working can be
 * compared against the one that did work rather than being lost to the edit
 * that replaced it.
 */
export async function recordFlow(
  dbSession: DbSession,
  organizationId: string,
  providerId: string,
  action: PmsAction,
  steps: unknown,
  userId: string,
  metadata: WorkflowMetadata = {},
): Promise<{ id: string; version: number; digest: string }> {
  const parsed = parseFlowSteps(steps);
  const digest = await flowDigest(parsed);

  const [latest] = await dbSession.db
    .select({ version: pmsActionFlows.version })
    .from(pmsActionFlows)
    .where(
      and(
        eq(pmsActionFlows.organizationId, organizationId),
        eq(pmsActionFlows.provider, providerId),
        eq(pmsActionFlows.action, action),
      ),
    )
    .orderBy(desc(pmsActionFlows.version))
    .limit(1);

  const version = (latest?.version ?? 0) + 1;
  const id = crypto.randomUUID();
  const now = new Date();

  await dbSession.db.insert(pmsActionFlows).values({
    id,
    organizationId,
    provider: providerId,
    action,
    version,
    accessMode: metadata.accessMode ?? "customer_desktop_session",
    // Stored as the canonical form the digest was taken over, so a row read
    // back and re-hashed matches rather than differing by key order.
    stepsJson: canonicalize(parsed),
    digest,
    status: "draft",
    requiredRole: metadata.requiredRole ?? null,
    riskClass: metadata.riskClass ?? "medium",
    verificationStrategy: metadata.verificationStrategy ?? "read_after_write",
    reconciliationStrategy: metadata.reconciliationStrategy ?? "field_match",
    fallback: metadata.fallback ?? "human_handoff",
    // A workflow nobody has exercised claims nothing.
    certification: metadata.certification ?? "unimplemented",
    learnedByUserId: userId,
    promotedByUserId: null,
    promotedAt: null,
    lastReplayAt: null,
    lastReplayOk: null,
    consecutiveFailures: 0,
    knownIssues: metadata.knownIssues ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return { id, version, digest };
}

export type PromotionResult =
  | { ok: true; status: WorkflowStatus; retired: number }
  | { ok: false; reason: string };

/**
 * Move a workflow along its lifecycle.
 *
 * The one act in this file that changes what a customer's PMS will be driven
 * with, so three things are checked rather than assumed. The transition has to
 * be one the table allows. The workflow has to belong to this workspace —
 * shipped workflows are seeded and read-only at runtime, and promoting one is a
 * deployment rather than a request. And activation names its author, which the
 * database also insists on: a row cannot be `active` with no promoter.
 *
 * Activating retires whatever it replaces, because `activeFlow` takes the
 * active row and two of them would make which one runs a matter of ordering
 * rather than of somebody's decision.
 */
export async function promoteFlow(
  dbSession: DbSession,
  organizationId: string,
  flowId: string,
  userId: string,
  to: WorkflowStatus,
): Promise<PromotionResult> {
  const [flow] = await dbSession.db
    .select({
      organizationId: pmsActionFlows.organizationId,
      provider: pmsActionFlows.provider,
      action: pmsActionFlows.action,
      status: pmsActionFlows.status,
      certification: pmsActionFlows.certification,
    })
    .from(pmsActionFlows)
    .where(eq(pmsActionFlows.id, flowId))
    .limit(1);

  if (!flow) return { ok: false, reason: "No such workflow." };
  if (flow.organizationId === null) {
    return { ok: false, reason: "Workflows Aval ships are changed by deployment, not at runtime." };
  }
  if (flow.organizationId !== organizationId) return { ok: false, reason: "No such workflow." };

  const from = flow.status as WorkflowStatus;
  if (from === to) return { ok: true, status: to, retired: 0 };
  if (!transitionAllowed(from, to)) {
    return {
      ok: false,
      reason: to === "active" && from !== "testing"
        // Named specifically, because this is the transition somebody will try
        // to take and the generic message would not say why it is refused.
        ? "A workflow reaches service through testing. Move it to testing and exercise it first."
        : `A ${from} workflow cannot become ${to}.`,
    };
  }
  if (to === "active" && flow.certification === "unimplemented") {
    return { ok: false, reason: "A workflow that has never been exercised cannot be put into service." };
  }

  const now = new Date();
  let retired = 0;
  if (to === "active") {
    const previous = await dbSession.db
      .update(pmsActionFlows)
      .set({ status: "disabled", updatedAt: now })
      .where(
        and(
          eq(pmsActionFlows.organizationId, organizationId),
          eq(pmsActionFlows.provider, flow.provider),
          eq(pmsActionFlows.action, flow.action),
          eq(pmsActionFlows.status, "active"),
        ),
      )
      .returning({ id: pmsActionFlows.id });
    retired = previous.length;
  }

  const updated = await dbSession.db
    .update(pmsActionFlows)
    .set({
      status: to,
      ...(to === "active" ? { promotedByUserId: userId, promotedAt: now } : {}),
      updatedAt: now,
    })
    .where(and(eq(pmsActionFlows.organizationId, organizationId), eq(pmsActionFlows.id, flowId)))
    .returning({ id: pmsActionFlows.id });

  // Reported from what the database did, not from having asked. An update
  // row-level security declined returns nothing, and a caller told "promoted"
  // about a workflow still sitting in draft would queue writes against a path
  // that cannot run.
  return updated.length > 0
    ? { ok: true, status: to, retired }
    : { ok: false, reason: "This workflow could not be changed by this account." };
}

export interface WorkflowSummary {
  id: string;
  organizationId: string | null;
  provider: string;
  action: string;
  version: number;
  accessMode: string;
  status: WorkflowStatus;
  certification: Certification;
  riskClass: string;
  requiredRole: string | null;
  verificationStrategy: string;
  reconciliationStrategy: string;
  fallback: string;
  knownIssues: string | null;
  lastReplayAt: Date | null;
  lastReplayOk: boolean | null;
  consecutiveFailures: number;
  promotedByUserId: string | null;
  promotedAt: Date | null;
  /** True for a workflow Aval ships, which this workspace may use but not edit. */
  shipped: boolean;
}

/** Every workflow this workspace can see: its own, and the ones Aval ships. */
export async function listWorkflows(
  dbSession: DbSession,
  organizationId: string,
  providerId?: string,
): Promise<WorkflowSummary[]> {
  const rows = await dbSession.db
    .select()
    .from(pmsActionFlows)
    .where(
      and(
        or(isNull(pmsActionFlows.organizationId), eq(pmsActionFlows.organizationId, organizationId)),
        ...(providerId ? [eq(pmsActionFlows.provider, providerId)] : []),
      ),
    );

  return rows
    .map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      provider: row.provider,
      action: row.action,
      version: row.version,
      accessMode: row.accessMode,
      status: row.status as WorkflowStatus,
      certification: row.certification as Certification,
      riskClass: row.riskClass,
      requiredRole: row.requiredRole,
      verificationStrategy: row.verificationStrategy,
      reconciliationStrategy: row.reconciliationStrategy,
      fallback: row.fallback,
      knownIssues: row.knownIssues,
      lastReplayAt: row.lastReplayAt,
      lastReplayOk: row.lastReplayOk,
      consecutiveFailures: row.consecutiveFailures,
      promotedByUserId: row.promotedByUserId,
      promotedAt: row.promotedAt,
      shipped: row.organizationId === null,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider)
      || a.action.localeCompare(b.action)
      || b.version - a.version);
}
