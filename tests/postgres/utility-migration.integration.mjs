import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';

const url=process.env.AVAL_TEST_DATABASE_URL;
if(!url || !['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Utility migration rehearsal requires a disposable loopback database');

test('utility migration preserves populated legacy meters and bills without guessing mappings',async()=>{
  const name=`aval_utility_legacy_${randomBytes(6).toString('hex')}`;
  const admin=new Client({connectionString:url});
  await admin.connect();
  let created=false,db;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);created=true;
    const target=new URL(url);target.pathname=`/${name}`;
    db=new Client({connectionString:target.href});await db.connect();
    const directory=new URL('../../supabase/migrations/',import.meta.url);
    const migration='20260926000100_utility_pilot.sql';
    for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql') && f<migration).sort()) {
      await db.query('BEGIN');
      await db.query(await readFile(new URL(file,directory),'utf8'));
      await db.query('COMMIT');
    }
    await db.query("INSERT INTO organizations(id,name,owner_user_id,created_at,updated_at) VALUES('legacy-org','Synthetic legacy','synthetic-owner',now(),now())");
    await db.query("INSERT INTO utility_meters(id,organization_id,utility_type,property_label,unit_of_measure,created_at,updated_at) VALUES('000-meter','legacy-org','water','Ambiguous site','gal',now(),now())");
    await db.query("INSERT INTO utility_bills(id,organization_id,meter_id,period_start,period_end,usage_amount,cost_cents,currency,source,created_at) VALUES('000-bill','legacy-org','000-meter','2026-01-01','2026-02-01',125,11600,'MXN','manual',now())");
    await db.query('BEGIN');
    await db.query(await readFile(new URL(migration,directory),'utf8'));
    await db.query('COMMIT');
    assert.deepEqual((await db.query('SELECT id,property_label,unit_of_measure,site_id,parent_meter_id FROM utility_meters')).rows,[{id:'000-meter',property_label:'Ambiguous site',unit_of_measure:'gal',site_id:null,parent_meter_id:null}]);
    assert.deepEqual((await db.query('SELECT id,meter_id,unit_of_measure,reading_kind,source_system,external_id,cost_cents,currency FROM utility_bills')).rows,[{id:'000-bill',meter_id:'000-meter',unit_of_measure:'gal',reading_kind:'unknown',source_system:null,external_id:null,cost_cents:'11600',currency:'MXN'}]);
    assert.equal((await db.query('SELECT count(*) FROM utility_sites')).rows[0].count,'0');
  }finally{
    if(db)await db.end();
    if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
