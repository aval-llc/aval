import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runRecordTool } from "../../lib/ask-aval/record-tools.ts";
import { eq } from "drizzle-orm";
import { withDbSession } from "../../db/postgres/session.ts";
import { ownershipEntities, properties } from "../../db/postgres/schema.ts";
import { completeWorkOrder, createVendor, createWorkOrder } from "../../lib/operations/maintenance.ts";
import { createLead, createLease } from "../../lib/operations/leasing.ts";
import { createProperty, createUnit } from "../../lib/operations/portfolio.ts";
import { createMeter, recordBill } from "../../lib/infrastructure/meters.ts";

/**
 * The entity reads that tool the Specialist library: each returns this
 * workspace's rows, says plainly when there are none, and is invisible to
 * every other workspace.
 */
export async function runRecordToolsCases(t, { session, config, administrator }) {
  const owner = `records_${randomUUID()}`, stranger = `records_${randomUUID()}`;
  const run = (work) => session(owner, (s) => work(s, s.identity.organizationId));
  const other = (work) => session(stranger, (s) => work(s, s.identity.organizationId));
  const read = (name, input = {}) => run((s, org) => runRecordTool(s, name, input, org));

  await t.test("with no records, every read says so rather than reporting zeros", async () => {
    for (const name of ["get_vendors", "get_leads", "get_utility_bills"]) {
      assert.equal((await read(name)).json.available, false, name);
    }
  });

  const property = await run((s, org) => createProperty(s, org, { name: `Records ${randomUUID().slice(0, 6)}` }));
  const leased = await run((s, org) => createUnit(s, org, { propertyId: property.id, unitNumber: "1A" }));
  await run((s, org) => createUnit(s, org, { propertyId: property.id, unitNumber: "2B", status: "vacant_ready", marketRentCents: 190_000, vacantSince: new Date(Date.now() - 10 * 86400_000) }));
  await run((s, org) => createLease(s, org, { unitId: leased.id, startDate: new Date("2025-11-01"), endDate: new Date(Date.now() + 40 * 86400_000), rentCents: 175_000, depositCents: 175_000 }));
  await run((s, org) => createVendor(s, org, { name: "Lapsed Plumbing", trade: "plumbing", insuranceExpiresAt: new Date("2025-01-01") }));
  await run((s, org) => createLead(s, org, { propertyId: property.id, channel: "zillow", unitTypeLabel: "2BR" }));
  const meter = await run((s, org) => createMeter(s, org, { utilityType: "water", propertyLabel: property.name, unitOfMeasure: "gal" }));
  await run((s, org) => recordBill(s, org, { meterId: meter.id, periodStart: new Date("2026-08-01"), periodEnd: new Date("2026-08-31"), usageAmount: 12_000, costCents: 8_400, currency: "USD", source: "manual" }));

  await t.test("each read returns this workspace's records, with only the fields the work needs", async () => {
    const vendors = (await read("get_vendors", { trade: "plumb" })).json;
    assert.equal(vendors.vendors[0].insurance_lapsed, true, "a lapsed certificate is flagged");
    assert.equal("email" in vendors.vendors[0], false, "no contact details reach the model");
    const leases = (await read("get_expiring_leases", { within_days: 60 })).json;
    assert.equal(leases.expiring_leases.length, 1);
    assert.equal(leases.expiring_leases[0].deposit_cents, 175_000);
    assert.equal((await read("get_expiring_leases", { within_days: 30 })).json.expiring_leases.length, 0, "the window is honoured");
    const units = (await read("get_available_units")).json;
    assert.equal(units.units.length, 1);
    assert.ok(units.units[0].days_vacant >= 9);
    assert.equal((await read("get_leads")).json.leads[0].channel, "zillow");
    const utilities = (await read("get_utility_bills", { utility_type: "water" })).json;
    assert.equal(utilities.bills[0].cost_cents, 8_400);
    const staff = (await read("get_workspace_staff")).json;
    assert.ok(staff.staff.length >= 1);
    assert.equal(Object.keys(staff.staff[0]).sort().join(), "name,role", "names and roles only");
    assert.equal((await read("get_connection_health")).json.available, true);
  });

  await t.test("another workspace sees none of it", async () => {
    for (const name of ["get_vendors", "get_leads", "get_utility_bills"]) {
      assert.equal((await other((s, org) => runRecordTool(s, name, {}, org))).json.available, false, name);
    }
    assert.equal((await other((s, org) => runRecordTool(s, "get_expiring_leases", { within_days: 365 }, org))).json.expiring_leases.length, 0);
    assert.equal((await other((s, org) => runRecordTool(s, "get_available_units", {}, org))).json.units.length, 0);
  });

  await t.test("owners are read through the properties a person can see, never the whole workspace", async () => {
    const now = new Date();
    const [ownerA, ownerB] = [`owner_${randomUUID()}`, `owner_${randomUUID()}`];
    const second = await run((s, org) => createProperty(s, org, { name: `Records B ${randomUUID().slice(0, 6)}` }));
    await run(async (s, org) => {
      await s.db.insert(ownershipEntities).values([
        { id: ownerA, organizationId: org, name: "Alder Holdings", legalName: "Alder Holdings LLC", createdAt: now, updatedAt: now },
        { id: ownerB, organizationId: org, name: "Birch Partners", createdAt: now, updatedAt: now },
      ]);
      await s.db.update(properties).set({ ownershipEntityId: ownerA }).where(eq(properties.id, property.id));
      await s.db.update(properties).set({ ownershipEntityId: ownerB }).where(eq(properties.id, second.id));
    });
    const everyone = (await read("get_owners")).json;
    assert.deepEqual(everyone.owners.map((row) => row.name), ["Alder Holdings", "Birch Partners"]);
    assert.equal(everyone.owners[0].properties[0].id, property.id);
    assert.equal(Object.keys(everyone.owners[0]).sort().join(), "id,legal_name,name,properties,status", "no contact or banking details");

    // A person granted only the first property sees its owner and not the other,
    // although ownership_entities itself is visible to the whole workspace.
    const scoped = `scoped_${randomUUID()}`;
    await session(scoped, async () => {});
    const org = await run(async (_s, organizationId) => organizationId);
    await administrator.query("insert into access_grants (id,organization_id,principal_id,role,organization_scope,property_id,created_at,updated_at) values ($1,$2,$3,'operator',false,$4,now(),now())", [randomUUID(), org, scoped, property.id]);
    const narrow = await withDbSession(config, { principalId: scoped, organizationId: org, actorId: scoped, requestId: randomUUID() }, (s) => runRecordTool(s, "get_owners", {}, org));
    assert.deepEqual(narrow.json.owners.map((row) => row.name), ["Alder Holdings"], "a property grant reaches that property's owner only");
    assert.equal((await other((s, orgId) => runRecordTool(s, "get_owners", {}, orgId))).json.available, false, "another workspace sees no owner");
  });

  await t.test("a turn is derived from unit status, the move-out and the unit's work since, and says what is not recorded", async () => {
    assert.equal((await read("get_turns")).json.turns.length, 0, "an occupied or ready unit is not a turn");
    const moveOut = new Date(Date.now() - 6 * 86400_000);
    const turning = await run((s, org) => createUnit(s, org, { propertyId: property.id, unitNumber: "3C", status: "vacant_not_ready", vacantSince: moveOut }));
    await run((s, org) => createLease(s, org, { unitId: turning.id, status: "expired", startDate: new Date("2025-01-01"), endDate: moveOut, rentCents: 160_000, depositCents: 160_000 }));
    await run((s, org) => createWorkOrder(s, org, { propertyId: property.id, unitId: turning.id, category: "general", summary: "Paint and patch", estimateCents: 45_000 }));
    await run(async (s, org) => {
      const old = await createWorkOrder(s, org, { propertyId: property.id, unitId: turning.id, summary: "Closed before the move-out", reportedAt: new Date("2025-06-01") });
      await completeWorkOrder(s, org, old.id, { at: new Date("2025-06-03"), actualCostCents: 9_900 });
    });
    const turns = (await read("get_turns")).json;
    assert.equal(turns.turns.length, 1);
    const [turn] = turns.turns;
    assert.equal(turn.phase, "make_ready");
    assert.equal(turn.move_out_on, moveOut.toISOString().slice(0, 10));
    assert.ok(turn.days_vacant >= 5);
    assert.equal(turn.open_work_orders, 1, "work reported before the move-out is not this turn's");
    assert.equal(turn.estimate_cents, 45_000);
    assert.equal(turn.actual_cost_cents, 0, "cost closed before the move-out is not this turn's");
    assert.deepEqual(turns.not_recorded, ["turn scope", "turn budget", "target ready date"]);
    assert.equal((await read("get_turns", { phase: "upcoming" })).json.turns.length, 0);
    assert.equal((await other((s, org) => runRecordTool(s, "get_turns", {}, org))).json.turns.length, 0, "another workspace sees no turn");
  });
}
