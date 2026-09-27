const {EventEmitter}=require('node:events');
const test=require('node:test');const assert=require('node:assert/strict');
const {infer}=require('../inference.cjs');
const params={system:'test',messages:[],tools:[{name:'read_evidence',input_schema:{type:'object'}}]};
function rpcFixture({usage=true,tool='read_evidence',forbidden=false}={}) {
  const rpc=new EventEmitter();rpc.request=async(method,args)=>{
    if(method==='thread/start'){assert.equal(args.model,'gpt-6-luna');assert.equal(args.ephemeral,true);return{thread:{id:'thread'}};}
    if(method==='turn/start'){
      assert.equal(args.sandboxPolicy.networkAccess,false);
      queueMicrotask(()=>{
        const emit=(method,extra)=>rpc.emit('notification',{method,params:{threadId:'thread',...extra}});
        if(forbidden)emit('item/started',{item:{type:'commandExecution'}});
        if(usage)emit('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:123,outputTokens:45}}});
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
test('desktop inference rejects missing usage, unoffered tools and execution',async()=>{
  for(const options of [{usage:false},{tool:'send_money'},{forbidden:true}])await assert.rejects(infer(rpcFixture(options),'/tmp','gpt-6-luna',params));
});
