# Aval

Aval is an AI-native property-management workspace. The web app, APIs, durable agent runtime, provider integrations, audit trail, approvals, and scheduled work run in one Cloudflare Worker.

The backend MVP uses:

- Supabase Free for PostgreSQL and email/password authentication.
- Cloudflare Hyperdrive for the production database connection.
- PostgreSQL row-level security for organization isolation.
- Drizzle ORM with explicit request-scoped database sessions.
- Cloudflare's existing minute cron and task leases for background agent work.

Start with [the Supabase MVP setup guide](./docs/migration/README.md). Audit fixes and prior agent validation are recorded in [README_AUDIT_FIXES.md](./README_AUDIT_FIXES.md).

## Development

Requirements: Node.js `>=22.13.0`, npm, and Docker Desktop for local Supabase.

```powershell
npm install
npm run start:local
```

Useful checks:

```powershell
npm test
npm run lint
npm run test:postgres
```

`test:postgres` requires `AVAL_TEST_DATABASE_URL` pointing at a fresh disposable local PostgreSQL database. Hosted deployment is intentionally blocked until the Supabase and Hyperdrive values listed in the setup guide are configured.
