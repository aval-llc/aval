import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { prepareByDesignUtilityImport } from '../../lib/integrations/sap-bydesign/prepare-import.ts';
import { syntheticCredentials, syntheticProfile, syntheticReadConfig } from '../fixtures/sap-bydesign/synthetic.ts';
import { startByDesignSimulator } from '../fixtures/sap-bydesign/simulator.mjs';
import { createSite } from '../../lib/infrastructure/sites.ts';
import { createMeter, listBills } from '../../lib/infrastructure/meters.ts';
import { utilityInvestigations } from '../../lib/infrastructure/investigations.ts';
import { withVerifiedIdentityHeaders } from '../../lib/auth/request-identity.ts';
import { POST as importRoute } from '../../app/api/infrastructure/import/route.ts';
import { POST as followUpRoute } from '../../app/api/infrastructure/follow-up/route.ts';
import { POST as taskRoute } from '../../app/api/agents/tasks/route.ts';
import { runScheduledSweep } from '../../lib/workers/scheduled-sweep.ts';

const reply = (name, input) => ({ content: [{ type: 'tool_use', name, input, id: randomUUID() }], stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 50 }, routing: { providerId: 'test', model: 'scripted-bydesign' } });

export async function runByDesignCases(t, { session, config, administrator, userB }) {
  const subject = `bydesign_${randomUUID()}`;
  const run = work => session(subject, s => work(s, s.identity.organizationId));
  const saved = { ...env };
  env.DATABASE_URL = config.connectionString; delete env.HYPERDRIVE;
  const request = (path, body, user = subject) => new Request(`https://aval.test${path}`, {
    method: 'POST', headers: withVerifiedIdentityHeaders(new Headers({ 'content-type': 'application/json' }), { userId: user, email: `${user}@example.test`, displayName: 'Synthetic ByDesign evaluator', emailVerified: true }), body: JSON.stringify(body),
  });
  let profile, rows, org;
  try {
    await t.test('ByDesign simulated source -> public preview/apply -> persisted scoped utility evidence', async () => {
      const site = await run((s, o) => createSite(s, o, { name: 'ByDesign synthetic pilot' }));
      org = site.organizationId;
      const meter = await run((s, o) => createMeter(s, o, { siteId: site.id, utilityType: 'water', unitOfMeasure: 'm3', propertyLabel: site.name, meterNumber: 'SYNTH-WATER-001' }));
      profile = { ...syntheticProfile, meters: [{ ...syntheticProfile.meters[0], avalMeterId: meter.id }] };
      const server = await startByDesignSimulator();
      try {
        // Deliberately outside run()/DbSession: no provider call holds a transaction.
        const prepared = await prepareByDesignUtilityImport(syntheticReadConfig, syntheticCredentials, profile, server.fetch);
        assert.equal(prepared.evidence.liveSapValidated, false); rows = prepared.rows;
      } finally { await server.close(); }
      const previewResponse = await importRoute(request('/api/infrastructure/import', { mode: 'preview', rows }));
      assert.equal(previewResponse.status, 200); const preview = await previewResponse.json();
      assert.equal((await run((s, o) => listBills(s, o))).length, 0);
      assert.equal((await importRoute(request('/api/infrastructure/import', { mode: 'apply', rows, previewToken: preview.previewToken }))).status, 200);
      const persisted = await run((s, o) => listBills(s, o));
      assert.deepEqual(persisted.map(b => b.externalId).sort(), ['000001', '000002']);
      assert.equal(persisted.reduce((sum, b) => sum + b.costCents, 0), 29000);
      const findings = await run((s, o) => utilityInvestigations(s, o, 'es-mx'));
      assert.equal(findings.findings[0].variancePct, 50);
      assert.match(findings.findings[0].explanation, /consumo diario cambió 50%/);
      const foreign = await importRoute(request('/api/infrastructure/import', { mode: 'preview', rows }, userB));
      assert.equal(foreign.status, 400);
    });
    await t.test('ByDesign partial network failure writes nothing; retry and replay preserve two bills', async () => {
      const server = await startByDesignSimulator({ status: 503, failOnCall: 2 });
      try {
        await assert.rejects(prepareByDesignUtilityImport(syntheticReadConfig, syntheticCredentials, profile, server.fetch), error => error.code === 'HTTP_FAILURE');
        assert.equal((await run((s, o) => listBills(s, o))).length, 2);
        const retry = await prepareByDesignUtilityImport(syntheticReadConfig, syntheticCredentials, profile, server.fetch);
        const preview = await (await importRoute(request('/api/infrastructure/import', { mode: 'preview', rows: retry.rows }))).json();
        assert.equal(preview.counts.unchanged, 2);
        assert.equal((await importRoute(request('/api/infrastructure/import', { mode: 'apply', rows: retry.rows, previewToken: preview.previewToken }))).status, 200);
        assert.equal((await run((s, o) => listBills(s, o))).length, 2);
      } finally { await server.close(); }
    });
    await t.test('ByDesign scripted planner -> utility tool -> child review -> cron final answer', async () => {
      await administrator.query("UPDATE organizations SET active_model_provider='fixture' WHERE id=$1", [org]);
      const scheduled = [];
      let sawEvidence = false, modelCalls = 0;
      globalThis.__REQUEST_CONTEXT__ = { waitUntil: promise => scheduled.push(promise) };
      globalThis.__MODEL__ = async (_env, _org, params) => {
        modelCalls++;
        const committed = await administrator.query('SELECT id FROM utility_bills WHERE organization_id=$1', [org]);
        assert.equal(committed.rowCount, 2, 'model sees committed source data');
        const uses = params.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use') : []);
        if (params.tools.some(tool => tool.name === 'plan_goal')) {
          if (!uses.some(u => u.name === 'plan_goal')) return reply('plan_goal', { tasks: [
            { key: 'utilities', goal: 'Compara el consumo diario del medidor con los recibos registrados y cita la evidencia.', dependsOn: [], check: { kind: 'evidence', tools: ['get_utility_investigations'] } },
          ] });
        } else if (!uses.some(u => u.name === 'get_utility_investigations')) return reply('get_utility_investigations', { locale: 'es-mx' });
        else {
          const results = params.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []);
          const content = results.map(r => typeof r.content === 'string' ? r.content : JSON.stringify(r.content)).join('\n');
          assert.match(content, /variancePct/); assert.match(content, /000002/); sawEvidence = true;
        }
        return reply('render_answer', { headline: 'Revisión de consumo', narrative: 'El consumo diario aumentó 50%. Confirme las lecturas con el responsable del sitio; los recibos no prueban una fuga.', confidence: 'high' });
      };
      globalThis.__SEMANTIC_MODEL__ = async (_env, _org, params) => {
        const packet = JSON.parse(params.messages[0].content);
        const source = packet.sources.find(s => !s.failed && s.data && typeof s.data === 'object' && Object.keys(s.data).length);
        return reply('semantic_verdict', { passed: true, issues: [],
          requirements: [{ requirement: packet.goal, satisfied: true, explanation: 'Scripted orchestration check, not live-model grading', nodeKeys: packet.phase === 'plan' ? ['utilities'] : [] }],
          claims: packet.phase === 'plan' ? [] : [{ claim: 'Consumo diario', kind: 'fact', supported: true,
            citations: [{ sourceId: source?.id ?? 'missing', pointer: '/' + Object.keys(source?.data ?? { missing: true })[0].replaceAll('~', '~0').replaceAll('/', '~1') }] }],
        });
      };
      const response = await taskRoute(request('/api/agents/tasks', { goal: 'Revisa en español los recibos de agua del piloto ByDesign y explica qué falta verificar.', agentId: 'financial' }));
      assert.equal(response.status, 202); const { id } = await response.json();
      await Promise.all(scheduled);
      const read = async () => (await administrator.query('SELECT * FROM agent_tasks WHERE id=$1', [id])).rows[0];
      for (let i = 0; i < 12; i++) { await runScheduledSweep(env); if (['COMPLETED', 'FAILED'].includes((await read()).status)) break; }
      const final = await read();
      assert.equal(final.status, 'COMPLETED', final.error);
      assert.match(JSON.stringify(final.result_json), /50/); assert.equal(sawEvidence, true); assert.ok(modelCalls >= 4);
      const children = (await administrator.query('SELECT status FROM agent_tasks WHERE parent_task_id=$1', [id])).rows;
      assert.deepEqual(children.map(c => c.status), ['COMPLETED']);
    });
    await t.test('ByDesign evidence becomes one reviewed internal task without external execution', async () => {
      const finding = (await run((s, o) => utilityInvestigations(s, o, 'es-mx'))).findings[0];
      const body = { meterId: finding.meterId, siteId: finding.siteId, currentBillId: finding.currentBillId, priorBillId: finding.priorBillId, locale: 'es-mx', ...finding.followUpDraft };
      const first = await followUpRoute(request('/api/infrastructure/follow-up', body));
      assert.equal(first.status, 200); const { item } = await first.json();
      const replay = await (await followUpRoute(request('/api/infrastructure/follow-up', body))).json();
      assert.equal(replay.item.id, item.id); assert.equal(item.status, 'planned');
    });
  } finally {
    delete globalThis.__REQUEST_CONTEXT__; delete globalThis.__MODEL__; delete globalThis.__SEMANTIC_MODEL__;
    for (const key of Object.keys(env)) delete env[key]; Object.assign(env, saved);
  }
}
