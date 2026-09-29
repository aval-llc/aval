/** Run with module-hooks and a migrated loopback AVAL_TEST_DATABASE_URL.
 * Actual React UI -> Electron preload/IPC -> inference service -> API -> PG.
 * Only App Server responses are synthetic. Never reads subscription credentials.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { postgresEvaluation } from './lib/postgres-evaluation.mjs';
import { applyImport } from '../lib/operations/import-apply.ts';
import { demoPortfolio } from '../lib/operations/demo-portfolio.ts';
import { startDemoWorkflow } from '../lib/operations/demo-workflows.ts';
import { GET, POST } from '../app/api/agents/desktop/route.ts';
import { PUT as policy } from '../app/api/communications/maintenance-policy/route.ts';
import { syntheticEmergencyPolicy } from '../evals/maintenance/policy-fixture.mjs';
import { advanceTask } from '../lib/agents/runtime.ts';
import { getTask } from '../lib/agents/tasks.ts';
import { decideApproval, latestApprovalForTask } from '../lib/agents/approvals.ts';

const db = await postgresEvaluation();
const temporary = await mkdtemp(join(tmpdir(), 'aval-runner-browser-'));
let browser, server;
const backgrounds = [];
const priorContext = globalThis.__REQUEST_CONTEXT__;
globalThis.__REQUEST_CONTEXT__ = { waitUntil: promise => backgrounds.push(promise) };
try {
  await db.run(s => applyImport(s, db.org, demoPortfolio(new Date()), { sourceProvider: 'aval_demo', sourceConnectionId: null, externalId: null }));
  assert.equal((await policy(new Request(db.request('/api/communications/maintenance-policy', { ...syntheticEmergencyPolicy, acknowledgementVersion: 'maintenance-ack-v1' }), { method: 'PUT' }))).status, 200);
  const task = await db.run(s => startDemoWorkflow(s, db.org, db.user, 0, 'en'));
  const scope = JSON.parse(task.executionScopeJson);
  const bundle = await build({ entryPoints: ['tests/fixtures/desktop-runner-page.jsx'], bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  const operations = [];
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><div id="root"></div><script src="/runner.js"></script>'); }
      if (req.url === '/runner.js') { res.setHeader('content-type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
      if (req.url !== '/api/agents/desktop') { res.statusCode = 404; return res.end(); }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      operations.push(body.action ?? 'status');
      const request = db.request('/api/agents/desktop', body);
      const response = req.method === 'GET' ? await GET(new Request(request.url, { headers: request.headers })) : await POST(request);
      res.statusCode = response.status; res.setHeader('content-type', 'application/json'); res.end(await response.text());
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const input = { conversation_id: scope.conversationId, message_id: scope.messageId, resident_id: scope.maintenance.residentId, property_id: scope.maintenance.propertyId, unit_id: scope.maintenance.unitId, summary: 'Slow drain reported; cause unknown.', priority: 'routine' };
  const fixture = join(temporary, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ input, userData: join(temporary, 'electron'), url: `http://127.0.0.1:${server.address().port}` }));
  const electron = createRequire(new URL('../desktop/package.json', import.meta.url))('electron');
  browser = spawn(electron, [resolve('desktop/fixtures/runner-browser.cjs'), fixture], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  let browserError;
  browser.on('error', error => { browserError = error; });
  browser.stdout.on('data', data => process.stdout.write(data));
  browser.stderr.on('data', data => process.stderr.write(data));
  const deadline = Date.now() + 45000;
  let final;
  while (Date.now() < deadline) {
    if (browserError) throw browserError;
    assert.equal(browser.exitCode, null, 'browser must stay connected');
    await Promise.all(backgrounds.splice(0));
    final = await db.run(s => getTask(s, db.org, task.id));
    if (final.status === 'COMPLETED') break;
    if (final.status === 'WAITING_FOR_APPROVAL') {
      const approval = await db.run(s => latestApprovalForTask(s, db.org, task.id));
      assert.equal((await db.run(s => decideApproval(s, db.org, approval.id, 'approved', db.user, db.user, 'owner'))).ok, true);
    }
    if (operations.includes('register')) await db.run(s => advanceTask(s, {}, db.org, task.id, crypto.randomUUID(), { maxStepsThisInvocation: 1 }));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(final.status, 'COMPLETED', final.error);
  for (const op of ['register', 'claim', 'complete']) assert.ok(operations.includes(op), `UI must drive ${op}`);
  const count = (await db.admin.query("SELECT count(*) FROM work_orders WHERE organization_id=$1 AND source_provider='manual'", [db.org])).rows[0].count;
  assert.equal(Number(count), 1);
  assert.equal(JSON.parse(final.maintenanceOutcomeJson).draftState, 'verified');
  console.log(JSON.stringify({ status: 'passed', transport: 'real React/Electron IPC/API/PostgreSQL', model: 'synthetic RPC, not live validated', paidCalls: 0, workOrders: Number(count), taskStatus: final.status }));
} finally {
  browser?.kill();
  if (server) await new Promise(resolve => server.close(resolve));
  await Promise.allSettled(backgrounds);
  globalThis.__REQUEST_CONTEXT__ = priorContext;
  await db.close();
  await rm(temporary, { recursive: true, force: true });
}
