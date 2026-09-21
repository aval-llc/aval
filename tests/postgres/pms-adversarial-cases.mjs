import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { pmsActionFlows, pmsWriteQueue, pmsSeatSenderAddresses } from '../../db/postgres/schema.ts';
import { resolveCapability } from '../../lib/pms/capability.ts';
import { pmsToolAvailability } from '../../lib/pms/assembly.ts';
import { env } from 'cloudflare:workers';
import { withVerifiedIdentityHeaders } from '../../lib/auth/request-identity.ts';
import { GET as sessionGet, POST as sessionPost } from '../../app/api/pms/session/route.ts';

/**
 * An attempt to falsify the claims, rather than to demonstrate them.
 *
 * Everything here is written to fail if the boundary it names is decorative.
 * Two things in particular the rest of the suite does not prove:
 *
 *   - **Isolation at the database, not in a `where` clause.** Every query in
 *     `lib/pms/browser` filters by organization, and every one of them could be
 *     edited tomorrow. These read the new tables through a tenant's own session
 *     using another tenant's exact primary keys, so the guarantee has to come
 *     from row-level security rather than from the caller being careful.
 *   - **Discovery is not authority.** A provider action nobody authorized must
 *     leave the employee without the tool — not with a tool that refuses
 *     politely, which is a worse design because the model plans around having
 *     it.
 */

