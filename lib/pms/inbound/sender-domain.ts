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
 * Providers for which a consumer mailbox domain is nonetheless allowed.
 *
 * TODO(decision): **empty is the open policy question on this module, and empty
 * is the closed default** — chosen so no permissive gap exists while the call is
 * open. Adding `generic_email` here is the only change the decision needs.
 *
 * The case for adding it is the smallest customer: a two-person management
 * company whose "PMS" is a person forwarding notices from a Gmail account,
 * connected as `generic_email`. Under the closed rule that workspace cannot use
 * the seat at all, so the universality the seat exists for stops exactly where
 * the customer is smallest.
 *
 * The case against is that `gmail.com` on an allowlist is not a party, it is a
 * population: every Gmail user on earth may then write into that workspace's
 * agent context, DMARC-clean, with no forgery involved. The operator who ticked
 * the box will not have read it that way.
 *
 * A named PMS never belongs here — AppFolio does not send from Gmail, so such a
 * row is a mistake or an impersonation either way.
 */
const PUBLIC_MAILBOX_EXEMPT: ReadonlySet<string> = new Set<string>();

/** Whether a consumer mailbox domain may be allowlisted, and for which provider. */
export function publicMailboxRejection(
  domain: string,
  providerId: string,
): SenderDomainRejection | null {
  if (!PUBLIC_MAILBOX.has(domain)) return null;
  return PUBLIC_MAILBOX_EXEMPT.has(providerId) ? null : "public_mailbox";
}

/** Why a domain cannot be allowlisted for this provider, or null if it can. */
export function senderDomainRejection(domain: string, providerId: string): SenderDomainRejection | null {
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

  return publicMailboxRejection(domain, providerId);
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
  providerId: string,
  already: readonly string[],
): string[] {
  const held = new Set(already.map((domain) => normalizeSenderDomain(domain)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of descriptorDomains ?? []) {
    const domain = normalizeSenderDomain(raw);
    if (held.has(domain) || seen.has(domain)) continue;
    if (senderDomainRejection(domain, providerId)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}
