import { createDecipheriv, privateDecrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Client } from 'pg';
import { command, fileDigest, postgresEnvironment } from './backup-database.mjs';
import { pathToFileURL } from 'node:url';
import { prepareRestoreTarget, restoreUrl, verifyRestoredDatabase } from './backup-verification.mjs';

export async function restoreDatabase(encrypted, manifestPath) {
  process.umask(0o077);
  if (!encrypted || !manifestPath || !process.env.AVAL_RESTORE_DATABASE_URL || !process.env.AVAL_BACKUP_PRIVATE_KEY) throw new Error('Provide encrypted backup, manifest, disposable restore database and private key');
  const url = restoreUrl(process.env.AVAL_RESTORE_DATABASE_URL);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.algorithm !== 'AES-256-GCM+RSA-OAEP-SHA256' || !manifest.sealedVerification) throw new Error('Backup lacks encrypted snapshot metadata');
  if (await fileDigest(encrypted) !== manifest.sha256) throw new Error('Backup checksum mismatch');
  const key = privateDecrypt({ key: process.env.AVAL_BACKUP_PRIVATE_KEY, oaepHash: 'sha256' }, Buffer.from(manifest.encryptedKey,'base64'));
  const seal = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.sealedVerification.iv,'base64'));
  seal.setAuthTag(Buffer.from(manifest.sealedVerification.tag,'base64'));
  const verification = JSON.parse(Buffer.concat([seal.update(Buffer.from(manifest.sealedVerification.contents,'base64')),seal.final()]).toString('utf8'));
  await prepareRestoreTarget(url.href, verification.roles);
  const client = new Client({ connectionString: url.href }); await client.connect();
  try {
    const existing = await client.query("select 1 from pg_tables where schemaname not in ('pg_catalog','information_schema') limit 1");
    if (existing.rowCount) throw new Error('Restore target is not empty');
  } finally { await client.end(); }
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.iv,'base64')); cipher.setAuthTag(Buffer.from(manifest.tag,'base64'));
  const directory = await mkdtemp(join(tmpdir(), 'aval-restore-'));
  try {
    const dump = join(directory,'database.dump');
    await pipeline(createReadStream(encrypted), cipher, createWriteStream(dump, { mode: 0o600 }));
    await command('pg_restore', ['--exit-on-error','--no-owner', '--dbname', decodeURIComponent(url.pathname.slice(1)), dump], postgresEnvironment(url.href));
    const restored = new Client({ connectionString: url.href }); await restored.connect();
    try {
      const result = await verifyRestoredDatabase(restored, verification);
      console.log(JSON.stringify({ restoreVerified: true, ...result }));
      return result;
    } finally { await restored.end(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) restoreDatabase(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
