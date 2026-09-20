import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agentApprovals, integrationConnections } from '../../db/postgres/schema.ts';
import { seedWorkspaceEmployees, assignEmployeeForWork } from '../../lib/agents/expertise.ts';
import { intakeEvent } from '../../lib/agents/intake.ts';
import { createTask, getTask } from '../../lib/agents/tasks.ts';
import { executeApprovedTool } from '../../lib/agents/executor.ts';
import { requestApproval } from '../../lib/agents/approvals.ts';
import { getTool } from '../../lib/agents/registry.ts';
import { payloadHash } from '../../lib/agents/canonical-payload.ts';
import { resolveCapability } from '../../lib/pms/capability.ts';
import { discoverGrants } from '../../lib/pms/grants.ts';
import { activateFlow, recordFlow } from '../../lib/pms/flows.ts';
import { BrowserSimulator } from '../../lib/pms/browser/simulator.ts';
import { clearBrowserAdapters, registerBrowserAdapter } from '../../lib/pms/browser/adapter.ts';
import { drainOneWrite } from '../../lib/pms/browser/drain.ts';
import { readConnectionHealth } from '../../lib/pms/browser/health.ts';

/**
 * The customer experience this whole path exists to unlock.
 *
 * A management company with no PMS API integration connects the system their
 * team already uses, by signing into it on their own computer. Aval discovers
 * what that login can reach, the customer grants a subset, and an AI employee
 * then takes a resident's problem all the way to a verified work order inside
 * the customer's PMS — without Aval ever holding a PMS credential.
 *
 * Every step below is the production path. The provider is simulated and says
 * nothing about any real system; the certification for this work stays
 * `SIMULATOR_E2E_TESTED`.
 */

const PROVIDER = 'appfolio';
const ACTION = 'maintenance.work_order.create';

const STEPS = [
  { kind: 'open', page: 'Maintenance' },
  { kind: 'click', button: 'New Work Order' },
  { kind: 'fill', label: 'Unit', from: 'unit' },
  { kind: 'fill', label: 'Description', from: 'description' },
  { kind: 'click', button: 'Create Work Order' },
  { kind: 'capture', label: 'Work Order #', as: 'externalId' },
];

