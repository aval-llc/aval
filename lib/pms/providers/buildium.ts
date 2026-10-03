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
    mechanisms: ["api", "manual_export"],
    supported: true,
    permitted: true,
    note: "Server-to-server authentication using Buildium's required client headers.",
  },

  write: {
    // The official API remains a future route. The first executable route is
    // the supervised customer Desktop session, so it is first and therefore
    // selected by capability resolution until an API adapter is certified.
    mechanisms: ["ui", "api"],
    runner: "desktop",
    supported: true,
    permitted: true,
    note: "The pilot uses a restricted staff session on the customer's Desktop. An official API adapter can replace it when that account has API entitlement.",
  },
};
