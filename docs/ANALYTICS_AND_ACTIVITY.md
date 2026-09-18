# Analytics and activity

Operations and Portfolio Overview read the same organization-scoped reporting endpoint. Financial time series use the existing P&L rules over disjoint UTC calendar buckets, and reconcile to the selected reporting period. Refunds retain their signs, trust movement and capital expense stay outside NOI, unknown accounts remain reported in accounting notes, and absent ledger data remains empty.

Chart preferences are visual-only, stored per chart on the device. Categorical comparisons offer columns, horizontal bars, and dot silhouettes. Temporal series also offer line, area and steps. Stacked columns/areas are available only for additive, complete, non-negative series. Leasing cohort stages and income/expense/NOI are never stacked together. Dot textures fill the exact-value silhouette: dots do not count individual units. Charts offer keyboard inspection, hover details, an exact data table, and reduced-motion support.

`workspace_usage` (migration 0023) records at most one active minute per organization/user/server minute. The client records while the app is visible and focused, with interaction during the preceding minute. Duplicate tabs cannot double count. No typed content, page names, or client-provided identity/timestamp is stored. The grid displays the previous 365 UTC days above the greeting; no historical activity is fabricated. Buckets older than 367 days are pruned on the subject's next activity.

There is no demo mode. Legacy `?data=sample` links cannot enable sample data. Anonymous requests require authentication; `/mobile` redirects to the responsive authenticated dashboard. Existing historical fixture modules remain only as test fixtures/type definitions, not a selectable workspace.

## Deployment

Desktop 0.1.7 loads the hosted application. The desktop release waits for the same commit's successful website deployment before publishing signed/notarized assets.

CI and local development use Node 24.16.0, pinned in `.node-version`.

Since anonymous access is removed, the deployment smoke signs in normally. The workflow provisions one reserved verification account in an isolated workspace using its existing D1 deployment permission. It rotates a random 256-bit password each run, stores only its PBKDF2 hash in D1, and removes the runner's temporary credentials afterward. No business/sample records or connections are inserted. This account has no membership in customer workspaces. Optional `AVAL_SMOKE_EMAIL` and `AVAL_SMOKE_PASSWORD` secrets can select an existing dedicated verification account instead; neither is required for the default workflow. The automatic smoke verifies authentication, integration reads, and workspace health without making a model call.

If the live smoke fails, the Worker has already been deployed; the desktop release remains blocked until the workflow succeeds. Aval carries no shared Anthropic credential. Each workspace connects and selects its own model provider. Provider failures retain a fixed, safe explanation and request ID in the task error. `insufficient_credits` and `spend_limit` require action on that workspace's provider account. `invalid_request` means the provider rejected request parameters; use its request ID to investigate. Provider response bodies, which can quote user input, are not copied into logs or task records.


For machines that cannot mount temporary disk images, build the app with `npm run package:mac:local --prefix desktop` and then run `npm run package:mac:dmg-local --prefix desktop`. The fallback creates a true HFS+ UDZO DMG with an Applications link, verifies its checksum, and preserves the app bundle. It is a local, non-notarized artifact; GitHub release builds retain Developer ID signing, notarization, and Gatekeeper checks.
