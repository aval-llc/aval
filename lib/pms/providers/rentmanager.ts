import type { ProviderDescriptor } from "../types.ts";

/**
 * Rent Manager — permitted, but gated behind program enrollment.
 *
 * Note carefully that this is `permitted: true`. The Integrations Program does
 * allow what we want to do; we are simply not enrolled. That is a *grant* fact,
 * discovered per connection, not a terms prohibition — so a Rent Manager
 * customer sees "requires Rent Manager integration credentials" and not
 * "prohibited", because those are different sentences with different owners.
 */
export const rentmanager: ProviderDescriptor = {
  id: "rentmanager",
  displayName: "Rent Manager",

  read: {
    mechanisms: ["api"],
    supported: true,
    permitted: true,
    note: "Requires enrollment in Rent Manager's Integrations Program rather than a public self-serve key.",
  },

  write: {
    mechanisms: ["api"],
    runner: "cloud",
    supported: true,
    permitted: true,
    note: "Write scope depends on what the issued partner credential carries. Grant discovery decides, not this file.",
  },
};
