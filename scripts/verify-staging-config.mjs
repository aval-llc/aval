// Never log URLs with credentials. Staging uses separately named secrets,
// its own Supabase project, and a separately provisioned Hyperdrive binding.
for (const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','DATABASE_URL','SUPABASE_URL','SUPABASE_ANON_KEY','AVAL_HYPERDRIVE_ID','STAGING_PROJECT_REF','AVAL_STAGING_URL','AVAL_SMOKE_EMAIL','AVAL_SMOKE_PASSWORD']) {
  if (!process.env[key]) throw new Error(`Missing staging configuration: ${key}`);
}
if (process.env.STAGING_SYNTHETIC_ONLY !== 'true') throw new Error('Staging must be explicitly designated synthetic-only');
const ref = process.env.STAGING_PROJECT_REF;
if (!/^[a-z0-9]{20}$/.test(ref)) throw new Error('A dedicated Supabase staging project reference is required');
const api = new URL(process.env.SUPABASE_URL), db = new URL(process.env.DATABASE_URL), app = new URL(process.env.AVAL_STAGING_URL);
if (api.protocol !== 'https:' || api.hostname !== `${ref}.supabase.co`) throw new Error('Staging API project mismatch');
if (!['postgres:','postgresql:'].includes(db.protocol)
  || !(db.hostname === `db.${ref}.supabase.co` || (db.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(db.username) === `postgres.${ref}`))) throw new Error('Staging database must belong to the explicitly configured project');
if (app.protocol !== 'https:' || !app.hostname.startsWith('aval-staging.') || !app.hostname.endsWith('.workers.dev')) throw new Error('Use the isolated aval-staging workers.dev hostname');
console.log('Staging configuration accepted; verify Hyperdrive targets this same project before enabling the protected environment.');
