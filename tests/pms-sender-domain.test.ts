import assert from "node:assert/strict";
import test from "node:test";
import {
  describeSenderDomainRejection,
  normalizeSenderDomain,
  publicMailboxRejection,
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
  assert.equal(senderDomainRejection("appfolio.com", "appfolio"), null);
  assert.equal(senderDomainRejection("mail.appfolio.com", "appfolio"), null);
  assert.equal(senderDomainRejection("example.co.uk", "yardi"), null);
});

test("something that is not a domain is refused rather than guessed at", () => {
  assert.equal(senderDomainRejection("com", "appfolio"), "shape");
  assert.equal(senderDomainRejection("localhost", "appfolio"), "shape");
  assert.equal(senderDomainRejection("10.0.0.1", "appfolio"), "shape");
  assert.equal(senderDomainRejection("-appfolio.com", "appfolio"), "shape");
  assert.equal(senderDomainRejection("appfolio.c", "appfolio"), "shape");
  assert.equal(senderDomainRejection("", "appfolio"), "shape");
});

test("Aval's own domain cannot be allowed as a sender", () => {
  // Mail authenticating as aval.llc is our own forwarding or something imitating
  // it. Neither is a PMS reporting a work order, and allowing it would make a
  // seat trust its own bounces.
  assert.equal(senderDomainRejection("aval.llc", "generic_email"), "seat_domain");
  assert.equal(senderDomainRejection("mail.aval.llc", "generic_email"), "seat_domain");
});

test("an entry one label short of a domain is refused", () => {
  // `co.uk` would cover every organization in the UK. This is the mistake that
  // happens when someone types a vendor's domain from memory.
  assert.equal(senderDomainRejection("co.uk", "yardi"), "public_suffix");
  assert.equal(senderDomainRejection("com.au", "yardi"), "public_suffix");
  // Not a public suffix, just short — a real company can own this.
  assert.equal(senderDomainRejection("co.com", "yardi"), null);
});

test("a shared consumer mail domain is refused, because it grants a population", () => {
  // Nobody forges anything here: the sender really is gmail.com. That is the
  // problem — so is everyone else.
  assert.equal(senderDomainRejection("gmail.com", "generic_email"), "public_mailbox");
  assert.equal(senderDomainRejection("outlook.com", "appfolio"), "public_mailbox");
  assert.equal(publicMailboxRejection("proton.me", "generic_email"), "public_mailbox");
  // A subdomain of one is not the shared domain and is not treated as it.
  assert.equal(senderDomainRejection("notices.gmail.com", "generic_email"), null);
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
  assert.deepEqual(suggestedSenderDomains(["appfolio.com", "com", "gmail.com"], "appfolio", []), [
    "appfolio.com",
  ]);
});

test("suggestions drop what the workspace already allows, and never duplicate", () => {
  assert.deepEqual(suggestedSenderDomains(["appfolio.com"], "appfolio", ["appfolio.com"]), []);
  assert.deepEqual(suggestedSenderDomains(["APPFOLIO.com", "appfolio.com"], "appfolio", []), [
    "appfolio.com",
  ]);
  assert.deepEqual(suggestedSenderDomains(undefined, "generic_email", []), []);
});

test(
  "a generic_email workspace may allow a consumer mailbox domain",
  { todo: "policy decision open — see publicMailboxRejection in lib/pms/inbound/sender-domain.ts" },
  () => {
    // The smallest customer: a two-person management company whose PMS is a
    // person forwarding notices from Gmail, connected as `generic_email`. The
    // closed default shuts them out of the seat entirely. This test states the
    // open question and fails against the current rule on purpose — it is a
    // visible gap, not a passing suite.
    assert.equal(senderDomainRejection("gmail.com", "generic_email"), null);
    // Even if exempted there, a named PMS has no business sending from Gmail.
    assert.equal(senderDomainRejection("gmail.com", "appfolio"), "public_mailbox");
  },
);
