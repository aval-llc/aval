import { createCipheriv, createHash, publicEncrypt, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { databaseInventory } from './backup-verification.mjs';

export function postgresEnvironment(url) {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('PostgreSQL connection required');
  return { ...process.env, PGHOST: parsed.hostname, PGPORT: parsed.port || '5432', PGUSER: decodeURIComponent(parsed.username), PGPASSWORD: decodeURIComponent(parsed.password), PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)), PGSSLMODE: parsed.searchParams.get('sslmode') || (['localhost','127.0.0.1'].includes(parsed.hostname) ? 'disable' : 'require') };
}
export async function command(program, args, env = process.env) {
  if (env.AVAL_POSTGRES_CLIENT_IMAGE && ['pg_dump','pg_restore'].includes(program)) {
    if (!['postgres:17', 'postgres:17-alpine'].includes(env.AVAL_POSTGRES_CLIENT_IMAGE)) throw new Error('Unsupported PostgreSQL client image');
    const fileIndex = args.indexOf('--file');
    const file = program === 'pg_dump' ? args[fileIndex + 1] : args.at(-1);
    if (!file || !isAbsolute(file) || !dirname(file).startsWith(join(tmpdir(),'aval-'))) throw new Error('Backup container must mount an isolated backup directory');
    const mount = dirname(file);
    const containerFile = `/backup/${basename(file)}`;
    if (program === 'pg_dump') args[fileIndex + 1] = containerFile;
    else args[args.length - 1] = containerFile;
    const user = typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    args = ['run','--rm','--network','host',...user,'--mount',`type=bind,source=${mount},target=/backup`,
      ...['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','PGSSLMODE'].flatMap(name => ['--env',name]),
      env.AVAL_POSTGRES_CLIENT_IMAGE,program,...args];
    program = 'docker';
  }
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, stdio: ['ignore','pipe','pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume(); // Never print upstream errors containing connection details.
    child.on('error', () => reject(new Error(`${program} could not start`)));
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${program} failed (${code})`)));
  });
}
export async function encryptBackup(source, target, publicKey, verification) {
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  await pipeline(createReadStream(source), cipher, createWriteStream(target, { mode: 0o600, flags: 'wx' }));
  const metadata = { version: 1, algorithm: 'AES-256-GCM+RSA-OAEP-SHA256', encryptedKey: publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, key).toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  if (verification) {
    const verificationIv = randomBytes(12), seal = createCipheriv('aes-256-gcm', key, verificationIv);
    const contents = Buffer.concat([seal.update(JSON.stringify(verification)), seal.final()]);
    metadata.sealedVerification = { iv: verificationIv.toString('base64'), tag: seal.getAuthTag().toString('base64'), contents: contents.toString('base64') };
  }
  return metadata;
}
export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function backupDatabase() {
  process.umask(0o077);
  for (const name of ['DATABASE_URL','AVAL_BACKUP_PUBLIC_KEY']) if (!process.env[name]) throw new Error(`Missing ${name}; migrations must not proceed`);
  const artifactDirectory = process.env.AVAL_BACKUP_DIRECTORY;
  let endpoint;
  if (!artifactDirectory) {
    for (const name of ['AVAL_BACKUP_BUCKET','AVAL_BACKUP_ENDPOINT','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY']) if (!process.env[name]) throw new Error(`Missing ${name}; migrations must not proceed`);
    endpoint = new URL(process.env.AVAL_BACKUP_ENDPOINT);
    if (endpoint.protocol !== 'https:') throw new Error('Backup storage must use HTTPS');
  }
  const directory = await mkdtemp(join(tmpdir(), 'aval-backup-'));
  try {
    const dump = join(directory, 'database.dump'), encrypted = join(directory, 'database.enc'), manifest = join(directory, 'manifest.json');
    const source = new Client({ connectionString: process.env.DATABASE_URL });
    await source.connect();
    let verification;
    try {
      await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = (await source.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
      verification = await databaseInventory(source);
      await command('pg_dump', ['--format=custom',`--snapshot=${snapshot}`,'--file',dump], postgresEnvironment(process.env.DATABASE_URL));
      await source.query('COMMIT');
    } finally { await source.end(); }
    const metadata = await encryptBackup(dump, encrypted, process.env.AVAL_BACKUP_PUBLIC_KEY, verification);
    const sha256 = await fileDigest(encrypted);
    const prefix = `aval/${new Date().toISOString().replaceAll(':','-')}-${process.env.GITHUB_SHA || 'manual'}`;
    await writeFile(manifest, JSON.stringify({ ...metadata, sha256, createdAt: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null }), { mode: 0o600 });
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
      await copyFile(encrypted, join(artifactDirectory,'database.enc'));
      await copyFile(manifest, join(artifactDirectory,'manifest.json'));
      console.log(JSON.stringify({ encrypted: true, sha256, storage: 'awaiting_workflow_artifact_upload' }));
      return { directory: artifactDirectory, sha256 };
    }
    const common = ['--endpoint-url', endpoint.href];
    await command('aws', ['s3','cp',encrypted,`s3://${process.env.AVAL_BACKUP_BUCKET}/${prefix}/database.enc`,'--metadata',`sha256=${sha256}`,...common]);
    await command('aws', ['s3','cp',manifest,`s3://${process.env.AVAL_BACKUP_BUCKET}/${prefix}/manifest.json`,...common]);
    const remote = JSON.parse(await command('aws', ['s3api','head-object','--bucket',process.env.AVAL_BACKUP_BUCKET,'--key',`${prefix}/database.enc`,...common]));
    if (remote.Metadata?.sha256 !== sha256) throw new Error('Backup storage verification failed');
    const verified = join(directory, 'verified.enc');
    await command('aws', ['s3','cp',`s3://${process.env.AVAL_BACKUP_BUCKET}/${prefix}/database.enc`,verified,...common]);
    if (await fileDigest(verified) !== sha256) throw new Error('Downloaded backup checksum mismatch');
    const result = { backup: prefix, sha256, uploaded: true, restoreTested: false };
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `backup_prefix=${prefix}\n`, { flag: 'a' });
    console.log(JSON.stringify(result));
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) backupDatabase().catch(error => { console.error(error.message); process.exitCode = 1; });
