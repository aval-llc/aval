import assert from "node:assert/strict";
import test from "node:test";
import {
  disposeMessage,
  dispositionKey,
  REPROCESS_PREFIXES,
} from "../lib/pms/inbound/disposition.ts";
import { observedAuthservIds } from "../lib/pms/inbound/authentication.ts";

/**
 * What the reader does with a message once it has looked at it.
 *
 * The assertion that matters most is negative: a message that authenticated
 * nothing must carry no domain, because the only domain it has is the one its
 * sender wrote, and a review surface that rendered it would put attacker-chosen
 * text next to an Allow button.
 */

const VERIFIED = { verified: true, domain: "appfolio.com", method: "dmarc" as const, reason: "DMARC pass." };
const AUTHENTICATED_NOT_ALLOWED = {
  verified: false,
  domain: "buildium.com",
  method: "dkim" as const,
  reason: "buildium.com is authenticated but not allowlisted.",
};
const NOTHING_AUTHENTICATED = { verified: false, reason: "Only SPF passed." };

test("an allowlisted sender's message is verified and keyed under its workspace", () => {
  const disposition = disposeMessage({ organizationId: "org_1", verdict: VERIFIED, providerId: "appfolio" });
  assert.equal(disposition.state, "verified");
  assert.equal(disposition.providerId, "appfolio");
  assert.equal(dispositionKey(disposition, "abc123"), "verified/org_1/abc123");
  // Nothing about it can change, so no later sweep re-reads it.
  assert.equal(disposition.reprocess, false);
});

test("an authenticated sender nobody allowed is held, and named", () => {
  const disposition = disposeMessage({ organizationId: "org_1", verdict: AUTHENTICATED_NOT_ALLOWED });
  assert.equal(disposition.state, "held");
  assert.equal(disposition.domain, "buildium.com");
  assert.equal(disposition.method, "dkim");
  // The one thing an operator can act on, so it is the one thing re-read once
  // they act. Allowing a sender has to reach the mail already waiting.
  assert.equal(disposition.reprocess, true);
  assert.ok(REPROCESS_PREFIXES.includes("held"));
});

test("a message that authenticated nothing is counted, never named", () => {
  const disposition = disposeMessage({ organizationId: "org_1", verdict: NOTHING_AUTHENTICATED });
  assert.equal(disposition.state, "unauthenticated");
  // The control this module exists for.
  assert.equal(disposition.domain, null);
  assert.equal(disposition.providerId, null);
  assert.equal(disposition.reprocess, false);
});

test("a verdict that verified without a provider does not become verified", () => {
  // Would mean an allowlist row matched and then could not be found — a bug in
  // resolveSeatSender. It must not resolve to a default parser.
  const disposition = disposeMessage({ organizationId: "org_1", verdict: VERIFIED });
  assert.notEqual(disposition.state, "verified");
  assert.equal(disposition.state, "held");
});

test("mail to a slug no workspace holds has nobody to review it", () => {
  const disposition = disposeMessage({ organizationId: null, verdict: VERIFIED, providerId: "appfolio" });
  assert.equal(disposition.state, "unassigned");
  assert.equal(dispositionKey(disposition, "abc123"), "rejected/unassigned/abc123");
  // Not named even though it authenticated: there is no workspace whose operator
  // could act on it, so storing the domain would be collecting for nobody.
  assert.equal(disposition.domain, null);
});

test("every authserv-id on a message is recoverable for triage", () => {
  // The diagnostic for "nothing verifies and we cannot tell why". Includes the
  // sender's own, which is exactly the point: it shows what arrived, not what
  // was trusted.
  const raw =
    "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=appfolio.com\r\n"
    + "Authentication-Results: attacker.example; dmarc=pass header.from=appfolio.com\r\n"
    + "From: notifications@appfolio.com\r\n\r\nbody";
  assert.deepEqual(observedAuthservIds(raw), ["mx.cloudflare.net", "attacker.example"]);
  assert.deepEqual(observedAuthservIds("From: x@y.example\r\n\r\nbody"), []);
});
