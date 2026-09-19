/**
 * Decide one stored seat message on behalf of the reader Worker.
 *
 * The seat is split across three Workers on purpose (worker/pms-seat-reader.ts):
 * the mail Worker stores bytes and holds no database, the app serves
 * authenticated users and holds no handle on the unverified inbox, and the
 * reader runs on a cron between them. Moving the app onto Postgres removed the
 * reader's own database binding, so the two halves of a decision now meet here
 * instead of inside the reader.
 *
 * What crosses the wire is one message the reader is asking about — never a
 * handle on the bucket. This route cannot list the inbox, cannot read a message
 * it was not handed, and returns the key the object should end up under rather
 * than moving anything itself. The reader performs the move.
 */

import { adjudicateSeatMessage } from "@/lib/pms/inbound/adjudicate";
import { intakeEvent } from "@/lib/agents/intake";
import type { VerifiedMessage } from "@/lib/pms/inbound/promote";
import { promoteVerifiedMessage } from "@/lib/pms/inbound/promote";
import { withSystemSession } from "@/lib/api/with-session";
import { runtimeBindings } from "@/lib/runtime/bindings";
import { constantTimeEqual } from "@/lib/security/constant-time";

const UNAUTHORIZED = Response.json(
  { error: "Unauthorized" },
  { status: 401, headers: { "cache-control": "no-store" } },
);

export async function POST(request: Request): Promise<Response> {
  // Trimmed because the reader trims too, and `wrangler secret put` keeps
  // whatever it was handed — a piped value with a trailing newline would
  // otherwise store fine on both Workers and fail only as a 401 nobody can
  // account for.
  const configured = runtimeBindings().PMS_SEAT_READER_TOKEN;
  const expected = typeof configured === "string" ? configured.trim() : configured;
  if (typeof expected !== "string" || expected.length === 0) {
    // Fail closed. An unset token must not read as "no authentication
    // required" on the one route that writes rows on a Worker's say-so.
    return Response.json(
      { error: "The seat reader token is not configured." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!constantTimeEqual(presented, expected)) return UNAUTHORIZED;

  const body = (await request.json().catch(() => null)) as {
    digest?: unknown;
    recipient?: unknown;
    fallbackRecipient?: unknown;
    raw?: unknown;
    authservId?: unknown;
    currentKey?: unknown;
    receivedAt?: unknown;
  } | null;

  const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  const digest = text(body?.digest);
  const raw = typeof body?.raw === "string" ? body.raw : null;
  const authservId = text(body?.authservId);
  const currentKey = text(body?.currentKey);
  const receivedAtMs = typeof body?.receivedAt === "number" ? body.receivedAt : null;

  // The authserv-id is the reader's, not the message's. Defaulting it would
  // make every message authenticate against a value nobody chose.
  if (!digest || raw === null || !authservId || !currentKey || receivedAtMs === null) {
    return Response.json(
      { error: "digest, raw, authservId, currentKey and receivedAt are required." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const decision = await withSystemSession("worker", (session) =>
    adjudicateSeatMessage(session, {
      digest,
      recipient: text(body?.recipient),
      fallbackRecipient: text(body?.fallbackRecipient),
      raw,
      authservId,
      currentKey,
      receivedAt: new Date(receivedAtMs),
      promote: (message: VerifiedMessage) => promoteVerifiedMessage(session, message),
    }),
  );

  // The join. Adjudication ends at a recorded row; without this the message is
  // stored and never actioned. Only a verified, captured message creates work —
  // `intakeEvent` re-checks that itself, so this condition is a fast path and
  // not the control. Intake is keyed on the message digest, so the reader
  // retrying a sweep reaches the same task instead of opening a second one.
  let intake: { status: string; taskId?: string; reason?: string } | undefined;
  if (decision.disposition === "verified" && decision.captured && decision.organizationId) {
    const outcome = await withSystemSession("worker", (session) =>
      intakeEvent(session, {
        organizationId: decision.organizationId as string,
        source: "pms_seat_email",
        sourceId: digest,
        trustState: "verified",
        goal: `A verified message arrived in the PMS seat mailbox (${digest.slice(0, 12)}). Establish what operational work it represents, confirm the affected property, unit and resident from authorized records rather than from the message text, and coordinate the specialist that owns it through to a verified outcome.`,
      }),
    );
    intake = outcome.status === "refused"
      ? { status: outcome.status, reason: outcome.reason }
      : { status: outcome.status, taskId: outcome.task.id };
  }

  return Response.json({ ...decision, intake }, { headers: { "cache-control": "no-store" } });
}
