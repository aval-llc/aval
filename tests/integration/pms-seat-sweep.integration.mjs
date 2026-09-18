import assert from "node:assert/strict";
import test from "node:test";
import { bootRuntime } from "./harness.mjs";

/**
 * The seat reader's sweep, against real storage and a fake bucket.
 *
 * This is the join the whole seat path rests on: a stored message, a workspace's
 * allowlist, and a disposition. The test that matters most is the retroactive
 * one — an operator told "4 messages are waiting" and then shown nothing after
 * allowing the sender would have been lied to, and nothing else in the system
 * would have noticed.
 */

const CF = "mx.cloudflare.net";
const NOW = Date.now();

function org(sqlite, id, name) {
  sqlite
    .prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(id, name, "user_1", NOW, NOW);
}

/** A message as Email Routing would deliver it, with Cloudflare's result topmost. */
function delivered({ from = "appfolio.com", dmarc = "pass", dkim = "pass", authservId = CF, subject = "Work order" } = {}) {
  return (
    `Authentication-Results: ${authservId}; dkim=${dkim} header.d=${from}; `
    + `spf=pass smtp.mailfrom=bounce.${from}; dmarc=${dmarc} header.from=${from}\r\n`
    + `From: notifications@${from}\r\n`
    + `Subject: ${subject}\r\n\r\nbody`
  );
}

/**
 * An in-memory stand-in for the R2 bucket.
 *
 * Only what `SeatBucket` declares, so what the sweep is allowed to do to the
 * inbox is visible here: list, get, put, delete. No forward, no reply.
 */
function fakeBucket() {
  const objects = new Map();
  return {
    objects,
    store(key, raw, customMetadata = {}) {
      objects.set(key, {
        key,
        raw,
        uploaded: new Date(NOW),
        customMetadata,
      });
    },
    keys() {
      return [...objects.keys()].sort();
    },
    async list({ prefix, limit = 1000, cursor }) {
      const matching = [...objects.values()]
        .filter((object) => object.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
      const start = cursor ? matching.findIndex((object) => object.key === cursor) + 1 : 0;
      const page = matching.slice(start, start + limit);
      const truncated = start + page.length < matching.length;
      return {
        objects: page.map(({ key, uploaded, customMetadata }) => ({ key, uploaded, customMetadata })),
        truncated,
        cursor: truncated ? page[page.length - 1]?.key : undefined,
      };
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        key,
        uploaded: object.uploaded,
        customMetadata: object.customMetadata,
        async arrayBuffer() {
          return new TextEncoder().encode(object.raw).buffer;
        },
      };
    },
    async put(key, value, options = {}) {
      objects.set(key, {
        key,
        raw: new TextDecoder().decode(value),
        uploaded: new Date(NOW),
        customMetadata: options.customMetadata ?? {},
      });
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/** The digest is the key's last segment; the sweep never re-hashes. */
function unverifiedKey(recipient, digest) {
  return `unverified/${recipient}/${digest}`;
}

async function modules() {
  const { sweepSeatInbox } = await import("../../lib/pms/inbound/sweep.ts");
  const { allowSender } = await import("../../lib/pms/inbound/senders.ts");
  const { claimSeatSlug } = await import("../../lib/pms/inbound/seats.ts");
  const { seatReview, seatMessageCounts } = await import("../../lib/pms/inbound/messages.ts");
  return { sweepSeatInbox, allowSender, claimSeatSlug, seatReview, seatMessageCounts };
}

test("an allowlisted sender's message is verified, moved, and recorded", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox, allowSender, claimSeatSlug, seatReview, seatMessageCounts } = await modules();
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");

  const bucket = fakeBucket();
  bucket.store(unverifiedKey("agent-acme-props@aval.llc", "d1"), delivered(), {
    recipient: "agent-acme-props@aval.llc",
    verified: "false",
  });

  const summary = await sweepSeatInbox({ bucket, authservId: CF });
  assert.equal(summary.verified, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(bucket.keys(), ["verified/org_1/d1"]);
  // The metadata the mail Worker wrote said verified:"false". The object and the
  // row must not be able to disagree about what was decided.
  assert.equal(bucket.objects.get("verified/org_1/d1").customMetadata.verified, "true");

  const review = await seatReview("org_1");
  assert.equal(review.verified, 1);
  assert.deepEqual(review.held, []);
  assert.deepEqual(await seatMessageCounts("org_1"), { verified: 1 });
});

test("verified mail is not promoted yet, and says so rather than looking like silence", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox, allowSender, claimSeatSlug } = await modules();
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");

  const bucket = fakeBucket();
  bucket.store(unverifiedKey("agent-acme-props@aval.llc", "d1"), delivered(), {
    recipient: "agent-acme-props@aval.llc",
  });

  const summary = await sweepSeatInbox({ bucket, authservId: CF });
  // P1.1 is not built. The message is verified and retained, and the row records
  // why nothing parsed it — an expected state, not a failure.
  assert.equal(summary.verified, 1);
  assert.equal(summary.promoted, 0);
  const [row] = sqlite.prepare("SELECT reason, provider_id FROM pms_seat_messages").all();
  assert.equal(row.provider_id, "appfolio");
  assert.match(row.reason, /parser/i);
});

