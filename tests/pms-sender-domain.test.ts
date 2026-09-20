import assert from "node:assert/strict";
import test from "node:test";
import {
  describeSenderAddressRejection,
  describeSenderDomainRejection,
  normalizeSenderAddress,
  normalizeSenderDomain,
  publicMailboxRejection,
  senderAddressRejection,
  senderDomainRejection,
  suggestedSenderDomains,
} from "../lib/pms/inbound/sender-domain.ts";

/**
 * What an operator may allow to write to their seat.
 *
 * `tests/integration/pms-senders.integration.mjs` asserts the storage and the
 * join against real rows. These pin the rules, and they are mostly rejections,
 * because an allowlist entry is a standing grant that anything authenticating as
 * that domain may put text into an agent's context — the cost of one that is too
 * wide is not symmetrical with the cost of one that is too narrow.
 */

test("what an operator actually pastes is reduced to the domain they meant", () => {
  // Every one of these is something a person hands over when asked for a
  // "sending domain". Making them hand-edit it invites a workaround.
  assert.equal(normalizeSenderDomain("  APPFOLIO.com "), "appfolio.com");
  assert.equal(normalizeSenderDomain("https://mail.appfolio.com/notices?id=4"), "mail.appfolio.com");
  assert.equal(normalizeSenderDomain("notifications@appfolio.com"), "appfolio.com");
  assert.equal(normalizeSenderDomain("@appfolio.com"), "appfolio.com");
  assert.equal(normalizeSenderDomain("appfolio.com."), "appfolio.com");
  assert.equal(normalizeSenderDomain("appfolio.com:443"), "appfolio.com");
});

test("a wildcard is stripped, not honoured as syntax", () => {
  // `domainMatches` already covers subdomains, so `*.appfolio.com` and
  // `appfolio.com` are the same grant. Storing both spellings would make the
  // list harder to audit for no added reach.
  assert.equal(normalizeSenderDomain("*.appfolio.com"), "appfolio.com");
  assert.equal(normalizeSenderDomain(".appfolio.com"), "appfolio.com");
});

test("a researched vendor domain is allowed", () => {
  assert.equal(senderDomainRejection("appfolio.com"), null);
  assert.equal(senderDomainRejection("mail.appfolio.com"), null);
  assert.equal(senderDomainRejection("example.co.uk"), null);
});

test("something that is not a domain is refused rather than guessed at", () => {
  assert.equal(senderDomainRejection("com"), "shape");
  assert.equal(senderDomainRejection("localhost"), "shape");
  assert.equal(senderDomainRejection("10.0.0.1"), "shape");
  assert.equal(senderDomainRejection("-appfolio.com"), "shape");
  assert.equal(senderDomainRejection("appfolio.c"), "shape");
  assert.equal(senderDomainRejection(""), "shape");
});

test("Aval's own domain cannot be allowed as a sender", () => {
  // Mail authenticating as aval.llc is our own forwarding or something imitating
  // it. Neither is a PMS reporting a work order, and allowing it would make a
  // seat trust its own bounces.
  assert.equal(senderDomainRejection("aval.llc"), "seat_domain");
  assert.equal(senderDomainRejection("mail.aval.llc"), "seat_domain");
});

test("an entry one label short of a domain is refused", () => {
  // `co.uk` would cover every organization in the UK. This is the mistake that
  // happens when someone types a vendor's domain from memory.
  assert.equal(senderDomainRejection("co.uk"), "public_suffix");
  assert.equal(senderDomainRejection("com.au"), "public_suffix");
  // Not a public suffix, just short — a real company can own this.
  assert.equal(senderDomainRejection("co.com"), null);
});

test("a shared consumer mail domain is refused, because it grants a population", () => {
  // Nobody forges anything here: the sender really is gmail.com. That is the
  // problem — so is everyone else.
  assert.equal(senderDomainRejection("gmail.com"), "public_mailbox");
  assert.equal(senderDomainRejection("outlook.com"), "public_mailbox");
  assert.equal(publicMailboxRejection("proton.me"), "public_mailbox");
  // A subdomain of one is not the shared domain and is not treated as it.
  assert.equal(senderDomainRejection("notices.gmail.com"), null);
});

test("every rejection says what to do instead", () => {
  for (const rejection of ["shape", "seat_domain", "public_suffix", "public_mailbox"] as const) {
    const words = describeSenderDomainRejection(rejection);
    assert.match(words, /[.!]$/, `${rejection} should read as a sentence`);
    assert.ok(words.length > 30, `${rejection} should tell the operator what to do`);
  }
});