export async function runPmsJourneyCases(t, { session, administrator, propertyId }) {
  // A brand-new workspace, so "before connecting anything" is a real state
  // rather than whatever a previous file left behind.
  const customer = `user_${randomUUID()}`;
  const run = (work) => session(customer, (s) => work(s, s.identity.organizationId));
  const org = await run((_s, organizationId) => organizationId);

  const provider = new BrowserSimulator(PROVIDER, [ACTION]);
  clearBrowserAdapters();
  registerBrowserAdapter(provider);

  await t.test('1. a new workspace has a team and no PMS at all', async () => {
    assert.ok(await run((s, o) => seedWorkspaceEmployees(s, o, customer)) > 0, 'the starting team arrives');

    const connections = await run((s, o) => s.db.select().from(integrationConnections)
      .where(eq(integrationConnections.organizationId, o)));
    assert.equal(connections.length, 0, 'and nothing is connected');

    const before = await run((s, o) => resolveCapability(s, o, PROVIDER, ACTION));
    assert.notEqual(before.state, 'allow', 'so nothing can be written to a PMS yet');
  });

  await t.test('2. the customer connects the PMS by signing in on their own computer', async () => {
    // No password, no authenticator seed, no field for either. The connection
    // records that a device holds an authorized session; the customer created
    // that session themselves on the provider's own page.
    provider.signIn();
    await run(async (s, o) => {
      const now = new Date();
      await s.db.insert(integrationConnections).values({
        id: randomUUID(), organizationId: o, provider: PROVIDER, category: 'property',
        status: 'connected', authMode: 'customer_desktop_session',
        metadataJson: JSON.stringify({}),
        createdBy: customer, createdAt: now, updatedAt: now,
      });
    });

    const health = await run((s, o) => readConnectionHealth(s, o, PROVIDER));
    assert.equal(health.state, 'SESSION_REQUIRED', 'a fresh connection has not been used yet');
  });

  await t.test('3. Aval discovers what that login can actually reach', async () => {
    // Discovery reports facts and enables nothing. Finding that the session can
    // create work orders is not permission to create one.
    const grants = await run((s, o) => discoverGrants(s, o, PROVIDER));
    assert.ok(grants.probed, 'the session answered');
    assert.ok(grants.available.includes(ACTION), 'and this login can reach work-order creation');

    const stillOff = await run((s, o) => resolveCapability(s, o, PROVIDER, ACTION));
    assert.notEqual(stillOff.state, 'allow', 'discovering a capability does not grant it');
  });

  await t.test('4. the customer grants a subset, and Aval records a workflow', async () => {
    await administrator.query(
      `INSERT INTO public.pms_write_authorizations
         (id, organization_id, provider, action, status, signed_authorization,
          authorization_reference, version, approved_by_user_id, approved_at,
          created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'approved',true,'customer-signed',1,$5,now(),$5,now(),now())`,
      [randomUUID(), org, PROVIDER, ACTION, customer],
    );

    const recorded = await run((s, o) => recordFlow(s, o, PROVIDER, ACTION, STEPS, customer));
    await run((s, o) => activateFlow(s, o, recorded.id));

    const ready = await run((s, o) => resolveCapability(s, o, PROVIDER, ACTION));
    assert.equal(ready.state, 'allow');
    assert.equal(ready.runner, 'desktop', "and it runs on the customer's machine, not in Aval's cloud");
  });

  let task = null;
  await t.test('5. a resident reports a problem and an employee owns it', async () => {
    const intake = await run((s, o) => intakeEvent(s, {
      organizationId: o, source: 'email', sourceId: `resident-${randomUUID()}`,
      trustState: 'verified',
      goal: 'Resolve the reported heating failure in unit 12B until it is verified fixed',
    }));
    assert.equal(intake.status, 'created', 'the resident event becomes durable work');

    task = intake.task;
    assert.ok(task?.id, 'and the work exists, owned by the coordinator and queued');
    assert.equal(task.status, 'QUEUED');

    // The coordinator scored the team rather than picking by name.
    const assigned = await run((s, o) => assignEmployeeForWork(s, o, {
      objective: 'heating failure, resident reported, needs a repair',
      domains: ['maintenance'],
    }));
    assert.ok(assigned, 'somebody on this team is equipped for a repair');
    assert.match(assigned.role, /Maintenance|Resident/);
  });

  let child = null;
  await t.test('6. the coordinator delegates the repair to the employee that owns it', async () => {
    // The intake task is a root planner: it manages the plan and does no
    // operational work itself. That is a product rule, not a test detail — the
    // write has to happen in a checked child task owned by the employee, so
    // the thing that acted and the thing that is accountable are the same row.
    child = await run((s, o) => createTask(s, {
      organizationId: o, userId: customer, agentId: 'maintenance',
      parentTaskId: task.id, delegationDepth: 1,
      goal: 'Raise and verify a work order for the heating failure in 12B',
      check: { kind: 'evidence', tools: ['get_maintenance_performance'] },
    }));
    assert.equal(child.parentTaskId, task.id, 'the child belongs to the resident objective');
  });

  await t.test("7. the employee creates the work order through the customer's own session", async () => {
    provider.reset();
    provider.signIn();

    const args = { provider: PROVIDER, property_id: propertyId, summary: 'No heat in 12B', priority: 'emergency' };
    const approval = await run(async (s, o) => {
      const requested = await requestApproval(s, {
        taskId: child.id, organizationId: o, stepIndex: 0, tool: getTool('create_work_order'),
        evidence: { toolUseId: 'toolu_journey', payloadHash: await payloadHash(args) },
      });
      await s.db.update(agentApprovals)
        .set({ status: 'approved', approvalsReceived: 1, decidedAt: new Date(), decidedByUserId: customer })
        .where(eq(agentApprovals.id, requested.id));
      return requested;
    });
    assert.ok(approval.id);

    const outcome = await run((s, o) => executeApprovedTool(s, {
      toolName: 'create_work_order', args,
      subject: { organizationId: o, userId: customer, isGuest: false },
      context: { personaId: 'maintenance', delegationDepth: 0 },
      task: { id: child.id, stepIndex: 0, approvalId: approval.id, policyVersion: approval.policyVersion },
    }));

    // Queued, and reported as queued. A property manager whose laptop is closed
    // has not had their work order created.
    const reported = JSON.stringify(outcome.result ?? outcome);
    assert.match(reported, /queued|desktop runner/i, `a ui write is queued, not claimed done: ${reported}`);
    assert.equal(provider.external.length, 0, 'nothing has reached the provider yet');
  });

  await t.test('8. the desktop runner carries it out and Aval verifies it', async () => {
    const drained = await run((s, o) => drainOneWrite(s, o, 'the-customers-laptop'));
    assert.equal(drained.status, 'done', 'executed and read back at the provider');
    assert.ok(drained.externalId, "with the provider's own identifier");
    assert.equal(drained.connection, 'CONNECTED');

    assert.equal(provider.external.length, 1, 'exactly one work order exists in the PMS');
    assert.equal(provider.submits, 1);

    const health = await run((s, o) => readConnectionHealth(s, o, PROVIDER));
    assert.ok(health.lastVerifiedAt, 'and the connection is dated by a completed operation');
  });

  await t.test("9. the work is still Aval's to finish", async () => {
    // The PMS record is evidence toward the objective, not the objective. The
    // resident still has no heat until somebody verifies the repair, and the
    // work item is what carries that.
    const current = await run((s, o) => getTask(s, o, task.id));
    assert.ok(current, 'the work survived the provider round trip');
    assert.ok(!['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status),
      `a created work order does not finish the objective (was ${current.status})`);
  });

  clearBrowserAdapters();
}
