import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { postgresEvaluation } from '../../scripts/lib/postgres-evaluation.mjs';
import { createTask, claimTask, claimableTasks } from '../../lib/agents/tasks.ts';
import { agentsPaused, setAgentsPaused } from '../../lib/agents/pause.ts';
import { taskBoundary } from '../../lib/agents/task-boundary.ts';
import { withWorkerOrganizationSession } from '../../lib/api/with-session.ts';
import { PUT as pause } from '../../app/api/agents/pause/route.ts';
import { syncGmail } from '../../lib/communications/gmail-sync.ts';
import { GET as health } from '../../app/api/agents/health/route.ts';
import { withDbSession } from '../../db/postgres/session.ts';
import { sql } from 'drizzle-orm';
import { applyImport } from '../../lib/operations/import-apply.ts';
import { demoPortfolio } from '../../lib/operations/demo-portfolio.ts';
import { startDemoWorkflow } from '../../lib/operations/demo-workflows.ts';

test('new inbound evidence invalidates a draft, but replay does not erase a later human draft', async () => {
  const db=await postgresEvaluation();
  try {
    await db.run(s=>applyImport(s,db.org,demoPortfolio(new Date()),{sourceProvider:'aval_demo',sourceConnectionId:null,externalId:null}));
    const task=await db.run(s=>startDemoWorkflow(s,db.org,db.user,0));
    const scope=JSON.parse(task.executionScopeJson), id=randomUUID(), external=randomUUID();
    const saveDraft=()=>db.admin.query("UPDATE conversations SET draft_reply='Human-reviewed reply',draft_reply_status='ready' WHERE id=$1",[scope.conversationId]);
    const insert=()=>db.admin.query("INSERT INTO messages(id,conversation_id,external_message_id,direction,body,payload_json,created_at) VALUES($1,$2,$3,'inbound','New information','{}',now()) ON CONFLICT DO NOTHING",[id,scope.conversationId,external]);
    await saveDraft();await insert();
    assert.equal((await db.admin.query('SELECT draft_reply FROM conversations WHERE id=$1',[scope.conversationId])).rows[0].draft_reply,null);
    await saveDraft();await insert();
    assert.equal((await db.admin.query('SELECT draft_reply FROM conversations WHERE id=$1',[scope.conversationId])).rows[0].draft_reply,'Human-reviewed reply');
  } finally {await db.close();}
});

test('monitor token works without a cookie and exposes aggregates only; runtime rejects privileged login', async () => {
  const db = await postgresEvaluation();
  try {
    env.AGENT_HEALTH_TOKEN = randomUUID();
    const response = await health(new Request('https://app.aval.llc/api/agents/health', { headers: { authorization: `Bearer ${env.AGENT_HEALTH_TOKEN}` } }));
    assert.ok([200,503].includes(response.status));
    const body = await response.json();
    assert.equal(body.scope, 'global'); assert.ok(body.metrics); assert.equal(JSON.stringify(body).includes(db.org), false);
    assert.equal((await health(new Request('https://app.aval.llc/api/agents/health', {headers:{authorization:'Bearer invalid'}}))).status, 401);
    await assert.rejects(db.run(s => s.db.execute(sql`select aval_private.agent_health_snapshot()`)), error => error.cause?.code === '42501');
    await assert.rejects(withDbSession({connectionString:process.env.AVAL_TEST_DATABASE_URL}, {principalId:db.user, organizationId:db.org, actorId:db.user, requestId:randomUUID()}, async()=>{}), /Unsafe database runtime login/);
  } finally { await db.close(); }
});

test('pause prevents claims, creation and tool execution while retaining queued work', async () => {
  const db = await postgresEvaluation();
  try {
    const input = { organizationId: db.org, userId: db.user, agentId: 'maintenance', goal: 'Pause fixture', check: { kind: 'evidence', tools: ['read_maintenance_context'] } };
    const task = await db.run(s => createTask(s, input));
    assert.equal(await withWorkerOrganizationSession(db.org, s => agentsPaused(s, db.org)), false, 'worker role can read the pause control');
    const request = (paused, origin = 'https://app.aval.llc') => {
      const r = new Request(db.request('/api/agents/pause', { paused }), { method: 'PUT' });
      r.headers.set('origin', origin); return r;
    };
    assert.equal((await pause(request(true, 'https://evil.invalid'))).status, 403);
    assert.equal((await pause(request(true))).status, 200);
    assert.deepEqual(await db.run(s => claimableTasks(s)), []);
    assert.equal(await db.run(s => claimTask(s, task.id, randomUUID(), 'QUEUED')), false);
    await assert.rejects(db.run(s => createTask(s, input)), /paused/);
    assert.match(await db.run(s => taskBoundary(s, db.org, db.user, task.id, 'create_maintenance_work_order', {})), /paused/);
    await assert.rejects(db.session(`foreign_${randomUUID()}`, s => setAgentsPaused(s, db.org, false)), /owner/);
    assert.equal((await pause(request(false))).status, 200);
    assert.equal((await db.run(s => claimableTasks(s))).some(row => row.id === task.id), true);
    env.AVAL_AGENTS_PAUSED = 'true';
    assert.equal((await (await pause(request(false))).json()).paused, true, 'workspace owner cannot override global pause');
    assert.equal(await db.run(s => claimTask(s, task.id, randomUUID(), 'QUEUED')), false);
  } finally { await db.close(); }
});

test('expired Gmail history preserves its checkpoint and cannot silently replay old mail', async t => {
  const db = await postgresEvaluation();
  try {
    const connection = { id: randomUUID(), externalAccountId: `${db.user}@example.invalid` };
    await db.admin.query("INSERT INTO integration_connections(id,organization_id,provider,category,status,auth_mode,external_account_id,created_by,created_at,updated_at) VALUES($1,$2,'gmail','Communication','connected','oauth2',$3,$4,now(),now())", [connection.id,db.org,connection.externalAccountId,db.user]);
    await db.admin.query("INSERT INTO communication_inbox_state(connection_id,organization_id,account_id,cursor_json) VALUES($1,$2,$3,$4)", [connection.id,db.org,connection.externalAccountId,JSON.stringify({mode:'history',historyId:'expired'})]);
    t.mock.method(globalThis, 'fetch', async input => {
      assert.match(String(input), /\/history\?/);
      return Response.json({error:{message:'History expired'}}, {status:404});
    });
    await assert.rejects(db.run(s => syncGmail(s, db.org, connection, 'fixture')), /checkpoint was preserved/);
    const saved = await db.admin.query('SELECT cursor_json FROM communication_inbox_state WHERE connection_id=$1', [connection.id]);
    assert.deepEqual(saved.rows[0].cursor_json, {mode:'history',historyId:'expired'});
  } finally { await db.close(); }
});
