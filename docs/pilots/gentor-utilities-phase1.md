# Gentor utilities pilot — Phase 1

Implementation and local evaluation: 2026-09-25. Review branch: `khas`, based on `main` at `2c9f574`. This release does not deploy production or connect to Gentor's SAP systems.

## What staff can do

In Utilities / Servicios de energía y agua:

1. Create a service site, optionally linked to an existing Aval property.
2. Add meters with the original measurement unit and an optional physical meter number. Associate a submeter with a parent at the same site and of the same utility type.
3. Explicitly map older meters to sites. Free-text labels are not automatically matched to properties, and gallons are never relabeled as cubic meters.
4. Download the import template, replace the example with a reviewed export, validate the preview, then confirm the import.
5. Read same-meter comparisons with bill IDs, dates, quantities, currencies and missing-data explanations, in Spanish or English.
6. Review and edit an internal follow-up task before saving it in Tasks. This creates planned work; it does not dispatch a technician, send a message or write to SAP.

The financial and maintenance personas can read the new `get_utility_investigations` tool. New employee templates include it; existing employees still need their capability grants reviewed. No existing employee's grants are silently widened.

## Data contract and calculation rules

- New hierarchy: organization → service site → meter → optional submeter. A site may reference an existing property. Organization remains the security boundary.
- Site and meter references have composite organization foreign keys. Parent cycles and cross-utility parents are rejected. Mapped sites, meter units and utility types are immutable; corrections requiring a different identity use a new meter.
- Legacy meter IDs, bill IDs, labels, quantities and currencies survive migration. Bill unit snapshots are backfilled from the original meter, and old readings are marked `unknown`. Legacy sites remain unassigned until a person maps them.
- Import columns are listed in `public/utility-import-template.csv`. Supported inputs are CSV and a JSON array, maximum 500 rows and 500 KB per request. The HTTP envelope also counts toward the size limit.
- `sourceSystem` must identify the actual source namespace (system/client/company/account as needed). `externalId` identifies a bill inside that namespace. Preserve leading zeros. Two different source namespaces are not automatically deduplicated against each other.
- Dates use `YYYY-MM-DD`. `periodEnd` is **exclusive**: January 1 through January 31 is represented as January 1 to February 1. Confirm the source's date convention before preparing an export.
- Use `m3`, `gal`, `ccf`, `kWh` or `therm` as appropriate for the service. New water meters default to `m3` in `es-mx`; existing units do not change. Quantities support up to six decimal places. No automatic unit conversion occurs.
- Money uses integer minor units: `11600` means MXN 116.00. Currency must explicitly be MXN or USD. There is no foreign-exchange conversion.
- Readings are `actual`, `estimated` or `unknown`. Supply `tariffCode` when available. Optional `subtotalCents` and `taxCents` must both be present and sum exactly to the invoice total, or both be omitted. Aval preserves these fields; it does not implement DAC eligibility, tariff tiers or tax calculations.
- Exact repeat imports are no-ops after a fresh preview. To correct an existing source bill, provide the current `supersedesBillId` shown in the conflict response. The old row is retained and the replacement points to it. A stale preview fails with HTTP 409.
- A whole import and its audit append commit together. Unknown meters, wrong units or invalid rows reject the whole import. Concurrent confirmation cannot insert the same source bill twice.
- Usage totals are separated by unit and money by currency. Aggregate totals use **root meters only** to avoid counting parent/submeter consumption twice, across all recorded periods. These are not a normalized portfolio-period total. All meters retain their own individual comparisons.
- Comparisons use the two latest periods for the **same meter**, normalized by days. Missing mapping/history, gaps, overlaps, unfinished periods, changed units, estimated/unconfirmed readings and a zero baseline block the percentage. Bills alone do not prove a leak, equipment fault, savings or real-time conditions.
- Findings include recording dates and source periods. The investigation endpoint supports a site filter and at most 200 meters per response. Monthly data supports billing-period review, not real-time anomaly detection.

## Access and rollout

This MVP uses trusted, organization-wide utilities access. Organization-wide readers can read; workspace owners administer sites, mapping, imports and follow-ups. Property-scoped or owner-entity-scoped access is not implemented for this module and does not grant portfolio-wide utilities access. Do not put mutually isolated client entities into one shared pilot workspace.

After branch review, the deployment owner must apply `20260925000100_utility_pilot.sql` through the existing checksum-aware migration runner **before deploying this code**. Do not edit applied migrations or regenerate historical D1 migrations. The migration is additive; RLS also tightens the existing utility read policies.

Rehearse using a backup first. A legacy bill whose organization/meter relationship is invalid blocks migration; do not discard it to get a green deployment. The new numeric/type checks are `NOT VALID` to preserve historical rows while enforcing new writes. Review unresolved legacy values before using them in the pilot.

