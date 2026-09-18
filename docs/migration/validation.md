# Validation evidence — September 11, 2026

Scope: the PostgreSQL clean-install schema, enterprise hierarchy/RLS foundation, and isolated synthetic spike. **This is not proof that Aval's runtime has been migrated, that Supabase Auth works, or that agents are reliable in production.**

| Check | Result |
| --- | --- |
| Preserved faithfulness regression tests | 15 passed before the migration branch was created. |
| Runtime integration suite | 154 passed using scripted providers and local SQLite/D1-compatible fixtures. No provider network call was made. |
| TypeScript | Passed on the final source. |
| Translation parity | Passed: 1,760 English/Spanish keys. |
| Full repository lint | Passed with five existing image-element warnings and no errors. Generated benchmark bundles are excluded from source linting. |
| Focused migration lint | Passed. |
| Application production build | Passed all five Vinext stages from the repository. Existing middleware deprecation, plugin timing and large-chunk warnings remain. |
| Benchmark Worker bundle | Wrangler dry-run passed; no deployment. Approximately 393 KiB uncompressed / 78 KiB gzip. |
| Migration suite | Five passed: D1 inventory/history checks, benchmark gate rejection cases, full PostgreSQL table/type coverage and exhaustive organization-table RLS generation. |
| Real PostgreSQL suite | Six substantive scenarios passed (seven reported tests including the parent test), on native PostgreSQL 17.10 with a restricted application login. |
| Local HTTP load harness | 1,950 measured requests; zero operation errors. Tenant isolation, read-after-write, unique task generations and non-superuser/non-bypass RLS role checks passed. |
| Hosted benchmark | **Not run.** User will configure Supabase later. The local run correctly fails the hosted acceptance gate. |
| Unit suite | 522 tests discovered: 521 passed and one Apple-silicon-only packaging test skipped. Cross-platform path and permission assertions were corrected for Windows. |
| D1 migration replay | All 33 migrations applied successfully to a fresh local Wrangler D1 database, including `0032_enterprise_identity_hierarchy.sql`. |
| Clean PostgreSQL migration execution | **Not run in a fresh local Supabase instance.** Docker Desktop did not become ready on this machine. The earlier synthetic fixture passed on native PostgreSQL 17.10 and static coverage tests pass, but `supabase db reset` remains required before hosted apply. |
| Live Auth, hosted enterprise scoped RLS, backup restore, six-case real-agent smoke | Not implemented/run by this slice. No exporter is planned unless customer data is discovered. |
| macOS DMG | Not refreshed. This is an isolated backend preparation branch on Windows; the macOS signing/notarization/release pipeline was not invoked. |

## What the PostgreSQL tests actually prove

1. A restricted login cannot read business tables without its application role; that role sees no rows without context. Guessing another organization, revoked membership and escalating to `postgres` are denied. Unauthenticated platform headers do not authorize the **benchmark** endpoint.
2. Thirty simultaneous sessions alternate across ten organizations. A query with no explicit tenant predicate sees only that session's organization. Each session runs without superuser or RLS-bypass privileges.
3. Even an administrator cannot insert a task referencing a property in a different organization, because the composite foreign key rejects it.
4. An injected failure after a property update but before audit append rolls back both the revision and audit changes.
5. Twenty parallel audited writes produce a continuous, hash-verified chain. Five simultaneous retries of one request create one additional business effect. An audit deletion fails.
6. Thirty workers receive different task generations. An expired worker cannot checkpoint; reassignment increments the generation, and only the new owner/generation can checkpoint.

The fixture audit serialization is explicitly isolated from Aval's existing audit-chain protocol. Preserving and validating the production protocol remains a Phase 2/import requirement. The fixture membership policy does not implement the final owner/region/portfolio/property capability model.

## Local performance observations

These are client-observed HTTP p95 latencies, in milliseconds. The harness and database ran on the same Windows machine, using one direct PostgreSQL connection per request and no Hyperdrive pool.

| Concurrency | Indexed list | Audited write | Task claim | Errors |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 82.5 | 90.9 | 81.1 | 0 |
| 10 | 304.0 | 273.7 | 252.7 | 0 |
| 50 | 1,361.2 | 1,344.9 | 1,374.5 | 0 |
| 100 | 2,653.9 | 2,477.5 | 2,158.8 | 0 |

The acceptance targets were **not met** at higher concurrency. These results cannot predict the hosted path's latency or connection use. They verify that the complete load runner executes and reports failures honestly. No capacity or production-readiness claim follows from this run.

Raw synthetic evidence: [local-benchmark.json](./local-benchmark.json). It records the source fingerprint at execution time. Later source hardening and preserved lockfile platform metadata changed that fingerprint; the archived local report is diagnostic history, not current acceptance evidence. Generate a new hosted report from the final deployed source.

## Remaining release gates

See [the implementation handoff](./README.md). Production source identity remains unverified. The live Hyperdrive benchmark, full parity port, atomic domain integration, hierarchy/Auth/RLS, data rehearsals, backup restoration, complete test suite and production smoke are all outstanding. No cloud project, database, paid service, migration or customer message was created by this slice.
