/** Real model calls on labeled synthetic cases. No workspace actions or provider fixtures. */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { callClaude } from '../lib/ask-aval/anthropic.ts';
import { SEMANTIC_REVIEW_SYSTEM, SEMANTIC_REVIEW_TOOL, parseSemanticVerdict } from '../lib/agents/semantic-review.ts';
import { semanticCases } from '../tests/fixtures/semantic-cases.mjs';

const file = process.argv[2];
const env = { ...(file ? parseEnv(readFileSync(file, 'utf8')) : {}), ...process.env };
const report = { checkedAt: new Date().toISOString(), provider: 'anthropic', model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5', dataset: 'synthetic-semantic-v1', status: 'running', results: [] };
for (const item of semanticCases) {
  const start = Date.now();
  try {
    const response = await callClaude(env, { system: SEMANTIC_REVIEW_SYSTEM, messages: [{ role: 'user', content: JSON.stringify(item.packet) }], tools: [SEMANTIC_REVIEW_TOOL], tool_choice: { type: 'tool', name: 'semantic_verdict' }, max_tokens: 1800, timeout_ms: 20000 });
    const verdict = parseSemanticVerdict(response, item.packet);
    report.results.push({ id: item.id, expectedPass: item.expectedPass, actualPass: verdict.exitCode === 0, matched: item.expectedPass === (verdict.exitCode === 0), durationMs: Date.now() - start, usage: response.usage, problems: verdict.problems });
  } catch (error) {
    report.status = 'blocked_provider';
    report.error = { httpStatus: error.status ?? null, reason: String(error.message) };
    break;
  }
}
if (report.status === 'running') report.status = report.results.every(r => r.matched) ? 'passed' : 'failed';
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 2;
