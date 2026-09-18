import type { ProviderDescriptor } from "../types.ts";

/**
 * RealPage — Exchange partner program, sales-led.
 *
 * Descriptor exists so RealPage is resolved by the same matrix as every other
 * provider. Leaving it catalog-only would recreate the split-brain this layer
 * replaced, where one file said "read only" and another said "unavailable" and
 * neither was enforced.
 */
export const realpage: ProviderDescriptor = {
  id: "realpage",
  displayName: "RealPage",

  // Suggested during setup, never trusted: only a confirmed row in
  // pms_seat_senders lets mail from here be read.
  // Same caveat as Entrata: a large tenant's mail may carry its own domain.
  senderDomains: ["realpage.com"],

  read: {
    mechanisms: ["api"],
    supported: true,
    permitted: true,
    note: "Access granted only through the RealPage Exchange partner program. Sales-led, not self-serve.",
  },

  write: {
    mechanisms: ["api"],
    runner: "cloud",
    supported: true,
    permitted: true,
    note: "Exchange scopes vary per contracted product set. Grant discovery is the only reliable source.",
  },
};
