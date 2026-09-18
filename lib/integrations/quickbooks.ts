import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections } from "@/db/postgres/schema";
import { decryptSecret, encryptSecret } from "./crypto";
import { ProviderHttpError, providerJson, record, requiredString } from "./http";
import { requestOAuthToken, type IntegrationEnv } from "./oauth";
import type { QboAccount, QboJournalEntry } from "./quickbooks-rules";

export const QBO_PAGE_SIZE = 25;
type Connection = typeof integrationConnections.$inferSelect;
export type QboCursor = { phase: "accounts" | "journals" | "cdc"; position: number; cycleStartedAt: string; changedSince?: string };

export function syncCursor(raw: string, now: Date): QboCursor {
  const value = record(JSON.parse(raw));
  const changedSince = typeof value.changedSince === "string" ? value.changedSince : undefined;
  if (changedSince && (!Number.isFinite(Date.parse(changedSince)) || now.getTime() - Date.parse(changedSince) > 29 * 86400000 || Date.parse(changedSince) > now.getTime())) throw new Error("The QuickBooks change window requires reconciliation before imports can resume.");
  if (!value.phase) return { phase: "accounts", position: 1, cycleStartedAt: now.toISOString(), changedSince };
  if (!["accounts", "journals", "cdc"].includes(String(value.phase)) || !Number.isSafeInteger(value.position) || Number(value.position) < 1 || typeof value.cycleStartedAt !== "string" || !Number.isFinite(Date.parse(value.cycleStartedAt))) throw new Error("Invalid import checkpoint. Review the connection before restarting.");
  return { phase: value.phase as QboCursor["phase"], position: Number(value.position), cycleStartedAt: value.cycleStartedAt, changedSince };
}

/** Called only while holding the connection's durable worker lease. */
export async function quickbooksClient(dbSession: DbSession, connection: Connection, config: IntegrationEnv) {
  const key = config.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!key || !connection.accessTokenCiphertext || !connection.externalAccountId || !/^\d{1,32}$/.test(connection.externalAccountId)) throw new Error("Reconnect QuickBooks with a valid company and encrypted credentials.");
  let ciphertext = connection.accessTokenCiphertext;
  let access = await decryptSecret(ciphertext, key);
  let refreshCiphertext = connection.refreshTokenCiphertext;
  const metadata = record(JSON.parse(connection.metadataJson));
  const host = metadata.quickbooksEnvironment === "sandbox" ? "sandbox-quickbooks.api.intuit.com" : "quickbooks.api.intuit.com";
  const base = `https://${host}/v3/company/${connection.externalAccountId}`;
  async function refresh() {
    if (!refreshCiphertext) throw new ProviderHttpError(401, false);
    const refreshToken = await decryptSecret(refreshCiphertext, key!);
    const token = await dbSession.outsideTransaction(() => requestOAuthToken("quickbooks", config, { grant_type: "refresh_token", refresh_token: refreshToken }));
    const nextAccess = await encryptSecret(token.access_token, key!);
    const nextRefresh = token.refresh_token ? await encryptSecret(token.refresh_token, key!) : refreshCiphertext;
    const updated = await dbSession.db.update(integrationConnections).set({ accessTokenCiphertext: nextAccess, refreshTokenCiphertext: nextRefresh, expiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000), updatedAt: new Date() })
      .where(and(eq(integrationConnections.id, connection.id), eq(integrationConnections.organizationId, connection.organizationId), eq(integrationConnections.status, "connected"), eq(integrationConnections.accessTokenCiphertext, ciphertext))).returning({ id: integrationConnections.id });
    if (!updated.length) throw new Error("Connection changed during token refresh. Retry the import.");
    access = token.access_token; ciphertext = nextAccess; refreshCiphertext = nextRefresh;
  }
  let refreshed = false;
  if (connection.expiresAt && connection.expiresAt.getTime() < Date.now() + 300000) { await refresh(); refreshed = true; }
  return {
    async get(path: string): Promise<Record<string, unknown>> {
      for (;;) {
        try {
          const payload = record(await dbSession.outsideTransaction(() => providerJson(`${base}${path}`, { headers: { authorization: `Bearer ${access}`, accept: "application/json" } })));
          if (payload.Fault) throw new Error("QuickBooks rejected this query. Check the account and application permissions.");
          return payload;
        } catch (error) {
          if (error instanceof ProviderHttpError && error.status === 401 && !refreshed) { refreshed = true; await refresh(); continue; }
          throw error;
        }
      }
    },
    currentCiphertext: () => ciphertext,
  };
}

