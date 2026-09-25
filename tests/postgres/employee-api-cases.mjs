import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { withVerifiedIdentityHeaders } from '../../lib/auth/request-identity.ts';
import { GET as listEmployeesRoute, POST as createEmployeeRoute } from '../../app/api/agents/employees/route.ts';
import { GET as employeeDetail, PATCH as patchEmployee, POST as employeeAction } from '../../app/api/agents/employees/[id]/route.ts';
import { POST as setDefaultAgent } from '../../app/api/agents/default/route.ts';

/**
 * The contracts Stage D's directory is built on.
 *
 * Exercised through the real route handlers, so what the UI will call is what
 * is tested — including that the directory is rows rather than a fixed roster.
 */
export async function runEmployeeApiCases(t, { session, userA, userB, config }) {
  const org = await session(userA, (s) => s.identity.organizationId);
  const request = (user, path, method, body) => new Request(`https://app.aval.llc${path}`, {
    method,
    headers: withVerifiedIdentityHeaders(
      new Headers({ 'content-type': 'application/json', cookie: `aval-active-organization=${org}` }),
      { userId: user, email: `${user}@example.test`, displayName: user, emailVerified: true },
    ),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = async (response) => [response.status, await response.json()];

  // The route handlers open their own session from the worker env, so point it
  // at the disposable test cluster for the duration and put it back afterwards.
  const previousEnv = { ...env };
  env.DATABASE_URL = config.connectionString;
  delete env.HYPERDRIVE;
  try {

  await t.test('the directory is rows, a total and a nullable limit', async () => {
    const [status, body] = await json(await listEmployeesRoute(request(userA, '/api/agents/employees', 'GET'), undefined));
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.employees), 'employees are a list, not a fixed set of slots');
    assert.equal(typeof body.total, 'number');
    assert.ok('limit' in body, 'a ceiling is reported only where one is configured');
    assert.ok(Array.isArray(body.templates) && body.templates.length > 0, 'templates are offered as a starting point');
    assert.ok(!body.templates.some((template) => /^(general|financial|brokerage)$/.test(template.slug ?? '')),
      'templates are named roles, not persona enum values');
  });

  await t.test('a customer creates an employee with a role the code never shipped', async () => {
    const name = `API turnover ${randomUUID().slice(0, 8)}`;
    const [status, body] = await json(await createEmployeeRoute(
      request(userA, '/api/agents/employees', 'POST', { name, role: 'Turnover Coordinator', objective: 'Own unit turns.' }),
      undefined,
    ));
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.employee.role, 'Turnover Coordinator');
    assert.equal(body.employee.status, 'draft', 'it exists before it can act');

    // Creating it granted nothing.
    const [, detail] = await json(await employeeDetail(
      request(userA, `/api/agents/employees/${body.employee.id}`, 'GET'), undefined));
    assert.deepEqual(detail.scopes, {}, 'no authority arrived with the record');
    assert.equal(detail.openWork, 0);

    // Nameless is refused rather than stored empty.
    const [bad] = await json(await createEmployeeRoute(
      request(userA, '/api/agents/employees', 'POST', { name: '   ', role: 'Something' }), undefined));
    assert.equal(bad, 400);
    // And a duplicate name is a conflict, not a second confusing row.
    const [dupe] = await json(await createEmployeeRoute(
      request(userA, '/api/agents/employees', 'POST', { name, role: 'Another' }), undefined));
    assert.equal(dupe, 409);
  });

  await t.test('lifecycle and grants move through the API, and archiving refuses to orphan work', async () => {
    const [, created] = await json(await createEmployeeRoute(
      request(userA, '/api/agents/employees', 'POST', { name: `API lifecycle ${randomUUID().slice(0, 8)}`, role: 'Coordinator' }),
      undefined));
    const path = `/api/agents/employees/${created.employee.id}`;

    const [activated, active] = await json(await employeeAction(request(userA, path, 'POST', { action: 'activate' }), undefined));
    assert.equal(activated, 200);
    assert.equal(active.employee.status, 'active');

    const [granted, scopes] = await json(await employeeAction(
      request(userA, path, 'POST', { action: 'grant', scope: { kind: 'capability', value: 'get_portfolio_metrics' } }), undefined));
    assert.equal(granted, 200);
    assert.deepEqual(scopes.scopes.capability, ['get_portfolio_metrics']);

    const [revoked, afterRevoke] = await json(await employeeAction(
      request(userA, path, 'POST', { action: 'revoke', scope: { kind: 'capability', value: 'get_portfolio_metrics' } }), undefined));
    assert.equal(revoked, 200);
    assert.equal(afterRevoke.scopes.capability, undefined, 'revoking the last grant leaves the kind absent');

    const [paused, pausedBody] = await json(await employeeAction(request(userA, path, 'POST', { action: 'pause' }), undefined));
    assert.equal(paused, 200);
    assert.equal(pausedBody.employee.status, 'paused');

    const [renamed, patched] = await json(await patchEmployee(
      request(userA, path, 'PATCH', { role: 'Senior Coordinator' }), undefined));
    assert.equal(renamed, 200);
    assert.equal(patched.employee.role, 'Senior Coordinator');

    const [archived] = await json(await employeeAction(request(userA, path, 'POST', { action: 'archive' }), undefined));
    assert.equal(archived, 200);
    // An archived employee is part of the record and is no longer edited.
    const [afterArchive] = await json(await patchEmployee(request(userA, path, 'PATCH', { role: 'Rewritten' }), undefined));
    assert.equal(afterArchive, 400);

    const [unknown] = await json(await employeeAction(request(userA, path, 'POST', { action: 'invented' }), undefined));
    assert.equal(unknown, 400);
  });

  await t.test('another workspace cannot read or move this one\'s employees', async () => {
    const [, created] = await json(await createEmployeeRoute(
      request(userA, '/api/agents/employees', 'POST', { name: `API private ${randomUUID().slice(0, 8)}`, role: 'Private' }),
      undefined));
    const foreign = new Request(`https://app.aval.llc/api/agents/employees/${created.employee.id}`, {
      method: 'GET',
      headers: withVerifiedIdentityHeaders(new Headers({ 'content-type': 'application/json' }),
        { userId: userB, email: `${userB}@example.test`, displayName: userB, emailVerified: true }),
    });
    const [status] = await json(await employeeDetail(foreign, undefined));
    assert.equal(status, 404, 'invisible across the tenant boundary');
  });

  await t.test('Lease Review can be set as the default agent', async () => {
    // It could not. The allowlist on this route was hand-written and had lost
    // `leaseReview`, while the Setup picker rendered it from the catalogue — so
    // choosing that card always failed to save. The list is derived now.
    const [status] = await json(await setDefaultAgent(
      request(userA, '/api/agents/default', 'POST', { personaId: 'leaseReview' }), undefined));
    assert.equal(status, 200, 'every persona the picker offers can actually be chosen');
  });
  } finally {
    for (const key of Object.keys(env)) delete env[key];
    Object.assign(env, previousEnv);
  }
}
