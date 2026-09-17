import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { glAccounts, glTransactions, integrationConnections, integrationSyncState, syncRuns } from "@/db/postgres/schema";
import { applyImport } from "@/lib/operations/import-apply";
import type { GlAccountType } from "@/lib/operations/types";
import { fetchQuickbooksPage, quickbooksClient, syncCursor } from "./quickbooks";
import { normalizeQuickbooks } from "./quickbooks-rules";
import { ProviderHttpError } from "./http";
import type { IntegrationEnv } from "./oauth";
import { buildiumCursor, fetchBuildiumPage } from "./buildium";
import { decryptSecret } from "./crypto";

export const AUTOMATIC_IMPORT_PROVIDERS: ReadonlySet<string> = new Set(["quickbooks", "buildium"]);
const INTERVAL_MS = 15 * 60_000;
const LEASE_MS = 5 * 60_000;
const freeLease = (now: Date) => or(isNull(integrationSyncState.leaseExpiresAt), lte(integrationSyncState.leaseExpiresAt, now));

export async function scheduleImport(dbSession: DbSession, organizationId: string, provider: string, enabled = true) {
  if (!AUTOMATIC_IMPORT_PROVIDERS.has(provider)) throw new Error("Automatic import is not available for this provider yet.");
  const db = dbSession.db;
  const [connection] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.organizationId, organizationId), eq(integrationConnections.provider, provider))).limit(1);
  if (!connection || connection.status !== "connected" || !connection.externalAccountId) throw new Error("Connect and verify the provider before enabling imports.");
  const now = new Date();
  const [existing] = await db.select().from(integrationSyncState).where(eq(integrationSyncState.connectionId, connection.id)).limit(1);
  if (existing && existing.externalAccountId !== connection.externalAccountId) throw new Error("The connected company changed. Use a separate workspace or reconcile the previous company's imports first.");
  await db.insert(integrationSyncState).values({ connectionId: connection.id, organizationId, externalAccountId: connection.externalAccountId, enabled, nextRunAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: integrationSyncState.connectionId, set: { enabled, nextRunAt: now, attempts: 0, updatedAt: now } });
  return { connectionId: connection.id, enabled, status: enabled ? "queued" : "paused" };
}

export async function importStatus(dbSession: DbSession, organizationId: string, provider: string) {
  const db = dbSession.db;
  const [connection] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.organizationId, organizationId), eq(integrationConnections.provider, provider))).limit(1);
  if (!connection) return { enabled: false, lastRun: null, lastSyncAt: null };
  const [state] = await db.select().from(integrationSyncState).where(and(eq(integrationSyncState.connectionId, connection.id), eq(integrationSyncState.organizationId, organizationId))).limit(1);
  const [run] = await db.select().from(syncRuns).where(and(eq(syncRuns.connectionId, connection.id), eq(syncRuns.organizationId, organizationId))).orderBy(desc(syncRuns.startedAt)).limit(1);
  return { enabled: state?.enabled ?? false, lastSyncAt: connection.lastSyncAt, nextRunAt: state?.enabled ? state.nextRunAt : null, lastRun: run ? { id: run.id, status: run.status, error: run.error, counts: JSON.parse(run.countsJson), startedAt: run.startedAt, completedAt: run.completedAt } : null };
}

