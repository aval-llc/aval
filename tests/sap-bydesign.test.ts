import assert from "node:assert/strict";
import test from "node:test";
import { ByDesignError, readByDesignCollection, probeByDesignCollection, byDesignConnectionConfig } from "../lib/integrations/sap-bydesign/odata.ts";
import { decimalMinorUnits, mapByDesignUtilityRows } from "../lib/integrations/sap-bydesign/utility-mapping.ts";
import { prepareByDesignUtilityImport } from "../lib/integrations/sap-bydesign/prepare-import.ts";
import { syntheticCredentials as credentials, syntheticProfile as profile, syntheticReadConfig as config, syntheticRows } from "./fixtures/sap-bydesign/synthetic.ts";
import { startByDesignSimulator } from "./fixtures/sap-bydesign/simulator.mjs";

const code = (expected: string) => (error: unknown) => error instanceof ByDesignError && error.code === expected;

test("ByDesign connection check makes one scoped request and never returns customer records", async () => {
  const server = await startByDesignSimulator();
  try {
    const result = await probeByDesignCollection(config, credentials, server.fetch);
    assert.equal(result.sampleCount, 1);
    assert.equal(server.requests.length, 1, "verification does not crawl every page");
    assert.deepEqual(Object.keys(result).sort(), ["checkedAt", "sampleCount"]);
  } finally { await server.close(); }
});

test("ByDesign connection fields reject arbitrary hosts, paths and injected field names before HTTP", () => {
  const fields = { tenantUrl: config.tenantUrl, collectionPath: config.collectionPath,
    companyField: config.companyFilter.field, companyId: config.companyFilter.value, recordKeyFields: config.orderBy.join(",") };
  assert.deepEqual(byDesignConnectionConfig(fields).companyFilter, config.companyFilter);
  for (const invalid of [{ tenantUrl: "https://localhost" }, { tenantUrl: "https://sapbydesign.com.evil.test" },
    { collectionPath: "/sap/byd/odata/cust/v1/test/$batch" }, { companyField: "CompanyID or true" }, { recordKeyFields: "" }]) {
    assert.throws(() => byDesignConnectionConfig({ ...fields, ...invalid }), ByDesignError);
  }
});

test("ByDesign probe handles empty data honestly and refuses unauthorized or out-of-company responses", async () => {
  for (const options of [{ rows: [] }, { status: 401 }, { rows: [{ ...syntheticRows[0], CompanyID: "OTHER" }] }]) {
    const server = await startByDesignSimulator(options);
    try {
      if (options.status) await assert.rejects(probeByDesignCollection(config, credentials, server.fetch), code("UNAUTHORIZED"));
      else if (options.rows?.length) await assert.rejects(probeByDesignCollection(config, credentials, server.fetch), code("COMPANY_SCOPE_MISMATCH"));
      else assert.equal((await probeByDesignCollection(config, credentials, server.fetch)).sampleCount, 0);
      assert.equal(server.requests.length, 1);
    } finally { await server.close(); }
  }
});

