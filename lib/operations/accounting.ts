import { financialTimeline } from "@/lib/charts/financial-timeline";
/**
 * The books Aval reads: a chart of accounts, posted GL amounts, and the
 * per-lease receivables ledger that delinquency is computed from.
 *
 * Aval is not the system of record for anyone's accounting — it mirrors what
 * a connected accounting platform or PMS already holds — so this is a
 * reporting ledger, not double-entry bookkeeping (see `gl_transactions` in
 * db/schema.ts). What it adds over the source system is the join the source
 * system cannot do: receivables from the PMS against expenses from the books
 * against metered utility spend from Aval's own infrastructure module, in one
 * NOI figure that states what it could and could not see.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { glAccounts, glTransactions, leases, ledgerEntries, utilityBills } from "@/db/postgres/schema";
import { EntityNotFoundError, getProperty, propertyNames, unitCountsByProperty } from "./portfolio";
import { manualSource, type SourceRef } from "./provenance";
import {
  annualizedNoiCents,
  expenseLines,
  profitAndLoss,
  profitAndLossByProperty,
  reconcileUtilities,
  type ExpenseLineRow,
  type GlAccountLike,
  type GlTransactionLike,
  type ProfitAndLoss,
  type PropertyProfitAndLoss,
  type UtilityReconciliation,
} from "./metrics/financials";
import {
  ageLeaseCharges,
  balanceCents,
  delinquentAccounts,
  depositsHeldCents,
  summarizeAging,
  summarizeCollections,
  type AgedCharge,
  type AgingSummary,
  type CollectionSummary,
  type DelinquentAccount,
  type LedgerEntryLike,
} from "./metrics/receivables";
import { daysBetween, type GlAccountType, type LedgerCategory, type LedgerEntryType } from "./types";

/* ── chart of accounts ──────────────────────────────────────────────────── */

export interface GlAccountInput {
  code: string;
  name: string;
  accountType: GlAccountType;
  isTrustAccount?: boolean;
}

export async function createGlAccount(dbSession: DbSession, organizationId: string, input: GlAccountInput, source: SourceRef = manualSource()) {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    organizationId,
    code: input.code.trim(),
    name: input.name.trim(),
    accountType: input.accountType,
    // Deposit and owner-funds accounts default to trust when the caller says
    // so and never by name-matching. Guessing "is this account client money"
    // from a label is exactly the kind of inference that gets trust funds
    // reported as operating income.
    isTrustAccount: input.isTrustAccount ?? false,
    ...source,
    createdAt: now,
    updatedAt: now,
  };
  await dbSession.db.insert(glAccounts).values(row).onConflictDoNothing();
  return row;
}

export async function listGlAccounts(dbSession: DbSession, organizationId: string) {
  return dbSession.db.select().from(glAccounts).where(eq(glAccounts.organizationId, organizationId)).orderBy(glAccounts.code);
}

/* ── posted amounts ─────────────────────────────────────────────────────── */

export interface GlTransactionInput {
  accountId: string;
  propertyId?: string | null;
  amountCents: number;
  currency?: string;
  postedAt: Date;
  memo?: string | null;
}

export async function postGlTransaction(dbSession: DbSession, organizationId: string, input: GlTransactionInput, source: SourceRef = manualSource()) {
  const [account] = await dbSession.db
    .select({ id: glAccounts.id })
    .from(glAccounts)
    .where(and(eq(glAccounts.organizationId, organizationId), eq(glAccounts.id, input.accountId)))
    .limit(1);
  if (!account) throw new EntityNotFoundError("GL account", input.accountId);

  if (input.propertyId) {
    const property = await getProperty(dbSession, organizationId, input.propertyId);
    if (!property) throw new EntityNotFoundError("Property", input.propertyId);
  }

  const row = {
    id: crypto.randomUUID(),
    organizationId,
    accountId: input.accountId,
    propertyId: input.propertyId ?? null,
    amountCents: input.amountCents,
    currency: input.currency ?? "USD",
    postedAt: input.postedAt,
    memo: input.memo ?? null,
    ...source,
    createdAt: new Date(),
  };
  await dbSession.db.insert(glTransactions).values(row);
  return row;
}

