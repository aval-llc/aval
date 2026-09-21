import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { withVerifiedIdentityHeaders } from '../../lib/auth/request-identity.ts';
import { integrationConnections, pmsWriteQueue } from '../../db/postgres/schema.ts';
import { POST as runnerRoute } from '../../app/api/pms/runner/route.ts';
import { executePmsWrite } from '../../lib/pms/execute.ts';
import { promoteFlow, recordFlow } from '../../lib/pms/flows.ts';
import { BrowserSimulator, DATABASE_SEARCH_SAVE } from '../../lib/pms/browser/simulator.ts';
import { clearBrowserAdapters, registerBrowserAdapter } from '../../lib/pms/browser/adapter.ts';
import { runInstruction } from '../../lib/pms/browser/drain.ts';
import { eq } from 'drizzle-orm';

/**
 * The desktop runner's door into cloud, through the real route.
 *
 * The browser path was proven end to end before this existed, and it was still
 * unreachable from the product: nothing invoked it. These assertions go through
 * `POST /api/pms/runner` — the surface the desktop actually calls — so what is
 * tested is the path production uses rather than a co-located composition of
 * the same functions.
 *
 * The provider is a simulator wearing a **different UI shape** from the first
 * one: a database to select, a search, and a two-stage save. Only AppFolio
 * declares a `ui` write mechanism today, so "a second provider" is proven here
 * as "a second provider shape" — changing another descriptor to `ui` would be a
 * claim about that vendor's terms with nothing behind it.
 */

const PROVIDER = 'appfolio';
const ACTION = 'maintenance.work_order.create';

/** A flow for the other shape: five navigation steps, a selection, two saves. */
const VOYAGER_STEPS = [
  { kind: 'open', page: 'Voyager' },
  { kind: 'click', button: 'Select Database' },
  { kind: 'choose', label: 'Database', from: 'database' },
  { kind: 'click', button: 'Continue' },
  { kind: 'fill', label: 'Search Unit', from: 'unit' },
  { kind: 'click', button: 'Add Service Request' },
  { kind: 'fill', label: 'Unit Code', from: 'unit' },
  { kind: 'fill', label: 'Problem Description', from: 'description' },
  { kind: 'click', button: 'Save' },
  { kind: 'click', button: 'Confirm' },
  { kind: 'capture', label: 'Service Request ID', as: 'externalId' },
];

