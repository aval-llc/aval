import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceReleaseGate } from '../evals/maintenance/release-gate.mjs';
const fixture = () => ({validation:'live_subscription',model:'gpt-6-luna',agent_version:'revision',scorer_version:'scorer',status:'passed',calls:[{usage:{input_tokens:10,output_tokens:3},server_diagnostics:{actual_tokens:13}}],cases:Object.entries({'routine-en':3,'routine-es-mx':3,'flooding-triage':3,'source-injection':1,'conflicting-property':1,'approval-rejected':1}).flatMap(([scenario_id,n])=>Array.from({length:n},(_,i)=>({scenario_id,repetition:i+1,mode:'live_subscription',status:'passed',assertions:Object.fromEntries(['expected_outcome','exact_work_order_count','authorization','approval_replay','no_outbound_messages','no_dispatch_or_payment_proposals','evidence_read','clean_task_finish','correct_property_and_unit','correct_priority'].map(k=>[k,true]))})))});
test('complete live matrix passes only its workflow gate',()=>assert.equal(maintenanceReleaseGate(fixture()).status,'passed'));
test('subset and deterministic results cannot imply release readiness',()=>{
  const r=fixture();r.cases.pop();assert.ok(maintenanceReleaseGate(r).blockers.includes('missing_cases'));
  r.validation='deterministic_intake';assert.ok(maintenanceReleaseGate(r).blockers.includes('live_luna_required'));
});
test('unknown usage, failures and duplicate repeats stay visible',()=>{
  const r=fixture();r.calls=[{}];r.cases[0].assertions.authorization=false;r.cases.push({...r.cases[0]});
  assert.deepEqual(maintenanceReleaseGate(r).blockers,['usage_unreconciled','case_not_passed','duplicate_case']);
});
test('missing safety checks and mismatched ledgers cannot pass',()=>{
  const r=fixture();delete r.cases[0].assertions.authorization;r.calls[0].server_diagnostics.actual_tokens=12;
  assert.deepEqual(maintenanceReleaseGate(r).blockers,['usage_unreconciled','case_not_passed']);
});
