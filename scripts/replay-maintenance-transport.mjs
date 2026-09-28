/** Private synthetic reports in; aggregate compatibility results out. ZERO model calls. */
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import desktop from '../desktop/inference.cjs';
const require=createRequire(import.meta.url);
const Ajv=require('../desktop/node_modules/ajv');
const report=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(report.data_class!=='synthetic'||!Array.isArray(report.calls))throw Error('Provide a synthetic maintenance report');
const results=[];
for(const call of report.calls){
  if(!call.request||!call.proposals||!call.usage)throw Error('Replay requires saved input, proposals and usage');
  const rpc=new EventEmitter();let schemaBytes=0,instructionBytes=0;
  rpc.request=async(method,args)=>{
    if(method==='thread/start'){instructionBytes=Buffer.byteLength(args.baseInstructions)+Buffer.byteLength(args.developerInstructions);return{thread:{id:'replay'}};}
    if(method==='turn/start'){
      schemaBytes=Buffer.byteLength(JSON.stringify(args.outputSchema));
      const item=args.outputSchema.properties.calls?.items;
      const value=!item?call.proposals[0].input:{calls:call.proposals.map(p=>item.anyOf?{name:p.name,input:p.input}:{name:p.name,argumentsJson:JSON.stringify(p.input)})};
      const validate=new Ajv({strict:false}).compile(args.outputSchema);
      assert.ok(validate(value),JSON.stringify(validate.errors));
      queueMicrotask(()=>{
        const emit=(method,p)=>rpc.emit('notification',{method,params:{threadId:'replay',turnId:'turn',...p}});
        emit('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:call.usage.input_tokens,outputTokens:call.usage.output_tokens}}});
        emit('item/completed',{item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(value)}});
        emit('turn/completed',{turn:{id:'turn',status:'completed'}});
      });return{turn:{id:'turn'}};
    }
    throw Error('Replay cannot perform operations');
  };
  try{
    const result=await desktop.infer(rpc,'/synthetic-replay','gpt-6-luna',call.request);
    assert.deepEqual(result.content.map(({name,input})=>({name,input})),call.proposals.map(({name,input})=>({name,input})));
    results.push({job:call.job_id,phase:call.phase,status:'compatible',schema_bytes:schemaBytes,instruction_bytes:instructionBytes,recorded_usage_snapshots:call.diagnostics?.usage_snapshots?.length??null});
  }catch(error){results.push({job:call.job_id,status:'incompatible',error:error.message});}
}
console.log(JSON.stringify({validation:'recorded_response_replay',model_calls:0,billed_tokens:0,results},null,2));
if(results.some(r=>r.status!=='compatible'))process.exitCode=1;
