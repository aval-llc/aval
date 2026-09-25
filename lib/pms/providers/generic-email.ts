import type { ProviderDescriptor } from "../types.ts";

/**
 * The universal fallback: any PMS that can send mail.
 *
 * This is what makes the seat genuinely provider-agnostic. A system we have
 * never heard of, with no API and no partnership, can still copy the seat
 * address on notifications — and the moment it does, that customer gets the
 * unified read envelope and the reporting workflow.
 *
 * It has no write surface at all, which is why `supported: false` rather than
 * `permitted: false`. There is nothing here to prohibit. An operator sees
 * "not available for this system" and no clause, because quoting a clause would
 * imply a path exists that someone is forbidding.
 */
export const genericEmail: ProviderDescriptor = {
  id: "generic_email",
  displayName: "Other (email notifications)",

  read: {
    mechanisms: ["notification"],
    supported: true,
    permitted: true,
    note:
      "Works with any PMS that can copy an address on outbound notifications. "
      + "Inbound only, and unverified mail is stored without being parsed — anyone can "
      + "send to a seat address claiming to be a PMS.",
  },

  write: {
    // Inert: no mechanism, so `runner` is never consulted. Kept concrete rather
    // than optional so no call site has to handle an absent runner.
    mechanisms: [],
    runner: "desktop",
    supported: false,
    permitted: false,
    reason: "Notification capture has no write surface. Connect a supported PMS to enable writes.",
  },
};
