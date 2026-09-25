import test from 'node:test';
import assert from 'node:assert/strict';
import { internalPreview } from '../lib/integrations/internal-preview.ts';

test('internal panels appear only for the exact preview they belong to', () => {
  assert.equal(internalPreview('?preview=pms', 'pms'), true);
  assert.equal(internalPreview('?view=connections&preview=pms', 'pms'), true);
  assert.equal(internalPreview('', 'pms'), false);
  assert.equal(internalPreview('?preview=', 'pms'), false);
  assert.equal(internalPreview('?preview=pmsx', 'pms'), false);
  assert.equal(internalPreview('?preview=1', 'pms'), false);
  assert.equal(internalPreview('?preview=pms', 'billing'), false);
});