export async function fetchQuickbooksPage(client: Awaited<ReturnType<typeof quickbooksClient>>, cursor: QboCursor): Promise<{ accounts: QboAccount[]; journalEntries: QboJournalEntry[]; next: QboCursor | { changedSince: string }; complete: boolean }> {
  if (cursor.phase === "accounts" && cursor.position === 1) {
    const prefs = record((await client.get("/preferences")).Preferences);
    const currency = requiredString(record(record(prefs.CurrencyPrefs).HomeCurrency).value);
    if (currency !== "USD") throw new Error("This journal importer currently supports USD books only; no amounts were converted or relabeled.");
  }
  let rows: unknown[];
  if (cursor.phase === "cdc") {
    if (!cursor.changedSince) throw new Error("Missing QuickBooks change checkpoint");
    const result = await client.get(`/cdc?${new URLSearchParams({ entities: "JournalEntry", changedSince: cursor.changedSince })}`);
    if (!Array.isArray(result.CDCResponse)) throw new Error("QuickBooks returned no change response");
    rows = result.CDCResponse.flatMap((item) => {
      const queries = record(item).QueryResponse;
      if (!Array.isArray(queries)) throw new Error("Invalid QuickBooks change response");
      return queries.flatMap((query) => {
        const entries = record(query).JournalEntry ?? [];
        if (!Array.isArray(entries)) throw new Error("Invalid QuickBooks journal changes");
        return entries;
      });
    });
    if (rows.length >= 1000) throw new Error("QuickBooks reached its change-response limit. Reconcile a smaller change window before continuing.");
  } else {
    const entity = cursor.phase === "accounts" ? "Account" : "JournalEntry";
    const query = `SELECT * FROM ${entity}${entity === "Account" ? " WHERE Active IN (true, false)" : ""} STARTPOSITION ${cursor.position} MAXRESULTS ${QBO_PAGE_SIZE}`;
    const response = record((await client.get(`/query?${new URLSearchParams({ query })}`)).QueryResponse);
    const entities = response[entity] ?? [];
    if (!Array.isArray(entities) || entities.length > QBO_PAGE_SIZE) throw new Error("Unexpected QuickBooks page size");
    rows = entities;
  }
  const accounts: QboAccount[] = [], journalEntries: QboJournalEntry[] = [];
  let lineCount = 0;
  for (const item of rows) {
    const row = record(item);
    const id = requiredString(row.Id);
    if (row.status === "Deleted") throw new Error("QuickBooks reports a deleted journal. Reconcile its imported entries before resuming.");
    if (cursor.phase === "accounts") accounts.push({ Id: id, Name: requiredString(row.Name), AccountType: requiredString(row.AccountType), ...(typeof row.AcctNum === "string" ? { AcctNum: row.AcctNum } : {}) });
    else {
      const date = requiredString(row.TxnDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("QuickBooks returned an invalid journal date");
      if (row.CurrencyRef && record(row.CurrencyRef).value !== "USD") throw new Error("Foreign-currency journal entries require explicit currency mapping.");
      if (!Array.isArray(row.Line)) throw new Error("QuickBooks returned no journal lines");
      const seen = new Set<string>();
      const lines = row.Line.map((value) => {
        const line = record(value), lineId = requiredString(line.Id);
        if (seen.has(lineId)) throw new Error("QuickBooks returned duplicate journal line IDs");
        seen.add(lineId);
        const detail = record(line.JournalEntryLineDetail);
        return { Id: lineId, Amount: typeof line.Amount === "number" ? line.Amount : NaN, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: requiredString(detail.PostingType), AccountRef: { value: requiredString(record(detail.AccountRef).value) } } };
      });
      lineCount += lines.length;
      if (lineCount > 250) throw new Error("This journal page exceeds the bounded import size. Split the source journals before retrying.");
      journalEntries.push({ Id: id, TxnDate: date, Line: lines });
    }
  }
  const exhausted = cursor.phase === "cdc" || rows.length < QBO_PAGE_SIZE;
  const complete = exhausted && cursor.phase !== "accounts";
  const next = complete ? { changedSince: cursor.cycleStartedAt }
    : exhausted ? { ...cursor, phase: cursor.changedSince ? "cdc" as const : "journals" as const, position: 1 }
    : { ...cursor, position: cursor.position + QBO_PAGE_SIZE };
  return { accounts, journalEntries, next, complete };
}
