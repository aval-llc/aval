# Backend and agent audit — September 12, 2026

Review branch: `khas`, based on `6eb8765` (`Merge Supabase cutover`). This is a source-review release. No production deployment, database mutation, external message, payment, or desktop release was performed.

Later incident follow-up: the first-login migration was applied to production and the signed-in page recovered. See [live login repair](2026-09-12-live-login-repair.md) for evidence and the migrations still pending; the original audit below describes its earlier source-review scope.

## Verdict

The checked-in migration had functional blockers that schema installation and typechecking did not reveal. This audit reproduced and fixed first-login/invitation SQL failures, broken JSONB transcript writes, transaction failure handling, unsupported provider redirect settings, and worker permissions/ownership problems.

After these fixes, six deterministic agent workflows pass against real PostgreSQL under the restricted `aval_worker` role. This supports controlled staging testing. It does **not** establish live model quality, hosted Hyperdrive performance, or unattended production readiness.

## Scope and evidence

- Repository inventory: 67 schema tables, 33 historical SQLite migration entries, 75 API route files, and 42 files under `lib/agents`. There are now 10 PostgreSQL migration files. These are different inventories, not interchangeable counts.
- Source review concentrated on authentication/session boundaries, RLS, agent execution and review, durable claims, approvals, financial reservations/reconciliation, audit append, provider transports, import application, billing, scheduled work, and test/CI coverage. Repository-wide searches checked for retired runtime imports. This is not a claim that every route or integration was exercised end to end.
- No D1, SQLite Drizzle, `node:sqlite`, or global `getDb()` references were found in `app`, `lib`, `worker`, or `db/postgres`. Historical schema/export tooling and old integration fixtures still contain SQLite.
- Baseline default tests: 493 passed, 4 failed, 1 skipped. The failures were obsolete page-render tests importing a Worker bundle into plain Node; the old authenticated fixtures also relied on headers the public Worker now strips.
- Tests used disposable, loopback-only PostgreSQL databases and synthetic accounts. The application test login has `NOINHERIT`, `NOSUPERUSER`, and `NOBYPASSRLS`; human tests assume `aval_app`, and the six agent workflows assume `aval_worker`.
- Models and provider responses were scripted. No real provider credentials, messages, or inference spending were used.

## Fixes and their regression checks

| Problem | Change | Verification |
| --- | --- | --- |
| Auth bootstrap failed on ambiguous `subject` in `ON CONFLICT`. A null email-verification flag was not explicitly rejected. | New migration resolves SQL column ambiguity and requires verification to be exactly true. | Fresh installation, identity bootstrap/replay, and false/null verification rejection. |
| Invitation redemption failed on ambiguous `organization_id`. | Replacement function resolves its return-column ambiguity and uses a row lock for audit coordination. | Two concurrent redemptions produce one membership/grant and one valid audit append. |
| JSONB adapter handed native arrays to `pg`, which encodes them as PostgreSQL arrays. Agent transcripts failed to save. | Send validated JSON text to the driver while retaining the application's string contract. | Round trips for arrays, nested objects, quoted strings, null, booleans, and numbers; real agent checkpoint/resume. |
| PostgreSQL can answer `COMMIT` with `ROLLBACK` after a caught SQL error. Aval could report success or start a provider call without its reservation. | Check the commit command result at both final commit and external-operation boundaries; preserve falsy thrown provider errors. | Deliberately abort a transaction and verify no provider call or success; recover via savepoint; verify committed reservation from a separate connection. |
| Advisory locks were used on the Hyperdrive path. | Replace them with row locks on tasks, approvals, operations, and an authorized organization-lock helper. No table-edit permission is granted to members for coordination. | Concurrent claims, audit appends, step numbering, financial caps, duplicate votes; owner/approver/worker coordination and cross-organization denial. |
| `aval_worker` could not execute the tenant-context helper used by its RLS policies. | Grant execution of `current_organization_id()` to the worker role. | Run all six agent workflows as the actual restricted worker role. |
| Approvers could decide an approval but could not append its audit event. Audit deletion remained available to the worker. | Permit tenant-authorized audit append; revoke audit update/delete privileges from application and worker roles. | Approver audit append, concurrent chain integrity, and denied audit deletion for both roles. |
| Expired task holders could renew/write their lease, and a late actor response could enter the trace after takeover. | Fence heartbeats/checkpoints by generation, state and expiry; block completion after cancellation; recheck ownership immediately after inference; check reviewer generation/expiry. | Expiry, same-owner/new-generation takeover, cancellation, and replacement during inference. |
| A delayed reconciliation response could overwrite a newer worker's result. Stripe lookup was unbounded. | Fence writes by reconciliation owner, expiry and attempt; append events only after a successful fenced write; use bounded provider HTTP. | Simulate takeover during the provider call and verify no projection overwrite or extra event. |
| Provider/OAuth transport and Outlook used `redirect: error`, unsupported by Workers. | Use `manual` and reject redirect responses without forwarding credentials. | Redirect rejection, body limits, malformed responses, OAuth consent checks, and Outlook's bodyless 202 response. |
| Important test coverage was missing from normal CI. | Add provider regressions to the default suite, repair page rendering with explicit identity fixtures, add real PostgreSQL agent tests, and trigger database CI for application/agent changes. | Default suite and PostgreSQL suite; actual page components render in both languages. |