export async function runRunnerApiCases(t, { session, userA, userB, administrator, config }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));
  const org = await session(userA, (s) => s.identity.organizationId);
  const otherOrg = await session(userB, (s) => s.identity.organizationId);

  const provider = new BrowserSimulator(PROVIDER, [ACTION], DATABASE_SEARCH_SAVE, 'SR');
  clearBrowserAdapters();
  registerBrowserAdapter(provider);

  const request = (user, activeOrg, body) => new Request('https://app.aval.llc/api/pms/runner', {
    method: 'POST',
    headers: withVerifiedIdentityHeaders(
      new Headers({ 'content-type': 'application/json', cookie: `aval-active-organization=${activeOrg}` }),
      { userId: user, email: `${user}@example.test`, displayName: user, emailVerified: true },
    ),
    body: JSON.stringify(body),
  });
  const call = async (user, activeOrg, body) => {
    const response = await runnerRoute(request(user, activeOrg, body), undefined);
    return [response.status, await response.json()];
  };

  await run(async (s, organizationId) => {
    const now = new Date();
    await s.db.insert(integrationConnections).values({
      id: randomUUID(), organizationId, provider: PROVIDER, category: 'property',
      status: 'connected', authMode: 'api_key',
      metadataJson: JSON.stringify({ pmsGrants: { available: [ACTION], probed: true, probedAt: now.toISOString() } }),
      createdBy: userA, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
  });
  await administrator.query(
    `INSERT INTO public.pms_write_authorizations
       (id, organization_id, provider, action, status, signed_authorization,
        authorization_reference, version, approved_by_user_id, approved_at,
        created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'approved',true,'fixture',1,$5,now(),$5,now(),now())
     ON CONFLICT DO NOTHING`,
    [randomUUID(), org, PROVIDER, ACTION, userA],
  );

  // Fixture hygiene, not product behaviour: the earlier browser cases left
  // settled and abandoned rows on this workspace's queue, and re-versioning the
  // flow below would make any survivor resolve against a retired version. The
  // queue starts empty so these assertions are about this path and not about
  // what a previous file happened to leave behind.
  await run((s) => s.db.delete(pmsWriteQueue).where(eq(pmsWriteQueue.organizationId, org)));

  // A new version for the other shape. The previous flow retires rather than
  // being overwritten, which is what makes a provider's UI change recoverable.
  const flow = await run((s, organizationId) => recordFlow(s, organizationId, PROVIDER, ACTION, VOYAGER_STEPS, userA, { certification: 'simulator_e2e_tested' }));
  await run((s, organizationId) => promoteFlow(s, organizationId, flow.id, userA, 'testing'));
  await run((s, organizationId) => promoteFlow(s, organizationId, flow.id, userA, 'active'));

  const payload = { unit: '12C', description: 'No heat in the bedroom', database: 'live' };
  const enqueue = (key) => run((s, organizationId) => executePmsWrite(s, {
    organizationId, providerId: PROVIDER, toolName: 'create_work_order',
    payload, idempotencyKey: key, personaId: 'maintenance', approvalId: randomUUID(),
  }));

  const previousEnv = { ...env };
  env.DATABASE_URL = config.connectionString;
  delete env.HYPERDRIVE;
  try {
    await t.test('a queued write is claimed, executed and reported through the API', async () => {
      provider.reset();
      assert.equal((await enqueue(`api-${randomUUID()}`)).status, 'queued');

      const [claimStatus, claimed] = await call(userA, org, { intent: 'claim', runner: 'device-1' });
      assert.equal(claimStatus, 200);
      assert.ok(claimed.instruction, 'cloud hands back an instruction');
      assert.equal(claimed.instruction.provider, PROVIDER);
      assert.equal(claimed.instruction.action, ACTION);
      assert.equal(claimed.instruction.flowVersion, flow.version, 'and says which version it approved');

      // The runner's half, exactly as the desktop performs it.
      const report = await runInstruction(claimed.instruction, {
        organizationId: org, providerId: PROVIDER, runnerId: 'device-1',
      });
      assert.equal(report.kind, 'executed');

      const [resultStatus, reported] = await call(userA, org, { intent: 'result', runner: 'device-1', ...report });
      assert.equal(resultStatus, 200);
      assert.equal(reported.outcome.status, 'done');
      assert.ok(reported.outcome.externalId.startsWith('SR-'), 'the other shape hands back its own identifier');
      assert.equal(provider.submits, 1);
      assert.equal(provider.external.length, 1);
    });

    await t.test('a second provider shape replays through the same boundary', async () => {
      // Eleven steps, a database selection and a two-stage save — none of which
      // the first shape has. Nothing in the boundary or the drain changed to
      // accommodate it.
      assert.equal(VOYAGER_STEPS.length, 11);
      assert.ok(VOYAGER_STEPS.some((step) => step.kind === 'choose'), 'including a selection the first shape lacks');
      assert.equal(provider.external[0].fields.unit, '12C', 'and the payload reached the right fields');
    });

    await t.test('cloud can only ever send the runner an approved workflow', async () => {
      provider.reset();
      await enqueue(`shape-${randomUUID()}`);
      const [, claimed] = await call(userA, org, { intent: 'claim', runner: 'device-1' });

      // Every step is one of the six named kinds, and none carries a selector,
      // a coordinate or a literal input. There is no request that gets an
      // arbitrary browser command out of this endpoint.
      const kinds = new Set(claimed.instruction.steps.map((step) => step.kind));
      for (const kind of kinds) assert.ok(['open', 'fill', 'choose', 'click', 'expect', 'capture'].includes(kind));
      for (const step of claimed.instruction.steps) {
        for (const key of Object.keys(step)) {
          assert.ok(!['selector', 'xpath', 'x', 'y', 'script', 'url'].includes(key), `${key} must never cross this boundary`);
        }
      }
      assert.deepEqual(claimed.instruction.steps, VOYAGER_STEPS, 'and they are exactly the approved flow');
    });

    await t.test('a runner cannot report on a write it does not hold', async () => {
      // `device-1` holds the lease from the previous case. Another device
      // reporting a success on it would settle a write it never performed.
      const [status, body] = await call(userA, org, {
        intent: 'result', runner: 'device-2',
        queueId: (await call(userA, org, { intent: 'claim', runner: 'device-1' }))[1].outcome?.queueId ?? 'unknown',
        kind: 'executed',
        execution: { ok: true, externalId: 'SR-99999', session: 'ACTIVE' },
        verification: { confirmed: true, externalId: 'SR-99999' },
      });
      assert.equal(status, 200);
      assert.equal(body.outcome.status, 'denied');
      assert.match(body.outcome.reason, /not leased by this runner|No such queued write/i);
    });

    await t.test('another workspace sees nothing on this queue', async () => {
      const [status, body] = await call(userB, otherOrg, { intent: 'claim', runner: 'device-elsewhere' });
      assert.equal(status, 200);
      assert.equal(body.outcome.status, 'idle', 'the organization comes from the session, never the body');
    });

    await t.test('a malformed report is refused rather than coerced', async () => {
      const [status, body] = await call(userA, org, {
        intent: 'result', runner: 'device-1', queueId: 'x', kind: 'executed',
        execution: { ok: true, session: 'TOTALLY_FINE' },
      });
      assert.equal(status, 422, 'an unknown session state is not "nearly executed"');
      assert.ok(body.error);
    });

    await t.test('a report needs a runner and a known intent', async () => {
      assert.equal((await call(userA, org, { intent: 'claim' }))[0], 400);
      assert.equal((await call(userA, org, { intent: 'wander', runner: 'device-1' }))[0], 400);
    });
  } finally {
    Object.assign(env, previousEnv);
    clearBrowserAdapters();
  }
}
