import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceUsageAnalysis } from '../evals/maintenance/usage-analysis.mjs';
test('usage analysis preserves unknown counters and never sums notifications',()=>{
  const call={usage:{input_tokens:70000,output_tokens:1000},diagnostics:{usage_snapshots:[{total:{inputTokens:20000}},{total:{inputTokens:70000,cachedInputTokens:30000},last:{inputTokens:25000,outputTokens:500}}]}};
  const [r]=maintenanceUsageAnalysis([call]);assert.equal(r.reported_input_tokens,70000);assert.equal(r.input_before_last_snapshot,45000);assert.equal(r.cached_input_tokens,30000);assert.equal(r.reasoning_output_tokens,null);
  assert.equal(maintenanceUsageAnalysis([{}])[0].reported_input_tokens,null);
});