test("an authenticated sender nobody allowed is held and offered for review", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox, claimSeatSlug, seatReview } = await modules();
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");

  const bucket = fakeBucket();
  for (const digest of ["d1", "d2", "d3"]) {
    bucket.store(unverifiedKey("agent-acme-props@aval.llc", digest), delivered(), {
      recipient: "agent-acme-props@aval.llc",
    });
  }

  const summary = await sweepSeatInbox({ bucket, authservId: CF });
  assert.equal(summary.held, 3);
  assert.deepEqual(bucket.keys(), ["held/org_1/d1", "held/org_1/d2", "held/org_1/d3"]);

  const review = await seatReview("org_1");
  assert.equal(review.held.length, 1);
  assert.equal(review.held[0].domain, "appfolio.com");
  assert.equal(review.held[0].messages, 3);
  assert.equal(review.held[0].method, "dmarc");
});

test("allowing a held sender reaches the mail that was already waiting", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox, allowSender, claimSeatSlug, seatReview } = await modules();
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");

  const bucket = fakeBucket();
  for (const digest of ["d1", "d2"]) {
    bucket.store(unverifiedKey("agent-acme-props@aval.llc", digest), delivered(), {
      recipient: "agent-acme-props@aval.llc",
    });
  }

  await sweepSeatInbox({ bucket, authservId: CF });
  assert.equal((await seatReview("org_1")).held[0].messages, 2);

  // The operator clicks Allow on what the review showed them.
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");
  const second = await sweepSeatInbox({ bucket, authservId: CF });

  // This is the promise the review makes. Without the held prefix being
  // re-listed, the two messages would sit there forever and the button would
  // have been decorative.
  assert.equal(second.verified, 2);
  assert.deepEqual(bucket.keys(), ["verified/org_1/d1", "verified/org_1/d2"]);
  const review = await seatReview("org_1");
  assert.deepEqual(review.held, []);
  assert.equal(review.verified, 2);
});

test("a message that authenticated nothing is counted without being named", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox, claimSeatSlug, seatReview } = await modules();
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");

  const bucket = fakeBucket();
  // SPF passes, nothing else. Email Routing accepts this, and it must not
  // become a named sender an operator is invited to allow.
  bucket.store(
    unverifiedKey("agent-acme-props@aval.llc", "d1"),
    `Authentication-Results: ${CF}; spf=pass smtp.mailfrom=bounces.whoever.example; dkim=none; dmarc=none\r\n`
      + "From: notifications@appfolio.com\r\n\r\nbody",
    { recipient: "agent-acme-props@aval.llc" },
  );

  const summary = await sweepSeatInbox({ bucket, authservId: CF });
  assert.equal(summary.unauthenticated, 1);
  assert.deepEqual(bucket.keys(), ["rejected/org_1/d1"]);

  const review = await seatReview("org_1");
  assert.deepEqual(review.held, [], "an unauthenticated From must never appear as a held sender");
  assert.equal(review.unauthenticated.messages, 1);
  const [row] = sqlite.prepare("SELECT authenticated_domain FROM pms_seat_messages").all();
  assert.equal(row.authenticated_domain, null);
});

test("a sender's forged result cannot reach a verified disposition", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox, allowSender, claimSeatSlug } = await modules();
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");

  const bucket = fakeBucket();
  bucket.store(
    unverifiedKey("agent-acme-props@aval.llc", "d1"),
    `Authentication-Results: ${CF}; dkim=none; spf=fail smtp.mailfrom=attacker.example; dmarc=fail header.from=attacker.example\r\n`
      + `Authentication-Results: ${CF}; dmarc=pass header.from=appfolio.com\r\n`
      + "From: notifications@appfolio.com\r\n\r\nbody",
    { recipient: "agent-acme-props@aval.llc" },
  );

  const summary = await sweepSeatInbox({ bucket, authservId: CF });
  assert.equal(summary.verified, 0);
  assert.equal(summary.unauthenticated, 1);
});

