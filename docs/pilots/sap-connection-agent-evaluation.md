# SAP connection UI and layered-agent evaluation

Date: 2026-09-26. Branch: `khas`. Current `main` through `fb174c5` was merged before the layered-agent evaluation. Evaluated implementation: `e291069`. Nothing was deployed to production.

## What changed

- Connections includes **SAP Business ByDesign → Connect**, with the SAP mark, administrator-supplied connection fields and English/Mexican Spanish instructions.
- **Save and test SAP access** encrypts the credentials and makes one company-scoped GET. Successful access verification explicitly says mapping and a reviewed import are still required. Automatic sync is not started. A failure preserves the setup and explains what to check.
- Verification accepts only the supported HTTPS ByDesign tenant and OData collection paths, rejects redirects and company mismatches, caps the response, and never returns sample customer records to the UI. Empty results prove service access only, not usable company data.
- The Utilities Specialists now receive the existing same-meter comparison tool through their `utility.read` capability. All employee, workspace and runtime restrictions still apply.
- The merge preserved main's five optional employee templates and carried utility investigation access into the relevant templates. The unapplied utility migration was renamed to `20260926000100_utility_pilot.sql` because main already uses `20260925000100`. Its SQL did not change. A record-tool fixture now creates the required property/site/meter relationship.

## What we actually tested

| Test | Result |
|---|---|
| SAP transport and verification | 18 passed |
| PostgreSQL application, hierarchy, isolation, concurrency and backup restore | 297 passed; no skips |
| Full unit suite | 1,102 passed; one existing Apple Silicon-only case skipped on Windows |
| Migration unit tests | 11 passed |
| TypeScript | Passed |
| Final production build | Passed locally |
| English/Spanish key parity | 2,430 keys match |
| Lint | No errors; five existing image warnings |
| Browser: Connect button → form → successful verification | Passed with simulated responses |
| Browser: Spanish form → rejected login → useful error, still unconnected | Passed with simulated responses |

The SAP connection public-route test uses real PostgreSQL and a local HTTP simulator. It verifies encrypted storage, invalid-host rejection, cross-workspace denial before HTTP, success only after the upstream read, rejected credentials and an unchanged sync timestamp. Provider HTTP runs outside the database transaction.

The utilities workflow starts with simulated ByDesign bills, passes them through the real import preview/apply route, persists them, and creates a task through the public API. The scheduled worker drives **Aval One → Utilities Lead → Energy & Water Usage Analysis Specialist → reviews → final answer**. The Specialist reads the imported bill evidence, and the final result preserves the calculated 50% increase in daily consumption. It does not diagnose a leak or execute a provider action.

The existing hierarchy scenarios also exercised transient failures, forbidden tools, human approval and resume, cancellation, duplicate delegation, stagnation, missing capabilities, peer help, provider waits, revoked access, employee scope and shared budgets.

## Efficiency evidence

For the SAP utility scenario and one representative read-only objective in each of 16 runnable domains:

| Layer | Reasoning calls | Review calls |
|---|---:|---:|
| Aval One | 2 | 2 |
| Lead | 2 | 2 |
| Specialist | 2 | 1 |
| Total | **6** | **5** |

Each domain scenario creates exactly three tasks and reads its selected evidence tool exactly once. A further scheduled sweep after completion produces no additional inference or review calls. The SAP scenario separately enforces the same six-plus-five call ceiling and three completed task levels.

These are **11 total scripted inference invocations per simple three-level objective**, including reviews. This establishes bounded overhead and absence of duplicate work; it does not prove that a three-level route is the cheapest choice for every question. Review calls remain enabled. Real model behavior, actual token usage, semantic quality and commercial cost require a separate live-model evaluation.

**External model spend: $0. Live SAP validation: not performed.** Six other domains lack a runnable representative in the current readiness selection; their tests check a named refusal and handoff rather than pretending execution succeeded. Passing the representative tests does not validate every Specialist or every business workflow.

The machine-readable [evaluation](sap-connection-agent-evaluation.json) records all 16 domain measurements and normalized source hashes. The earlier independent-rehearsal report describes the synthetic source fields and must not be interpreted as Gentor's actual schema.

## Reproduce

Use a fresh disposable loopback PostgreSQL database. Set `AVAL_TEST_DATABASE_URL`; on Windows without PostgreSQL client binaries, set `AVAL_POSTGRES_CLIENT_IMAGE=postgres:17-alpine` with Docker running. Then run:

```text
npm run test:sap-bydesign
npm run test:postgres
npm run test:unit
npm run typecheck
npm run i18n:check
npm run lint
npm run build
```

For the browser harness:

```text
npx vite --config tests/visual/sap-harness/vite.config.mjs --host 127.0.0.1
```

Open `http://127.0.0.1:5200/` for simulated success or `http://127.0.0.1:5200/?locale=es-mx&failure=1` for a simulated rejected login. Use fake credentials only. The harness is not included in the application build and performs no real SAP authentication.

## Remaining pilot gate

An authorized ByDesign tenant, enabled service and confirmed customer field/meter mapping are still required. Reconcile a small real read against SAP before enabling ingestion, then evaluate the full workflow with a real model under an agreed spending limit. The new button verifies access; it does not make a customer integration production-ready by itself.
