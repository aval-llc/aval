import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { citationPointers, groundedReviewTool, hasPointer, parseSemanticVerdict, type ReviewPacket } from '../lib/agents/semantic-review.ts';
const require = createRequire(import.meta.url);
const Ajv = require('../desktop/node_modules/ajv');
const packet: ReviewPacket = {phase:'answer',goal:'Verify creation',check:{},proposal:{},completedTasks:[],sources:[
  {id:'s0',tool:'context',arguments:{},failed:false,data:{message:{body:'Slow drain'},'a/b':{'~':false}}},
  {id:'s1',tool:'receipt',arguments:{},failed:false,data:{execution:{verified:true},communication:{deliveryCount:0}}},
]};
test('citation schema binds existing source-local paths to the correct source',()=>{
  const tool = groundedReviewTool(packet);
  const validate = new Ajv().compile(tool.input_schema);
  const verdict = {passed:true,requirements:[{requirement:'Created',satisfied:true,explanation:'Verified receipt',nodeKeys:[]}],claims:[{claim:'Created',kind:'fact',supported:true,citations:[{sourceId:'s1',pointer:'/execution/verified'}]}],issues:[]};
  assert.equal(validate(verdict),true);
  for(const citation of [{sourceId:'s1',pointer:'/data/execution/verified'},{sourceId:'s0',pointer:'/execution/verified'},{sourceId:'invented',pointer:'/execution/verified'}]) {
    const invalid=structuredClone(verdict);invalid.claims[0].citations=[citation];assert.equal(validate(invalid),false);
    assert.equal(parseSemanticVerdict({id:'test',content:[{type:'tool_use',id:'v',name:'semantic_verdict',input:invalid}],usage:{input_tokens:0,output_tokens:0},stop_reason:'tool_use'},packet).exitCode,1);
  }
});
test('pointer enumeration preserves escaped keys, arrays, null fields and empty collections',()=>{
  const data={'a/b':{'~':false},list:[{id:'x'}],missing:null,empty:[]};
  assert.deepEqual(citationPointers(data),['/a~1b/~0','/list/0/id','/missing','/empty']);
  assert.ok(citationPointers(data).every(pointer=>hasPointer(data,pointer)));
  assert.deepEqual(citationPointers(null),[]);
});
