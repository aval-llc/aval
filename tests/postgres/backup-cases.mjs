import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { backupDatabase } from '../../scripts/backup-database.mjs';
import { restoreDatabase } from '../../scripts/restore-database.mjs';
import { databaseInventory, verifyRestoredDatabase, quoteIdentifier } from '../../scripts/backup-verification.mjs';

export async function runBackupCases(t, sourceUrl) {
  await t.test('encrypted backup restores actual records and permissions; corruption blocks recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(),'aval-backup-test-'));
    const { publicKey, privateKey } = generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
    const target = new URL(sourceUrl); target.pathname = `/aval_restore_${randomUUID().replaceAll('-','')}`;
    const values = { DATABASE_URL: sourceUrl, AVAL_BACKUP_PUBLIC_KEY: publicKey, AVAL_BACKUP_PRIVATE_KEY: privateKey, AVAL_BACKUP_DIRECTORY: directory, AVAL_RESTORE_DATABASE_URL: target.href };
    const previous = Object.fromEntries(Object.keys(values).map(name => [name,process.env[name]]));
    Object.assign(process.env,values);
    try {
      await backupDatabase();
      const encrypted = join(directory,'database.enc'), manifest = join(directory,'manifest.json');
      const metadata = JSON.parse(await readFile(manifest,'utf8'));
      assert.ok(metadata.sealedVerification); assert.equal(metadata.verification,undefined);
      const original = await readFile(encrypted);
      const damaged = Buffer.from(original); damaged[0] ^= 1;
      await writeFile(encrypted,damaged);
      await assert.rejects(restoreDatabase(encrypted,manifest),/checksum mismatch/);
      await writeFile(encrypted,original);
      const result = await restoreDatabase(encrypted,manifest);
      assert.equal(result.dataMatched,true); assert.equal(result.isolationVerified,true);
      const clone = new Client({connectionString:target.href}); await clone.connect();
      try {
        const expected = await databaseInventory(clone);
        await clone.query("UPDATE public.organizations SET name=name || ' changed' WHERE id=(SELECT id FROM public.organizations LIMIT 1)");
        await assert.rejects(verifyRestoredDatabase(clone,expected),/fingerprints/);
      } finally { await clone.end(); }
    } finally {
      for (const [name,value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name]=value; }
      const adminUrl = new URL(target); adminUrl.pathname='/postgres';
      const admin = new Client({connectionString:adminUrl.href}); await admin.connect();
      try { await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(target.pathname.slice(1))}`); } finally { await admin.end(); }
      await rm(directory,{recursive:true,force:true});
    }
  });
}
