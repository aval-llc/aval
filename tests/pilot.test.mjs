import test from 'node:test';
import { execFileSync } from 'node:child_process';
test('pilot policy, adapters and safety regression cases', () => {
  execFileSync(process.execPath, ['--import','./tests/integration/module-hooks.mjs','--test','tests/integration/pilot-cases.mjs'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
