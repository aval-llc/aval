/**
 * The Aval seat's reader — the component that decides whether stored mail may
 * be read (docs/PMS_INTEGRATION.md, P1).
 *
 * Three Workers, and the split is the security design rather than tidiness:
 *
 *   - `aval-pms-seat-inbound` handles live SMTP from strangers. No database, no
 *     parsing, no HTTP surface. It stores bytes.
 *   - `aval` (the app) serves authenticated users. No handle on the unverified
 *     inbox — `d9210f8` removed one that had been pasted in.
 *   - this, on a schedule. The only component holding both, and its input is
 *     already-stored bytes rather than a live conversation with a sender.
 *
 * So the crossing happens in one place, on a cron, with no public surface, and
 * neither of the other two has to be widened to make the seat work.
 *
 * Deploy:  npx wrangler deploy --config wrangler.reader.jsonc
 */

import { sweepSeatInbox, type SeatBucket } from "../lib/pms/inbound/sweep.ts";

export interface ReaderEnv {
  /** The unverified inbox the mail Worker writes. Read, moved, never forwarded. */
  PMS_SEAT_INBOX: R2Bucket;
  /** The app's database. `getDb()` reads this binding by name. */
  DB: D1Database;
  /**
   * The authserv-id the receiving MTA stamps on `Authentication-Results`.
   *
   * A var rather than a constant because Cloudflare does not document the value
   * and it is the one input that silently changes what this Worker concludes: a
   * wrong id means every message fails closed, which looks exactly like an inbox
   * nobody has written to. `pms_seat_messages.observed_authserv_ids` is recorded
   * for that case, and a missing var throws below rather than defaulting.
   */
  PMS_SEAT_AUTHSERV_ID?: string;
  /** Objects per run. Raise it to work through a backlog faster. */
  PMS_SEAT_SWEEP_LIMIT?: string;
}

export default {
  async scheduled(_event: ScheduledController, env: ReaderEnv): Promise<void> {
    const authservId = env.PMS_SEAT_AUTHSERV_ID?.trim();
    if (!authservId) {
      // Deliberately fatal. Defaulting would make every message unauthenticated
      // and the cron would report success while verifying nothing, which is the
      // failure this whole path is shaped to avoid.
      throw new Error(
        "PMS_SEAT_AUTHSERV_ID is not set. The reader cannot verify senders without the "
        + "authserv-id the receiving MTA stamps, and must not fall back to trusting the message.",
      );
    }

    const limit = Number(env.PMS_SEAT_SWEEP_LIMIT ?? "");
    const summary = await sweepSeatInbox({
      bucket: env.PMS_SEAT_INBOX as unknown as SeatBucket,
      authservId,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });

    // One line, all counts, no message content: this log is the evidence that
    // the sweep ran, and it is read when a customer says their PMS mail is not
    // arriving. Bodies and claimed senders are never logged.
    console.log(
      `[pms-seat-reader] processed=${summary.processed} verified=${summary.verified} `
      + `held=${summary.held} unauthenticated=${summary.unauthenticated} `
      + `unassigned=${summary.unassigned} promoted=${summary.promoted} `
      + `failed=${summary.failed} truncated=${summary.truncated}`,
    );

    if (summary.observedAuthservIds.length > 0) {
      // Only when something failed to authenticate. This is the line that
      // answers "is the expected authserv-id simply wrong", which otherwise
      // looks exactly like an inbox nobody has written to. Logged rather than
      // queried back out, so `lib/pms` stays uniformly org-scoped.
      console.log(
        `[pms-seat-reader] expected authserv-id ${authservId}; observed on unauthenticated mail: `
        + summary.observedAuthservIds.join(", "),
      );
    }

    if (summary.failed > 0) {
      // Surfaced as a failed cron run rather than a quiet counter. The objects
      // are still in place and the next run retries them, but a persistent
      // failure has to be visible somewhere that is watched.
      throw new Error(`${summary.failed} seat message(s) could not be processed; they remain in the inbox.`);
    }
  },
};
