import assert from "node:assert/strict";
import test from "node:test";
import { bootRuntime } from "./harness.mjs";

/**
 * The seat's sender allowlist against real storage.
 *
 * The layer these tests exist for is the *join*. `verifySender` had a passing
 * test suite while nothing persisted an allowlist, which meant the seat could
 * store mail and verify none of it — every message failed for the same reason
 * and no test noticed, because each half was correct alone. So most of what is
 * asserted here is `resolveSeatSender`: a real row, a real message, and the two
 * meeting.
 */

const NOW = Date.now();
const CF = "mx.cloudflare.net";

function org(sqlite, id, name) {
  sqlite
    .prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(id, name, "user_1", NOW, NOW);
}

/** A message carrying a Cloudflare result, as Email Routing would deliver it. */
function delivered({ dmarc = "pass", dkim = "pass", from = "appfolio.com", signedBy = from }) {
  return (
    `Authentication-Results: ${CF}; dkim=${dkim} header.d=${signedBy}; `
    + `spf=pass smtp.mailfrom=bounce.${from}; dmarc=${dmarc} header.from=${from}\r\n`
    + `From: notifications@${from}\r\n`
    + "Subject: Work order assigned\r\n\r\nbody"
  );
}

async function modules() {
  const senders = await import("../../lib/pms/inbound/senders.ts");
  const { parseAuthenticationResults } = await import("../../lib/pms/inbound/authentication.ts");
  return { ...senders, parseAuthenticationResults };
}

test("a workspace with no allowlist verifies nothing", async () => {
  const sqlite = await bootRuntime();
  const { resolveSeatSender, allowlistedSenderDomains, parseAuthenticationResults } = await modules();
  org(sqlite, "org_1", "Acme");

  assert.deepEqual(await allowlistedSenderDomains("org_1"), []);

  // A perfectly authenticated message from a real PMS. It still does not pass,
  // because this workspace has never said who may write to its seat.
  const auth = parseAuthenticationResults(delivered({}), CF);
  const resolved = await resolveSeatSender("org_1", auth);
  assert.equal(resolved.verdict.verified, false);
  assert.equal(resolved.providerId, undefined);
  assert.match(resolved.verdict.reason, /has not allowlisted/i);
});

test("an allowed domain verifies and names the system to read it as", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, resolveSeatSender, parseAuthenticationResults } = await modules();
  org(sqlite, "org_1", "Acme");

  const allowed = await allowSender("org_1", "appfolio.com", "appfolio", "user_1");
  assert.equal(allowed.ok, true);

  const resolved = await resolveSeatSender("org_1", parseAuthenticationResults(delivered({}), CF));
  assert.equal(resolved.verdict.verified, true);
  assert.equal(resolved.verdict.domain, "appfolio.com");
  // The point of storing the provider on the row: the format is known from
  // consent, not inferred from a body the sender wrote.
  assert.equal(resolved.providerId, "appfolio");
});

test("a subdomain the operator never enumerated is covered by the row", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, resolveSeatSender, parseAuthenticationResults } = await modules();
  org(sqlite, "org_1", "Acme");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");

  // The PMS starts sending from a new subdomain. Nothing breaks, and nobody had
  // to predict it — which is the failure that presents as "our PMS stopped
  // sending" and gets blamed on the PMS.
  const auth = parseAuthenticationResults(delivered({ from: "notifications.appfolio.com" }), CF);
  const resolved = await resolveSeatSender("org_1", auth);
  assert.equal(resolved.verdict.verified, true);
  assert.equal(resolved.providerId, "appfolio");
});

test("one workspace's allowlist is not another's", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, resolveSeatSender, parseAuthenticationResults } = await modules();
  org(sqlite, "org_1", "Acme");
  org(sqlite, "org_2", "Other");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");

  const auth = parseAuthenticationResults(delivered({}), CF);
  assert.equal((await resolveSeatSender("org_2", auth)).verdict.verified, false);
});

test("a domain that authenticates but is not allowed says so as a setup problem", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, resolveSeatSender, parseAuthenticationResults } = await modules();
  org(sqlite, "org_1", "Acme");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");

  const auth = parseAuthenticationResults(delivered({ from: "buildium.com" }), CF);
  const resolved = await resolveSeatSender("org_1", auth);
  assert.equal(resolved.verdict.verified, false);
  // Named separately from a forgery so an operator knows to add a domain rather
  // than investigate an attack. This is the held-sender case.
  assert.equal(resolved.verdict.domain, "buildium.com");
  assert.match(resolved.verdict.reason, /authenticated but not allowlisted/i);
});

