import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runRecordTool } from "../../lib/ask-aval/record-tools.ts";
import { createVendor } from "../../lib/operations/maintenance.ts";
import { createLead, createLease } from "../../lib/operations/leasing.ts";
import { createProperty, createUnit } from "../../lib/operations/portfolio.ts";
import { createMeter, recordBill } from "../../lib/infrastructure/meters.ts";

/**
 * The entity reads that tool the Specialist library: each returns this
 * workspace's rows, says plainly when there are none, and is invisible to
 * every other workspace.
 */
export async function runRecordToolsCases(t, { session }) {
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
}
