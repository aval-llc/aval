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

import { and, desc, eq } from "drizzle-orm";
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
  const [row] = await dbSession.db
    .select({
      id: pmsActionFlows.id,
      version: pmsActionFlows.version,
      digest: pmsActionFlows.digest,
      stepsJson: pmsActionFlows.stepsJson,
    })
    .from(pmsActionFlows)
    .where(
      and(
        eq(pmsActionFlows.organizationId, organizationId),
        eq(pmsActionFlows.provider, providerId),
        eq(pmsActionFlows.action, action),
        eq(pmsActionFlows.status, "active"),
      ),
    )
    .orderBy(desc(pmsActionFlows.version))
    .limit(1);

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
        eq(pmsActionFlows.organizationId, organizationId),
        eq(pmsActionFlows.provider, providerId),
        eq(pmsActionFlows.status, "active"),
      ),
    );
  return new Set(rows.map((row) => row.action as PmsAction));
}

/* ── authoring ────────────────────────────────────────────────────────────── */

/**
 * Record a workflow for one (provider, action), as a candidate.
 *
 * Candidate rather than active, always. A flow drives a customer's own PMS as
 * their own user, so the act of discovering one and the act of approving it are
 * deliberately different acts by different people — `activateFlow` is the
 * second. Nothing here can produce something replayable on its own.
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
    // Stored as the canonical form the digest was taken over, so a row read
    // back and re-hashed matches rather than differing by key order.
    stepsJson: canonicalize(parsed),
    digest,
    status: "candidate",
    learnedByUserId: userId,
    lastReplayAt: null,
    lastReplayOk: null,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  });

  return { id, version, digest };
}

/**
 * Approve a candidate flow, retiring whatever it replaces.
 *
 * One active version per (provider, action) at a time: `activeFlow` takes the
 * highest active version, and two active versions would make which one runs a
 * matter of ordering rather than of somebody's decision.
 */
export async function activateFlow(
  dbSession: DbSession,
  organizationId: string,
  flowId: string,
): Promise<boolean> {
  const [candidate] = await dbSession.db
    .select({ provider: pmsActionFlows.provider, action: pmsActionFlows.action, status: pmsActionFlows.status })
    .from(pmsActionFlows)
    .where(and(eq(pmsActionFlows.organizationId, organizationId), eq(pmsActionFlows.id, flowId)))
    .limit(1);
  if (!candidate || candidate.status === "retired") return false;

  const now = new Date();
  await dbSession.db
    .update(pmsActionFlows)
    .set({ status: "retired", updatedAt: now })
    .where(
      and(
        eq(pmsActionFlows.organizationId, organizationId),
        eq(pmsActionFlows.provider, candidate.provider),
        eq(pmsActionFlows.action, candidate.action),
        eq(pmsActionFlows.status, "active"),
      ),
    );

  // Reported from what the database did, not from having asked. An update that
  // row-level security declined returns no rows, and a caller told "approved"
  // about a flow that is still a candidate would queue writes against a path
  // that cannot run.
  const activated = await dbSession.db
    .update(pmsActionFlows)
    .set({ status: "active", updatedAt: now })
    .where(and(eq(pmsActionFlows.organizationId, organizationId), eq(pmsActionFlows.id, flowId)))
    .returning({ id: pmsActionFlows.id });

  return activated.length > 0;
}

/** Take a flow out of service without deleting the record of what it was. */
export async function retireFlow(dbSession: DbSession, organizationId: string, flowId: string): Promise<boolean> {
  const updated = await dbSession.db
    .update(pmsActionFlows)
    .set({ status: "retired", updatedAt: new Date() })
    .where(and(eq(pmsActionFlows.organizationId, organizationId), eq(pmsActionFlows.id, flowId)))
    .returning({ id: pmsActionFlows.id });
  return updated.length > 0;
}
