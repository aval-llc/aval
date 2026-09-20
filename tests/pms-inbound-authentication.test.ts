import assert from "node:assert/strict";
import test from "node:test";
import {
  domainMatches,
  parseAuthenticationResults,
  verifySender,
} from "../lib/pms/inbound/authentication.ts";

/**
 * The gate on the seat's read envelope.
 *
 * Everything the seat stores arrived from a stranger at a discoverable address.
 * These assertions are the difference between "a PMS sent us a work order" and
 * "somebody said a PMS sent us a work order", so they are written adversarially:
 * most of them are messages that should NOT pass.
 */

const CF = "mx.cloudflare.net";

function message(headers: string, body = "hello"): string {
  return `${headers}\r\n\r\n${body}`;
}

test("a clean DMARC pass from an allowlisted domain is verified", () => {
  const raw = message(
    `Authentication-Results: ${CF}; dkim=pass header.d=appfolio.com; spf=pass smtp.mailfrom=bounce.appfolio.com; dmarc=pass header.from=appfolio.com\r\n`
    + "From: notifications@appfolio.com\r\n"
    + "Subject: Work order assigned",
  );
  const verdict = verifySender(parseAuthenticationResults(raw, CF), ["appfolio.com"]);
  assert.equal(verdict.verified, true);
  assert.equal(verdict.domain, "appfolio.com");
  assert.equal(verdict.method, "dmarc");
});

test("a sender's own forged Authentication-Results cannot promote them", () => {
  // The attack this module exists for. Cloudflare prepends its result, so the
  // real one is topmost and the sender's is below it. Reading the *stored*
  // `headers.get()` string instead would see both joined with a comma and have
  // no way to tell which was which.
  const raw = message(
    `Authentication-Results: ${CF}; dkim=none; spf=fail smtp.mailfrom=attacker.example; dmarc=fail header.from=appfolio.com\r\n`
    + `Authentication-Results: ${CF}; dkim=pass header.d=appfolio.com; dmarc=pass header.from=appfolio.com\r\n`
    + "From: notifications@appfolio.com\r\n"
    + "Subject: Please pay this invoice",
  );
  const verdict = verifySender(parseAuthenticationResults(raw, CF), ["appfolio.com"]);
  assert.equal(verdict.verified, false, "the forged result below Cloudflare's must be ignored");
});

test("a result from some other authserv-id is not ours to trust", () => {
  // A relay's own header, or one written by anyone upstream. Only the
  // authserv-id we expect means anything.
  const raw = message(
    "Authentication-Results: relay.example.net; dmarc=pass header.from=appfolio.com\r\n"
    + "From: notifications@appfolio.com",
  );
  assert.equal(parseAuthenticationResults(raw, CF), null);
  const verdict = verifySender(parseAuthenticationResults(raw, CF), ["appfolio.com"]);
  assert.equal(verdict.verified, false);
  assert.match(verdict.reason, /no trusted authentication-results/i);
});

test("SPF alone never verifies, however clean it is", () => {
  // SPF authenticates the envelope sender. A message can be SPF-clean for
  // bounces.somewhere.example and still display as being from AppFolio.
  const raw = message(
    `Authentication-Results: ${CF}; spf=pass smtp.mailfrom=appfolio.com; dkim=none; dmarc=none\r\n`
    + "From: notifications@appfolio.com",
  );
  const verdict = verifySender(parseAuthenticationResults(raw, CF), ["appfolio.com"]);
  assert.equal(verdict.verified, false);
  assert.match(verdict.reason, /envelope sender, not the From/i);
});

test("an authenticated domain that is not allowlisted is refused, and says so distinctly", () => {
  // The operator needs to tell "add a domain" apart from "someone is forging".
  const raw = message(
    `Authentication-Results: ${CF}; dkim=pass header.d=buildium.com; dmarc=pass header.from=buildium.com\r\n`,
  );
  const verdict = verifySender(parseAuthenticationResults(raw, CF), ["appfolio.com"]);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.domain, "buildium.com");
  assert.match(verdict.reason, /authenticated but not allowlisted/i);
});

test("an empty allowlist verifies nothing", () => {
  // A workspace that has not said who may write to its seat has not consented.
  const raw = message(`Authentication-Results: ${CF}; dmarc=pass header.from=appfolio.com\r\n`);
  const verdict = verifySender(parseAuthenticationResults(raw, CF), []);
  assert.equal(verdict.verified, false);
  assert.match(verdict.reason, /not allowlisted any sender/i);
});

test("a lookalike domain does not match on a suffix", () => {
  // The classic way suffix matching goes wrong.
  assert.equal(domainMatches("notappfolio.com", "appfolio.com"), false);
  assert.equal(domainMatches("appfolio.com.evil.example", "appfolio.com"), false);
  // Subdomains do match: PMS vendors send from mail./notifications. routinely.
  assert.equal(domainMatches("notifications.appfolio.com", "appfolio.com"), true);
  assert.equal(domainMatches("APPFOLIO.COM.", "appfolio.com"), true);
  assert.equal(domainMatches("appfolio.com", ""), false);
});

test("a comment cannot smuggle a result past the parser", () => {
  // RFC 8601 allows CFWS comments, and their contents are arbitrary text.
  const raw = message(
    `Authentication-Results: ${CF}; spf=fail (dmarc=pass header.from=appfolio.com) smtp.mailfrom=attacker.example; dmarc=fail header.from=appfolio.com\r\n`,
  );
  const auth = parseAuthenticationResults(raw, CF);
  assert.equal(auth?.results.get("dmarc"), "fail");
  assert.equal(verifySender(auth, ["appfolio.com"]).verified, false);
});

