import type { ProviderDescriptor } from "../types.ts";

/**
 * Buildium — open API, endpoint-level scoping, no automation prohibition.
 *
 * Writes are permitted and supported; what does not exist yet is our adapter for
 * them. That distinction is the reason `unlearned` is a separate state: a
 * Buildium customer is not blocked by anyone's policy, they are waiting on us.
 */
export const buildium: ProviderDescriptor = {
  id: "buildium",
  displayName: "Buildium",

  // Suggested during setup, never trusted: only a confirmed row in
  // pms_seat_senders lets mail from here be read.
  senderDomains: ["buildium.com"],

  read: {
    mechanisms: ["api"],
    supported: true,
    permitted: true,
    note: "Server-to-server authentication using Buildium's required client headers.",
  },

  write: {
    mechanisms: ["api"],
    runner: "cloud",
    supported: true,
    permitted: true,
    note: "Buildium scopes per endpoint, so a narrow key is genuinely narrow — prefer it over a broad one.",
  },
};