If the UI release must be rolled back after imports begin, disable the new screen while keeping the revision-aware backend: older readers would count superseded bills. A full application rollback is safe only before new imports/corrections, or with a separately verified compatibility patch. Retain the additive tables and bill history; do not down-migrate by dropping imported bills or sites. Never merge `khas` merely to try it: `main` triggers production deployment.

## Local evaluation results

Calculation and isolation gates are binary: **all cases must pass**. No percentage score can compensate for a wrong financial number or cross-organization access.

| Check | Result |
| --- | --- |
| Unit suite | 786 passed, 1 existing Apple-silicon-only executable check skipped on Windows |
| PostgreSQL suite | 235 passed, zero skipped |
| Migration unit suite | 11 passed |
| Typecheck and localization parity | Passed |
| Lint | Zero errors; five pre-existing image warnings |
| Production bundle | Passed locally; no deployment performed |
| Browser walkthrough | Spanish controls, `m3` default, import preview/confirm and reviewed follow-up verified against isolated mock responses |
| Encrypted backup/restore | Passed locally; 90 tables, data, permissions and isolation verified |
| Populated legacy migration | Passed on a separate disposable PostgreSQL database; IDs, source units and money preserved without guessed sites |
| Live SAP, live model and production browser journey | Not validated in this release |

The new unit cases cover mixed units/currencies, daily normalization, meter isolation, missing/invalid comparisons, parent/submeter totals, CSV validation, dates, money and invoice reconciliation. The PostgreSQL cases cover organization isolation, missing RLS context, composite keys, hierarchy validation, explicit legacy mapping, unit snapshots, reviewed imports, idempotency, corrections, stale previews, concurrent imports, public routes, Spanish tool output and retry-safe internal tasks. Existing planner/child/review/cron regressions also ran using scripted models. Invoking the new utility tool in these tests is not evidence that a real model chose it correctly.

The browser fixture tests UI wiring only. PostgreSQL persistence and authorization were verified separately through the actual public route handlers and real database sessions. Auth/network behavior on the hosted Worker remains a staging/live release check.

No paid model calls, external communications or SAP mutations were used. Provider testing cost: **$0**.

Reproduce with Node 22+ and a fresh disposable local PostgreSQL database:

```powershell
npm run typecheck
npm run i18n:check
npm run lint
npm run test:unit
npm run test:migration
$env:AVAL_TEST_DATABASE_URL = '<loopback disposable PostgreSQL URL>'
# Optional Docker-backed pg_dump/psql for backup verification:
$env:AVAL_POSTGRES_CLIENT_IMAGE = 'postgres:17-alpine'
npm run test:postgres
npm run build
```

The PostgreSQL suites refuse remote hosts. The legacy migration rehearsal additionally requires CREATE DATABASE privileges on the disposable local test server and drops only its randomly named rehearsal database.

## Before real pilot ingestion

The Gentor pilot owner and Aval release owner must record:

- The named SEISA/Astra properties/sites, exact meter list and staff who can access the workspace. Confirm the relationship between Gentor, SEISA and Astra rather than inferring it from names.
- SAP Business ByDesign is now confirmed as the product. Its enabled services, source system/company identifiers, export owner, field dictionary and a de-identified sample still need confirmation. Applications and lease records are not assumed to live in SAP.
- Whether meters/submeters exist, who reads them, actual versus estimated readings, source date conventions, billing cadence, currencies and tariff/tax fields.
- Approved data handling, retention/deletion and staff access arrangements before personal or customer data enters the hosted pilot. Start with utility records without resident personal data.
- A named Gentor reviewer for Spanish explanation quality and a named Aval reviewer for release evidence.

Run the first real sample in staging and require exact reconciliation of imported IDs/counts, unit-separated quantities and currency-separated money to the reviewed source, plus 100% calculation/isolation gates. With an explicitly configured model and spending limit, ask in Spanish: “Compara los dos últimos periodos del medidor y cita los recibos. Indica qué falta verificar antes de actuar.”

For each live-model explanation, the Gentor reviewer scores four criteria from 0–2: correct interpretation, traceable evidence, clear Spanish, and actionable follow-up with appropriate uncertainty. Require at least 7/8, with no invented source, unsupported causal claim or incorrect number. Exact calculations and access controls remain separate all-pass gates. Record the model/version, prompt, source IDs, output and reviewer decision. This manual quality evaluation is not yet run.

Live SAP authentication/sync/write-back, lease-expiration enhancements and application workflows remain later work. Phase 1 prepares a controlled utilities pilot using reviewed exports; it does not certify unattended operation.

Independent ByDesign connector work and simulated agent coverage are documented in [the ByDesign rehearsal report](sap-bydesign-independent-testing.md).
