import assert from "node:assert/strict";
import {
  allowSender, allowSenderAddress, allowlistedSenderDomains,
  readSeatAddressAllowlist, resolveSeatSender, revokeSenderAddress,
} from "../../lib/pms/inbound/senders.ts";
import { parseAuthenticationResults } from "../../lib/pms/inbound/authentication.ts";
import { recordSeatMessage, seatReview } from "../../lib/pms/inbound/messages.ts";

/**
 * Who may write to a workspace's seat, against real rows.
 *
 * The rule these exist to hold is one sentence: **a grant to a mailbox is not a
 * grant to its domain.** A consumer mailbox provider can never be allowlisted
 * as a domain, because `gmail.com` names a population rather than a party; the
 * smallest customer is served instead by approving the one person who forwards
 * their notices. That is only safe if approving `john@gmail.com` leaves
 * `attacker@gmail.com` exactly as untrusted as it was, so most of what is
 * asserted here is that it does.
 */

const CF = "mx.cloudflare.net";

/** A message as Cloudflare Email Routing would deliver it. */
function delivered({ from, mailbox, dmarc = "pass", dkim = "pass", signedBy = from }) {
  return (
    `Authentication-Results: ${CF}; dkim=${dkim} header.d=${signedBy}; `
    + `spf=pass smtp.mailfrom=bounce.${from}; dmarc=${dmarc} header.from=${from}\r\n`
    + `From: ${mailbox}\r\n`
    + "Subject: The radiator in 4B is leaking\r\n\r\nbody"
  );
}

const resolve = (s, org, raw) => resolveSeatSender(s, org, parseAuthenticationResults(raw, CF), raw);