test("revoking takes effect on the next message", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, revokeSender, resolveSeatSender, parseAuthenticationResults } = await modules();
  org(sqlite, "org_1", "Acme");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");
  const auth = parseAuthenticationResults(delivered({}), CF);
  assert.equal((await resolveSeatSender("org_1", auth)).verdict.verified, true);

  assert.equal(await revokeSender("org_1", "appfolio.com"), true);
  // No disabled row left behind for a later code path to misread as consent.
  assert.equal((await resolveSeatSender("org_1", auth)).verdict.verified, false);
  assert.equal(await revokeSender("org_1", "appfolio.com"), false);
});

test("re-allowing a domain under a different system reports what it replaced", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, readSeatAllowlist } = await modules();
  org(sqlite, "org_1", "Acme");

  await allowSender("org_1", "shared-host.example", "generic_email", "user_1");
  const moved = await allowSender("org_1", "shared-host.example", "buildium", "user_2");
  assert.equal(moved.ok, true);
  // A domain changing provider changes how its mail is parsed, so the caller
  // gets something concrete to confirm instead of a silent overwrite.
  assert.equal(moved.replacedProviderId, "generic_email");

  const list = await readSeatAllowlist("org_1");
  assert.equal(list.length, 1, "re-allowing updates the row rather than adding one");
  assert.equal(list[0].providerId, "buildium");
  assert.equal(list[0].addedBy, "user_2");
});

test("what an operator pastes is stored normalized, and matches once", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, readSeatAllowlist } = await modules();
  org(sqlite, "org_1", "Acme");

  await allowSender("org_1", "https://MAIL.appfolio.com/x", "appfolio", "user_1");
  const again = await allowSender("org_1", "mail.appfolio.com", "appfolio", "user_1");
  assert.equal(again.ok, true);
  const list = await readSeatAllowlist("org_1");
  assert.equal(list.length, 1, "two spellings of one domain are one grant");
  assert.equal(list[0].domain, "mail.appfolio.com");
});

test("a row cannot name a system that does not exist", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, readSeatAllowlist } = await modules();
  org(sqlite, "org_1", "Acme");

  // Such a row would verify mail and then have nowhere to send it.
  const rejected = await allowSender("org_1", "appfolio.com", "appfolio_v2", "user_1");
  assert.equal(rejected.ok, false);
  assert.deepEqual(await readSeatAllowlist("org_1"), []);
});

test("a domain the rules refuse never reaches storage", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, readSeatAllowlist } = await modules();
  org(sqlite, "org_1", "Acme");

  for (const domain of ["gmail.com", "co.uk", "aval.llc", "com"]) {
    const rejected = await allowSender("org_1", domain, "generic_email", "user_1");
    assert.equal(rejected.ok, false, `${domain} should be refused`);
  }
  assert.deepEqual(await readSeatAllowlist("org_1"), []);
});

test("SPF alone does not pass, even for an allowed domain", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, resolveSeatSender, parseAuthenticationResults } = await modules();
  org(sqlite, "org_1", "Acme");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");

  // SPF authenticates the envelope sender, not the From a parser reads. A row on
  // the allowlist must not turn that into a pass.
  const raw =
    `Authentication-Results: ${CF}; spf=pass smtp.mailfrom=bounces.appfolio.com; dkim=none; dmarc=none\r\n`
    + "From: notifications@appfolio.com\r\n\r\nbody";
  const resolved = await resolveSeatSender("org_1", parseAuthenticationResults(raw, CF));
  assert.equal(resolved.verdict.verified, false);
  assert.equal(resolved.providerId, undefined);
});

test("a sender's own forged result cannot reach an allowlisted provider", async () => {
  const sqlite = await bootRuntime();
  const { allowSender, resolveSeatSender, parseAuthenticationResults } = await modules();
  org(sqlite, "org_1", "Acme");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");

  // Cloudflare's result is topmost; the sender's claim sits below it and is
  // ignored. Asserted here as well as in the unit tests because this is the
  // path where a pass would hand an attacker a provider id.
  const raw =
    `Authentication-Results: ${CF}; dkim=none; spf=fail smtp.mailfrom=attacker.example; dmarc=fail header.from=attacker.example\r\n`
    + `Authentication-Results: ${CF}; dmarc=pass header.from=appfolio.com\r\n`
    + "From: notifications@appfolio.com\r\n\r\nbody";
  const resolved = await resolveSeatSender("org_1", parseAuthenticationResults(raw, CF));
  assert.equal(resolved.verdict.verified, false);
  assert.equal(resolved.providerId, undefined);
});
