import type { ProviderDescriptor } from "../types.ts";

/**
 * Entrata — signed API Developer Interface Agreement plus IP allowlisting.
 *
 * The allowlist is the reason a future Entrata write stays `runner: 'cloud'`
 * even though desktop is our default posture for anything sensitive: Entrata
 * only accepts calls from addresses it knows, and a property manager's laptop
 * is not one of them. This is the case where cloud is the *safer* answer.
 */
export const entrata: ProviderDescriptor = {
  id: "entrata",
  displayName: "Entrata",

  // Suggested during setup, never trusted: only a confirmed row in
  // pms_seat_senders lets mail from here be read.
  // Enterprise deployments often send under the management company's own
  // domain, so this suggestion will be wrong as often as right. The held-sender
  // review is what tells an operator the domain their tenant actually uses.
  senderDomains: ["entrata.com"],

  read: {
    mechanisms: ["api"],
    supported: true,
    permitted: true,
    note: "Requires a signed API Developer Interface Agreement and IP allowlisting before any credential works.",
  },

  write: {
    mechanisms: ["api"],
    runner: "cloud",
    supported: true,
    permitted: true,
    note: "IP allowlisting means writes must originate from our egress, not a customer machine.",
  },
};
