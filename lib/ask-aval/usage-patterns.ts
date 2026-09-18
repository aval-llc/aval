/**
 * The other half of closed-loop learning: not what a user said (that's
 * preferences.ts), but what they actually did. Aggregated fresh from real
 * action tables at request time — insight_decisions, automation_runs,
 * draft_documents — rather than a separately maintained "learned" table,
 * so it can never drift stale and needs no background job to refresh it.
 *
 * Every field aggregated here (insight id, decision, automation status,
 * document format/type) is already a small fixed-cardinality label, never
 * free text — so this is privacy-safe by construction, the same guarantee
 * preferences.ts gets from its fixed vocabulary, without needing one here.
 *
 * A single occurrence is not a pattern: every bucket below requires a
 * minimum count before it's surfaced, so one early denial doesn't get
 * reported to the model as "this workspace denies X."
 */

import { and, eq, ne } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { automationRuns, draftDocuments, insightDecisions } from "@/db/postgres/schema";

const MIN_OCCURRENCES = 3;

const INSIGHT_LABELS: Record<string, string> = {
  "collections-gap": "rent collections reminders",
  "vacancy-pricing": "vacancy pricing reviews",
  "noi-variance": "NOI variance reviews",
  "maintenance-sla": "maintenance escalations",
  "deposit-reconciliation": "deposit reconciliation reviews",
  "lease-renewal": "lease renewal reviews",
};

function insightLabel(insightId: string): string {
  return INSIGHT_LABELS[insightId] ?? insightId.replace(/-/g, " ");
}

function topEntry(counts: Map<string, number>): [string, number] | null {
  let best: [string, number] | null = null;
  for (const entry of counts) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best && best[1] >= MIN_OCCURRENCES ? best : null;
}

export async function getUsagePatternContext(dbSession: DbSession, organizationId: string): Promise<string> {
  const db = dbSession.db;
  const [decisions, runs, drafts] = await Promise.all([
    db.select().from(insightDecisions).where(eq(insightDecisions.organizationId, organizationId)),
    db.select().from(automationRuns).where(eq(automationRuns.organizationId, organizationId)),
    db.select().from(draftDocuments).where(and(eq(draftDocuments.organizationId, organizationId), ne(draftDocuments.status, "deleted"))),
  ]);

  const lines: string[] = [];

  // Per-insight approve/deny rate — only when there's enough of that
  // specific insight's decisions to call it a rate rather than a coin flip.
  const byInsight = new Map<string, { approved: number; denied: number; sent: number }>();
  for (const row of decisions) {
    const bucket = byInsight.get(row.insightId) ?? { approved: 0, denied: 0, sent: 0 };
    if (row.decision === "approved") bucket.approved++;
    else if (row.decision === "denied") bucket.denied++;
    else if (row.decision === "sent") bucket.sent++;
    byInsight.set(row.insightId, bucket);
  }
  for (const [insightId, counts] of byInsight) {
    const total = counts.approved + counts.denied + counts.sent;
    if (total < MIN_OCCURRENCES) continue;
    const acted = counts.approved + counts.sent;
    if (acted === total) lines.push(`Consistently approves/sends ${insightLabel(insightId)} (${total}/${total} times).`);
    else if (counts.denied === total) lines.push(`Consistently denies ${insightLabel(insightId)} (${total}/${total} times).`);
  }

  // Automation types actually run, regardless of outcome.
  const runsByInsight = new Map<string, number>();
  for (const row of runs) runsByInsight.set(row.insightId, (runsByInsight.get(row.insightId) ?? 0) + 1);
  const topAutomation = topEntry(runsByInsight);
  if (topAutomation) lines.push(`Runs the ${insightLabel(topAutomation[0])} automation more than any other (${topAutomation[1]} times).`);

  // Dominant export format across drafted documents.
  const byFormat = new Map<string, number>();
  for (const row of drafts) byFormat.set(row.format, (byFormat.get(row.format) ?? 0) + 1);
  const topFormat = topEntry(byFormat);
  if (topFormat && topFormat[1] > drafts.length / 2) lines.push(`Almost always requests drafts as ${topFormat[0]} (${topFormat[1]}/${drafts.length}).`);

  // Recurring document type (the eyebrow label set at draft time, e.g. "Weekly report").
  const byType = new Map<string, number>();
  for (const row of drafts) if (row.documentType) byType.set(row.documentType, (byType.get(row.documentType) ?? 0) + 1);
  const topType = topEntry(byType);
  if (topType) lines.push(`Regularly requests "${topType[0]}" documents (${topType[1]} times).`);

  if (lines.length === 0) return "";
  return `\n\nObserved usage patterns for this workspace, from real actions taken here (directional signal from behavior, not a stated rule — do not present these as the user's own words):\n${lines.map((line) => `- ${line}`).join("\n")}`;
}
