/** Reads existing reports only. Output is restricted to gitignored work/. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeInferenceBaseline } from '../evals/maintenance/baseline-analysis.mjs';

const [input, output = 'work/inference-baseline.json', prices] = process.argv.slice(2);
if (!input) throw Error('Usage: node scripts/analyze-inference-baseline.mjs REPORT [work/OUTPUT.json] [PRICES.json]');
const root = fileURLToPath(new URL('../work/', import.meta.url));
const destination = resolve(output);
const within = relative(root, destination);
if (!within || within === '..' || within.startsWith('../') || within.startsWith('..\\') || resolve(root, within) !== destination) throw Error('Detailed baseline output must stay inside this checkout’s gitignored work/ directory');
const report = analyzeInferenceBaseline(JSON.parse(await readFile(input, 'utf8')), prices ? JSON.parse(await readFile(prices, 'utf8')) : null);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ output: destination, attempts: report.attempts, modelCallsMade: 0 }));
