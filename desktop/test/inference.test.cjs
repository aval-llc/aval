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
test('maintenance proposals use typed arguments and compact final answers use direct output',async()=>{
  const create={name:'create_maintenance_work_order',input_schema:{type:'object',properties:{summary:{type:'string'}},required:['summary']}};
  const final={name:'render_answer',input_schema:{type:'object',properties:{headline:{type:'string'},narrative:{type:'string'},confidence:{type:'string'}},required:['headline','narrative','confidence']}};
  for(const direct of [false,true]) {
    const rpc=new EventEmitter();const input=direct?{headline:'Recorded',narrative:'Draft only',confidence:'high'}:{summary:'Slow drain'};
    rpc.request=async(method,args)=>{
      if(method==='thread/start')return{thread:{id:'thread'}};
      if(method==='turn/start') {
        const validate=new (require('../node_modules/ajv'))().compile(args.outputSchema);
        const output=direct?input:{calls:[{name:create.name,input}]};assert.equal(validate(output),true);
        if(!direct)assert.equal(validate({calls:[{name:create.name,argumentsJson:'{}'}]}),false);
        queueMicrotask(()=>{
          for(const [method,p] of [['thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:100,outputTokens:20}}}],['item/completed',{item:{type:'agentMessage',text:JSON.stringify(output)}}],['turn/completed',{turn:{id:'turn',status:'completed'}}]])rpc.emit('notification',{method,params:{threadId:'thread',...p}});
        });return {turn:{id:'turn'}};
      }
    };
    const response=await infer(rpc,'/tmp','gpt-6-luna',{system:'policy',messages:[],tools:direct?[final]:[create,final]});
    assert.deepEqual(response.content[0].input,input);
    assert.equal(response.content[0].name,direct?'render_answer':create.name);
  }
});
test('timeout waits for terminal usage and never returns the interrupted proposal',async()=>{
  const rpc=new EventEmitter();
  rpc.request=async(method)=>{
    if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start')return {turn:{id:'turn'}};
    if(method==='turn/interrupt')queueMicrotask(()=>{
      rpc.emit('notification',{method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'turn',tokenUsage:{total:{inputTokens:500,outputTokens:70}}}});
      rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'interrupted'}}});
    });
  };
  await assert.rejects(infer(rpc,'/tmp','gpt-6-luna',params,{timeoutMs:5,interruptGraceMs:50}),error=>{
    assert.deepEqual(error.usage,{input_tokens:500,output_tokens:70});
    assert.equal(error.diagnostics.terminal_status,'interrupted');assert.equal(error.diagnostics.usage_status,'reported');return true;
  });
  assert.equal(rpc.listenerCount('notification'),0);
});
test('timeout without acknowledgement preserves unknown usage despite a partial snapshot',async()=>{
  const rpc=new EventEmitter();
  rpc.request=async(method)=>{
    if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start') {
      queueMicrotask(()=>rpc.emit('notification',{method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'turn',tokenUsage:{total:{inputTokens:100,outputTokens:10}}}}));
      return {turn:{id:'turn'}};
    }
  };
  await assert.rejects(infer(rpc,'/tmp','gpt-6-luna',params,{timeoutMs:5,interruptGraceMs:5}),error=>{
    assert.equal(error.usage,undefined);assert.equal(error.diagnostics.usage_status,'unknown');assert.equal(error.diagnostics.terminal_observed,false);return true;
  });
  assert.equal(rpc.listenerCount('notification'),0);
});
