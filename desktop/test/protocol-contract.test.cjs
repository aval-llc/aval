const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DESKTOP_PROTOCOL } = require('../protocol.json');
const { CAPABILITIES } = require('../inference.cjs');
test('Desktop capability and both package paths include the shared protocol', () => {
  assert.equal(CAPABILITIES.protocolVersion, DESKTOP_PROTOCOL);
  assert.ok(require('../package.json').build.files.includes('protocol.json'));
  assert.match(readFileSync(join(__dirname, '../scripts/package-offline-mac.sh'), 'utf8'), /DESKTOP_DIR\}\/protocol\.json/);
});