/** One bounded page per connection; overlapping crons cannot rotate its tokens twice. */
export async function runImportWorker(dbSession: DbSession, config: IntegrationEnv, limit = 2) {
  const db = dbSession.db, now = new Date();
  const due = await db.select().from(integrationSyncState).where(and(eq(integrationSyncState.enabled, true), lte(integrationSyncState.nextRunAt, now), freeLease(now))).orderBy(asc(integrationSyncState.nextRunAt)).limit(Math.max(1, Math.min(limit, 5)));
  let processed = 0;
  for (const candidate of due) {
    const lease = crypto.randomUUID();
    const [state] = await db.update(integrationSyncState).set({ leaseToken: lease, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), updatedAt: now })
      .where(and(eq(integrationSyncState.connectionId, candidate.connectionId), eq(integrationSyncState.enabled, true), lte(integrationSyncState.nextRunAt, now), freeLease(now))).returning();
    if (!state) continue;
    processed++;
    const scope = and(eq(integrationSyncState.connectionId, state.connectionId), eq(integrationSyncState.leaseToken, lease));
    const runId = crypto.randomUUID();
    try {
      await db.update(syncRuns).set({ status: "interrupted", error: "Worker lease expired; the saved page will be retried.", completedAt: now }).where(and(eq(syncRuns.connectionId, state.connectionId), eq(syncRuns.status, "running")));
      const [connection] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, state.connectionId), eq(integrationConnections.organizationId, state.organizationId))).limit(1);
      if (!connection || !AUTOMATIC_IMPORT_PROVIDERS.has(connection.provider) || connection.status !== "connected" || connection.externalAccountId !== state.externalAccountId) throw new Error("The connected account changed or needs authorization. Review it before resuming.");
      await db.insert(syncRuns).values({ id: runId, organizationId: state.organizationId, connectionId: state.connectionId, provider: connection.provider, status: "running", cursorJson: state.cursorJson, countsJson: "{}", startedAt: now });
      if (connection.provider === "buildium") {
        if (!connection.accessTokenCiphertext || !config.INTEGRATION_TOKEN_ENCRYPTION_KEY) throw new Error("Buildium credentials unavailable");
        const credentials = JSON.parse(await decryptSecret(connection.accessTokenCiphertext, config.INTEGRATION_TOKEN_ENCRYPTION_KEY)) as Record<string, string>;
        const page = await dbSession.outsideTransaction(() => fetchBuildiumPage(credentials, buildiumCursor(state.cursorJson)));
        await dbSession.atomic(async () => {
          const [current] = await db.select().from(integrationSyncState).where(and(scope, eq(integrationSyncState.enabled, true))).limit(1);
          const [currentConnection] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, connection.id), eq(integrationConnections.status, "connected"), eq(integrationConnections.accessTokenCiphertext, connection.accessTokenCiphertext!))).limit(1);
          if (!current || !currentConnection || !current.leaseExpiresAt || current.leaseExpiresAt <= new Date()) throw new Error("Buildium connection or worker lease changed");
          const result = await applyImport(dbSession, state.organizationId, page.batch, { sourceProvider: "buildium", sourceConnectionId: connection.id, externalId: null });
          if (result.conflictsDetected || result.failed.length || result.skipped.length) throw new Error("Buildium import requires reconciliation; checkpoint retained");
          const completedAt = new Date();
          const saved = await db.update(integrationSyncState).set({ cursorJson: JSON.stringify(page.next), attempts: 0, nextRunAt: new Date(completedAt.getTime() + (page.complete ? INTERVAL_MS : 0)), leaseToken: null, leaseExpiresAt: null, updatedAt: completedAt }).where(scope).returning();
          if (!saved.length) throw new Error("Buildium worker ownership changed");
          if (page.complete) await db.update(integrationConnections).set({ lastSyncAt: completedAt }).where(eq(integrationConnections.id, connection.id));
          await db.update(syncRuns).set({ status: page.complete ? "completed" : "page_completed", cursorJson: JSON.stringify(page.next), countsJson: JSON.stringify({ ...result, complete: page.complete, readOnly: true }), completedAt }).where(eq(syncRuns.id, runId));
        });
        continue;
      }
      const cursor = syncCursor(state.cursorJson, now);
      const client = await quickbooksClient(dbSession, connection, config);
      const page = await fetchQuickbooksPage(client, cursor);
      const storedAccounts = await db.select().from(glAccounts).where(and(eq(glAccounts.organizationId, state.organizationId), eq(glAccounts.sourceProvider, "quickbooks")));
      const types = new Map(storedAccounts.filter(a => a.externalId).map(a => [a.externalId!, a.accountType as GlAccountType]));
      const normalized = normalizeQuickbooks({ ...page, knownAccountTypes: types });
      if (normalized.rejected.length) {
        await db.update(syncRuns).set({ countsJson: JSON.stringify({ rejected: normalized.rejected }) }).where(eq(syncRuns.id, runId));
        throw new Error("Some source rows need review; no rows from this page were imported and its checkpoint was retained.");
      }
      // The reporting ledger is append-only. Changed/deleted source journals
      // must be reconciled explicitly, never passed off as unchanged or duplicated.
      for (const account of normalized.batch.glAccounts ?? []) {
        const old = storedAccounts.find(a => a.externalId === account.externalId);
        if (old && (old.accountType !== account.accountType || old.sourceConnectionId !== connection.id)) throw new Error("An imported account changed type or company. Reconcile its reporting entries first.");
      }
      if (page.journalEntries.length) {
        const existing = await db.select().from(glTransactions).where(and(eq(glTransactions.organizationId, state.organizationId), eq(glTransactions.sourceProvider, "quickbooks")));
        const incoming = new Map((normalized.batch.glTransactions ?? []).map(row => [row.externalId, row]));
        const changedIds = new Set(page.journalEntries.map(row => row.Id));
        const accountIds = new Map(storedAccounts.map(row => [row.externalId, row.id]));
        for (const old of existing) {
          if (!old.externalId || !changedIds.has(old.externalId.split(":")[0])) continue;
          const row = incoming.get(old.externalId);
          if (!row || row.amountCents !== old.amountCents || accountIds.get(row.accountExternalId) !== old.accountId || Date.parse(row.postedAt) !== old.postedAt.getTime() || old.sourceConnectionId !== connection.id) throw new Error("A previously imported journal was changed or had lines removed. Reconcile it before resuming.");
        }
      }
      const [current] = await db.select().from(integrationSyncState).where(and(scope, eq(integrationSyncState.enabled, true))).limit(1);
      const [currentConnection] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, connection.id), eq(integrationConnections.status, "connected"), eq(integrationConnections.accessTokenCiphertext, client.currentCiphertext()))).limit(1);
      if (!current || !currentConnection || !current.leaseExpiresAt || current.leaseExpiresAt <= new Date()) throw new Error("Import paused or connection changed before application.");
      const result = await applyImport(dbSession, state.organizationId, normalized.batch, { sourceProvider: "quickbooks", sourceConnectionId: connection.id, externalId: null });
      await db.update(syncRuns).set({ countsJson: JSON.stringify({ ...result, scope: "chart_of_accounts_and_journal_adjustments_only", complete: page.complete }) }).where(eq(syncRuns.id, runId));
      if (result.failed.length || result.skipped.length || result.conflictsDetected) throw new Error("Import partially applied. Review the reported rows; this page's checkpoint has not advanced.");
      const completedAt = new Date();
      const saved = await db.update(integrationSyncState).set({ cursorJson: JSON.stringify(page.next), attempts: 0, nextRunAt: new Date(completedAt.getTime() + (page.complete ? INTERVAL_MS : 0)), leaseToken: null, leaseExpiresAt: null, updatedAt: completedAt }).where(scope).returning();
      if (!saved.length) throw new Error("Worker ownership changed before the checkpoint was saved.");
      if (page.complete) await db.update(integrationConnections).set({ lastSyncAt: completedAt }).where(and(eq(integrationConnections.id, connection.id), eq(integrationConnections.status, "connected"), eq(integrationConnections.accessTokenCiphertext, client.currentCiphertext())));
      await db.update(syncRuns).set({ status: page.complete ? "completed" : "page_completed", cursorJson: JSON.stringify(page.next), completedAt }).where(eq(syncRuns.id, runId));
    } catch (error) {
      const attempt = state.attempts + 1;
      const retry = error instanceof ProviderHttpError && error.retryable && attempt < 4;
      const retryDelay = Math.max(30_000 * 2 ** (attempt - 1), error instanceof ProviderHttpError ? error.retryAfterSeconds * 1000 : 0);
      const message = error instanceof Error ? error.message : "Import failed. Review the connection and retry.";
      await db.update(syncRuns).set({ status: retry ? "retrying" : "needs_review", error: message, completedAt: new Date() }).where(eq(syncRuns.id, runId));
      await db.update(integrationSyncState).set({ ...(retry ? {} : { enabled: false }), attempts: attempt, nextRunAt: new Date(Date.now() + retryDelay), leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() }).where(scope);
    }
  }
  return { processed };
}
