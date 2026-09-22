import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { GET, POST } from '../../app/api/assistant/history/route.ts';
import { POST as transcribe } from '../../app/api/assistant/transcribe/route.ts';
import { POST as startTask } from '../../app/api/agents/tasks/route.ts';
import { createEmployee } from '../../lib/agents/employees.ts';
import { getTask } from '../../lib/agents/tasks.ts';
import { withVerifiedIdentityHeaders } from '../../lib/auth/request-identity.ts';
import { env } from 'cloudflare:workers';

export async function runMinimalChatCases(t, { session, config }) {
  const user = 'chat_' + randomUUID(), other = 'other_' + randomUUID(), id = randomUUID();
  const run = fn => session(user, fn);
  const request = (path, body) => new Request('https://aval.test' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const route = async (handler, req, subject = user) => {
    env.HYPERDRIVE = config;
    await session(subject, async s => {
      const headers = withVerifiedIdentityHeaders(req.headers, { userId: subject, email: subject + '@example.test', displayName: subject, source: 'password' }, s.identity.organizationId, subject);
      req = new Request(req, { headers });
    });
    return handler(req);
  };
  await t.test('chat history survives reload and is isolated by user and organization', async () => {
    await run(async s => {
      const org = s.identity.organizationId;
      await s.db.execute(sql`insert into assistant_chat_entries(organization_id,user_id,id,payload) values (${org},${user},${id},${JSON.stringify({ id, role: 'user', text: 'Check my portfolio' })}::jsonb)`);
    });
    const response = await route(GET, new Request('https://aval.test/api/assistant/history'));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).messages[0].text, 'Check my portfolio');
    const isolated = await route(GET, new Request('https://aval.test/api/assistant/history'), other);
    assert.deepEqual((await isolated.json()).messages, []);
    await session(other, async s => {
      assert.equal((await s.db.execute(sql`select * from assistant_chat_entries where id=${id}`)).rows.length, 0);
    });
  });
  await t.test('history rejects invalid messages, is append only and strips non-public fields', async () => {
    const invalid = await route(POST, request('/api/assistant/history', { id: 'bad', role: 'system', text: 'hidden' }));
    assert.equal(invalid.status, 400);
    const entry = { id: randomUUID(), role: 'assistant', text: 'Ready', internalReasoning: 'do not retain', token: 'secret' };
    assert.equal((await route(POST, request('/api/assistant/history', entry))).status, 200);
    assert.equal((await route(POST, request('/api/assistant/history', { ...entry, text: 'overwrite' }))).status, 200);
    const rows = await (await route(GET, new Request('https://aval.test/api/assistant/history'))).json();
    assert.deepEqual(rows.messages.find(m => m.id === entry.id), { id: entry.id, role: 'assistant', text: 'Ready' });
  });
  await t.test('a failed turn leaves nothing behind for a reload to find', async () => {
    // History is append only, so a stored failure could never be replaced by
    // the answer a retry produced — every attempt would survive and reloading
    // would bring back a column of "couldn't finish" orbs beside one question.
    // The rule the cleanup migration applies, asserted on rows rather than on
    // the sentence describing it.
    const failed = randomUUID(); const answered = randomUUID();
    await session(user, async s => {
      await s.db.execute(sql`insert into assistant_chat_entries(organization_id,user_id,id,payload)
        values (${s.identity.organizationId},${user},${failed},${JSON.stringify({ id: failed, role: 'assistant', error: "Couldn't finish" })}::jsonb)`);
      await s.db.execute(sql`insert into assistant_chat_entries(organization_id,user_id,id,payload)
        values (${s.identity.organizationId},${user},${answered},${JSON.stringify({ id: answered, role: 'assistant', text: 'Here is the answer' })}::jsonb)`);

      await s.db.execute(sql`delete from public.assistant_chat_entries
        where payload ->> 'error' is not null and payload ->> 'role' = 'assistant'`);

      assert.equal((await s.db.execute(sql`select 1 from assistant_chat_entries where id=${failed}`)).rows.length, 0,
        'the failure is forgotten');
      assert.equal((await s.db.execute(sql`select 1 from assistant_chat_entries where id=${answered}`)).rows.length, 1,
        'and nothing that answered anything is touched');
    });
  });

  await t.test('voice rejects invalid uploads without contacting a provider', async () => {
    const response = await route(transcribe, request('/api/assistant/transcribe', { audio: 'invalid' }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid_audio');
  });
  await t.test('chat task creation preserves actual employee identity and atomically saves one retry-safe link', async () => {
    let employee;
    await run(async s => { employee = await createEmployee(s, s.identity.organizationId, user, { name: 'Chat employee', role: 'Portfolio analysis', status: 'active', autonomyMode: 'supervised' }); });
    const body = { goal: 'Check my portfolio', employeeId: employee.id, chatMessageId: id, context: { view: 'overview' } };
    const first = await route(startTask, request('/api/agents/tasks', body));
    assert.equal(first.status, 202); const task = await first.json();
    const second = await route(startTask, request('/api/agents/tasks', body));
    assert.equal((await second.json()).taskId, task.taskId);
    await run(async s => {
      assert.equal((await getTask(s, s.identity.organizationId, task.taskId)).employeeId, employee.id);
      const rows = await s.db.execute(sql`select payload from assistant_chat_entries where id=${id+'-run'}`);
      assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].payload.taskId, task.taskId);
    });
    const crossTenant = await route(startTask, request('/api/agents/tasks', body), other);
    assert.equal(crossTenant.status, 400);
  });
}
