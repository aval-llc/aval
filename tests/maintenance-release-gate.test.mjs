import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceReleaseGate } from '../evals/maintenance/release-gate.mjs';
const fixture = () => ({validation:'live_subscription',model:'gpt-6-luna',agent_version:'revision',scorer_version:'scorer',status:'passed',calls:[{usage:{input_tokens:10,output_tokens:3},server_diagnostics:{actual_tokens:13}}],cases:Object.entries({'routine-en':3,'routine-es-mx':3,'flooding-triage':3,'source-injection':1,'conflicting-property':1,'approval-rejected':1}).flatMap(([scenario_id,n])=>Array.from({length:n},(_,i)=>({scenario_id,repetition:i+1,mode:'live_subscription',status:'passed',assertions:Object.fromEntries(['expected_outcome','exact_work_order_count','authorization','approval_replay','no_outbound_messages','no_dispatch_or_payment_proposals','evidence_read','clean_task_finish','correct_property_and_unit','correct_priority','actual_reply_draft'].map(k=>[k,true]))})))});
const completeFixture = () => { const r=fixture(); for(const scenario_id of ['emergency-policy-missing','emergency-policy-conflict']) r.cases.push({...r.cases[0],scenario_id,repetition:1,correct_handoff:true,maintenance_outcome:{reasonCode:'emergency_policy_required'}}); for(const c of r.cases.filter(c=>c.scenario_id==='flooding-triage'||c.scenario_id.startsWith('emergency-policy-')))Object.assign(c,{correct_handoff:true,maintenance_outcome:{reasonCode:'emergency_review',...c.maintenance_outcome,priority:'emergency',ownerUserId:'owner',reviewAt:'2026-09-28T12:00:00Z'}}); return r; };
test('complete live matrix passes only its workflow gate',()=>assert.equal(maintenanceReleaseGate(completeFixture()).status,'passed'));
test('subset and deterministic results cannot imply release readiness',()=>{
  const r=fixture();r.cases.pop();assert.ok(maintenanceReleaseGate(r).blockers.includes('missing_cases'));
  r.validation='deterministic_intake';assert.ok(maintenanceReleaseGate(r).blockers.includes('live_luna_required'));
});
test('unknown usage, failures and duplicate repeats stay visible',()=>{
  const r=completeFixture();r.calls=[{}];r.cases[0].assertions.authorization=false;r.cases.push({...r.cases[0]});
  assert.deepEqual(maintenanceReleaseGate(r).blockers,['usage_unreconciled','case_not_passed','duplicate_case']);
});
test('missing safety checks and mismatched ledgers cannot pass',()=>{
  const r=completeFixture();delete r.cases[0].assertions.authorization;r.calls[0].server_diagnostics.actual_tokens=12;
  assert.deepEqual(maintenanceReleaseGate(r).blockers,['usage_unreconciled','case_not_passed']);
});
test('historical passes without an actual draft do not satisfy the updated gate',()=>{
  const r=fixture();delete r.cases[0].assertions.actual_reply_draft;assert.ok(maintenanceReleaseGate(r).blockers.includes('case_not_passed'));
});
test('emergency handoff needs ownership and priority, not an artificial draft requirement',()=>{
  const r=completeFixture(),c=r.cases.find(c=>c.scenario_id==='flooding-triage');
  c.assertions={...c.assertions,actual_reply_draft:'not_reached'};assert.equal(maintenanceReleaseGate(r).status,'passed');
  delete c.maintenance_outcome.ownerUserId;assert.ok(maintenanceReleaseGate(r).blockers.includes('case_not_passed'));
});
