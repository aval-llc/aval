import { Client } from 'pg';

export const quoteIdentifier = value => '"' + value.replaceAll('"', '""') + '"';
export function restoreUrl(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || !/^aval_restore_[a-z0-9_]+$/.test(url.pathname.slice(1))) throw new Error('Use a disposable loopback aval_restore_* database');
  return url;
}

/** Compare application data and permissions against the same snapshot as pg_dump. */
export async function databaseInventory(client) {
  await client.query("SET TIME ZONE 'UTC'");
  const { rows: tables } = await client.query(`SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
    coalesce(c.relacl::text, '') AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND n.nspname IN ('public','aval_private','aval_migrations') ORDER BY 1,2`);
  for (const table of tables) {
    const identifier = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    const { rows } = await client.query(`SELECT count(*)::text AS count, coalesce(md5(string_agg(digest, '' ORDER BY digest)), md5('')) AS digest
      FROM (SELECT md5(row_to_json(t)::text) AS digest FROM ${identifier} t) contents`);
    Object.assign(table, rows[0]);
  }
  const { rows: policies } = await client.query(`SELECT schemaname,tablename,policyname,permissive,roles::text,cmd,qual,with_check
    FROM pg_policies WHERE schemaname IN ('public','aval_private') ORDER BY 1,2,3`);
  const { rows: roles } = await client.query("SELECT rolname,rolinherit,rolbypassrls FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'postgres' ORDER BY rolname");
  return { tables, policies, roles };
}

export async function prepareRestoreTarget(value, roles) {
  const url = restoreUrl(value);
  const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.href }); await admin.connect();
  try {
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [url.pathname.slice(1)])).rowCount) throw new Error('Restore database already exists; use a fresh drill identifier');
    for (const role of roles) {
      if (!role.rolname || role.rolname.startsWith('pg_') || role.rolname === 'postgres') throw new Error('Invalid restore role');
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role.rolname])).rowCount;
      if (!exists) await admin.query(`CREATE ROLE ${quoteIdentifier(role.rolname)} NOLOGIN NOSUPERUSER ${role.rolinherit ? 'INHERIT' : 'NOINHERIT'} ${role.rolbypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS'}`);
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(url.pathname.slice(1))} TEMPLATE template0 ENCODING 'UTF8'`);
  } finally { await admin.end(); }
}

export async function verifyRestoredDatabase(client, expected) {
  const actual = await databaseInventory(client);
  if (JSON.stringify(actual.tables) !== JSON.stringify(expected.tables)) throw new Error('Restored data counts, fingerprints or table permissions differ');
  if (JSON.stringify(actual.policies) !== JSON.stringify(expected.policies)) throw new Error('Restored workspace access policies differ');
  for (const name of ['aval_app','aval_worker']) {
    const source = expected.roles.find(r => r.rolname === name), target = actual.roles.find(r => r.rolname === name);
    if (!source || !target || source.rolinherit !== target.rolinherit || source.rolbypassrls !== target.rolbypassrls || target.rolbypassrls) throw new Error('Restored application role is incorrect');
  }
  // Exercise real restored policies using an identity with no workspace grant.
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE aval_app');
    await client.query("SELECT set_config('aval.principal_id','backup-drill-no-access',true), set_config('aval.organization_id','backup-drill-no-access',true)");
    for (const table of ['properties','residents','integration_connections']) {
      if ((await client.query(`SELECT 1 FROM public.${quoteIdentifier(table)} LIMIT 1`)).rowCount) throw new Error('Restored database exposes another workspace');
    }
  } finally { await client.query('ROLLBACK'); }
  return { tablesVerified: actual.tables.length, dataMatched: true, permissionsMatched: true, isolationVerified: true };
}