Cloudflare explicitly lists advisory locks as unsupported: [Hyperdrive supported features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/). Row locks avoid that unsupported feature; a local test is not a hosted Hyperdrive benchmark.

## The six agent workflows, in plain English

1. Aval reads portfolio data, checks its proposed answer, and saves the final answer.
2. Aval reads data, pauses, then resumes from its saved work and finishes.
3. Aval tries to answer without reading the required data; completion is refused.
4. The reviewer rejects the answer; Aval makes only a bounded number of repair attempts and withholds the result.
5. The user cancels while the model is answering; Aval stops without publishing that answer.
6. Another worker takes over while the old model request is running; the old worker cannot save its late response or overwrite ownership.

The intentionally refused cases **pass** when Aval refuses correctly. This is not “six useful answers out of six.”

## Validation

- Default suite: **504 passed, 0 failed, 1 existing skip** (505 total).
- PostgreSQL suite: **27 passed, 0 failed, 0 skipped**, including six scripted agent workflows and the existing RLS/concurrency spike tests.
- Typecheck, migration lint, and changed-file lint: passed.
- Full lint: no errors; five existing image-element warnings.
- Production build: passed.
- Schema inventory regeneration: unchanged. Historical SQLite artifacts were not rewritten.

Local logs are under ignored `outputs/audit/`. They are not deployment evidence or production records.

## Remaining work, prioritized

1. **Before deploying this branch:** apply its three new PostgreSQL migrations using the existing checksum-aware migration runner, then deploy the matching code to staging. Existing deployments need the new `lock_organization` function before this application code runs. Do not rerun a full clean-install SQL file against an existing database. No remote migrations were applied in this audit.
2. **Before unattended agents:** run real-model staging evaluations, with connected synthetic provider accounts, including reviewed external actions, approval-to-provider execution, delegation, retry exhaustion, and unknown outcomes. The old SQLite integration harness and several standalone evaluation scripts still need conversion; their existence is not PostgreSQL coverage.
3. **Before charging customers:** replace retroactive plan allowance calculations in `lib/billing/usage.ts` with recorded grants and usage reservations. Current allowance is today's plan multiplied by months since organization creation; changing plans can reprice historical entitlement. This is the separately planned billing release, not silently fixed by database migration.
4. **Runtime follow-up:** `lib/agents/executor.ts` times out by racing promises without cancelling the underlying tool. Mutation retries are disabled, but a timed-out operation can still finish later. End-to-end abort propagation and recoverable outbox handling need dedicated tests. Also, an import failure in the current scheduled sweep skips communications and agent work for that organization until the next sweep.
5. **Hosted acceptance:** verify real sign-in, scoped property access across all enterprise roles, Hyperdrive load/latency, provider OAuth callbacks, backup restoration, and production smoke tests. This audit did not revalidate live Cloudflare/Supabase configuration or perform a backup restore.

## Review and rollout

Review `main...khas` first. The changes remain on `khas`; merging `main` can trigger deployment, so coordinate the three new database migrations with whoever manages releases. After staging validation and your approval, merge and run production smoke tests. The branch does not publish a DMG or update `desktop-latest`, consistent with the request to review before merging.
