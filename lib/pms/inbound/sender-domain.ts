/**
 * What an operator may type into the "senders allowed to write to this seat"
 * field — the pure half of the allowlist.
 *
 * Same split as `seat-address.ts` / `seats.ts`: what a sender domain *is* has no
 * database in it, and `senders.ts` does the reads and writes.
 *
 * Two things this is defending, and they pull in opposite directions:
 *
 *   - An entry that is too narrow costs a support ticket. The PMS starts sending
 *     from a new subdomain, mail stops being read, and the customer concludes
 *     their PMS is broken. `domainMatches` handles that by accepting subdomains,
 *     so an operator never has to predict `notifications.appfolio.com`.
 *   - An entry that is too broad costs the boundary itself. An allowlist entry
 *     is a standing grant that anything authenticating as that domain may put
 *     text into an agent's context, and the agent acts on what it reads. So the
 *     rejections below are not input validation in the form-field sense; each
 *     one is a grant somebody would regret making.
 *
 * Normalization is deliberately forgiving and rejection is deliberately not.
 * An operator pasting `https://mail.appfolio.com/` or `billing@appfolio.com`
 * meant `appfolio.com` and should not be made to hand-edit it; an operator
 * typing `com` meant something, but nothing we can safely guess.
 */

import { SEAT_DOMAIN } from "./seat-address.ts";

/**
 * A label is 1–63 characters of alphanumerics and internal hyphens; the last
 * one is alphabetic and at least two characters, so `1.2.3.4` and `localhost`
 * are not domains. Deliberately stricter than the RFCs: this is a field an
 * operator types a vendor's domain into, not a general-purpose parser.
 */
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Registry suffixes where the second level is still public, so an entry at that
 * level would cover unrelated organizations.
 *
 * Not the full Public Suffix List, and not pretending to be — pulling that in
 * would make this module depend on a data file that goes stale. It is the set
 * that shows up when someone enters a UK or Australian vendor domain one label
 * short, which is the mistake this catches. `shape` already rejects a bare
 * `com`, since it has no dot.
 */
const PUBLIC_SECOND_LEVEL: ReadonlySet<string> = new Set([
  "co", "com", "net", "org", "ac", "gov", "edu", "govt", "sch", "ltd", "plc", "me",
]);

/**
 * Consumer mailbox providers, where a domain is shared by everyone who signed
 * up for it.
 *
 * Allowlisting one of these does not grant a party; it grants a *population*.
 * Anyone with a Gmail account can then send DMARC-clean mail that this workspace
 * reads as its PMS, and no forgery is involved — the sender really is
 * gmail.com.
 */
const PUBLIC_MAILBOX: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com",
  "zoho.com", "yandex.com", "fastmail.com", "hey.com", "qq.com", "163.com",
]);

export type SenderDomainRejection = "shape" | "seat_domain" | "public_suffix" | "public_mailbox";

/**
 * What an operator typed, reduced to the domain they meant.
 *
 * Accepts a URL, a full email address, a `*.` wildcard or a leading `@`, because
 * all four are what people actually paste when asked for a sending domain. The
 * wildcard is stripped rather than honored as syntax: `domainMatches` already
 * covers subdomains, so `*.appfolio.com` and `appfolio.com` mean the same thing
 * and storing two spellings of one grant would make the list harder to audit.
 */
