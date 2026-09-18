import assert from "node:assert/strict";
import test from "node:test";
import { bootRuntime } from "./harness.mjs";

/**
 * Verified seat mail becoming operational data — P1.1's ingestion half.
 *
 * What is asserted here is the honest boundary: the envelope is captured,
 * durably and exactly once, and no entities are extracted because no provider
 * parser exists. A test that pretended otherwise would be the worst outcome in
 * this whole path — silent, plausible, wrong data attributed to a customer's PMS.
 */

const NOW = Date.now();
const CRLF = "\r\n";

function org(sqlite, id, name) {
  sqlite
    .prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(id, name, "user_1", NOW, NOW);
}

function notification({ subject = "Work order 4021 assigned", body = "Unit 12C reports a leak." } = {}) {
  return [
    "From: notifications@appfolio.com",
    `Subject: ${subject}`,
    "Date: Thu, 17 Sep 2026 18:40:00 -0700",
    "Message-ID: <4021@appfolio.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join(CRLF);
}

async function modules() {
  const { promoteVerifiedMessage } = await import("../../lib/pms/inbound/promote.ts");
  const { captureNotification, seatEventId, notificationParser } =
    await import("../../lib/pms/inbound/notifications.ts");
  return { promoteVerifiedMessage, captureNotification, seatEventId, notificationParser };
}

test("a verified message is captured as an event with its envelope normalized", async () => {
  const sqlite = await bootRuntime();
  const { promoteVerifiedMessage } = await modules();
  org(sqlite, "org_1", "Acme");

  const outcome = await promoteVerifiedMessage({
    organizationId: "org_1",
    providerId: "appfolio",
    digest: "d1",
    objectKey: "verified/org_1/d1",
    raw: notification(),
  });

  assert.equal(outcome.promoted, true, "captured");
  assert.equal(outcome.extracted, false, "no parser exists, and it says so");
  assert.match(outcome.reason, /AppFolio/);

  const [row] = sqlite.prepare("SELECT * FROM integration_events").all();
  assert.equal(row.provider, "appfolio");
  assert.equal(row.organization_id, "org_1");
  assert.equal(row.event_type, "seat.notification");
  // `received`, not `processed`. Nothing has extracted entities from it, and
  // claiming otherwise would make the backlog invisible.
  assert.equal(row.status, "received");

  const payload = JSON.parse(row.payload_json);
  assert.equal(payload.subject, "Work order 4021 assigned");
  assert.equal(payload.text, "Unit 12C reports a leak.");
  assert.equal(payload.claimedFrom, "notifications@appfolio.com");
  assert.equal(payload.sentAt, new Date("2026-09-17T18:40:00-07:00").toISOString());
  // Where the raw message still is. A parser written later starts from this.
  assert.equal(payload.objectKey, "verified/org_1/d1");
});

test("the event's timestamp is the notification's own, not the capture time", async () => {
  const sqlite = await bootRuntime();
  const { promoteVerifiedMessage } = await modules();
  org(sqlite, "org_1", "Acme");

  await promoteVerifiedMessage({
    organizationId: "org_1",
    providerId: "appfolio",
    digest: "d1",
    objectKey: "verified/org_1/d1",
    raw: notification(),
  });

  const [row] = sqlite.prepare("SELECT received_at FROM integration_events").all();
  assert.equal(row.received_at, new Date("2026-09-17T18:40:00-07:00").getTime());
});

test("capturing the same message twice writes one event", async () => {
  const sqlite = await bootRuntime();
  const { captureNotification } = await modules();
  org(sqlite, "org_1", "Acme");

  const message = {
    organizationId: "org_1",
    providerId: "appfolio",
    digest: "d1",
    objectKey: "verified/org_1/d1",
    raw: notification(),
  };

  const first = await captureNotification(message);
  const second = await captureNotification(message);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.eventId, first.eventId, "the second capture finds the first, not a new row");
  assert.equal(sqlite.prepare("SELECT count(*) AS total FROM integration_events").get().total, 1);
});

test("two workspaces receiving the same notice each get their own event", async () => {
  const sqlite = await bootRuntime();
  const { captureNotification, seatEventId } = await modules();
  org(sqlite, "org_1", "Acme");
  org(sqlite, "org_2", "Other");

  // The same bytes, so the same content hash. integration_events is unique on
  // (provider, external_event_id) and NOT on the organization, so a digest-only
  // key would drop the second workspace's copy as a duplicate — one customer
  // silently losing mail because another received the same vendor notice.
  const raw = notification();
  await captureNotification({ organizationId: "org_1", providerId: "appfolio", digest: "same", objectKey: "k1", raw });
  await captureNotification({ organizationId: "org_2", providerId: "appfolio", digest: "same", objectKey: "k2", raw });

  const rows = sqlite.prepare("SELECT organization_id, external_event_id FROM integration_events ORDER BY organization_id").all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.organization_id), ["org_1", "org_2"]);
  assert.equal(rows[0].external_event_id, seatEventId("org_1", "same"));
  assert.notEqual(rows[0].external_event_id, rows[1].external_event_id);
});

