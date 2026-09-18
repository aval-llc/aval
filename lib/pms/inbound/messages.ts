/**
 * The reader's ledger, and the review an operator sees — storage for
 * `pms_seat_messages`.
 *
 * Written by the reader Worker, read by the app. Nothing here touches R2: the
 * app Worker deliberately has no handle on the unverified inbox (`d9210f8`), so
 * this table is how a settings panel learns that mail is waiting without
 * reopening that boundary.
 *
 * Every write is keyed on the message's content hash, so a sweep that runs twice
 * or dies halfway writes the same rows. That is what makes the sweep safe to
 * re-run rather than something needing a cursor to protect.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { pmsSeatMessages } from "@/db/schema";
import type { SeatDisposition } from "./disposition.ts";

export interface SeatMessageRecord {
  digest: string;
  recipient: string;
  organizationId: string | null;
  disposition: SeatDisposition;
  /** Only ever an authenticated domain. Null is the signal not to name a sender. */
  domain: string | null;
  method: string | null;
  providerId: string | null;
  /** Triage text. May carry sender-influenced content — never rendered to an operator. */
  reason: string | null;
  observedAuthservIds: string | null;
  objectKey: string;
  receivedAt: Date;
}

/**
 * The ledger key — `<recipient>:<digest>`.
 *
 * Constructed here rather than taken from the message, because the digest is a
 * content hash and two workspaces can be sent the same bytes. See the column's
 * note in `db/schema.ts` for what keying on the digest alone would have done.
 */
export function seatMessageId(recipient: string, digest: string): string {
  return `${recipient}:${digest}`;
}

/**
 * Record what was decided about one message.
 *
 * Upserts on the digest. A re-sweep of a held message that has since been
 * allowed overwrites its row, which is how the review empties out on its own
 * once a sender is allowed — no separate reconciliation step to forget.
 */
export async function recordSeatMessage(record: SeatMessageRecord): Promise<void> {
  const processedAt = new Date();
  const values = {
    id: seatMessageId(record.recipient, record.digest),
    digest: record.digest,
    recipient: record.recipient,
    organizationId: record.organizationId,
    disposition: record.disposition,
    authenticatedDomain: record.domain,
    method: record.method,
    providerId: record.providerId,
    reason: record.reason,
    observedAuthservIds: record.observedAuthservIds,
    objectKey: record.objectKey,
    receivedAt: record.receivedAt,
    processedAt,
  };

  await getDb()
    .insert(pmsSeatMessages)
    .values(values)
    .onConflictDoUpdate({
      target: pmsSeatMessages.id,
      set: {
        organizationId: values.organizationId,
        disposition: values.disposition,
        authenticatedDomain: values.authenticatedDomain,
        method: values.method,
        providerId: values.providerId,
        reason: values.reason,
        observedAuthservIds: values.observedAuthservIds,
        objectKey: values.objectKey,
        processedAt,
      },
    });
}

export interface HeldSender {
  /** Authenticated, therefore safe to show. */
  domain: string;
  /** dmarc | dkim, so the panel can say how it was established. */
  method: string | null;
  messages: number;
  firstSeen: Date;
  lastSeen: Date;
}

export interface SeatReview {
  /** Authenticated senders this workspace has not allowed. The actionable list. */
  held: HeldSender[];
  /**
   * Mail that authenticated nothing — counted, never named. There is no domain
   * field here on purpose: the only domain such a message carries is the one its
   * sender wrote.
   */
  unauthenticated: { messages: number; lastSeen: Date | null };
  /** Verified and handed to the read envelope. Shown so silence is legible. */
  verified: number;
}

/** What the seat's settings panel shows: who is waiting, and what got through. */
export async function seatReview(organizationId: string): Promise<SeatReview> {
  const db = getDb();

  const heldRows = await db
    .select({
      domain: pmsSeatMessages.authenticatedDomain,
      method: sql<string | null>`max(${pmsSeatMessages.method})`,
      messages: sql<number>`count(*)`,
      firstSeen: sql<number>`min(${pmsSeatMessages.receivedAt})`,
      lastSeen: sql<number>`max(${pmsSeatMessages.receivedAt})`,
    })
    .from(pmsSeatMessages)
    .where(
      and(
        eq(pmsSeatMessages.organizationId, organizationId),
        eq(pmsSeatMessages.disposition, "held"),
      ),
    )
    .groupBy(pmsSeatMessages.authenticatedDomain)
    .orderBy(desc(sql`count(*)`));

  const [unauthenticated] = await db
    .select({
      messages: sql<number>`count(*)`,
      lastSeen: sql<number | null>`max(${pmsSeatMessages.receivedAt})`,
    })
    .from(pmsSeatMessages)
    .where(
      and(
        eq(pmsSeatMessages.organizationId, organizationId),
        eq(pmsSeatMessages.disposition, "unauthenticated"),
      ),
    );

  const [verified] = await db
    .select({ messages: sql<number>`count(*)` })
    .from(pmsSeatMessages)
    .where(
      and(
        eq(pmsSeatMessages.organizationId, organizationId),
        eq(pmsSeatMessages.disposition, "verified"),
      ),
    );

  return {
    held: heldRows
      // A held row always has an authenticated domain — the disposition is
      // defined by having one. Filtered rather than asserted so a malformed row
      // drops out of a customer-facing list instead of throwing in it.
      .filter((row): row is typeof row & { domain: string } => typeof row.domain === "string")
      .map((row) => ({
        domain: row.domain,
        method: row.method,
        messages: Number(row.messages),
        firstSeen: new Date(Number(row.firstSeen)),
        lastSeen: new Date(Number(row.lastSeen)),
      })),
    unauthenticated: {
      messages: Number(unauthenticated?.messages ?? 0),
      lastSeen: unauthenticated?.lastSeen ? new Date(Number(unauthenticated.lastSeen)) : null,
    },
    verified: Number(verified?.messages ?? 0),
  };
}

/**
 * Per-disposition counts for one workspace.
 *
 * Org-scoped like everything else in `lib/pms`, which `tests/org-scoping-isolation.test.ts`
 * enforces by reading these sources. On D1 there is no row-level security, so
 * a convenience query without an organization filter is the whole failure mode
 * that test exists to catch — and "it is only for diagnostics" is an assumption
 * about callers that nothing in the code holds.
 */
export async function seatMessageCounts(organizationId: string): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({ disposition: pmsSeatMessages.disposition, messages: sql<number>`count(*)` })
    .from(pmsSeatMessages)
    .where(eq(pmsSeatMessages.organizationId, organizationId))
    .groupBy(pmsSeatMessages.disposition);
  return Object.fromEntries(rows.map((row) => [row.disposition, Number(row.messages)]));
}