export function normalizeSenderDomain(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Everything after the authority is not part of a domain.
  value = value.split(/[/?#]/)[0];
  // A pasted mailbox, or a stray `@` from one.
  const at = value.lastIndexOf("@");
  if (at >= 0) value = value.slice(at + 1);
  value = value.replace(/:\d+$/, "");
  value = value.replace(/^\*?\./, "");
  value = value.replace(/\.$/, "");
  return value;
}

/**
 * Whether a consumer mailbox domain may be allowlisted. It may not — for any
 * provider, including `generic_email`.
 *
 * This was the open question on this module and it is now decided closed. The
 * case for an exemption was the smallest customer: a two-person management
 * company whose "PMS" is a person forwarding notices from Gmail. The case
 * against is that `gmail.com` on an allowlist is not a party, it is a
 * population — every Gmail user on earth may then write into that workspace's
 * agent context, DMARC-clean, with no forgery involved, and the operator who
 * ticked the box will not have read it that way.
 *
 * The small customer is served instead by granting the *mailbox*, not the
 * domain: see `senderAddressRejection` and the trust ladder in `senders.ts`.
 * An exact-address grant gives that workspace exactly the one person who
 * forwards its notices, and gives no one else anything.
 *
 * A named PMS never belonged here either — AppFolio does not send from Gmail,
 * so such a row is a mistake or an impersonation either way.
 */
export function publicMailboxRejection(domain: string): SenderDomainRejection | null {
  return PUBLIC_MAILBOX.has(domain) ? "public_mailbox" : null;
}

/**
 * The rejections that are about the *name*, shared by domain and address grants.
 *
 * Everything here disqualifies a name whatever kind of grant it is attached to:
 * `john@co.uk` is as meaningless as `co.uk`. The one rule not in here is the
 * consumer mailbox, which is exactly the rule that differs between the two —
 * see `senderAddressRejection`.
 */
function domainStructureRejection(domain: string): SenderDomainRejection | null {
  if (!DOMAIN.test(domain)) return "shape";

  // The seat's own domain. Mail that authenticates as aval.llc is either our own
  // forwarding or something imitating it, and neither is a PMS reporting a work
  // order. Allowlisting it would also make a seat trust its own bounces.
  if (domain === SEAT_DOMAIN || domain.endsWith(`.${SEAT_DOMAIN}`)) return "seat_domain";

  // Only under a two-letter country TLD, which is where these suffixes are a
  // registry level. `co.com` is a domain a company can own, and rejecting it
  // would be this rule overreaching into names that are somebody's property.
  const labels = domain.split(".");
  if (labels.length === 2 && labels[1].length === 2 && PUBLIC_SECOND_LEVEL.has(labels[0])) {
    return "public_suffix";
  }

  return null;
}

/** Why a domain cannot be allowlisted, or null if it can. */
export function senderDomainRejection(domain: string): SenderDomainRejection | null {
  return domainStructureRejection(domain) ?? publicMailboxRejection(domain);
}

/* ── exact mailbox grants ─────────────────────────────────────────────────── */

export type SenderAddressRejection = SenderDomainRejection | "address_shape";

/**
 * What an operator typed, reduced to the mailbox they meant.
 *
 * Same forgiveness as `normalizeSenderDomain` and for the same reason — people
 * paste `mailto:` links and `Jane Doe <jane@example.com>` out of a mail client.
 * What it will not do is guess: a value with no `@` stays as typed and is
 * rejected by shape rather than being turned into something plausible.
 */
export function normalizeSenderAddress(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^mailto:/, "");
  const angle = value.lastIndexOf("<");
  if (angle >= 0) {
    const close = value.indexOf(">", angle);
    value = close < 0 ? value.slice(angle + 1) : value.slice(angle + 1, close);
  }
  return value.trim().replace(/\.$/, "");
}

/**
 * Why a mailbox cannot be allowlisted, or null if it can.
 *
 * Deliberately **more permissive than `senderDomainRejection` in exactly one
 * way**: a consumer mailbox domain is allowed here. That is the whole design.
 * `gmail.com` as a domain grants a population; `john@gmail.com` grants one
 * mailbox, and nothing about that grant reaches `attacker@gmail.com`.
 *
 * Every other rule still applies, because they are about the name rather than
 * the breadth of the grant: `jane@co.uk` names no organization, and
 * `someone@aval.llc` is the seat's own domain.
 */
export function senderAddressRejection(address: string): SenderAddressRejection | null {
  const at = address.lastIndexOf("@");
  // A local part, an `@`, and no whitespace or routing punctuation. The shape
  // an operator can type wrong, not a general RFC 5322 parser.
  if (at < 1 || at === address.length - 1) return "address_shape";
  if (/[\s"'<>,;]/.test(address)) return "address_shape";
  if (address.indexOf("@") !== at) return "address_shape";

  return domainStructureRejection(address.slice(at + 1));
}

/** Words for an address rejection. */
export function describeSenderAddressRejection(rejection: SenderAddressRejection): string {
  return rejection === "address_shape"
    ? "Enter a full email address, like notices@example.com."
    : describeSenderDomainRejection(rejection);
}

/**
 * Words for a rejection.
 *
 * Each says what to do instead, because an operator hitting one of these is
 * mid-setup and the alternative to a usable sentence is a support ticket or a
 * workaround that widens the grant.
 */
export function describeSenderDomainRejection(rejection: SenderDomainRejection): string {
  switch (rejection) {
    case "seat_domain":
      return `${SEAT_DOMAIN} is Aval's own domain and cannot be allowed as a sender. Enter the domain your PMS sends from.`;
    case "public_suffix":
      return "That covers every organization under that suffix. Enter the full domain, like example.co.uk.";
    case "public_mailbox":
      return "That is a shared consumer mail domain, so allowing it would let anyone with an account there write to your Aval seat. Enter a domain your organization or your PMS controls.";
    case "shape":
      return "Enter a domain, like appfolio.com — no scheme, path or mailbox.";
  }
}

/**
 * The suggestions to offer for a provider, minus what is already allowed.
 *
 * Suggestions run through the same rejection rules as typed input. A descriptor
 * is researched rather than observed, and a suggestion that could not be typed
 * by hand must not arrive through a checkbox instead.
 */
export function suggestedSenderDomains(
  descriptorDomains: readonly string[] | undefined,
  already: readonly string[],
): string[] {
  const held = new Set(already.map((domain) => normalizeSenderDomain(domain)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of descriptorDomains ?? []) {
    const domain = normalizeSenderDomain(raw);
    if (held.has(domain) || seen.has(domain)) continue;
    if (senderDomainRejection(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}
