const test = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync,readFileSync,rmSync,existsSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const {execFileSync} = require('node:child_process');
const {EventEmitter} = require('node:events');
const Ajv = require('ajv');
const {infer} = require('../inference.cjs');

// Generates the contract from the exact binary shipped by electron-builder.
// No authentication, model request, network or user configuration is required.
test('packaged macOS App Server accepts Aval inference and interruption protocol', {skip:process.platform!=='darwin'||process.arch!=='arm64'}, async()=>{
  const binary=resolve(__dirname,'../node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex');
  assert.ok(existsSync(binary),'Install the pinned Desktop Codex dependency');
  const temporary=mkdtempSync(join(tmpdir(),'aval-protocol-'));
  try {
    execFileSync(binary,['app-server','generate-json-schema','--out',temporary],{stdio:['ignore','pipe','pipe']});
    const ajv=new Ajv({strict:false,validateFormats:false,allowUnionTypes:true});
    const schemas=Object.fromEntries(['ThreadStartParams','TurnStartParams','TurnInterruptParams','ThreadTokenUsageUpdatedNotification'].map(name=>[name,JSON.parse(readFileSync(join(temporary,'v2',`${name}.json`),'utf8'))]));
    const validators=Object.fromEntries(Object.entries(schemas).map(([name,schema])=>[name,ajv.compile(schema)]));
    const validate=(name,value)=>assert.ok(validators[name](value),JSON.stringify(validators[name].errors));
    assert.ok(schemas.TurnStartParams.properties.outputSchema);
    assert.ok(schemas.ThreadStartParams.properties.ephemeral);
    assert.equal(schemas.TurnStartParams.properties.maxOutputTokens,undefined,'Reassess the hard-output-limit capability if the bundled protocol changes');
    const rpc=new EventEmitter();
    rpc.request=async(method,args)=>{
      if(method==='thread/start') {validate('ThreadStartParams',args);return {thread:{id:'thread'},model:'gpt-6-luna'};}
      if(method==='turn/start') {validate('TurnStartParams',args);return {turn:{id:'turn'}};}
      if(method==='turn/interrupt') {
        validate('TurnInterruptParams',args);
        const total={inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:0,reasoningOutputTokens:0};
        const usage={threadId:'thread',turnId:'turn',tokenUsage:{total,last:total}};
        validate('ThreadTokenUsageUpdatedNotification',usage);
        queueMicrotask(()=>{
          rpc.emit('notification',{method:'thread/tokenUsage/updated',params:usage});
          rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'interrupted'}}});
        });
      }
    };
    await assert.rejects(infer(rpc,temporary,'gpt-6-luna',{system:'Synthetic protocol check',messages:[],tools:[{name:'render_answer',input_schema:{type:'object'}}]}, {timeoutMs:5,interruptGraceMs:100}), error=>{
      assert.equal(error.diagnostics.terminal_observed,true);
      assert.deepEqual(error.usage,{input_tokens:100,output_tokens:20});return true;
    });
    console.log(JSON.stringify({packaged_app_server:execFileSync(binary,['--version'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(),protocol_compatible:true,live_model_validated:false,model_calls:0}));
  } finally {rmSync(temporary,{recursive:true,force:true});}
});
