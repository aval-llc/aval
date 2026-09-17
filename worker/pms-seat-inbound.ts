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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async email(message: ForwardableEmailMessage, env: SeatEnv): Promise<void> {
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
    const recipient = message.to.toLowerCase();

    await env.PMS_SEAT_INBOX.put(`unverified/${recipient}/${digest}`, raw as unknown as ArrayBuffer, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        // Envelope facts only. Every one of these is attacker-controlled and is
        // recorded as a claim, never as an established fact.
        claimedFrom: message.from.slice(0, 320),
        recipient,
        receivedAt: new Date().toISOString(),
        // Recorded for P1's verification pass to evaluate. Not evaluated here.
        authenticationResults: (message.headers.get("authentication-results") ?? "").slice(0, 1000),
        verified: "false",
      },
    });

    // The recipient is the routing key that tells P1 which workspace this
    // belongs to. Logged without the body, which is unverified content.
    console.log(`[pms-seat] stored unverified message for ${recipient} (${size} bytes, ${digest.slice(0, 12)})`);
  },
};
