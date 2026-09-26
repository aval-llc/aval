import './integration/module-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NextIntlClientProvider} from 'next-intl';
import {readFile} from 'node:fs/promises';
const {belongsToAgent} = await import('../app/components/agent-library-model.ts');
const {EmployeeDirectory} = await import('../app/components/employee-directory.tsx');
const {PERSONA_PRESETS} = await import('../app/components/agent-avatar/personas.ts');
const {LEADS} = await import('../lib/agents/organization/domains.ts');

test('employee work stays in its own folder even when it uses a built-in persona', () => {
  const task = {agentId:'maintenance', employeeId:'jeff'};
  assert.equal(belongsToAgent(task, 'jeff', true), true);
  assert.equal(belongsToAgent(task, 'maintenance', false), false);
  assert.equal(belongsToAgent(task, 'another-employee', true), false);
  assert.equal(belongsToAgent({agentId:'maintenance'}, 'maintenance', false), true);
  assert.equal(belongsToAgent({agentId:'custom-role'}, 'custom-role', false), true);
  assert.equal(belongsToAgent({agentId:'jeff'}, 'jeff', true), false);
});
for (const locale of ['en','es-mx']) test(`library renders Aval One and every Lead at first paint, with accessible creation/search, in ${locale}`, async () => {
  const messages = JSON.parse(await readFile(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'));
  const html = renderToStaticMarkup(React.createElement(NextIntlClientProvider,{locale,messages,timeZone:'UTC'},React.createElement(EmployeeDirectory)));
  // Aval One and the 22 Leads, before any request completes. The historical
  // agents are among them under their own names' successors.
  assert.equal((html.match(/class="agent-folder folder-color-/g)??[]).length, 1 + LEADS.length);
  assert.equal(LEADS.filter(lead => lead.legacyPersonaId).length, Object.keys(PERSONA_PRESETS).length - 1);
  for (const lead of LEADS) assert.ok(html.includes(lead.name.replace('&', '&amp;')), `${lead.name} renders`);
  assert.ok(html.includes(messages.AgentLibrary.newAgent));
  assert.ok(html.includes(`aria-label="${messages.Employees.searchPlaceholder}"`));
  assert.doesNotMatch(html, /<textarea|No AI employees yet/);
});