export async function listGlTransactions(dbSession: DbSession, organizationId: string, filters: { propertyId?: string; accountId?: string } = {}) {
  const conditions = [eq(glTransactions.organizationId, organizationId)];
  if (filters.propertyId) conditions.push(eq(glTransactions.propertyId, filters.propertyId));
  if (filters.accountId) conditions.push(eq(glTransactions.accountId, filters.accountId));
  return dbSession.db.select().from(glTransactions).where(and(...conditions)).orderBy(desc(glTransactions.postedAt));
}

/* ── receivables ledger ─────────────────────────────────────────────────── */

export interface LedgerEntryInput {
  leaseId: string;
  entryType: LedgerEntryType;
  category: LedgerCategory;
  amountCents: number;
  currency?: string;
  postedAt: Date;
  dueAt?: Date | null;
  memo?: string | null;
}

/**
 * Posts a charge, payment, credit or refund against a lease.
 *
 * `amountCents` must be positive — the direction lives in `entryType`. A
 * negative amount here would mean the same thing twice and lets a sign bug
 * turn a payment into a charge silently, so it is rejected rather than
 * normalized.
 */
export async function postLedgerEntry(dbSession: DbSession, organizationId: string, input: LedgerEntryInput, source: SourceRef = manualSource()) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Ledger amountCents must be a positive integer; direction is carried by entryType");
  }

  const [lease] = await dbSession.db
    .select({ id: leases.id, propertyId: leases.propertyId })
    .from(leases)
    .where(and(eq(leases.organizationId, organizationId), eq(leases.id, input.leaseId)))
    .limit(1);
  if (!lease) throw new EntityNotFoundError("Lease", input.leaseId);

  const row = {
    id: crypto.randomUUID(),
    organizationId,
    leaseId: input.leaseId,
    propertyId: lease.propertyId,
    entryType: input.entryType,
    category: input.category,
    amountCents: input.amountCents,
    currency: input.currency ?? "USD",
    postedAt: input.postedAt,
    dueAt: input.dueAt ?? null,
    memo: input.memo ?? null,
    ...source,
    createdAt: new Date(),
  };
  await dbSession.db.insert(ledgerEntries).values(row);
  return row;
}

export async function listLedgerEntries(dbSession: DbSession, organizationId: string, filters: { leaseId?: string; propertyId?: string } = {}) {
  const conditions = [eq(ledgerEntries.organizationId, organizationId)];
  if (filters.leaseId) conditions.push(eq(ledgerEntries.leaseId, filters.leaseId));
  if (filters.propertyId) conditions.push(eq(ledgerEntries.propertyId, filters.propertyId));
  return dbSession.db.select().from(ledgerEntries).where(and(...conditions)).orderBy(desc(ledgerEntries.postedAt));
}

function toLedgerLike(row: typeof ledgerEntries.$inferSelect): LedgerEntryLike {
  return {
    id: row.id,
    leaseId: row.leaseId,
    propertyId: row.propertyId,
    entryType: row.entryType as LedgerEntryType,
    category: row.category as LedgerCategory,
    amountCents: row.amountCents,
    postedAt: row.postedAt,
    dueAt: row.dueAt,
  };
}

/** One lease's running balance, for a resident record or a collections message. */
export async function leaseBalanceCents(dbSession: DbSession, organizationId: string, leaseId: string): Promise<number> {
  const rows = await listLedgerEntries(dbSession, organizationId, { leaseId });
  return balanceCents(rows.map(toLedgerLike));
}

/* ── read model ─────────────────────────────────────────────────────────── */

export interface DelinquentAccountWithContext extends DelinquentAccount {
  propertyName: string;
  unitId: string;
  rentCents: number;
  /** Balance owed as a multiple of one month's rent — the figure that separates a late payment from a resident who has stopped paying. Null when the lease carries no rent. */
  monthsOfRentOwed: number | null;
}

