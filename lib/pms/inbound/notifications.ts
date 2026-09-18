/**
 * Verified seat mail becoming operational data — P1.1's ingestion half.
 *
 * Two layers, and the split is the honest part:
 *
 *   - **The envelope is captured.** Every verified message is normalized by
 *     `mime.ts` and written to `integration_events`, keyed so it can never be
 *     written twice. This is standardised mail structure, not anyone's guess,
 *     and it is durable: when a vendor's format is learned later, the history is
 *     still here to re-read, and the raw message is still in R2 besides.
 *   - **Entity extraction is per provider, and no provider has one.** Turning
 *     "AppFolio work order assigned" into an `ImportBatch` of properties, units
 *     and work orders requires knowing AppFolio's notification layout. Nobody
 *     here has seen one. A parser written from an educated guess would be a
 *     fabricated vendor format that happens to typecheck, and its failures would
 *     be silent — fields quietly absent, a work order attached to the wrong
 *     unit. So the registry below is empty and a message resolves to `unlearned`,
 *     the same word this codebase already uses for a path it has not been taught
 *     (`pms_action_flows`, and the `unlearned` capability state).
 *
 * `unlearned` is not a failure. The message is verified, captured, queryable and
 * re-processable. What is missing is named, and it is missing in one place.
 */

import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationEvents } from "@/db/postgres/schema";
import { parseMessage, type ParsedMessage } from "./mime.ts";

/** What a per-provider parser would receive. Declared now so the seam is typed. */
export interface NotificationContext {
  organizationId: string;
  providerId: string;
  digest: string;
  message: ParsedMessage;
}

/**
 * What a per-provider parser would return: entities for
 * `lib/operations/import-plan.ts`, or nothing it could recognise.
 *
 * Deliberately not `ImportBatch` yet. Committing to that shape from zero real
 * samples would be designing the interface around a format nobody has read.
 */
export interface NotificationExtraction {
  recognised: boolean;
  /** What kind of notification this is, once a parser can say. */
  kind?: string;
  reason: string;
}

export type NotificationParser = (context: NotificationContext) => Promise<NotificationExtraction>;

/**
 * Per-provider notification parsers.
 *
 * Empty, and the emptiness is the point — see the module note. A provider
 * graduates in here when someone has a real message from it, the same way a
 * provider graduates out of `providers/unassessed.ts` when someone has actually
 * read its terms.
 */
const PARSERS: ReadonlyMap<string, NotificationParser> = new Map();

export function notificationParser(providerId: string): NotificationParser | undefined {
  return PARSERS.get(providerId);
}

export interface CapturedNotification {
  /** The `integration_events` row id, existing or newly written. */
  eventId: string;
  /** False when this exact message had already been captured. */
  created: boolean;
  extraction: NotificationExtraction;
  message: ParsedMessage;
}

/**
 * The event key.
 *
 * `integration_events` is unique on `(provider, external_event_id)` and **not**
 * on the organization, so a content hash alone would be a cross-tenant bug: two
 * workspaces can receive the same vendor notice — the same bytes, the same
 * digest — and the second capture would be silently dropped as a duplicate. The
 * workspace is part of the key for that reason and no other.
 */
export function seatEventId(organizationId: string, digest: string): string {
  return `seat:${organizationId}:${digest}`;
}

/** The normalized envelope, sized for a row rather than for an archive. */
function payloadOf(message: ParsedMessage, digest: string, objectKey: string) {
  return {
    digest,
    // Where the raw message still is. A parser written later starts here.
    objectKey,
    subject: message.subject?.slice(0, 500) ?? null,
    // The sender's own claim about itself. Kept because a workflow needs to
    // show it, and labelled because verification lives on the allowlist row,
    // not in this string.
    claimedFrom: message.from?.slice(0, 320) ?? null,
    sentAt: message.date?.toISOString() ?? null,
    messageId: message.messageId?.slice(0, 500) ?? null,
    text: message.text?.slice(0, 16 * 1024) ?? null,
    // Deliberately not the HTML body: it is the same content in a form nothing
    // downstream reads, and it is the bulky half of most notifications.
    hasHtml: message.html !== null,
    attachments: message.attachments.slice(0, 20),
    truncated: message.truncated,
  };
}

/**
 * Capture a verified message, and ask its provider's parser to read it.
 *
 * Idempotent: re-capturing writes nothing and reports `created: false`, so the
 * sweep re-reading a message after a provider change or a redeploy cannot
 * duplicate an event.
 */
export async function captureNotification(dbSession: DbSession, options: {
  organizationId: string;
  providerId: string;
  digest: string;
  objectKey: string;
  raw: string;
  /**
   * Overrides the registry lookup.
   *
   * Injected the same way the sweep takes `promote`, rather than exposing a
   * mutable registry: a global a test can write to is a global that leaks
   * between tests, and this one would decide how a customer's mail is read.
   */
  parser?: NotificationParser;
}): Promise<CapturedNotification> {
  const { organizationId, providerId, digest, objectKey, raw } = options;
  const message = parseMessage(raw);
  const externalEventId = seatEventId(organizationId, digest);

  const [existing] = await dbSession.db
    .select({ id: integrationEvents.id })
    .from(integrationEvents)
    // The organization is in `externalEventId` already, so this filter is
    // redundant by construction — and redundant by construction is exactly the
    // kind of scoping that breaks when someone changes how the key is built.
    // It also keeps the scoping visible in SQL rather than only inside a
    // template string, which is what `tests/org-scoping-isolation.test.ts` reads.
    .where(and(
      eq(integrationEvents.organizationId, organizationId),
      eq(integrationEvents.externalEventId, externalEventId),
    ))
    .limit(1);

  const parser = options.parser ?? notificationParser(providerId);
  const extraction = parser
    ? await parser({ organizationId, providerId, digest, message })
    : {
      recognised: false,
      reason:
        `No ${providerId} notification parser yet (P1.1). The message is captured and can be re-read once `
        + "one exists.",
    };

  if (existing) return { eventId: existing.id, created: false, extraction, message };

  const eventId = crypto.randomUUID();
  await dbSession.db
    .insert(integrationEvents)
    .values({
      id: eventId,
      organizationId,
      provider: providerId,
      externalEventId,
      // Names both what it is and what happened to it. A later parser changes
      // the status, not the event type.
      eventType: "seat.notification",
      payloadJson: JSON.stringify(payloadOf(message, digest, objectKey)),
      // `received`, not `processed`: nothing has extracted entities from it.
      // Claiming otherwise would make the backlog invisible.
      status: extraction.recognised ? "processed" : "received",
      receivedAt: message.date ?? new Date(),
    })
    // Two sweeps racing on the same message is a no-op rather than a violation.
    .onConflictDoNothing();

  return { eventId, created: true, extraction, message };
}
