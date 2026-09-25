/**
 * What a seat address is — the one definition, shared by both ends.
 *
 * `worker/pms-seat-inbound.ts` decides which recipients it will accept, and the
 * app decides which slugs it will issue. If those two disagree, the app hands a
 * customer an address that the Worker silently rejects, and the failure shows up
 * as a PMS integration that "just doesn't send anything" — which is the most
 * expensive kind of bug this system can have, because it looks like the
 * customer's PMS is at fault.
 *
 * So both import this. No dependencies, deliberately: the Worker is bundled
 * separately by wrangler and must be able to pull this in without dragging the
 * app's module graph into an isolate that handles unverified mail.
 *
 * Addresses are `agent-{slug}@aval.llc`. The slug is chosen by an operator
 * during setup and is **permanent**: once a customer has typed it into their
 * PMS, the address is out of our control. A workspace that renames gets an
 * additional slug; it never gives one up, and no slug is ever issued twice.
 * `organization_seat_slugs` enforces that by construction — `slug` is its
 * primary key and rows are never deleted.
 */

export const SEAT_DOMAIN = "aval.llc";
export const SEAT_LOCAL_PREFIX = "agent-";

/**
 * Lowercase alphanumerics and internal hyphens, 3–40 characters.
 *
 * Narrow on purpose. Widening it later costs one line; having issued addresses
 * that a stricter rule would reject is not reversible, because the customer's
 * PMS already has them. Three characters minimum so a typo of a real slug is
 * unlikely to be another real slug.
 */
export const SEAT_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

/**
 * Local parts nobody may claim, because a message to one is probably meant for
 * a person or a system rather than a seat.
 *
 * Reserved against the *slug*, so `agent-support@aval.llc` cannot be issued.
 * This is a small list and not a security control — the Worker's recipient check
 * and the workspace allowlist are. It exists so an operator cannot pick
 * something that will confuse their own staff.
 */
const RESERVED: ReadonlySet<string> = new Set([
  "admin", "support", "help", "billing", "security", "abuse", "postmaster",
  "noreply", "no-reply", "test", "aval", "agent", "root", "info", "sales",
]);

export type SlugRejection = "shape" | "reserved";

/** Why a slug cannot be issued, or null if it can. */
export function slugRejection(slug: string): SlugRejection | null {
  if (!SEAT_SLUG.test(slug)) return "shape";
  if (RESERVED.has(slug)) return "reserved";
  return null;
}

/** Words for a rejection, for the setup field that shows them. */
export function describeSlugRejection(rejection: SlugRejection): string {
  return rejection === "reserved"
    ? "That name is reserved. Pick something specific to your organization."
    : "Use 3–40 lowercase letters, numbers and hyphens, starting and ending with a letter or number.";
}

/** The address a customer types into their PMS. */
export function seatAddress(slug: string): string {
  return `${SEAT_LOCAL_PREFIX}${slug}@${SEAT_DOMAIN}`;
}

/**
 * The slug an envelope recipient names, or null if it is not a seat address.
 *
 * This is the Worker's accept/reject decision. It deliberately does **not**
 * check whether the slug was ever issued: the Worker has no database, and
 * resolving a slug to a workspace is a later step that happens after sender
 * verification. Storing mail for an unissued slug is inert; accepting mail for
 * the whole domain would not be.
 */
export function seatSlugOf(recipient: string): string | null {
  const address = recipient.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 0 || address.slice(at + 1) !== SEAT_DOMAIN) return null;
  const local = address.slice(0, at);
  if (!local.startsWith(SEAT_LOCAL_PREFIX)) return null;
  const slug = local.slice(SEAT_LOCAL_PREFIX.length);
  // Shape only — a reserved slug was never issuable, so mail addressed to one
  // is not seat mail either.
  return slugRejection(slug) === null ? slug : null;
}
