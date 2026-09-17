import type { ProviderDescriptor } from "../types.ts";

/**
 * Yardi Voyager / Breeze — permitted under a signed per-interface agreement.
 *
 * Same shape as Rent Manager: the program permits it, we need the agreement and
 * the interface credentials. `permitted: true` with the enrollment surfaced as a
 * grant, because calling this "prohibited" would misdescribe a negotiation as a
 * legal wall and quietly kill a sales conversation.
 */
export const yardi: ProviderDescriptor = {
  id: "yardi",
  displayName: "Yardi Voyager",

  read: {
    mechanisms: ["api"],
    supported: true,
    permitted: true,
    note: "Requires approved Yardi Interface Partner status and a signed per-interface agreement. No self-serve signup.",
  },

  write: {
    mechanisms: ["api"],
    runner: "cloud",
    supported: true,
    permitted: true,
    note: "Each Yardi interface is licensed separately; a read interface does not imply a write interface.",
  },
};
