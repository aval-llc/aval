import { createDecipheriv, privateDecrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Client } from 'pg';
import { command, fileDigest, postgresEnvironment } from './backup-database.mjs';

async function main() {
  process.umask(0o077);
  const [encrypted, manifestPath] = process.argv.slice(2);
  if (!encrypted || !manifestPath || !process.env.AVAL_RESTORE_DATABASE_URL || !process.env.AVAL_BACKUP_PRIVATE_KEY) throw new Error('Provide encrypted backup, manifest, disposable restore database and private key');
  const url = new URL(process.env.AVAL_RESTORE_DATABASE_URL);
  if (!['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Restore drills are restricted to a disposable loopback database');
  const client = new Client({ connectionString: url.href }); await client.connect();
  try {
    const existing = await client.query("select 1 from pg_tables where schemaname not in ('pg_catalog','information_schema') limit 1");
    if (existing.rowCount) throw new Error('Restore target is not empty');
  } finally { await client.end(); }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.algorithm !== 'AES-256-GCM+RSA-OAEP-SHA256') throw new Error('Unsupported backup format');
  if (await fileDigest(encrypted) !== manifest.sha256) throw new Error('Backup checksum mismatch');
  const key = privateDecrypt({ key: process.env.AVAL_BACKUP_PRIVATE_KEY, oaepHash: 'sha256' }, Buffer.from(manifest.encryptedKey,'base64'));
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.iv,'base64')); cipher.setAuthTag(Buffer.from(manifest.tag,'base64'));
  const directory = await mkdtemp(join(tmpdir(), 'aval-restore-'));
  try {
    const dump = join(directory,'database.dump');
    await pipeline(createReadStream(encrypted), cipher, createWriteStream(dump, { mode: 0o600 }));
    await command('pg_restore', ['--exit-on-error','--no-owner','--no-acl', '--dbname', decodeURIComponent(url.pathname.slice(1)), dump], postgresEnvironment(url.href));
    console.log('Restore completed. Run data counts, tenant-isolation and application smoke checks before accepting this drill.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
