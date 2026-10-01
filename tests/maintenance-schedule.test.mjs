import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceSchedule} from '../evals/maintenance/schedule.mjs';
import {maintenanceScenarios} from '../evals/maintenance/scenarios.mjs';
test('evaluation reaches every risk class before any repetition',()=>{
  const runs=maintenanceSchedule(maintenanceScenarios);
  assert.deepEqual(runs.slice(0,maintenanceScenarios.length).map(r=>r.scenario.id),maintenanceScenarios.map(s=>s.id));
  assert.ok(runs.slice(0,maintenanceScenarios.length).every(r=>r.repetition===1));
  assert.equal(runs.length,maintenanceScenarios.reduce((n,s)=>n+s.repetitions,0));
  assert.throws(()=>maintenanceSchedule(maintenanceScenarios,0));
});
