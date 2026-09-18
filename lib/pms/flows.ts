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