test("no provider has an entity parser, and that is reported rather than implied", async () => {
  await bootRuntime();
  const { notificationParser } = await modules();
  // The registry is empty on purpose: writing an AppFolio parser from no real
  // sample would be inventing a vendor's format, and its failures would be
  // silent — fields quietly absent, a work order on the wrong unit.
  for (const providerId of ["appfolio", "buildium", "doorloop", "yardi", "generic_email"]) {
    assert.equal(notificationParser(providerId), undefined, `${providerId} must not claim a parser`);
  }
});

test("a parser's verdict is what decides the event's status", async () => {
  const sqlite = await bootRuntime();
  const { captureNotification } = await modules();
  org(sqlite, "org_1", "Acme");

  // The seam, exercised without faking a vendor format: a parser is asked, and
  // what it says lands on the row. This is what a real parser plugs into, and
  // the stand-in only reads the subject it was handed.
  const captured = await captureNotification({
    organizationId: "org_1",
    providerId: "appfolio",
    digest: "d9",
    objectKey: "verified/org_1/d9",
    raw: notification(),
    parser: async ({ message }) => ({
      recognised: message.subject?.startsWith("Work order") ?? false,
      kind: "maintenance.work_order",
      reason: "Recognised by the test's stand-in parser.",
    }),
  });

  assert.equal(captured.extraction.recognised, true);
  assert.equal(sqlite.prepare("SELECT status FROM integration_events").get().status, "processed");

  // And a parser that does not recognise the message leaves it `received`, so
  // an unparsed backlog stays visible.
  const unrecognised = await captureNotification({
    organizationId: "org_1",
    providerId: "appfolio",
    digest: "d10",
    objectKey: "verified/org_1/d10",
    raw: notification({ subject: "Monthly statement" }),
    parser: async ({ message }) => ({
      recognised: message.subject?.startsWith("Work order") ?? false,
      reason: "Not a work order notification.",
    }),
  });
  assert.equal(unrecognised.extraction.recognised, false);
  assert.equal(
    sqlite.prepare("SELECT status FROM integration_events WHERE external_event_id LIKE '%d10'").get().status,
    "received",
  );
});

test("a message whose provider no longer exists is refused, not captured under a stray name", async () => {
  const sqlite = await bootRuntime();
  const { promoteVerifiedMessage } = await modules();
  org(sqlite, "org_1", "Acme");

  const outcome = await promoteVerifiedMessage({
    organizationId: "org_1",
    providerId: "appfolio_v2",
    digest: "d1",
    objectKey: "verified/org_1/d1",
    raw: notification(),
  });
  assert.equal(outcome.promoted, false);
  assert.equal(sqlite.prepare("SELECT count(*) AS total FROM integration_events").get().total, 0);
});

test("an attachment is recorded by name and type, never by content", async () => {
  const sqlite = await bootRuntime();
  const { promoteVerifiedMessage } = await modules();
  org(sqlite, "org_1", "Acme");

  const secret = Buffer.from("attachment bytes that must not reach an agent").toString("base64");
  const raw = [
    "From: notifications@appfolio.com",
    "Subject: Invoice 4021",
    'Content-Type: multipart/mixed; boundary="=_b"',
    "",
    "--=_b",
    "Content-Type: text/plain",
    "",
    "Invoice attached.",
    "--=_b",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="invoice-4021.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    secret,
    "--=_b--",
  ].join(CRLF);

  await promoteVerifiedMessage({
    organizationId: "org_1",
    providerId: "appfolio",
    digest: "d1",
    objectKey: "verified/org_1/d1",
    raw,
  });

  const stored = sqlite.prepare("SELECT payload_json FROM integration_events").get().payload_json;
  assert.doesNotMatch(stored, /must not reach an agent/);
  assert.doesNotMatch(stored, new RegExp(secret.slice(0, 24)));
  const payload = JSON.parse(stored);
  assert.equal(payload.attachments[0].filename, "invoice-4021.pdf");
  assert.equal(payload.attachments[0].contentType, "application/pdf");
});
