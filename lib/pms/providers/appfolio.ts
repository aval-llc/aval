import type { ProviderDescriptor } from "../types.ts";

/**
 * AppFolio — the provider this whole layer exists to describe honestly.
 *
 * The read half needs no API and no partnership. Adding Aval as a staff user
 * gives the seat an address inside the customer's AppFolio, and AppFolio then
 * mails it work-order assignments, resident messages and notifications exactly
 * as it would any employee. We receive; we never poll.
 *
 * The write half is technically identical to what a person does — a signed-in
 * staff session, clicking — and that is precisely why `supported` is true and
 * `permitted` is false. A competitor ships this today by storing the customer's
 * credentials and driving the UI from their own infrastructure. We are not
 * copying that, for two reasons: AppFolio's Core terms appear to forbid it, and
 * the customer is the party who signed those terms, so the breach risk would
 * land on our design partner rather than on us.
 *
 * `runner: 'desktop'` is the structural answer to the second problem. If a
 * customer ever signs an authorization for this, the clicking happens in the
 * Electron shell on their machine, in the session they are already signed into.
 * Aval never holds an AppFolio password.
 */
export const appfolio: ProviderDescriptor = {
  id: "appfolio",
  displayName: "AppFolio",

  read: {
    mechanisms: ["notification", "manual_export"],
    supported: true,
    permitted: true,
    note:
      "Inbound mail to the seat address. AppFolio sends, we receive, nothing polls. "
      + "The Database API would be richer but needs Property Manager Max plus Stack "
      + "approval, so notification capture is the path that works for every customer today.",
  },

  write: {
    mechanisms: ["ui"],
    runner: "desktop",
    supported: true,
    permitted: false,
    reason:
      "AppFolio Core terms 5.4(ix) prohibit using \"any robot, spider, or other automated "
      + "device, process or means to access, retrieve, scrape or index any portion of the "
      + "Services\". 5.4(ii) prohibits making the Services available to a third party, and "
      + "5.4(xi) restricts access by AppFolio's direct or indirect competitors — AppFolio "
      + "sells Realm-X, so an AI agent vendor plausibly qualifies. "
      + "Clause text retrieved from secondary sources on 2026-09-16 and NOT yet read against "
      + "the live agreement by counsel. VERIFY before this field changes.",
    override: "signed_authorization",
  },
};
