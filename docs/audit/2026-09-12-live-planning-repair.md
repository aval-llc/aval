# Live planning repair — September 12, 2026

## Failure

The Projects screen could load, but creating either a project or an item returned the generic save error. Aval sends JavaScript epoch timestamps in milliseconds; the PostgreSQL parity migration had created planning_projects.created_at and the three planning-item timestamp fields as 32-bit integers. A current millisecond timestamp exceeds that type, so PostgreSQL rejected the insert before any record was created.

The live schema check confirmed all four fields were integers, the current application timestamp required bigint, both planning tables contained zero rows, and migration 20260912000400 had not been recorded.

## Repair

- Added 20260912000400_planning_epoch_bigint.sql, which changes planning_projects.created_at plus planning_items.starts_at, ends_at, and updated_at to bigint.
- Updated the reproducible SQLite-to-PostgreSQL schema generator and generated Drizzle schema to use numeric bigint mappings for these epoch-millisecond fields.
- Added a PostgreSQL regression that creates a current-date project and task through the real planning store, reads them back through RLS, and confirms timestamps remain JavaScript numbers.
- Added structured, non-sensitive error codes to planning-route logs so a future database failure is diagnosable without exposing request contents.

## Live verification

The migration was applied atomically to the existing Supabase project and recorded with SHA-256 754631295c61f77bbf3bb360e5b2b1762bd6eefdffc51b2d12ff682518c53f56.

A rollback-only production check assumed Aval's restricted aval_app role, bootstrapped a synthetic tenant, inserted a project and a linked task with current-size millisecond timestamps, and read one saved task. The transaction then rolled back; no diagnostic account, project, or task was retained.

The authenticated live Projects UI then created and displayed a temporary task through POST /api/planning. The same UI deleted it successfully afterward, returning the workspace to zero planning items. This exercised the deployed browser, Worker, Hyperdrive, RLS session, and Supabase write path end to end.

Local validation:

- PostgreSQL suite: **29 passed**, including the new planning case and six deterministic agent workflows.
- Migration suite: **5 passed**.
- Typecheck and migration lint: passed.
- Unit suite: **504 passed, 1 existing platform-specific skip**.
- Production build and full lint: passed; lint retains five existing image-element warnings.

No Worker redeployment was required for the live repair because the deployed store already sends compatible numeric parameters and Drizzle's integer reader converts PostgreSQL integer strings to JavaScript numbers. The matching source schema and migration remain on khas for future reproducible deployments.
