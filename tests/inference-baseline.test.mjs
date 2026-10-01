import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeInferenceBaseline } from '../evals/maintenance/baseline-analysis.mjs';

test('baseline distinguishes unknown usage and never invents harness overhead', () => {
  const result = analyzeInferenceBaseline({ calls: [{ phase: 'actor', usage: { input_tokens: 10000, output_tokens: 2000 }, duration_ms: 100 }, { phase: 'actor' }] }, { version: 'fixture', inputPerMillion: 0.1, cachedInputPerMillion: 0.01, outputPerMillion: 0.5 });
  assert.equal(result.phases.actor.unknownUsage, 1);
  assert.equal(result.phases.actor.inputTokens.p50, 10000);
  assert.equal(result.cost.usd, 0.002);
  assert.equal(result.cost.unpricedAttempts, 1);
  assert.equal(result.overhead.status, 'not_identifiable_from_usage_alone');
});
test('cached input is a subset; reasoning is not billed twice', () => {
  const result = analyzeInferenceBaseline({ calls: [{ usage: { input_tokens: 10000, output_tokens: 2000 }, diagnostics: { usage_snapshots: [{ total: { cachedInputTokens: 5000, reasoningOutputTokens: 1500 } }] } }] }, { version: 'fixture', inputPerMillion: 0.1, cachedInputPerMillion: 0.01, outputPerMillion: 0.5 });
  assert.equal(result.cost.usd, 0.00155);
});
