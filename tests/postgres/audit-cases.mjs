import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { agentTasks, organizationInvitations } from '../../db/postgres/schema.ts';
import { requestApproval, decideApproval, getApproval } from '../../lib/agents/approvals.ts';
import { getTool } from '../../lib/agents/registry.ts';
import { withDbSession } from '../../db/postgres/session.ts';
import { createTask, claimTask, getTask, heartbeat, updateTask, requestCancel, appendStep } from '../../lib/agents/tasks.ts';
import { appendAuditEvents, verifyOrganizationChain } from '../../lib/audit/log.ts';
import { digestPayload } from '../../lib/audit/chain.ts';
import { reserveFinancialOperation, reconcileDueFinancialOperations } from '../../lib/agents/financial-operations.ts';
import { advanceTask } from '../../lib/agents/runtime.ts';

// All database code is real. Only model responses are scripted; this is a
// workflow regression suite, not evidence of live model quality.
const reply = (name, input, id = randomUUID()) => ({
  content: [{ type: 'tool_use', name, input, id }], stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 50 },
  routing: { providerId: 'test', model: 'scripted' },
});
const conclusion = () => reply('render_answer', { headline: 'Portfolio reviewed', narrative: 'Review the available portfolio records.', confidence: 'high' });

export async function runAuditCases(t, { config, administrator, userId, invitedUserId, organizationId }) {
  const run = work => withDbSession(config, {
    principalId: userId, actorId: userId, organizationId, requestId: randomUUID(),
    auth: { userId, email: `${userId}@example.test`, displayName: 'Audit fixture', source: 'password' },
  }, work, { verifyCleanContext: true });
  const task = () => run(s => createTask(s, { organizationId, userId, agentId: 'financial',
    goal: 'Review the portfolio', check: { kind: 'evidence', tools: ['get_portfolio_metrics'] }, maxTokens: 100000 }));

  await t.test('Auth rejects missing email verification before bootstrapping', async () => {
    for (const flag of [null, false]) {
      await assert.rejects(run(s => s.db.execute(sql`select aval_private.bootstrap_supabase_identity(
        ${userId}, 'fixture@example.test', 'Fixture', ${flag}::boolean, ${organizationId}, null)`)),
      error => error.cause?.code === '28000');
    }
  });

  await t.test('racing invitation redemption grants one membership and appends a valid audit', async () => {
    const codeHash = await digestPayload(randomUUID());
    const payloadDigest = await digestPayload({ invitation: true });
    await run(s => s.db.insert(organizationInvitations).values({ id: randomUUID(), organizationId,
      codeHash, role: 'approver', createdByUserId: userId, createdAt: new Date(), expiresAt: new Date(Date.now() + 60000) }));
    const redeem = () => withDbSession(config, { principalId: invitedUserId, actorId: invitedUserId,
      organizationId: 'org_system', requestId: randomUUID() }, s =>
      s.db.execute(sql`select * from aval_private.redeem_invitation(${codeHash}, ${payloadDigest})`));
    const outcomes = await Promise.all([redeem(), redeem()]);
    assert.deepEqual(outcomes.map(r => r.rows[0].outcome).sort(), ['accepted', 'already_accepted']);
    assert.equal((await run(s => verifyOrganizationChain(s, organizationId))).verdict.ok, true);
  });

  await t.test('duplicate approval clicks count once and a rejection cannot be overwritten', async () => {
    const created = await task();
    const approval = await run(s => requestApproval(s, { taskId: created.id, organizationId, stepIndex: 0,
      tool: getTool('send_external_message'), evidence: {}, requiredApprovals: 2 }));
    const decide = decision => run(s => decideApproval(s, organizationId, approval.id, decision, userId, userId, 'owner'));
    const votes = await Promise.all([decide('approved'), decide('approved')]);
    assert.equal(votes.filter(r => r.ok).length, 1);
    assert.equal((await run(s => getApproval(s, organizationId, approval.id))).approvalsReceived, 1);
    const second = work => withDbSession(config, { principalId: invitedUserId, actorId: invitedUserId,
      organizationId, requestId: randomUUID() }, work);
    const rejection = await second(s => decideApproval(s, organizationId, approval.id, 'rejected', invitedUserId, userId, 'approver'));
    assert.equal(rejection.ok, true);
    assert.equal((await decide('approved')).ok, false);
    assert.equal((await run(s => getApproval(s, organizationId, approval.id))).status, 'rejected');
    const locked = await second(s => s.db.execute(sql`select aval_private.lock_organization(${organizationId})`));
    assert.equal(locked.rowCount, 1, 'non-admin audit writers must acquire the same organization lock');
    const payloadDigest = await digestPayload('approver audit');
    await Promise.all([run(s => appendAuditEvents(s, organizationId, [{ kind: 'answer', label: 'owner', payloadDigest, count: 1 }])),
      second(s => appendAuditEvents(s, organizationId, [{ kind: 'answer', label: 'approver', payloadDigest, count: 1 }]))]);
    assert.equal((await run(s => verifyOrganizationChain(s, organizationId))).verdict.ok, true);
    await assert.rejects(run(s => s.db.execute(sql`select aval_private.lock_organization('another_organization')`)), error => error.cause?.code === '42501');
    await withDbSession(config, { principalId: 'principal_aval_worker', actorId: 'principal_aval_worker', organizationId,
      requestId: randomUUID() }, s => appendAuditEvents(s, organizationId, [{ kind: 'answer', label: 'worker', payloadDigest, count: 1 }]), { role: 'aval_worker' });
    for (const role of ['aval_app', 'aval_worker']) {
      await assert.rejects(withDbSession(config, { principalId: userId, actorId: userId, organizationId, requestId: randomUUID() },
        s => s.db.execute(sql`delete from public.answer_audit_log where organization_id=${organizationId}`), { role }),
      error => error.cause?.code === '42501');
    }
  });

  await t.test('JSONB preserves arrays, strings, objects, null and booleans', async () => {
    const created = await task();
    for (const value of [[], [{ role: 'user', content: 'Hello' }], 'quoted "text"', { nested: [1, null] }, null, true, 42]) {
      await run(async s => {
        await s.db.update(agentTasks).set({ transcriptJson: JSON.stringify(value) }).where(eq(agentTasks.id, created.id));
        assert.deepEqual(JSON.parse((await getTask(s, organizationId, created.id)).transcriptJson), value);
      });
    }
  });

  await t.test('an aborted transaction cannot call a provider or report success', async () => {
    for (const external of [false, true]) {
      let called = false;
      await assert.rejects(run(async s => {
        await s.db.execute(sql`select 1 / 0`).catch(() => {});
        if (external) await s.outsideTransaction(async () => { called = true; });
        return 'success';
      }), /rolled back before commit/);
      assert.equal(called, false);
    }
  });

  await t.test('a savepoint recovers SQL failure without poisoning the request', async () => {
    await run(async s => {
      await assert.rejects(s.atomic(() => s.db.execute(sql`select 1 / 0`)));
      assert.equal((await s.db.execute(sql`select 1 as value`)).rows[0].value, 1);
    });
  });

  await t.test('provider boundaries commit first, clear RLS context, and preserve falsy errors', async () => {
    const created = await task();
    await run(async s => {
      assert.equal(await claimTask(s, created.id, 'external-boundary', 'QUEUED'), true);
      let caught = false;
      try {
        await s.outsideTransaction(async () => {
          const row = await administrator.query('select lease_owner from agent_tasks where id=$1', [created.id]);
          assert.equal(row.rows[0].lease_owner, 'external-boundary', 'reservation must already be committed');
          throw null;
        });
      } catch (error) { caught = true; assert.equal(error, null); }
      assert.equal(caught, true);
      assert.equal((await getTask(s, organizationId, created.id)).leaseOwner, 'external-boundary');
    });
  });

  await t.test('concurrent workers claim once; expired or replaced workers cannot checkpoint', async () => {
    const created = await task();
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => run(s => claimTask(s, created.id, `w${i}`, 'QUEUED'))));
    assert.equal(outcomes.filter(Boolean).length, 1);
    const old = await run(s => getTask(s, organizationId, created.id));
    await administrator.query("update agent_tasks set lease_expires_at=now()-interval '1 second' where id=$1", [created.id]);
    assert.equal(await run(s => heartbeat(s, created.id, old.leaseOwner, old.leaseGeneration)), false);
    assert.equal(await run(s => updateTask(s, old, old.leaseOwner, { status: 'COMPLETED' })), false);
    // Reusing an owner name still cannot resurrect an older generation.
    assert.equal(await run(s => claimTask(s, created.id, old.leaseOwner, 'RUNNING')), true);
    assert.equal(await run(s => updateTask(s, old, old.leaseOwner, { status: 'COMPLETED' })), false);
    const current = await run(s => getTask(s, organizationId, created.id));
    assert.equal(current.leaseGeneration, old.leaseGeneration + 1);
  });

  await t.test('cancellation blocks a stale successful result', async () => {
    const created = await task();
    await run(s => claimTask(s, created.id, 'cancel-worker', 'QUEUED'));
    const before = await run(s => getTask(s, organizationId, created.id));
    await run(s => requestCancel(s, organizationId, created.id));
    assert.equal(await run(s => updateTask(s, before, 'cancel-worker', { status: 'COMPLETED' })), false);
    assert.equal(await run(s => updateTask(s, before, 'cancel-worker', { status: 'CANCELLED' })), true);
  });

  await t.test('concurrent audit appends remain continuous and rollback with domain changes', async () => {
    const payloadDigest = await digestPayload({ fixture: true });
    await Promise.all(Array.from({ length: 8 }, () => run(s => appendAuditEvents(s, organizationId,
      [{ kind: 'answer', label: 'audit fixture', payloadDigest, count: 1 }]))));
    const report = await run(s => verifyOrganizationChain(s, organizationId));
    assert.equal(report.verdict.ok, true, JSON.stringify(report));
    const count = (await administrator.query('select count(*) from answer_audit_log where organization_id=$1', [organizationId])).rows[0].count;
    await assert.rejects(run(async s => {
      await appendAuditEvents(s, organizationId, [{ kind: 'answer', label: 'rollback', payloadDigest, count: 1 }]);
      throw new Error('rollback audit');
    }), /rollback audit/);
    assert.equal((await administrator.query('select count(*) from answer_audit_log where organization_id=$1', [organizationId])).rows[0].count, count);
  });

  await t.test('concurrent step appends get distinct sequences', async () => {
    const created = await task();
    const outcomes = await Promise.all(Array.from({ length: 6 }, (_, stepIndex) => run(s => appendStep(s, {
      taskId: created.id, organizationId, stepIndex, kind: 'model_call',
    }))));
    assert.equal(outcomes.filter(Boolean).length, 6);
    const rows = await administrator.query('select sequence from agent_task_steps where task_id=$1 order by sequence', [created.id]);
    assert.deepEqual(rows.rows.map(r => r.sequence), [1, 2, 3, 4, 5, 6]);
  });

  let reservedId;
  await t.test('racing financial reservations cannot exceed the cap and duplicates have one effect', async () => {
    const created = await task();
    const make = idempotencyKey => ({ organizationId, taskId: created.id, stepIndex: 0, toolName: 'issue_payment',
      idempotencyKey, amountCents: 60, currency: 'USD', accountFingerprint: 'fixture', dailyLimitCents: 100 });
    const keys = [randomUUID(), randomUUID()];
    const outcomes = await Promise.all(keys.map(key => run(s => reserveFinancialOperation(s, make(key)))));
    assert.equal(outcomes.filter(r => r.ok).length, 1);
    const winner = outcomes.findIndex(r => r.ok);
    reservedId = outcomes[winner].operation.id;
    const duplicate = await run(s => reserveFinancialOperation(s, make(keys[winner])));
    assert.deepEqual(duplicate, { ok: false, duplicate: true, reason: 'duplicate' });
    const events = await administrator.query('select count(*) from agent_financial_events where operation_id=$1', [outcomes[winner].operation.id]);
    assert.equal(Number(events.rows[0].count), 1);
  });

  await t.test('reconciliation cannot overwrite another worker after a provider response', async subtest => {
    await administrator.query("update agent_financial_operations set external_transaction_id='tr_fixture', next_reconcile_at=now() where id=$1", [reservedId]);
    subtest.mock.method(globalThis, 'fetch', async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      assert.ok(init.signal, 'provider lookup must be bounded');
      await administrator.query("update agent_financial_operations set reconcile_lease_owner='replacement', reconcile_lease_expires_at=now()+interval '1 minute', status='settled', reconciliation_status='matched' where id=$1", [reservedId]);
      return new Response(null, { status: 404 });
    });
    const result = await run(s => reconcileDueFinancialOperations(s, { STRIPE_SECRET_KEY: 'fixture' }));
    assert.deepEqual(result, { checked: 1, matched: 0, discrepancies: 0, deferred: 1 });
    const row = (await administrator.query('select status, reconciliation_status, reconcile_lease_owner from agent_financial_operations where id=$1', [reservedId])).rows[0];
    assert.deepEqual(row, { status: 'settled', reconciliation_status: 'matched', reconcile_lease_owner: 'replacement' });
    assert.equal(Number((await administrator.query('select count(*) from agent_financial_events where operation_id=$1', [reservedId])).rows[0].count), 1);
  });

  // A fixture-owned provider selection bypasses billing, never a real key.
  await administrator.query("update organizations set active_model_provider='fixture' where id=$1", [organizationId]);
  let actorTurns;
  let actorIndex;
  let rejectReview = false;
  globalThis.__MODEL__ = async () => {
    const turn = actorTurns[Math.min(actorIndex++, actorTurns.length - 1)];
    return typeof turn === 'function' ? turn() : turn;
  };
  globalThis.__SEMANTIC_MODEL__ = async (_env, _org, params) => {
    const packet = JSON.parse(params.messages[0].content);
    const source = packet.sources.find(s => !s.failed && s.data && typeof s.data === 'object' && Object.keys(s.data).length);
    const pointer = '/' + Object.keys(source?.data ?? { fixture: true })[0].replaceAll('~', '~0').replaceAll('/', '~1');
    return reply('semantic_verdict', { passed: !rejectReview,
      requirements: [{ requirement: packet.goal, satisfied: !rejectReview, explanation: 'Scripted workflow fixture.', nodeKeys: [] }],
      claims: [{ claim: 'Portfolio records', kind: 'fact', supported: !rejectReview, citations: [{ sourceId: source?.id ?? 'absent', pointer }] }],
      issues: rejectReview ? ['Scripted rejection'] : [],
    });
  };
  const script = (...turns) => { actorTurns = turns; actorIndex = 0; rejectReview = false; };
  const advance = (created, options) => withDbSession(config, { principalId: 'principal_aval_worker',
    actorId: 'principal_aval_worker', organizationId, requestId: randomUUID() },
  s => advanceTask(s, {}, organizationId, created.id, randomUUID(), options), { role: 'aval_worker', verifyCleanContext: true });

  try {
    await t.test('agent workflow: read evidence, review, and persist a final answer', async () => {
      const created = await task();
      script(reply('get_portfolio_metrics', {}), conclusion());
      const result = await advance(created);
      assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
      const saved = await run(s => getTask(s, organizationId, created.id));
      assert.ok(saved.resultJson); assert.equal(saved.leaseOwner, null);
    });
    await t.test('agent workflow: yield after evidence and resume the stored transcript', async () => {
      const created = await task();
      script(reply('get_portfolio_metrics', {}), conclusion());
      assert.equal((await advance(created, { maxStepsThisInvocation: 1 })).status, 'QUEUED');
      const saved = await run(s => getTask(s, organizationId, created.id));
      assert.match(saved.transcriptJson, /tool_result/);
      const result = await advance(created);
      assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
    });
    await t.test('agent workflow: missing evidence cannot produce a final answer', async () => {
      const created = await task(); script(conclusion());
      const result = await advance(created);
      assert.equal(result.status, 'FAILED', JSON.stringify(result));
      assert.equal((await run(s => getTask(s, organizationId, created.id))).resultJson, null);
    });
    await t.test('agent workflow: reviewer rejection is bounded and withholds the result', async () => {
      const created = await task(); script(reply('get_portfolio_metrics', {}), conclusion()); rejectReview = true;
      const result = await advance(created);
      assert.equal(result.status, 'FAILED', JSON.stringify(result));
      assert.equal((await run(s => getTask(s, organizationId, created.id))).resultJson, null);
    });
    await t.test('agent workflow: cancellation during inference prevents proposed actions', async () => {
      const created = await task();
      script(async () => { await run(s => requestCancel(s, organizationId, created.id)); return conclusion(); });
      const result = await advance(created);
      const saved = await run(s => getTask(s, organizationId, created.id));
      assert.equal(result.status, 'CANCELLED', JSON.stringify(result));
      assert.equal(saved.resultJson, null);
    });
    await t.test('agent workflow: lease takeover during inference cannot write the old result', async () => {
      const created = await task();
      script(async () => {
        await administrator.query("update agent_tasks set lease_expires_at=now()-interval '1 second' where id=$1", [created.id]);
        assert.equal(await run(s => claimTask(s, created.id, 'replacement', 'RUNNING')), true);
        return conclusion();
      });
      const result = await advance(created);
      assert.notEqual(result.status, 'COMPLETED');
      const saved = await run(s => getTask(s, organizationId, created.id));
      assert.equal(saved.leaseOwner, 'replacement'); assert.equal(saved.resultJson, null);
      const count = await administrator.query("select count(*) from agent_task_steps where task_id=$1 and kind='model_call'", [created.id]);
      assert.equal(Number(count.rows[0].count), 0, 'stale model response must not enter the current trace');
    });
  } finally {
    delete globalThis.__MODEL__; delete globalThis.__SEMANTIC_MODEL__;
  }
}
