/** Live Codex inference over labeled synthetic evidence; no business-provider calls. */
import { writeFileSync } from 'node:fs';
import { startCodexInference } from './lib/codex-inference.mjs';
import { SEMANTIC_REVIEW_SYSTEM, SEMANTIC_REVIEW_TOOL, parseSemanticVerdict } from '../lib/agents/semantic-review.ts';
import { semanticCases } from '../tests/fixtures/semantic-cases.mjs';

const output = process.argv[2];
if (!output) throw Error('Supply a report output path.');
const report = { checkedAt: new Date().toISOString(), provider: 'codex-app-server', dataset: 'synthetic-semantic-v1', status: 'running', results: [] };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
let client;
try {
  client = await startCodexInference();
  report.model = client.model;
  for (const item of semanticCases) {
    const start = Date.now();
    const response = await client.call({ system: SEMANTIC_REVIEW_SYSTEM, messages: [{ role: 'user', content: JSON.stringify(item.packet) }], tools: [SEMANTIC_REVIEW_TOOL], tool_choice: { type: 'tool', name: 'semantic_verdict' }, timeout_ms: 60000 });
    const verdict = parseSemanticVerdict(response, item.packet);
    report.results.push({ id: item.id, expectedPass: item.expectedPass, actualPass: verdict.exitCode === 0, matched: item.expectedPass === (verdict.exitCode === 0), durationMs: Date.now() - start, usage: response.usage, ...verdict });
    save();
    console.log(JSON.stringify({ case: item.id, matched: report.results.at(-1).matched, durationMs: Date.now() - start }));
  }
  report.status = report.results.every(r => r.matched) ? 'passed' : 'failed';
  report.metrics = {
    cases: report.results.length,
    falseApprovals: report.results.filter(r => !r.expectedPass && r.actualPass).length,
    falseRejections: report.results.filter(r => r.expectedPass && !r.actualPass).length,
  };
} catch (error) { report.status = 'blocked_provider'; report.error = error.message; }
finally { await client?.close(); save(); }
console.log(JSON.stringify({ status: report.status, model: report.model, cases: report.results.length, error: report.error }));
if (report.status !== 'passed') process.exitCode = 2;
