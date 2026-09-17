import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * POST /api/operations/import — load a batch of operations records.
 *
 * The ingestion path the operations tables shipped without. `POST /api/sync`
 * queues a `sync_runs` row and says the work is "queued for the provider
 * worker"; there is no provider worker, and the PMS APIs that would feed one
 * are mostly gated behind partner programs. This is the endpoint every
 * connector will eventually funnel into, and it is useful before any of them
 * exist: a workspace can load its portfolio from a spreadsheet export today.
 *
 * `dryRun` plans without writing, so an operator can see exactly what a batch
 * would do — and which rows it would refuse — before committing to it. Worth
 * having because the answer is frequently "most of it, and here are the eleven
 * rows whose property id doesn't exist", which is a thing you want to learn
 * before a partial import, not after.
 */

import { ensureOrganization } from "@/lib/integrations/organizations";
import { getApiIdentity } from "@/lib/integrations/session";
import { applyImport } from "@/lib/operations/import-apply";
import { plannedRowCount, planImport, type ImportBatch } from "@/lib/operations/import-plan";
import { operationsErrorResponse } from "@/lib/operations/errors";
import { MANUAL_SOURCE } from "@/lib/operations/types";
import { readJsonBody } from "@/lib/operations/validation";

/**
 * A ceiling on one request, not on a portfolio.
 *
 * Each row becomes at least one D1 statement, and a Worker has a wall-clock
 * budget; a 50,000-row batch would time out partway and leave the caller
 * guessing how much landed. Rejecting up front with the limit named is a
 * better failure than a truncated success.
 */
const MAX_ROWS_PER_BATCH = 2000;

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only the workspace owner can import records" }, { status: 403 });
  await ensureOrganization(dbSession, identity);

  try {
    const body = await readJsonBody(request);
    if (["sourceProvider", "sourceConnectionId", "syncRunId"].some((key) => Object.hasOwn(body, key))) {
      return Response.json({ error: "Import provenance and sync runs are assigned by the server" }, { status: 400 });
    }
    const batch = (body.batch ?? {}) as ImportBatch;
    const reserved = ["sourceProvider", "sourceConnectionId", "syncRunId", "source_provider", "source_connection_id", "sync_run_id"];
    if (Object.values(batch).some(rows => Array.isArray(rows) && rows.some(row => row && typeof row === "object" && reserved.some(key => Object.hasOwn(row, key))))) {
      return Response.json({ error: "Row provenance is assigned by the server" }, { status: 400 });
    }
    const dryRun = body.dryRun === true;

    // The provider this data came from, which becomes every row's provenance.
    // Defaults to "manual" — a spreadsheet a person exported is exactly that,
    // and labelling it with a connector's name would misattribute it.
    const sourceProvider = MANUAL_SOURCE;

    const plan = planImport(batch);
    const total = plannedRowCount(plan) + plan.skipped.length;
    if (total === 0) {
      return Response.json({ error: "The batch contained no rows" }, { status: 400 });
    }
    if (total > MAX_ROWS_PER_BATCH) {
      return Response.json(
        { error: `A batch may carry at most ${MAX_ROWS_PER_BATCH} rows; this one has ${total}. Split it and send them in order.` },
        { status: 413 },
      );
    }

    if (dryRun) {
      // Planned against an empty set of known ids, so a reference that would
      // have resolved against existing rows shows here as unresolved. Stated
      // rather than papered over: a dry run is a floor on what will apply.
      return Response.json({
        dryRun: true,
        counts: plan.counts,
        skipped: plan.skipped,
        note: "Planned without reading existing rows, so references to records already in this workspace appear unresolved here. A real import resolves them.",
      });
    }

    const result = await applyImport(dbSession,
      identity.organizationId,
      batch,
      { sourceProvider, sourceConnectionId: null, externalId: null },
    );
    return Response.json({ result }, { status: 201 });
  } catch (error) {
    return operationsErrorResponse(error);
  }
}

export const POST = withApiSession(POSTWithSession);
