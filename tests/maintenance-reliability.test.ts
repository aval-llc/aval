import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatedMaintenanceReads } from '../lib/agents/maintenance-progress.ts';
import { modelBudget, maintenanceAdmission } from '../lib/agents/inference-budget.ts';
import type { Message } from '../lib/ask-aval/model-types';

test('read-loop detection is insensitive to JSON key order but preserves changed observations', () => {
  const messages: Message[] = [];
  for (let i=0;i<4;i++) {
    messages.push({role:'assistant',content:[{type:'tool_use',id:String(i),name:'read_maintenance_context',input:i%2?{message_id:'m',conversation_id:'c'}:{conversation_id:'c',message_id:'m'}}]});
    messages.push({role:'user',content:[{type:'tool_result',tool_use_id:String(i),content:JSON.stringify(i%2?{unit:'u',property:'p'}:{property:'p',unit:'u'})}]});
  }
  assert.equal(repeatedMaintenanceReads(messages),3);
  messages.push({role:'assistant',content:[{type:'tool_use',id:'new',name:'read_maintenance_context',input:{conversation_id:'c',message_id:'m'}}]});
  messages.push({role:'user',content:[{type:'tool_result',tool_use_id:'new',content:'{"property":"changed","unit":"u"}'}]});
  assert.equal(repeatedMaintenanceReads(messages),0);
});
test('subscription admission reserves observed review costs without raising task limits',()=>{
  assert.equal(maintenanceAdmission(180000,false).allowed,true);
  assert.equal(maintenanceAdmission(127999,false).allowed,false);
  assert.equal(maintenanceAdmission(64000,true).allowed,true);
  assert.equal(maintenanceAdmission(64000,true,0,80000).allowed,false);
  assert.equal(maintenanceAdmission(180000,false,130000,64000).allowed,false);
});
test('inference admission separates a review reserve from estimated input and output', () => {
  const params={remaining:26000,system:'policy',tools:[],messages:[],reviewReserve:24000};
  const result=modelBudget(params);
  assert.ok(result.estimatedInput>0);
  assert.equal(result.outputTokens,params.remaining-params.reviewReserve-result.estimatedInput);
});
