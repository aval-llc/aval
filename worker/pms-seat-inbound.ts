/**
 * The Aval seat's inbound mailbox — stub (docs/PMS_INTEGRATION.md, P0.0 step 3).
 *
 * This is the read half of the whole design. A customer adds Aval as a user in
 * their PMS with one of these addresses, and the PMS then mails it work-order
 * assignments, resident messages and notices exactly as it would any employee.
 * No API, no partnership, no polling: AppFolio sends, we receive. That is why
 * `generic_email` works for a PMS nobody has ever heard of.
 *
 * Deliberately a stub. It logs the recipient, stores the raw message to R2 keyed
 * by content hash, and returns. **No parsing.**
 *
 * That restraint is the point, not an unfinished edge. These addresses are
 * discoverable and anyone can send to them claiming to be AppFolio — inbound
 * sender verification (SPF/DKIM/DMARC alignment against a per-org allowlist) is
 * P1. Until it exists, a parser here would be an unauthenticated path from a
 * stranger's email straight into an agent's context. Storing and not reading is
 * the only safe shape for this worker today.
 *
 * Routing cannot target a Worker that does not exist, so this deploys before the
 * catch-all rule is pointed at it.
 *
 * ## Why this Worker filters recipients itself
 *
 * Seat addresses are `agent-{orgSlug}@aval.llc` — local parts on the apex, not a
 * subdomain. Cloudflare Email Routing matches literal local parts or nothing:
 * there is no `agent-*` wildcard rule (see docs/PMS_INTEGRATION_DISCOVERY.md).
 * So the only rule that can deliver an address nobody pre-registered is the
 * zone's **catch-all**, and a catch-all hands this Worker *every* unmatched
 * message to the domain — a typo of a colleague's name, a scrape of the WHOIS
 * contact, a spam run against common local parts.
 *
 * That makes the check below a security boundary, not a convenience. Under the
 * earlier (abandoned) subdomain design, Cloudflare's rule engine was the filter
 * and this Worker only ever saw seat mail. On the apex-prefix path the rule
 * engine cannot distinguish seat mail from anything else, and this function is
 * the only thing that can. It runs before the body is read, so a message that is
 * not addressed to a seat is never buffered and never stored.
 */

export interface SeatEnv {
  /** Raw inbound messages, pending verification. Never read by the agent runtime. */
  PMS_SEAT_INBOX: R2Bucket;
}

/**
 * Cloudflare's Email Workers message shape. Declared locally rather than
 * imported because `@cloudflare/workers-types` does not ship `ForwardableEmailMessage`
 * in the version this project pins.
 */
interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  setReject(reason: string): void;
}

/** Messages above this are rejected rather than stored. A PMS notice is small. */
const MAX_RAW_BYTES = 5 * 1024 * 1024;

/**
 * What counts as a seat address is defined once, in a module the app imports
 * too (`lib/pms/inbound/seat-address.ts`). A private copy here would drift the
 * first time the slug rules changed, and the drift is the expensive kind: the
 * app issues an address, the Worker rejects it, and the customer's PMS looks
 * like the thing that is broken.
 *
 * Still a shape check and nothing more. This Worker has no database, so it
 * cannot ask whether a slug was ever issued. `agent-notarealorg@aval.llc` is
 * stored under its own key and belongs to no workspace — inert, because
 * resolving a recipient to an organization happens after sender verification.
 * Accepting mail for the whole domain would not be inert.
 */
import { seatSlugOf } from "../lib/pms/inbound/seat-address.ts";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * What happens to a message that reached this Worker but is not seat mail.
 *
 * Under the catch-all this is the disposition for *every* misaddressed message
 * to aval.llc, so it is a policy call rather than a detail. Two honest options:
 *
 *   - `setReject(reason)` returns a permanent SMTP error, so the human who typed
 *     `evna@aval.llc` gets a bounce and can correct it. This is also what the
 *     zone does today with the catch-all disabled, which means enabling the
 *     catch-all changes nothing observable for non-seat mail. The cost is that a
 *     bounce confirms which addresses do not exist, so someone probing the
 *     domain learns `agent-acme@` is real and `agent-xyz@` is not.
 *   - Returning silently drops the message. No enumeration signal, but a real
 *     person's typo vanishes with no bounce.
 *
 * Rejecting, because this Worker is being inserted into the path of a domain
 * that already carries human mail, and the safest change to make to a working
 * mail domain is the one nobody can observe. Seat addresses are handed to
 * customers to type into a PMS anyway — they are not secret, so the enumeration
 * the bounce leaks is information Aval publishes on purpose.
 *
 * Reversing this is one line, and the decision should be revisited if the seat
 * addresses ever stop being customer-facing.
 */
function disposeOfNonSeatMail(message: ForwardableEmailMessage, recipient: string): void {
  // Deliberately not logged at info level with the full address: under a
  // catch-all this fires for every spam run against the domain, and the log
  // would become a list of addresses strangers guessed. The local part is
  // enough to tell a typo from a probe.
  console.log(`[pms-seat] rejected non-seat recipient ${recipient.split("@")[0].slice(0, 32)}`);
  message.setReject("No such recipient at this domain.");
}

export default {
  async email(message: ForwardableEmailMessage, env: SeatEnv): Promise<void> {
    // First, before anything is read. A message that is not addressed to a seat
    // must not be buffered, hashed or stored — under the catch-all this is the
    // only check that distinguishes seat mail from the rest of the domain.
    const recipient = message.to.toLowerCase();
    const orgSlug = seatSlugOf(recipient);
    if (orgSlug === null) {
      disposeOfNonSeatMail(message, recipient);
      return;
    }

    if (message.rawSize > MAX_RAW_BYTES) {
      message.setReject("Message too large for the Aval seat mailbox.");
      return;
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = message.raw.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_RAW_BYTES) {
          await reader.cancel();
          message.setReject("Message too large for the Aval seat mailbox.");
          return;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const raw = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.length;
    }

    // Content hash as the key: a PMS that sends the same notice twice writes the
    // same object twice, which is a no-op rather than a duplicate to de-dupe
    // later. Same dedupe-on-primary-key discipline as `integration_events`.
    const digest = await sha256Hex(raw);

    const key = `unverified/${recipient}/${digest}`;

    await env.PMS_SEAT_INBOX.put(key, raw as unknown as ArrayBuffer, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        // Envelope facts only. Every one of these is attacker-controlled and is
        // recorded as a claim, never as an established fact.
        claimedFrom: message.from.slice(0, 320),
        recipient,
        // The slug the address claims. Not resolved to an organization here —
        // there is no slug column to resolve it against, and resolution is P1's
        // job anyway, after sender verification.
        claimedOrgSlug: orgSlug,
        receivedAt: new Date().toISOString(),
        // Recorded for P1's verification pass to evaluate. Not evaluated here.
        authenticationResults: (message.headers.get("authentication-results") ?? "").slice(0, 1000),
        verified: "false",
      },
    });

    // The full key, not a digest prefix. R2 has no list operation in wrangler —
    // `r2 object get` takes an exact path — so a truncated hash here would mean
    // a stored message nobody can retrieve. The key is a content hash and a
    // recipient, both already known to whoever sent the message; the body,
    // which is unverified content, is never logged.
    console.log(`[pms-seat] stored ${key} (${size} bytes)`);
  },
};