test("suggestions are filtered by the same rules as typed input", () => {
  // A descriptor is researched, not observed. A suggestion that an operator
  // could not have typed must not get in through a checkbox instead.
  assert.deepEqual(suggestedSenderDomains(["appfolio.com", "com", "gmail.com"], []), [
    "appfolio.com",
  ]);
});

test("suggestions drop what the workspace already allows, and never duplicate", () => {
  assert.deepEqual(suggestedSenderDomains(["appfolio.com"], ["appfolio.com"]), []);
  assert.deepEqual(suggestedSenderDomains(["APPFOLIO.com", "appfolio.com"], []), [
    "appfolio.com",
  ]);
  assert.deepEqual(suggestedSenderDomains(undefined, []), []);
});

test("no provider may allowlist a consumer mailbox domain, generic_email included", () => {
  // This was the open policy question on the module and it is decided closed.
  // The smallest customer — a two-person company whose "PMS" is a person
  // forwarding notices from Gmail — is served by granting that person's
  // mailbox, not the domain they happen to use. See the address tests below.
  for (const provider of ["generic_email", "appfolio", "yardi"]) {
    assert.equal(
      senderDomainRejection("gmail.com"), "public_mailbox",
      `${provider} must not be able to allowlist an entire consumer mail domain`,
    );
  }
  assert.equal(publicMailboxRejection("icloud.com"), "public_mailbox");
  assert.equal(publicMailboxRejection("outlook.com"), "public_mailbox");
  assert.equal(publicMailboxRejection("yahoo.com"), "public_mailbox");
});

test("an address is reduced to the mailbox the operator meant", () => {
  assert.equal(normalizeSenderAddress("  Notices@AppFolio.com "), "notices@appfolio.com");
  assert.equal(normalizeSenderAddress("mailto:notices@appfolio.com"), "notices@appfolio.com");
  assert.equal(normalizeSenderAddress("Jane Doe <jane@example.com>"), "jane@example.com");
  assert.equal(normalizeSenderAddress("jane@example.com."), "jane@example.com");
  // No `@` is not guessed into something plausible; it stays wrong and is
  // rejected by shape.
  assert.equal(normalizeSenderAddress("example.com"), "example.com");
  assert.equal(senderAddressRejection(normalizeSenderAddress("example.com")), "address_shape");
});

test("a mailbox may be allowed where its domain may not", () => {
  // The single rule that differs between a domain grant and an address grant.
  // `gmail.com` grants a population; `john@gmail.com` grants one mailbox.
  assert.equal(senderDomainRejection("gmail.com"), "public_mailbox");
  assert.equal(senderAddressRejection("john@gmail.com"), null);
  assert.equal(senderAddressRejection("john@icloud.com"), null);
  assert.equal(senderAddressRejection("notices@appfolio.com"), null);
});

test("every other rule still applies to a mailbox, because they are about the name", () => {
  // A name that identifies no organization identifies none with an `@` in front
  // of it either.
  assert.equal(senderAddressRejection("jane@co.uk"), "public_suffix");
  assert.equal(senderAddressRejection("someone@aval.llc"), "seat_domain");
  assert.equal(senderAddressRejection("someone@mail.aval.llc"), "seat_domain");
  assert.equal(senderAddressRejection("jane@localhost"), "shape");
  assert.equal(senderAddressRejection("jane@10.0.0.1"), "shape");
});

test("a mailbox that is not one mailbox is refused", () => {
  assert.equal(senderAddressRejection("@example.com"), "address_shape");
  assert.equal(senderAddressRejection("jane@"), "address_shape");
  assert.equal(senderAddressRejection("jane"), "address_shape");
  assert.equal(senderAddressRejection("jane@a@example.com"), "address_shape");
  assert.equal(senderAddressRejection("jane doe@example.com"), "address_shape");
  // A list, or anything carrying address syntax, is not a single grant.
  assert.equal(senderAddressRejection("jane@example.com,bob@example.com"), "address_shape");
  assert.equal(senderAddressRejection("<jane@example.com>"), "address_shape");
});

test("an address rejection tells the operator what to do", () => {
  const shape = describeSenderAddressRejection("address_shape");
  assert.ok(shape.includes("@"), "it should show the shape it wants");
  // The shared codes keep the domain wording rather than inventing a second
  // vocabulary for the same rule.
  assert.equal(describeSenderAddressRejection("seat_domain"), describeSenderDomainRejection("seat_domain"));
});
