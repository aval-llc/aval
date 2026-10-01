/** Read-only preflight: do not deploy a runtime guard onto a privileged login. */
import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

export async function verifyRuntimeLogin(env = process.env, dependencies = { fetch, client: config => new Client(config) }) {
const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, AVAL_HYPERDRIVE_ID, DATABASE_URL } = env;
if (![CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, AVAL_HYPERDRIVE_ID, DATABASE_URL].every(Boolean)) throw Error('Runtime-login preflight configuration missing');
if (!/^[a-f0-9]{32}$/i.test(CLOUDFLARE_ACCOUNT_ID) || !/^[a-f0-9-]{32,36}$/i.test(AVAL_HYPERDRIVE_ID)) throw Error('Invalid Cloudflare configuration identifiers');
const response = await dependencies.fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/hyperdrive/configs/${AVAL_HYPERDRIVE_ID}`, {
  headers: { authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw Error(`Cannot verify Hyperdrive origin (${response.status}); deployment stopped before migration`);
const data = await response.json();
const user = data?.result?.origin?.user;
if (!data.success || typeof user !== 'string' || !/^aval_runtime(?:\.[a-z0-9]+)?$/.test(user)) throw Error('Hyperdrive must use aval_runtime. Configure its scoped login before deployment; credentials were not modified.');
const client = dependencies.client({connectionString:DATABASE_URL,connectionTimeoutMillis:5000});
try {
  await client.connect();
  const roles = await client.query('SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1',['aval_runtime']);
  const role = roles.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || !role.rolcanlogin) throw Error('Runtime database role is absent or privileged; deployment stopped');
  return {runtimeLogin:'aval_runtime',restricted:true};
} finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verifyRuntimeLogin())); }
  catch { console.error('Runtime-login preflight failed. Verify Hyperdrive read permission, the aval_runtime origin login and its NOSUPERUSER/NOBYPASSRLS grants. No production changes were made.'); process.exitCode=1; }
}
