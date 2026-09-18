import assert from "node:assert/strict";
import test from "node:test";
import { bootRuntime } from "./harness.mjs";

/**
 * Seat addresses against real storage.
 *
 * The invariant every assertion here defends: a slug belongs to one workspace
 * forever. A seat address lives inside a customer's PMS configuration, outside
 * our control, and may still be in use years after they stopped thinking about
 * it. Mail sent to it must never arrive at a different workspace — so these
 * tests are mostly about what cannot happen.
 */

const NOW = Date.now();

function org(sqlite, id, name) {
  sqlite
    .prepare("INSERT OR IGNORE INTO organizations (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(id, name, "user_1", NOW, NOW);
}

test("claiming a slug gives the workspace an address", async () => {
  const sqlite = await bootRuntime();
  const { claimSeatSlug, organizationForRecipient } = await import("../../lib/pms/inbound/seats.ts");
  org(sqlite, "org_1", "Acme");

  const claim = await claimSeatSlug("org_1", "acme-props", "user_1");
  assert.equal(claim.ok, true);
  assert.equal(claim.address, "agent-acme-props@aval.llc");
  assert.equal(claim.alias, false);
  assert.equal(await organizationForRecipient("agent-acme-props@aval.llc"), "org_1");
});

test("a slug another workspace holds cannot be taken, by anyone", async () => {
  const sqlite = await bootRuntime();
  const { claimSeatSlug, organizationForRecipient } = await import("../../lib/pms/inbound/seats.ts");
  org(sqlite, "org_1", "Acme");
  org(sqlite, "org_2", "Other");

  await claimSeatSlug("org_1", "acme-props", "user_1");
  const stolen = await claimSeatSlug("org_2", "acme-props", "user_2");
  assert.equal(stolen.ok, false);
  // Does not disclose who holds it: a setup field must not be an enumeration
  // oracle for other workspaces' live addresses.
  assert.doesNotMatch(String(stolen.reason), /org_1|acme/i);
  // And the address still resolves to its owner.
  assert.equal(await organizationForRecipient("agent-acme-props@aval.llc"), "org_1");
});

test("renaming adds an address and the old one keeps working", async () => {
  const sqlite = await bootRuntime();
  const { claimSeatSlug, organizationForRecipient, seatAddressesFor } =
    await import("../../lib/pms/inbound/seats.ts");
  org(sqlite, "org_1", "Acme");

  await claimSeatSlug("org_1", "acme-props", "user_1");
  const renamed = await claimSeatSlug("org_1", "acme-residential", "user_1");
  assert.equal(renamed.ok, true);

  // The whole point: the customer's PMS still has the first address on file.
  assert.equal(await organizationForRecipient("agent-acme-props@aval.llc"), "org_1");
  assert.equal(await organizationForRecipient("agent-acme-residential@aval.llc"), "org_1");

  const addresses = await seatAddressesFor("org_1");
  assert.equal(addresses.primary, "agent-acme-residential@aval.llc");
  assert.equal(addresses.all.length, 2);
  assert.equal(addresses.all[0], "agent-acme-residential@aval.llc", "the current address sorts first");
});

test("a released slug is never freed for someone else", async () => {
  const sqlite = await bootRuntime();
  const { claimSeatSlug } = await import("../../lib/pms/inbound/seats.ts");
  org(sqlite, "org_1", "Acme");
  org(sqlite, "org_2", "Other");

  await claimSeatSlug("org_1", "acme-props", "user_1");
  await claimSeatSlug("org_1", "acme-residential", "user_1"); // moved on

  // org_1 no longer displays acme-props, but it is not available.
  const taken = await claimSeatSlug("org_2", "acme-props", "user_2");
  assert.equal(taken.ok, false);
});

test("re-claiming an address this workspace already holds switches back to it", async () => {
  const sqlite = await bootRuntime();
  const { claimSeatSlug, seatAddressesFor } = await import("../../lib/pms/inbound/seats.ts");
  org(sqlite, "org_1", "Acme");

  await claimSeatSlug("org_1", "acme-props", "user_1");
  await claimSeatSlug("org_1", "acme-residential", "user_1");
  const back = await claimSeatSlug("org_1", "acme-props", "user_1");

  assert.equal(back.ok, true);
  assert.equal(back.alias, true, "no new row — it already held this one");
  assert.equal((await seatAddressesFor("org_1")).primary, "agent-acme-props@aval.llc");
  assert.equal((await seatAddressesFor("org_1")).all.length, 2, "still two addresses, not three");
});

test("an unissued but well-formed address resolves to nobody", async () => {
  await bootRuntime();
  const { organizationForRecipient } = await import("../../lib/pms/inbound/seats.ts");
  // The Worker stores this — it has no database and cannot know. Resolution is
  // where it becomes nothing, which is why storing it was inert.
  assert.equal(await organizationForRecipient("agent-nobody-here@aval.llc"), null);
});

test("a human address never resolves to a workspace", async () => {
  const sqlite = await bootRuntime();
  const { claimSeatSlug, organizationForRecipient } = await import("../../lib/pms/inbound/seats.ts");
  org(sqlite, "org_1", "Acme");
  await claimSeatSlug("org_1", "acme-props", "user_1");
  assert.equal(await organizationForRecipient("evan@aval.llc"), null);
});

test("a workspace with no slug has no address to show", async () => {
  const sqlite = await bootRuntime();
  const { seatAddressesFor } = await import("../../lib/pms/inbound/seats.ts");
  org(sqlite, "org_fresh", "Fresh");
  const addresses = await seatAddressesFor("org_fresh");
  assert.equal(addresses.primary, null);
  assert.deepEqual(addresses.all, []);
});
