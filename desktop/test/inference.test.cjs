const {EventEmitter}=require('node:events');
const test=require('node:test');const assert=require('node:assert/strict');
const {infer}=require('../inference.cjs');
const params={system:'test',messages:[],tools:[{name:'read_evidence',input_schema:{type:'object'}}]};
function rpcFixture({usage=true,tool='read_evidence',forbidden=false, repeatedUsage=false}={}) {
  const rpc=new EventEmitter();rpc.request=async(method,args)=>{
    if(method==='thread/start'){assert.equal(args.model,'gpt-6-luna');assert.equal(args.ephemeral,true);return{thread:{id:'thread'}};}
    if(method==='turn/start'){
      assert.equal(args.sandboxPolicy.networkAccess,false);
      queueMicrotask(()=>{
        const emit=(method,extra)=>rpc.emit('notification',{method,params:{threadId:'thread',...extra}});
        if(forbidden)emit('item/started',{item:{type:'commandExecution'}});
        if(usage)emit('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:123,outputTokens:45}}});
        if(repeatedUsage) for(let i=0;i<2;i++) emit('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:200,outputTokens:60},last:{inputTokens:77,outputTokens:15}}});
        emit('item/completed',{item:{type:'agentMessage',text:JSON.stringify({calls:[{name:tool,argumentsJson:'{}'}]})}});
        emit('turn/completed',{turn:{status:'completed'}});
      });return{turn:{id:'turn'}};
    }
  };return rpc;
}
test('desktop inference pins Luna, disables execution and returns measured usage',async()=>{
  const rpc=rpcFixture();const result=await infer(rpc,'/tmp','gpt-6-luna',params);
  assert.deepEqual(result.usage,{input_tokens:123,output_tokens:45});assert.equal(result.content[0].name,'read_evidence');assert.equal(rpc.listenerCount('notification'),0);
});
test('fresh-thread cumulative usage includes internal requests but never sums repeated notifications',async()=>{
  const result=await infer(rpcFixture({repeatedUsage:true}),'/tmp','gpt-6-luna',params);
  assert.deepEqual(result.usage,{input_tokens:200,output_tokens:60});
  assert.equal(result.diagnostics.usage_snapshots.length,2);
  assert.equal(result.diagnostics.hard_output_token_limit,false);
  assert.equal(result.diagnostics.actual_model_status,'not_exposed_by_protocol');
});
test('desktop inference rejects missing usage, unoffered tools and execution',async()=>{
  for(const options of [{usage:false},{tool:'send_money'},{forbidden:true}])await assert.rejects(infer(rpcFixture(options),'/tmp','gpt-6-luna',params));
});