test("a folded header is read as one header", () => {
  // Real MTAs fold long Authentication-Results across lines. Reading only the
  // first physical line would silently drop the dmarc result.
  const raw = message(
    `Authentication-Results: ${CF}; dkim=pass header.d=appfolio.com;\r\n`
    + "\tdmarc=pass header.from=appfolio.com\r\n",
  );
  const auth = parseAuthenticationResults(raw, CF);
  assert.equal(auth?.results.get("dmarc"), "pass");
  assert.equal(verifySender(auth, ["appfolio.com"]).verified, true);
});

test("headers appearing after the body are not headers", () => {
  // A message whose *body* contains a line shaped like a header must not be
  // able to introduce one.
  const raw = message(
    "From: attacker@example.com",
    `Authentication-Results: ${CF}; dmarc=pass header.from=appfolio.com`,
  );
  assert.equal(parseAuthenticationResults(raw, CF), null);
});

test("dkim=pass/policy-style results parse to their bare result", () => {
  const raw = message(`Authentication-Results: ${CF}; dkim=pass/1024 header.d=appfolio.com\r\n`);
  assert.equal(parseAuthenticationResults(raw, CF)?.results.get("dkim"), "pass");
});

/* ── the exact mailbox ────────────────────────────────────────────────────── */

/**
 * `authenticatedAddress` is the stronger claim: not "this domain sent it" but
 * "this mailbox sent it". It is what a grant to one sender is checked against,
 * so these are written the same way as the rest of this file — mostly messages
 * that must NOT yield an address.
 */

/** A message as Cloudflare Email Routing would deliver it. */
function delivered({
  dmarc = "pass",
  dkim = "pass",
  from = "gmail.com",
  signedBy = from,
  mailbox = `john@${from}`,
  extraHeaders = "",
}: {
  dmarc?: string;
  dkim?: string;
  from?: string;
  signedBy?: string;
  mailbox?: string;
  extraHeaders?: string;
}): string {
  return message(
    `Authentication-Results: ${CF}; dkim=${dkim} header.d=${signedBy}; `
    + `spf=pass smtp.mailfrom=bounce.${from}; dmarc=${dmarc} header.from=${from}\r\n`
    + `From: ${mailbox}\r\n`
    + extraHeaders
    + "Subject: Notice",
  );
}

test("a DMARC pass with an aligned DKIM signature establishes the mailbox", async () => {
  const { authenticatedAddress } = await import("../lib/pms/inbound/authentication.ts");
  const raw = delivered({});
  const found = authenticatedAddress(parseAuthenticationResults(raw, CF), raw);
  assert.deepEqual(found, { address: "john@gmail.com", domain: "gmail.com" });
});

test("a display name and relaxed subdomain alignment are still one mailbox", async () => {
  const { authenticatedAddress } = await import("../lib/pms/inbound/authentication.ts");
  const raw = delivered({
    from: "appfolio.com",
    signedBy: "mail.appfolio.com",
    mailbox: '"Doe, John" <Notices@AppFolio.com>',
  });
  const found = authenticatedAddress(parseAuthenticationResults(raw, CF), raw);
  assert.equal(found?.address, "notices@appfolio.com");
});

test("DMARC alone does not establish a mailbox, because SPF can satisfy it", async () => {
  const { authenticatedAddress } = await import("../lib/pms/inbound/authentication.ts");
  // The case this rule exists for. DMARC can pass on an aligned SPF result,
  // which authenticates the envelope and says nothing whatever about the From
  // local part — so the domain is established and the mailbox is not.
  const raw = delivered({ dkim: "none" });
  const auth = parseAuthenticationResults(raw, CF);
  assert.equal(authenticatedAddress(auth, raw), null);
  // The domain still is, which is what keeps a real PMS working.
  const { authenticatedDomain } = await import("../lib/pms/inbound/authentication.ts");
  assert.equal(authenticatedDomain(auth)?.domain, "gmail.com");
});

test("a DKIM signature by an unrelated domain does not establish the mailbox", async () => {
  const { authenticatedAddress } = await import("../lib/pms/inbound/authentication.ts");
  // A forwarder or a bulk sender signing for itself. The signature is real and
  // it covers somebody else's header.
  const raw = delivered({ from: "gmail.com", signedBy: "bulk-sender.example" });
  assert.equal(authenticatedAddress(parseAuthenticationResults(raw, CF), raw), null);
});

test("a From the DMARC result does not cover is refused", async () => {
  const { authenticatedAddress } = await import("../lib/pms/inbound/authentication.ts");
  // `header.from` says gmail.com; the actual From header says something else.
  const raw = delivered({ from: "gmail.com", mailbox: "john@evil.example" });
  assert.equal(authenticatedAddress(parseAuthenticationResults(raw, CF), raw), null);
});

test("two From headers establish nothing, because clients disagree on which they show", async () => {
  const { authenticatedAddress } = await import("../lib/pms/inbound/authentication.ts");
  const raw = delivered({ extraHeaders: "From: attacker@gmail.com\r\n" });
  assert.equal(authenticatedAddress(parseAuthenticationResults(raw, CF), raw), null);
});

test("a list of senders is not a single authenticated mailbox", async () => {
  const { authenticatedAddress } = await import("../lib/pms/inbound/authentication.ts");
  const raw = delivered({ mailbox: "john@gmail.com, attacker@gmail.com" });
  assert.equal(authenticatedAddress(parseAuthenticationResults(raw, CF), raw), null);
});

test("a failing DMARC establishes no mailbox however well signed", async () => {
  const { authenticatedAddress } = await import("../lib/pms/inbound/authentication.ts");
  const raw = delivered({ dmarc: "fail" });
  assert.equal(authenticatedAddress(parseAuthenticationResults(raw, CF), raw), null);
});
