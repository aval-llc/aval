import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Build-time only: no shell, credentials, or Git process in the Worker. */
export function agentBuildVersion() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    const hash = createHash('sha256');
    for (const path of [...new Set(files)].sort()) {
      hash.update(path); hash.update('\0');
      try { hash.update(readFileSync(path)); } catch { hash.update('deleted'); }
      hash.update('\0');
    }
    return `${commit}:tree-${hash.digest('hex')}`;
  } catch { return 'unversioned-local'; }
}
