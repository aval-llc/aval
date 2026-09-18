# Aval Supabase MVP

## Status

The application runtime has been converted from Cloudflare D1 to PostgreSQL. The hosted Supabase project and Hyperdrive connection still need to be supplied by the project owner before deployment.

There is no customer data to import. The checked-in D1 schema and migration files remain only as historical source material; Aval does not bind or open D1 at runtime.

## MVP architecture

```mermaid
flowchart LR
    Browser["Aval web and desktop"] --> Worker["One Cloudflare Worker"]
    Worker --> Auth["Supabase Auth"]
    Worker --> Hyperdrive["Cloudflare Hyperdrive"]
    Hyperdrive --> Postgres["Supabase Postgres"]
    Cron["Cloudflare minute cron"] --> Worker
    Worker --> Providers["Connected AI and business providers"]
```

- Supabase Auth owns passwords, verification, access tokens, and refresh tokens.
- The Worker stores tokens in secure HttpOnly cookies and resolves the active organization on every request.
- Every request opens a short PostgreSQL transaction and sets transaction-local identity values used by RLS.
- The application connects as `aval_runtime`, then assumes either `aval_app` or `aval_worker`.
- Model and provider calls run after the current transaction commits; their results are recorded in a new transaction.
- The existing task table, leases, and minute cron remain the job queue.
- Storage, Realtime, SAML, PGMQ, PITR, and a separate job Worker are outside this MVP.

This design works on Supabase Free. It does not claim managed backups, PITR, SAML, or an uptime guarantee.

## One-time hosted setup

1. Create an empty Supabase Free project in the US West region.
2. In Supabase Auth, keep email/password signup enabled, require email confirmation, and set Aval's production Site URL and redirect URL.
3. Copy the project URL, anon key, and an administrator PostgreSQL connection string. Keep the database connection string off the client.
4. Apply every checked-in migration through the checksum-aware runner:

   ```powershell
   $env:DATABASE_URL = "YOUR_SUPABASE_ADMIN_DATABASE_URL"
   npm run db:migrate -- --allow-remote
   ```

5. Create the restricted runtime login with a new random password:

   ```powershell
   $env:AVAL_DATABASE_PASSWORD = "A_NEW_RANDOM_PASSWORD_OF_AT_LEAST_24_CHARACTERS"
   npm run db:runtime-role -- --allow-remote
   ```

6. Create one Cloudflare Hyperdrive configuration using the Supabase direct PostgreSQL endpoint and the `aval_runtime` login. Disable query caching. Save the Hyperdrive ID.
7. Create and verify one Supabase Auth user reserved for deployment smoke tests.
8. Add these values to the GitHub `production` environment:

   | Kind | Name | Value |
   | --- | --- | --- |
   | Variable | `AVAL_PRODUCTION_URL` | Aval's HTTPS URL |
   | Variable | `AVAL_HYPERDRIVE_ID` | Cloudflare Hyperdrive UUID |
   | Variable | `SUPABASE_URL` | Supabase project URL |
   | Secret | `SUPABASE_ANON_KEY` | Supabase anon key |
   | Secret | `SUPABASE_DB_URL` | Administrator DB URL used only for migrations |
   | Secret | `AVAL_SMOKE_EMAIL` | Verified smoke user's email |
   | Secret | `AVAL_SMOKE_PASSWORD` | Smoke user's password |
   | Secret | `CLOUDFLARE_API_TOKEN` | Scoped Worker deployment token |
   | Secret | `CLOUDFLARE_ACCOUNT_ID` | Owning Cloudflare account |

9. Run the **Cloudflare production** GitHub Action. It verifies the app against disposable PostgreSQL, applies any unapplied migration by hash, deploys the Worker, then signs in through Supabase Auth and checks the integrations and agent-health APIs.

### Hosted Auth email configuration

In Supabase **Authentication → URL Configuration**, set the Site URL to `https://app.aval.llc` and allow `https://app.aval.llc/**` as a redirect URL. In **Authentication → Email Templates → Reset password**, use the checked-in `supabase/templates/recovery.html` content. Its link sends the one-time token hash to Aval's server-side confirmation route; do not replace it with a browser access-token fragment. The local Supabase configuration already uses this template.

The repository now lives at `https://github.com/aval-llc/aval`. Repository secrets and environments transfer with the repository, but organization owners should review team access and the organization's GitHub Actions policy after the transfer.

The runtime-role password is used when creating Hyperdrive and does not belong in the Worker or GitHub deployment environment afterward.

## Local development

Docker Desktop must be running because the Supabase CLI starts local Postgres and Auth in containers.

```powershell
npm install
npm run supabase:start
npm run supabase:reset
npm run start:local
```

Local confirmation messages appear in Inbucket at `http://127.0.0.1:54324`. The app runs at `http://127.0.0.1:3000`.

Run the disposable PostgreSQL integration suite with:

```powershell
$env:AVAL_TEST_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
npm run test:postgres
```

## Free-tier operating limits

Before real customer data is accepted, add encrypted daily `pg_dump` backups to a private R2 bucket and perform a restore test. Supabase Free does not provide the managed recovery guarantees assumed by PITR. Upgrade only when customer requirements or measured capacity justify it.

The old D1 database can remain untouched for 30 days as evidence. Because it has no customer data and the new system does not dual-write, it is not an application rollback target after PostgreSQL accepts writes.

## What is intentionally deferred

- Porting the large legacy SQLite agent harness to PostgreSQL.
- Enterprise SAML activation and customer IdP configuration.
- Storage, document objects, Realtime, PGMQ, and vector search.
- A separate staging Worker and a second background Worker.
- The larger maintenance-domain and 100-case evaluation releases.
- Automated R2 backup/restore, which becomes mandatory before customer data.

The MVP database check covers clean migration application, migration replay, Supabase identity bootstrap, organization isolation, denied cross-organization writes, and transaction rollback. The existing synthetic Hyperdrive spike separately covers context leakage, task claiming, lease fencing, audit continuity, and latency measurement.