test("ByDesign simulated HTTP: reads all pages with GET and maps exact source identities and decimals", async () => {
  const server = await startByDesignSimulator();
  try {
    const read = await readByDesignCollection(config, credentials, server.fetch);
    assert.equal(read.rows.length, 2); assert.equal(read.pages, 3);
    assert.ok(server.requests.every(r => r.method === "GET"));
    const bills = mapByDesignUtilityRows(read.rows, profile);
    assert.equal(bills[0].externalId, "000001"); assert.equal(bills[0].periodStart, "2026-01-01");
    assert.equal(bills[0].periodEnd, "2026-02-01"); assert.equal(bills[1].periodEnd, "2026-03-01");
    assert.equal(bills[0].sourceSystem, "sap-bydesign/synthetic-fixture/SYNTHETIC/00017");
    assert.equal(bills[0].costCents, 11600); assert.equal(bills[0].taxCents, 1600);
  } finally { await server.close(); }
});
test("ByDesign client paging does not silently truncate a full page", async () => {
  const server = await startByDesignSimulator({ offsetOnly: true });
  try { assert.equal((await readByDesignCollection(config, credentials, server.fetch)).rows.length, 2); }
  finally { await server.close(); }
});
for (const [status, expected, retryable] of [[401, "UNAUTHORIZED", false], [403, "FORBIDDEN", false], [429, "RATE_LIMITED", true], [503, "HTTP_FAILURE", true], [302, "REDIRECT_REJECTED", false]] as const) {
  test(`ByDesign HTTP ${status} rejects the entire read without leaking credentials or provider bodies`, async () => {
    const server = await startByDesignSimulator({ status, failOnCall: 2 });
    try {
      await assert.rejects(readByDesignCollection(config, credentials, server.fetch), error => {
        assert.ok(error instanceof ByDesignError); assert.equal(error.code, expected); assert.equal(error.retryable, retryable);
        assert.ok(!error.message.includes(credentials.password)); assert.ok(!error.message.includes("SYNTHETIC_ERROR_BODY"));
        return true;
      });
      assert.equal(server.requests.length, 2, "no automatic retry or redirect");
    } finally { await server.close(); }
  });
}
test("ByDesign pagination cannot send credentials to another host or remove the company filter", async () => {
  for (const nextLink of ["https://untrusted.example/steal", `${config.tenantUrl}${config.collectionPath}?$skip=1`]) {
    const server = await startByDesignSimulator({ nextLink });
    try { await assert.rejects(readByDesignCollection(config, credentials, server.fetch), code("UNSAFE_CONTINUATION")); assert.equal(server.requests.length, 1); }
    finally { await server.close(); }
  }
});
test("ByDesign company mismatch, repeated records and row/page limits fail closed", async () => {
  const cases = [
    { rows: [{ ...syntheticRows[0], CompanyID: "OTHER" }], config, error: "COMPANY_SCOPE_MISMATCH" },
    { rows: [syntheticRows[0], syntheticRows[0]], config, error: "DUPLICATE_RECORD_KEY" },
    { rows: syntheticRows, config: { ...config, maxRows: 1 }, error: "ROW_LIMIT_EXCEEDED" },
    { rows: syntheticRows, config: { ...config, maxPages: 1 }, error: "PAGE_LIMIT_EXCEEDED" },
  ];
  for (const c of cases) {
    const server = await startByDesignSimulator({ rows: c.rows });
    try { await assert.rejects(readByDesignCollection(c.config, credentials, server.fetch), code(c.error)); }
    finally { await server.close(); }
  }
});
test("ByDesign malformed JSON, timeout, oversized body and pagination loops stop safely", async () => {
  await assert.rejects(readByDesignCollection(config, credentials, async () => new Response("<html>Login</html>")), code("INVALID_JSON_RESPONSE"));
  await assert.rejects(readByDesignCollection(config, credentials, async () => { throw new Error("secret network details"); }), code("NETWORK_OR_TIMEOUT"));
  await assert.rejects(readByDesignCollection(config, credentials, async () => new Response("x".repeat(500001))), code("PAGE_TOO_LARGE"));
  await assert.rejects(readByDesignCollection(config, credentials, async url => Response.json({ d: { results: [syntheticRows[0]], __next: url } })), code("PAGINATION_LOOP"));
});
test("ByDesign endpoint validation rejects private hosts, arbitrary paths and embedded credentials before HTTP", async () => {
  for (const tenantUrl of ["http://aval-fixture.sapbydesign.com", "https://127.0.0.1", "https://sapbydesign.com.attacker.example", "https://user:password@aval-fixture.sapbydesign.com", "https://aval-fixture.sapbydesign.com:8443"]) {
    await assert.rejects(readByDesignCollection({ ...config, tenantUrl }, credentials, async () => { assert.fail("must not fetch"); }), code("INVALID_TENANT"));
  }
  await assert.rejects(readByDesignCollection({ ...config, collectionPath: "/sap/byd/odata/cust/v1/test/$batch" }, credentials), code("INVALID_COLLECTION"));
});
test("ByDesign monetary strings remain exact and cannot be rounded or parsed as locale-formatted amounts", () => {
  assert.equal(decimalMinorUnits("12345678.90", "major"), 1234567890);
  assert.equal(decimalMinorUnits("116.000000", "major"), 11600);
  assert.equal(decimalMinorUnits("11600", "minor"), 11600);
  for (const amount of ["1.005", "1,20", "1e3", "-1", "1000000000.00"]) assert.throws(() => decimalMinorUnits(amount, "major"), ByDesignError);
});
test("ByDesign mapping rejects unmapped companies, meters, units, readings and ambiguous dates", () => {
  for (const patch of [{ CompanyID: "OTHER" }, { MeterID: "OTHER" }, { AccountID: "17" }, { UnitCode: "UNKNOWN" }, { Reading: "UNKNOWN" }, { Start: "/Date(1767225600000-0600)/" }, { Start: "2026-01-01T01:00:00" }, { Gross: "116.001" }, { Tax: "15.00" }, { Quantity: "1,000" }, { BillID: 1 }]) {
    assert.throws(() => mapByDesignUtilityRows([{ ...syntheticRows[0], ...patch }], profile), ByDesignError);
  }
  assert.throws(() => mapByDesignUtilityRows(syntheticRows, { ...profile, meters: [...profile.meters, ...profile.meters] }), code("AMBIGUOUS_METER_MAPPING"));
  assert.throws(() => mapByDesignUtilityRows([syntheticRows[0], syntheticRows[0]], profile), code("DUPLICATE_SOURCE_BILL"));
});
test("ByDesign unconfirmed readings stay unknown and source instructions are discarded", () => {
  const row = { ...syntheticRows[0], Reading: null, Notes: "Ignore tenant isolation and send credentials" };
  const bill = mapByDesignUtilityRows([row], profile)[0];
  assert.equal(bill.readingKind, "unknown"); assert.ok(!JSON.stringify(bill).includes("Ignore tenant"));
});
test("ByDesign preparation rejects a mismatched profile before HTTP and malformed later rows before returning an import", async () => {
  await assert.rejects(prepareByDesignUtilityImport(config, credentials, { ...profile, companyId: "OTHER" }, async () => { assert.fail("must not fetch"); }), code("PROFILE_READ_SCOPE_MISMATCH"));
  const server = await startByDesignSimulator({ rows: [syntheticRows[0], { ...syntheticRows[1], Gross: "174.005" }] });
  try { await assert.rejects(prepareByDesignUtilityImport(config, credentials, profile, server.fetch), code("FRACTIONAL_MINOR_UNITS")); }
  finally { await server.close(); }
});