export interface AccountingReport {
  timeline: ReturnType<typeof financialTimeline>;
  profitAndLoss: ProfitAndLoss | null;
  byProperty: (PropertyProfitAndLoss & { propertyName: string | null })[];
  expenseLines: ExpenseLineRow[];
  /** NOI extrapolated to a year. Null for periods shorter than a month — see `annualizedNoiCents`. */
  annualizedNoiCents: number | null;
  collections: CollectionSummary | null;
  aging: AgingSummary | null;
  delinquents: DelinquentAccountWithContext[];
  depositsHeldCents: number;
  utilityReconciliation: UtilityReconciliation | null;
  /** Present when nothing in this workspace can support the section — stated rather than rendered as zeroes. */
  notes: string[];
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Everything the Accounting tab shows.
 *
 * Sections that have no data return `null` and add a line to `notes` instead
 * of returning zeroes. A P&L of zeroes is a claim that the portfolio earned
 * and spent nothing; "no connected source has provided general-ledger data" is
 * the truth, and the two must not look the same on a screen an owner reads.
 */
export async function summarizeAccounting(dbSession: DbSession,
  organizationId: string,
  periodStart: Date,
  periodEnd: Date,
  asOf = new Date()
): Promise<AccountingReport> {
  const db = dbSession.db;
  const [accountRows, transactionRows, ledgerRows, leaseRows] = await Promise.all([
    listGlAccounts(dbSession, organizationId),
    db.select().from(glTransactions).where(eq(glTransactions.organizationId, organizationId)),
    db.select().from(ledgerEntries).where(eq(ledgerEntries.organizationId, organizationId)),
    db.select().from(leases).where(eq(leases.organizationId, organizationId)),
  ]);

  const notes: string[] = [];
  const accounts: GlAccountLike[] = accountRows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.accountType as GlAccountType,
    isTrustAccount: row.isTrustAccount,
  }));
  const transactions: GlTransactionLike[] = transactionRows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    propertyId: row.propertyId,
    amountCents: row.amountCents,
    postedAt: row.postedAt,
  }));
  const ledger = ledgerRows.map(toLedgerLike);

  const hasGl = accounts.length > 0 && transactions.length > 0;
  const hasLedger = ledger.length > 0;
  if (!hasGl) notes.push("No general-ledger data has been provided for this workspace, so there is no profit and loss to report.");
  if (!hasLedger) notes.push("No resident ledger entries have been provided, so receivables, aging and collections cannot be computed.");

  const unitCounts = await unitCountsByProperty(dbSession, organizationId);
  const statement = hasGl ? profitAndLoss(transactions, accounts, periodStart, periodEnd) : null;
  if (statement && statement.unmappedTransactionCount > 0) {
    notes.push(
      `${statement.unmappedTransactionCount} posted amount(s) reference an account that is not in this workspace's chart of accounts and were left out of the figures above.`,
    );
  }

  // Aging walks each lease's own entries: credits apply oldest-charge-first
  // within a lease, and pooling every lease's entries together would let one
  // resident's payment settle another's arrears.
  const byLease = new Map<string, LedgerEntryLike[]>();
  for (const entry of ledger) {
    const group = byLease.get(entry.leaseId);
    if (group) group.push(entry);
    else byLease.set(entry.leaseId, [entry]);
  }
  const agedCharges: AgedCharge[] = [];
  for (const entries of byLease.values()) agedCharges.push(...ageLeaseCharges(entries, asOf));

  const leaseById = new Map(leaseRows.map((lease) => [lease.id, lease]));
  const propertyIds = new Set<string>();
  for (const row of transactionRows) if (row.propertyId) propertyIds.add(row.propertyId);
  for (const charge of agedCharges) propertyIds.add(charge.propertyId);
  const names = await propertyNames(dbSession, organizationId, [...propertyIds]);

  const delinquents: DelinquentAccountWithContext[] = delinquentAccounts(agedCharges).map((account) => {
    const lease = leaseById.get(account.leaseId);
    const rentCents = lease?.rentCents ?? 0;
    return {
      ...account,
      propertyName: names.get(account.propertyId) ?? "Unknown property",
      unitId: lease?.unitId ?? "",
      rentCents,
      monthsOfRentOwed: rentCents > 0 ? Math.round((account.balanceCents / rentCents) * 100) / 100 : null,
    };
  });

  // Cross-system check: metered utility spend against the utilities line in
  // the books. Only meaningful when the workspace flags which GL accounts are
  // utilities, which it does by account type plus a name Aval does not guess —
  // so the caller passes the ids, and with none the section is null.
  const utilityBillRows = await db
    .select({ costCents: utilityBills.costCents, periodStart: utilityBills.periodStart })
    .from(utilityBills)
    .where(eq(utilityBills.organizationId, organizationId));
  const billsInPeriod = utilityBillRows.filter((bill) => bill.periodStart >= periodStart && bill.periodStart <= periodEnd);
  const utilityAccountIds = new Set(
    accountRows.filter((row) => row.name.toLowerCase().includes("utilit")).map((row) => row.id),
  );
  const utilityReconciliation =
    billsInPeriod.length > 0 && utilityAccountIds.size > 0
      ? reconcileUtilities(billsInPeriod, transactions, utilityAccountIds)
      : null;
  if (utilityReconciliation?.materialDifference) {
    notes.push(
      "Metered utility spend and the utilities line in the general ledger disagree for this period. Neither has been adjusted — check which is complete.",
    );
  }

  const periodDays = daysBetween(periodStart, periodEnd) + 1;

  return {
    profitAndLoss: statement,
    timeline: hasGl ? financialTimeline(transactions, accounts, periodStart, periodEnd) : null,
    byProperty: hasGl
      ? profitAndLossByProperty(transactions, accounts, periodStart, periodEnd, unitCounts).map((row) => ({
          ...row,
          propertyName: row.propertyId === null ? null : names.get(row.propertyId) ?? "Unknown property",
        }))
      : [],
    expenseLines: hasGl ? expenseLines(transactions, accounts, periodStart, periodEnd) : [],
    annualizedNoiCents: statement ? annualizedNoiCents(statement.noiCents, periodDays) : null,
    collections: hasLedger ? summarizeCollections(ledger, periodStart, periodEnd) : null,
    aging: hasLedger ? summarizeAging(agedCharges) : null,
    delinquents,
    depositsHeldCents: depositsHeldCents(ledger),
    utilityReconciliation,
    notes,
    periodStart,
    periodEnd,
  };
}