export async function runPmsAdversarialCases(t, { session, userA, userB, administrator, config }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));
  const other = (work) => session(userB, (s) => work(s, s.identity.organizationId));
  const orgA = await run((_s, o) => o);
  const orgB = await other((_s, o) => o);
  assert.notEqual(orgA, orgB);

  await t.test('a tenant session cannot reach another tenant rows on the provider tables', async () => {
    // Seeded through the administrator connection so the rows genuinely exist
    // and the only thing between them and org A is row-level security.
    const queueId = randomUUID();
    const flowId = randomUUID();
    await administrator.query(
      `INSERT INTO public.pms_write_queue
         (id, organization_id, provider, action, approval_id, flow_id, payload_json,
          idempotency_key, status, attempts, created_at, updated_at)
       VALUES ($1,$2,'appfolio','maintenance.work_order.create',null,null,'{}'::jsonb,$3,'pending',0,now(),now())`,
      [queueId, orgB, `adversarial-${queueId}`],
    );
    await administrator.query(
      // An active workflow names its promoter — the database insists, which is
      // why this fixture has to as well.
      `INSERT INTO public.pms_action_flows
         (id, organization_id, provider, action, version, steps_json, digest, status,
          promoted_by_user_id, promoted_at, consecutive_failures, created_at, updated_at)
       VALUES ($1,$2,'appfolio','maintenance.work_order.create',99,'[]','deadbeef','active',$3,now(),0,now(),now())`,
      [flowId, orgB, userB],
    );

    // Org A asks for org B's rows by their exact primary keys. Guessing the id
    // is not the control; the control is that knowing it changes nothing.
    const queue = await run((s) => s.db.select().from(pmsWriteQueue).where(eq(pmsWriteQueue.id, queueId)));
    assert.equal(queue.length, 0, 'another workspace queued write is not readable by id');

    const flows = await run((s) => s.db.select().from(pmsActionFlows).where(eq(pmsActionFlows.id, flowId)));
    assert.equal(flows.length, 0, 'nor is its approved workflow');

    // And it cannot be taken over by writing to it either.
    const stolen = await run((s) => s.db.update(pmsWriteQueue)
      .set({ status: 'leased', leasedBy: 'attacker' })
      .where(eq(pmsWriteQueue.id, queueId))
      .returning({ id: pmsWriteQueue.id }));
    assert.equal(stolen.length, 0, 'nor leased out from under its owner');

    const after = await administrator.query(
      'SELECT status, leased_by FROM public.pms_write_queue WHERE id = $1', [queueId],
    );
    assert.equal(after.rows[0].status, 'pending', 'the row is untouched');
    assert.equal(after.rows[0].leased_by, null);
  });

  await t.test('an approved sender mailbox is invisible across workspaces', async () => {
    const address = `cross-${randomUUID()}@gmail.com`;
    await administrator.query(
      `INSERT INTO public.pms_seat_sender_addresses
         (organization_id, address, provider_id, added_by, added_at)
       VALUES ($1,$2,'generic_email',$3, now())`,
      [orgB, address, userB],
    );
    const found = await run((s) => s.db.select().from(pmsSeatSenderAddresses)
      .where(eq(pmsSeatSenderAddresses.address, address)));
    assert.equal(found.length, 0, 'a grant made in another workspace is not readable here');
  });

  await t.test('a provider capability the workspace never authorized is not a tool', async () => {
    // The load-bearing distinction, on an action no fixture in this suite
    // authorizes. The provider supports posting a payment and the workspace has
    // said nothing about it, so the employee must not be holding that tool.
    const resolution = await run((s, o) => resolveCapability(s, o, 'appfolio', 'arrears.payment.post'));
    assert.notEqual(resolution.state, 'allow', `an unauthorized capability resolved ${resolution.state}`);

    const availability = await run((s, o) => pmsToolAvailability(s, o, 'maintenance'));
    const offered = availability.providersByTool.get('post_payment') ?? [];
    assert.ok(!offered.includes('appfolio'),
      `an unauthorized write must not be offered for that provider: ${JSON.stringify(offered)}`);
  });

  /* ── the connection surface a customer actually uses ─────────────────── */

  const previousEnv = { ...env };
  env.DATABASE_URL = config.connectionString;
  delete env.HYPERDRIVE;
  try {
    const request = (user, org, method, body, query = '') => new Request(
      `https://app.aval.llc/api/pms/session${query}`,
      {
        method,
        headers: withVerifiedIdentityHeaders(
          new Headers({ 'content-type': 'application/json', cookie: `aval-active-organization=${org}` }),
          { userId: user, email: `${user}@example.test`, displayName: user, emailVerified: true },
        ),
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const post = async (user, org, body) => {
      const response = await sessionPost(request(user, org, 'POST', body), undefined);
      return [response.status, await response.json()];
    };
    const get = async (user, org, query) => {
      const response = await sessionGet(request(user, org, 'GET', null, query), undefined);
      return [response.status, await response.json()];
    };

    await t.test('connecting by signing in records what a login reaches, and grants none of it', async () => {
      const [status, body] = await post(userA, orgA, {
        provider: 'appfolio',
        session: 'ACTIVE',
        discovered: ['maintenance.work_order.create', 'arrears.payment.post'],
        runner: 'a-laptop',
      });
      assert.equal(status, 200);
      assert.ok(body.discovered.includes('arrears.payment.post'), 'the reach is recorded');
      assert.match(body.note, /not permissions/i, 'and said to be reach rather than permission');

      // The load-bearing assertion for this whole screen: a customer who
      // connected must not thereby have authorized anything.
      const resolution = await run((s, o) => resolveCapability(s, o, 'appfolio', 'arrears.payment.post'));
      assert.notEqual(resolution.state, 'allow', `connecting granted ${resolution.state}`);
      const availability = await run((s, o) => pmsToolAvailability(s, o, 'maintenance'));
      assert.ok(!(availability.providersByTool.get('post_payment') ?? []).includes('appfolio'),
        'and no tool appeared because a session could reach it');
    });

    await t.test('the connection reports its session state to the customer', async () => {
      const [status, body] = await get(userA, orgA, '?provider=appfolio');
      assert.equal(status, 200);
      assert.equal(body.connected, true);
      assert.equal(body.accessMode, 'customer_desktop_session', 'the access mode is a real thing, not a label');
      assert.equal(body.session.state, 'CONNECTED');
      assert.ok(body.session.lastVerifiedAt, 'dated by a session that actually worked');
    });

    await t.test('a lapsed session is recorded as lapsed, not as disconnected', async () => {
      const [, body] = await post(userA, orgA, { provider: 'appfolio', session: 'EXPIRED' });
      assert.equal(body.session.state, 'SESSION_EXPIRED');
      const [, view] = await get(userA, orgA, '?provider=appfolio');
      assert.equal(view.connected, true, 'a closed laptop has not disconnected the PMS');
    });

    await t.test('the route refuses what it cannot honestly accept', async () => {
      // A provider whose writes do not run on the customer's machine has no
      // desktop session to establish.
      assert.equal((await get(userA, orgA, '?provider=doorloop'))[0], 404);
      assert.equal((await post(userA, orgA, { provider: 'doorloop', session: 'ACTIVE' }))[0], 404);
      // "Nearly signed in" is not a state this path has.
      assert.equal((await post(userA, orgA, { provider: 'appfolio', session: 'PROBABLY_FINE' }))[0], 422);
    });

    await t.test('one workspace cannot connect on behalf of another', async () => {
      await post(userB, orgB, { provider: 'appfolio', session: 'PERMISSION_DENIED' });
      const [, mine] = await get(userA, orgA, '?provider=appfolio');
      assert.equal(mine.session.state, 'SESSION_EXPIRED',
        "another workspace's session state must not overwrite this one");
    });
  } finally {
    Object.assign(env, previousEnv);
  }
}
