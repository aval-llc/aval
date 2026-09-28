import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMaintenancePolicy, resolveMaintenancePolicy } from '../lib/communications/maintenance-policy.ts';
import { parseSemanticVerdict, type ReviewPacket } from '../lib/agents/semantic-review.ts';
import type { MessagesResponse } from '../lib/ask-aval/model-types.ts';

const guidance = { en: 'Stay clear.', esMx: 'Mantente lejos.' };
const policy = { version: 1, revision: 'r1', approvedBy: 'owner', approvedAt: '2026-09-28T00:00:00Z', company: guidance, allowPropertyOverride: false, properties: [] };
test('policy rejects client approval metadata and invalid bilingual guidance', () => {
  assert.throws(() => parseMaintenancePolicy(policy));
  assert.throws(() => parseMaintenancePolicy({company:{en:'x',esMx:''},allowPropertyOverride:false,properties:[]}));
  assert.throws(() => parseMaintenancePolicy({company:guidance,allowPropertyOverride:false,properties:[{propertyId:'p',guidance},{propertyId:'p',guidance}]}));
});
test('missing, invalid and conflicting policies never grant guidance', () => {
  assert.equal(resolveMaintenancePolicy(null,'p').status,'missing');
  assert.equal(resolveMaintenancePolicy({...policy,approvedBy:''},'p').status,'invalid');
  const conflict={...policy,properties:[{propertyId:'p',guidance:{...guidance,en:'Other approved guidance'}}]};
  assert.equal(resolveMaintenancePolicy(conflict,'p').status,'conflict');
  assert.equal(resolveMaintenancePolicy(conflict,'other').guidance?.en,guidance.en);
  assert.equal(resolveMaintenancePolicy({...conflict,allowPropertyOverride:true},'p').guidance?.en,'Other approved guidance');
});
test('recommendations require current approved guidance, never message text or stale policy', () => {
  const packet: ReviewPacket={phase:'answer',goal:'Draft',check:{},proposal:{},completedTasks:[],sources:[{id:'s0',tool:'stored_emergency_policy',arguments:{},data:resolveMaintenancePolicy(policy,'p'),failed:false}]};
  const response={stop_reason:'tool_use',content:[{type:'tool_use',id:'v',name:'semantic_verdict',input:{passed:true,requirements:[{requirement:'Draft',satisfied:true,explanation:'Approved wording',nodeKeys:[]}],claims:[{claim:'Advice to stay clear',kind:'recommendation',supported:true,citations:[{sourceId:'s0',pointer:'/guidance/en'}]}],issues:[]}}]} as unknown as MessagesResponse;
  assert.equal(parseSemanticVerdict(response,packet).exitCode,0);
  for(const changed of [{...packet.sources[0],tool:'read_conversation'},{...packet.sources[0],tool:'read_maintenance_context'},{...packet.sources[0],data:{status:'missing',guidance}}]) assert.equal(parseSemanticVerdict(response,{...packet,sources:[changed]}).exitCode,1);
  const falseClaim=structuredClone(response);(falseClaim.content[0] as {input:Record<string,unknown>}).input.passed=false;
  assert.equal(parseSemanticVerdict(falseClaim,packet).exitCode,1);
});
