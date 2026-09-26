# SAP Business ByDesign: independent connector rehearsal

Date: 2026-09-25 (America/Los_Angeles). Branch: `khas`.
Confirmed target product: **SAP Business ByDesign**. Gentor's enabled services, data model and credentials remain unavailable.

## Delivered

A read-only OData v2 connector foundation, an explicit utility mapping profile, a local HTTP simulator, and regression coverage through Aval's actual PostgreSQL/public-route/agent-runtime path. These additions do not enable a production SAP connection or change the integration catalog. No SAP account, API subscription, database migration or new infrastructure is required to run the simulation.

The simulator listens on an ephemeral loopback port. The test transport rewrites one synthetic SAP hostname to that local server and rejects every other destination. It cannot proxy to SAP. The production reader still requires HTTPS on an explicit `*.sapbydesign.com` tenant and has no localhost exception. Fixture credentials are invented and only accepted by the simulator.

## Basis and assumptions

SAP documents OData services with collection queries, `$select`, `$filter`, `$orderby`, `$top`, `$skip` and continuation links in its [ByDesign OData user guide](https://help.sap.com/docs/SAP_BUSINESS_BYDESIGN/7c182c462ec043cba338a30b952068c7/2bccd772722d1014b742a3a0c4b116d0.html?locale=en-US). Its [analytics documentation](https://help.sap.com/docs/r/7c182c462ec043cba338a30b952068c7/latest/en-US/2be3c33a722d1014a62bdc2382beea48.html) describes exposed data sources and technical-user access through communication arrangements.

SAP's own [API samples](https://github.com/SAP-samples/byd-api-samples/blob/main/README.md) require a licensed ByDesign system and are tailored to partner demo tenants. We have not downloaded customer records or connected to any sample tenant. We independently authored the fixtures.

`UtilityBillCollection`, `CompanyID`, `MeterID`, `Gross`, `Reading`, and the other names in `tests/fixtures/sap-bydesign/synthetic.ts` are **invented fixture names**. They are not a claim that SAP ships a standard utility-meter service or that Gentor exposes these fields. Actual invoices might lack meter/quantity data, or represent multiple charges per document; those need a reviewed customer mapping or another source before import. An invoice amount alone must never become invented consumption.

The current transport supports the tested OData v2 JSON envelope (`d.results`, optional `d.__next`) for explicitly configured analytics data-source or custom-service collection paths. It does not implement SOAP, arbitrary service actions, OAuth setup, writes, automatic synchronization or metadata discovery. Basic technical-user authentication is a supported starting point to verify with Gentor; the actual permitted authentication method still needs confirmation. Alternative hostnames and date encodings require explicit review, not a bypass of endpoint validation.

## Pipeline and invariants

1. `readByDesignCollection` fetches bounded pages with GET only. Credentials stay on the exact approved host/collection; redirects and continuation scope changes fail. Company filtering is also checked against each returned row.
2. A unique ordered record key is required. Repeated keys, loops, limits, malformed JSON, oversized pages and errors reject the complete read. Default limits: 100 rows/page, 500 rows, 20 pages, 500 KB/page, 10-second request timeout.
3. `mapByDesignUtilityRows` requires explicit company/account/meter mappings. Source IDs retain leading zeros. Known unit and reading codes are mapped; unknown codes fail. Missing reading confirmation stays `unknown`.
4. Money is converted from decimal strings to integer minor units without rounding. Date-only or UTC-midnight OData v2 dates are supported. Inclusive billing ends are converted only when the reviewed profile explicitly says `inclusive`; offset/local timestamps fail rather than guessing a timezone.
5. `prepareByDesignUtilityImport` reads and validates everything before returning rows. It takes no database session. Provider HTTP must finish **before** entering Aval's transaction.
6. The existing preview/apply API validates organization/meter ownership and binds confirmation to the reviewed content. Correction history, audit append, idempotency and transaction behavior remain in the existing utility importer.
7. The agent reads persisted utility evidence, and the existing scheduler drives child work and review. Follow-up tasks remain internal and require a human-confirmed request.

HTTP 401/403 require credentials/permission correction. HTTP 429 and 5xx expose a sanitized retryable error and bounded Retry-After information. There is no automatic retry loop or hidden external write. A caller can restart a failed read; nothing is imported from partial results. Source payloads, credentials and provider error bodies are not echoed into error messages.

Ordered paging is **not a consistent SAP snapshot**. For a real pilot use a reviewed, stable billing window/export and reconcile counts and totals against the source. Concurrent source edits could otherwise omit rows even when duplicate detection passes. Automatic incremental updates, source deletions, line-item aggregation and large-volume extraction remain unimplemented.

## Reproduce without SAP access

Validated with Node 24.19.0 on Windows:

```powershell
npm run test:sap-bydesign
npm run rehearse:sap-bydesign
```

The rehearsal writes `outputs/sap-bydesign/rehearsal.json` and `outputs/sap-bydesign/synthetic-reviewed-bills.json`. It opens and closes its own loopback server. It never loads local secrets or calls an external model. Generated bill rows use a fake Aval meter ID and are for local evaluation, not production import.

For actual persistence and scripted-agent coverage, run the existing suite against a **fresh disposable local** PostgreSQL database:

```powershell
$env:AVAL_TEST_DATABASE_URL = '<disposable loopback PostgreSQL URL>'
$env:AVAL_POSTGRES_CLIENT_IMAGE = 'postgres:17-alpine'
npm run test:postgres
```

Do not point this suite at a customer database. Its loopback restriction is enforced. The Docker image setting uses Docker for the backup tools; the database must already be running before tests start.

## Evaluation

| Scenario | Required result |
| --- | --- |
| January: 310 m³ over 31 days; February: 420 m³ over 28 days | Daily usage 10 → 15 m³; increase exactly 50% |
| MXN 116.00 + MXN 174.00 | Exactly 29,000 minor units; recorded usage 730 m³ |
| IDs `000001`, `000002`, account `00017` | Preserved unchanged |
| Different company, account, unknown meter or unit | No prepared import |
| Third decimal monetary value, inconsistent tax, ambiguous date | Rejected without rounding or guessing |
| Failure on page two, unsafe redirect, malformed response | No partial import; no credentials forwarded |
| Successful retry and repeat confirmation | Exactly two persisted bills |
| Another Aval organization tries those meter IDs | Import denied |
| Public task → planner → child utility read → review → cron finalization | Completed with persisted evidence, without browser polling |
| Repeated reviewed follow-up request | One planned internal task |

All calculation and isolation cases are binary, all-pass gates. The test report is recorded in `sap-bydesign-evaluation.json` alongside this document. Scripted planner and semantic-review responses exercise orchestration; they do **not** measure a real model's judgment, Spanish writing quality or resistance to arbitrary prompt injection. The source-notes test verifies field allowlisting only.

## Remaining live gate

Before enabling the connector in Aval's production UI, obtain a ByDesign test tenant and approved read-only access. Capture its enabled service metadata, field meanings, company/account identifiers and sample bill records. Confirm invoice versus line-item identity, meter availability, quantities/units, inclusive/exclusive dates, timezone semantics and currencies. Reconcile a small read with the SAP screen/export, validate permissions and continuation URLs on that tenant, then run the same public-route/agent workflow with an explicitly configured real model and cost budget.

No standalone S/4HANA or SAP GROW trial substitutes for Business ByDesign validation. Live compatibility and Gentor pilot readiness remain **unverified**.

## Aval connection screen

On `khas`, Connections now includes **SAP Business ByDesign → Connect**. The workspace owner enters the SAP address, dedicated read-only username/password, enabled OData collection path, company field/ID, and unique record fields supplied by the SAP administrator. Field names are configuration, not assumed SAP standards.

**Save and test SAP access** encrypts the credentials, then issues one scoped GET with `$top=1`. Successful verification records read access only, including whether a sample row was found. Empty data does not prove the company has usable records. It does not import rows, queue sync, validate utility field mappings, or establish Gentor compatibility. Mapping and reviewed ingestion remain the next setup step. The UI explains this in English and Mexican Spanish.

The transport rejects arbitrary hosts, redirects, unsupported paths, malformed responses and mismatched companies. Connection ownership and encrypted persistence are tested through the public routes against local PostgreSQL. Live SAP validation still requires an authorized tenant.
