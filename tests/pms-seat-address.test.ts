import assert from "node:assert/strict";
import test from "node:test";
import { seatAddress, seatSlugOf, slugRejection } from "../lib/pms/inbound/seat-address.ts";

/**
 * What a seat address is.
 *
 * `worker/pms-seat-inbound.ts` and the app both import this module, so these
 * assertions bind both ends at once. They matter more than most: an address the
 * app issues but the Worker rejects presents as a PMS that mysteriously sends
 * nothing, and the customer's first conclusion is that their PMS is broken.
 */

test("a seat address round-trips", () => {
  assert.equal(seatAddress("acme-props"), "agent-acme-props@aval.llc");
  assert.equal(seatSlugOf("agent-acme-props@aval.llc"), "acme-props");
});

test("the recipient check is case- and whitespace-insensitive", () => {
  // Envelope recipients arrive in whatever case the sender used.
  assert.equal(seatSlugOf("  AGENT-Acme-Props@Aval.LLC "), "acme-props");
});

test("anything that is not a seat address on this domain is not seat mail", () => {
  assert.equal(seatSlugOf("evan@aval.llc"), null, "a human address must never read as a seat");
  assert.equal(seatSlugOf("agent-acme@example.com"), null, "another domain is not ours");
  assert.equal(seatSlugOf("agentacme@aval.llc"), null, "the prefix is exact");
  assert.equal(seatSlugOf("agent-@aval.llc"), null, "an empty slug is not a slug");
  assert.equal(seatSlugOf("not-an-address"), null);
});

test("a reserved local part is not a seat, at either end", () => {
  // Issuing is blocked, and so is accepting — otherwise mail to
  // agent-support@ would be stored for a slug that could never be claimed.
  assert.equal(slugRejection("support"), "reserved");
  assert.equal(seatSlugOf("agent-support@aval.llc"), null);
});

test("slug shape is narrow, because an issued address cannot be taken back", () => {
  assert.equal(slugRejection("acme-props"), null);
  assert.equal(slugRejection("a1b2c3"), null);
  assert.equal(slugRejection("ab"), "shape", "two characters is too close to a typo of another slug");
  assert.equal(slugRejection("-acme"), "shape");
  assert.equal(slugRejection("acme-"), "shape");
  assert.equal(slugRejection("Acme"), "shape", "uppercase would make two addresses look like one");
  assert.equal(slugRejection("acme props"), "shape");
  assert.equal(slugRejection("acme_props"), "shape");
  assert.equal(slugRejection("a".repeat(41)), "shape");
  assert.equal(slugRejection("a".repeat(40)), null);
});

test("an address with a slug the shape rejects is not accepted either", () => {
  // The two ends cannot disagree, because they are the same function.
  assert.equal(seatSlugOf("agent-Acme@aval.llc"), "acme", "lowercased first, then checked");
  assert.equal(seatSlugOf("agent-ab@aval.llc"), null);
  assert.equal(seatSlugOf("agent-acme_props@aval.llc"), null);
});

test("subaddressing does not smuggle a different slug in", () => {
  // Email Routing preserves `+detail` in message.to. If it is ever enabled on
  // this zone, `agent-acme+anything@` must not resolve to `acme` by accident —
  // the plus is not in the slug grammar, so the whole local part fails.
  assert.equal(seatSlugOf("agent-acme-props+urgent@aval.llc"), null);
});