test("mail to a slug no workspace holds is set aside, not attributed", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox } = await modules();
  org(sqlite, "org_1", "Acme");

  const bucket = fakeBucket();
  bucket.store(unverifiedKey("agent-notarealorg@aval.llc", "d1"), delivered(), {
    recipient: "agent-notarealorg@aval.llc",
  });

  const summary = await sweepSeatInbox({ bucket, authservId: CF });
  assert.equal(summary.unassigned, 1);
  assert.deepEqual(bucket.keys(), ["rejected/unassigned/d1"]);
  // Not attributable to any workspace, so no workspace's review can see it —
  // there is deliberately no cross-org reader for these rows.
  const [row] = sqlite.prepare("SELECT organization_id FROM pms_seat_messages").all();
  assert.equal(row.organization_id, null);
});

test("a recipient that is not a seat address cannot be made to resolve", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox, claimSeatSlug } = await modules();
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");

  const bucket = fakeBucket();
  // Metadata is the mail Worker's, but it is still checked here rather than
  // trusted: a recipient that is not a seat address must not look like one.
  bucket.store("unverified/agent-acme-props@aval.llc/d1", delivered(), {
    recipient: "evan@aval.llc",
  });

  const summary = await sweepSeatInbox({ bucket, authservId: CF });
  assert.equal(summary.unassigned, 1);
});

test("running the sweep twice changes nothing the first run decided", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox, allowSender, claimSeatSlug } = await modules();
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");

  const bucket = fakeBucket();
  bucket.store(unverifiedKey("agent-acme-props@aval.llc", "d1"), delivered(), {
    recipient: "agent-acme-props@aval.llc",
  });

  await sweepSeatInbox({ bucket, authservId: CF });
  const after = await sweepSeatInbox({ bucket, authservId: CF });

  // Nothing left under unverified/ or held/, so the second run has nothing to
  // do — and the row is keyed on the content hash either way.
  assert.equal(after.processed, 0);
  assert.deepEqual(bucket.keys(), ["verified/org_1/d1"]);
  const [{ count }] = sqlite.prepare("SELECT count(*) as count FROM pms_seat_messages").all();
  assert.equal(count, 1);
});

test("a wrong authserv-id fails every message closed, and records what arrived", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox, allowSender, claimSeatSlug } = await modules();
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");
  await allowSender("org_1", "appfolio.com", "appfolio", "user_1");

  const bucket = fakeBucket();
  bucket.store(unverifiedKey("agent-acme-props@aval.llc", "d1"), delivered({ authservId: "mx.example.net" }), {
    recipient: "agent-acme-props@aval.llc",
  });

  // The expected id is the one input that silently changes the conclusion, and
  // Cloudflare does not document it. Wrong id must fail closed...
  const summary = await sweepSeatInbox({ bucket, authservId: CF });
  assert.equal(summary.verified, 0);
  assert.equal(summary.unauthenticated, 1);
  // ...and report what actually arrived, which is what tells a developer why
  // instead of this looking identical to an inbox nobody has written to. The
  // run reports it; nothing queries it back out across workspaces.
  assert.deepEqual(summary.observedAuthservIds, ["mx.example.net"]);
  const [row] = sqlite.prepare("SELECT observed_authserv_ids FROM pms_seat_messages").all();
  assert.equal(row.observed_authserv_ids, "mx.example.net");
});

test("the per-run limit is split across prefixes so neither starves the other", async () => {
  const sqlite = await bootRuntime();
  const { sweepSeatInbox, claimSeatSlug } = await modules();
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");

  const bucket = fakeBucket();
  for (const digest of ["a1", "a2", "a3", "a4"]) {
    bucket.store(unverifiedKey("agent-acme-props@aval.llc", digest), delivered(), {
      recipient: "agent-acme-props@aval.llc",
    });
  }
  bucket.store("held/org_1/h1", delivered({ from: "buildium.com" }), {
    recipient: "agent-acme-props@aval.llc",
  });

  // Budget of 2 per prefix. A first-come budget would spend all four on the
  // backlog and never look at the held message an operator may be waiting on.
  const summary = await sweepSeatInbox({ bucket, authservId: CF, limit: 4 });
  assert.equal(summary.truncated, true);
  assert.equal(summary.processed, 3, "two from unverified, one from held");
  const [{ count }] = sqlite.prepare("SELECT count(*) as count FROM pms_seat_messages").all();
  assert.equal(count, 3);
});