/** Leases carrying any past-due balance, for collections surfaces that need the resident behind the number. */
export async function delinquentLeaseIds(dbSession: DbSession, organizationId: string, asOf = new Date()): Promise<string[]> {
  const rows = await dbSession.db.select().from(ledgerEntries).where(eq(ledgerEntries.organizationId, organizationId));
  const byLease = new Map<string, LedgerEntryLike[]>();
  for (const row of rows) {
    const entry = toLedgerLike(row);
    const group = byLease.get(entry.leaseId);
    if (group) group.push(entry);
    else byLease.set(entry.leaseId, [entry]);
  }
  const ids = new Set<string>();
  for (const [leaseId, entries] of byLease) {
    if (ageLeaseCharges(entries, asOf).some((charge) => charge.bucket !== "current")) ids.add(leaseId);
  }
  return [...ids];
}

/** Seeds a minimal chart of accounts so a workspace with no accounting connector can still record expenses by hand. */
export async function seedDefaultChartOfAccounts(dbSession: DbSession, organizationId: string) {
  const existing = await listGlAccounts(dbSession, organizationId);
  if (existing.length > 0) return existing;

  const defaults: GlAccountInput[] = [
    { code: "4000", name: "Rental income", accountType: "income" },
    { code: "4100", name: "Other income", accountType: "income" },
    { code: "6000", name: "Repairs and maintenance", accountType: "operating_expense" },
    { code: "6100", name: "Utilities", accountType: "operating_expense" },
    { code: "6200", name: "Insurance", accountType: "operating_expense" },
    { code: "6300", name: "Property taxes", accountType: "operating_expense" },
    { code: "6400", name: "Management fees", accountType: "operating_expense" },
    { code: "6500", name: "Turnover and make-ready", accountType: "operating_expense" },
    { code: "7000", name: "Capital improvements", accountType: "capital_expense" },
    { code: "2100", name: "Security deposits held", accountType: "liability", isTrustAccount: true },
  ];

  for (const account of defaults) await createGlAccount(dbSession, organizationId, account);
  return listGlAccounts(dbSession, organizationId);
}

/** Ledger entries for a set of leases, for callers that already know which leases they care about. */
export async function ledgerForLeases(dbSession: DbSession, organizationId: string, leaseIds: string[]) {
  if (leaseIds.length === 0) return [];
  return dbSession.db
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.organizationId, organizationId), inArray(ledgerEntries.leaseId, leaseIds)))
    .orderBy(desc(ledgerEntries.postedAt));
}