export async function runSeatSenderCases(t, { session, userA, userB }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));
  const other = (work) => session(userB, (s) => work(s, s.identity.organizationId));

  await t.test("a consumer mailbox domain cannot be allowlisted, whatever the provider", async () => {
    for (const provider of ["generic_email", "appfolio"]) {
      const refused = await run((s, org) => allowSender(s, org, "gmail.com", provider, userA));
      assert.equal(refused.ok, false, `${provider} must not be able to allow an entire consumer mail domain`);
      assert.match(refused.reason, /anyone with an account/i);
    }
  });

  await t.test("approving one mailbox does not trust the domain behind it", async () => {
    // The whole point. A two-person management company whose "PMS" is a person
    // forwarding notices from Gmail gets that person, and gets nobody else.
    const allowed = await run((s, org) => allowSenderAddress(s, org, "John@Gmail.com", "generic_email", userA));
    assert.equal(allowed.ok, true);
    assert.equal(allowed.sender.address, "john@gmail.com", "stored normalized");

    const john = await run((s, org) => resolve(s, org, delivered({ from: "gmail.com", mailbox: "john@gmail.com" })));
    assert.equal(john.verdict.verified, true, "the approved sender is read");
    assert.equal(john.tier, "approved_address");
    assert.equal(john.providerId, "generic_email");

    // The sentence this file exists for.
    const attacker = await run((s, org) => resolve(s, org, delivered({ from: "gmail.com", mailbox: "attacker@gmail.com" })));
    assert.equal(attacker.verdict.verified, false, "approving John must not admit every Gmail account");
    assert.equal(attacker.tier, "review");
    assert.equal(attacker.providerId, undefined, "and nothing chooses a parser for it");

    // Not even by a lookalike that differs only in punctuation.
    for (const lookalike of ["j.ohn@gmail.com", "john+x@gmail.com"]) {
      const near = await run((s, org) => resolve(s, org, delivered({ from: "gmail.com", mailbox: lookalike })));
      assert.equal(near.verdict.verified, false, `${lookalike} is not john@gmail.com`);
    }

    // And the domain allowlist was never written to.
    const domains = await run((s, org) => allowlistedSenderDomains(s, org));
    assert.ok(!domains.includes("gmail.com"), "a mailbox grant must never appear as a domain grant");
  });

  await t.test("a subdomain of an approved mailbox's domain is not the mailbox", async () => {
    // `domainMatches` accepts subdomains for a *domain* grant, deliberately.
    // An address grant has no such latitude, because a subdomain is exactly
    // where a lookalike sender would live.
    const sub = await run((s, org) => resolve(s, org, delivered({
      from: "mail.gmail.com", mailbox: "john@mail.gmail.com",
    })));
    assert.equal(sub.verdict.verified, false);
    assert.equal(sub.tier, "review");
  });

  await t.test("an approved mailbox still has to authenticate as itself", async () => {
    // DMARC can pass on an aligned SPF result, which says nothing about the
    // local part. A message that only clears that bar is not John.
    const spfOnly = await run((s, org) => resolve(s, org, delivered({
      from: "gmail.com", mailbox: "john@gmail.com", dkim: "none",
    })));
    assert.equal(spfOnly.verdict.verified, false, "an unsigned From is not an authenticated mailbox");

    const failed = await run((s, org) => resolve(s, org, delivered({
      from: "gmail.com", mailbox: "john@gmail.com", dmarc: "fail",
    })));
    assert.equal(failed.verdict.verified, false);
  });

  await t.test("the ladder prefers the narrower grant", async () => {
    // With both an approved domain and an approved mailbox under it, the
    // mailbox decides. Trust never widens to the broadest rung that would also
    // have matched.
    await run((s, org) => allowSender(s, org, "appfolio.com", "appfolio", userA));
    await run((s, org) => allowSenderAddress(s, org, "notices@appfolio.com", "generic_email", userA));

    const narrow = await run((s, org) => resolve(s, org, delivered({
      from: "appfolio.com", mailbox: "notices@appfolio.com",
    })));
    assert.equal(narrow.tier, "approved_address");
    assert.equal(narrow.providerId, "generic_email", "the narrower grant also chooses the parser");

    // Another mailbox at that domain still passes, on the domain rung — the
    // domain grant is real and this does not take it away.
    const wide = await run((s, org) => resolve(s, org, delivered({
      from: "appfolio.com", mailbox: "someone-else@appfolio.com",
    })));
    assert.equal(wide.tier, "approved_domain");
    assert.equal(wide.providerId, "appfolio");
  });

  await t.test("revoking a mailbox takes effect on the next message", async () => {
    assert.equal(await run((s, org) => revokeSenderAddress(s, org, "john@gmail.com")), true);
    const after = await run((s, org) => resolve(s, org, delivered({ from: "gmail.com", mailbox: "john@gmail.com" })));
    assert.equal(after.verdict.verified, false, "consent is revocable and immediate");
    assert.equal(await run((s, org) => revokeSenderAddress(s, org, "john@gmail.com")), false);
  });

  await t.test("one workspace's approved mailbox is not another's", async () => {
    await other((s, org) => allowSenderAddress(s, org, "john@gmail.com", "generic_email", userB));
    const mine = await run((s, org) => readSeatAddressAllowlist(s, org));
    assert.ok(!mine.some((row) => row.address === "john@gmail.com"),
      "a grant in another workspace must not appear here");

    const refused = await run((s, org) => resolve(s, org, delivered({ from: "gmail.com", mailbox: "john@gmail.com" })));
    assert.equal(refused.verdict.verified, false, "nor admit their sender");
  });

  await t.test("held mail names the mailbox, so a person approves that sender", async () => {
    // What adjudication needs. Offering the operator `gmail.com` would make the
    // only available approval the one that must never be made; offering
    // `stranger@gmail.com` makes the narrow approval the easy one.
    await run((s, org) => recordSeatMessage(s, {
      digest: "d".repeat(64),
      recipient: "acme@aval.llc",
      organizationId: org,
      disposition: "held",
      domain: "gmail.com",
      address: "stranger@gmail.com",
      method: "dmarc",
      providerId: null,
      reason: "authenticated, not allowed",
      observedAuthservIds: null,
      objectKey: `held/${org}/${"d".repeat(64)}`,
      receivedAt: new Date(),
    }));

    const review = await run((s, org) => seatReview(s, org));
    const held = review.held.find((sender) => sender.domain === "gmail.com");
    assert.ok(held, "the held sender is offered for review");
    assert.deepEqual(held.addresses, ["stranger@gmail.com"]);
    assert.equal(held.domainAllowlistable, false,
      "and the panel is told the domain is not an option, rather than finding out by failing");
  });
}
