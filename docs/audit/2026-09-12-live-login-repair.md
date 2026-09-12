# Live first-login repair — September 12, 2026

## User-visible failure and cause

Creating an account in Supabase Auth succeeded, but the first authenticated Aval page failed before opening the workspace. The live database's `aval_private.bootstrap_supabase_identity` function raised PostgreSQL `42702`: `column reference "subject" is ambiguous`. Its `ON CONFLICT (provider, subject)` target collided with its `subject` function parameter.

This was reproduced against the live database with the restricted `aval_app` role in a rollback-only transaction. The diagnostic left no persistent account. Before repair, the database had seven recorded migrations, ending at `20260911000500`. The corrective migration was already on `khas` in commit `d4ea72a`, but was not installed in production.

The live Cloudflare Worker `aval` already had `HYPERDRIVE` and Supabase Auth configured. Its active version during diagnosis was `0d23b36d-5464-4682-8b84-ba5d78dd2ec2`, created September 12 at 02:41 UTC. Cloudflare's tail showed requests for both `app.aval.llc` and `aval.evalxnder.workers.dev` reaching this Worker. The version had no source-commit tag, so its exact Git SHA was not established. A failed GitHub deployment workflow alone was insufficient evidence that the live Worker still used D1.

## Production repair

Applied the existing `20260912000200_auth_identity_conflict.sql` function replacement through the correct Supabase project's SQL editor, with an exclusive migration-history lock, an already-applied guard, and the history insert in the same transaction. No existing migration file was rewritten. The recorded SHA-256 is:

`0814c87ddc9308080e8a9d058a29028cd3b69e22fb960277c6bfdcef79d76a1c`

The function now disambiguates conflict columns and requires email verification to be exactly true. The repair changed no passwords or secrets and retained the existing tenant-access checks.

Read-only verification returned `login_fix_installed = true`, `migration_record_matches = true`, and zero persistent diagnostic principals. Reloading the previously failing authenticated Workers-domain page opened Aval's nine-step onboarding screen. Cloudflare logged successful requests for `/en`, `/api/preferences`, and `/api/appearance` at 22:03 UTC.

The official app domain displayed its sign-in screen when checked without its own authenticated cookie. A fresh login on that domain was requested from the user but was not independently completed during this verification. The existing Workers-domain authenticated session was sufficient to reproduce recovery through the same live Worker and database; it does not constitute a completed onboarding or live-model agent test.

## Regression coverage and CI

- Added a PostgreSQL upgrade regression that installs the historical broken function inside a transaction, reproduces `42702` under `aval_app`, applies the repair, and verifies both first and repeated login produce one identity link. All fixture changes roll back.
- Fixed the PostgreSQL GitHub Actions job to install `desktop` dependencies before the root unit suite. The previous run failed because `app-builder-lib/scheme.json` was absent and never reached its PostgreSQL tests. The production workflow already had this dependency step.
- Local PostgreSQL suite: **28 passed**, including the new upgrade test and six deterministic agent cases.
- Local unit suite: **504 passed, 1 existing skip, 0 failed**.
- Migration lint and `git diff --check`: passed.
- No application bundle was changed or redeployed for this database-only repair. No desktop package or release was changed.

## Remaining rollout boundaries

This repair applied only the login migration. `20260912000100_hyperdrive_invitation_lock.sql` and `20260912000300_tenant_coordination_lock.sql` still need to be applied before deploying the complete `khas` application changes. The checksum-aware migration runner discovers and applies these missing versions while skipping the recorded login fix. Do not rerun the full clean-install SQL against the existing database.

GitHub's main-branch production run `34668813503` stopped before migration or deployment because its `SUPABASE_URL` configuration was missing or invalid. Other required deployment inputs were not all reached by that check and should not be assumed complete. Production GitHub configuration still needs correction before relying on automatic releases; live Worker secrets are separate from GitHub Actions configuration.

Changes remain on `khas` for review. No merge to `main` was performed. This incident repair does not certify pending provider OAuth, complete onboarding, hosted load/backup acceptance, or the real-model planner → child-task → final-answer workflow.
