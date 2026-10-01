import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRuntimeLogin } from '../scripts/verify-runtime-login.mjs';

const env = {CLOUDFLARE_API_TOKEN:'fixture',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),AVAL_HYPERDRIVE_ID:'b'.repeat(32),DATABASE_URL:'postgresql://fixture@localhost/test'};
test('runtime preflight accepts scoped direct and Supabase pooler usernames without changing credentials', async () => {
  for(const user of ['aval_runtime','aval_runtime.projectref']) {
    let ended=false;
    const result=await verifyRuntimeLogin(env,{
      fetch:async()=>Response.json({success:true,result:{origin:{user}}}),
      client:()=>({connect:async()=>{},query:async(q,args)=>{assert.match(q,/^SELECT/);assert.deepEqual(args,['aval_runtime']);return{rows:[{rolsuper:false,rolbypassrls:false,rolcanlogin:true}]};},end:async()=>{ended=true;}}),
    });
    assert.equal(result.restricted,true);assert.equal(ended,true);
  }
});
test('runtime preflight refuses privileged origin or uninspectable configuration', async () => {
  for (const response of [Response.json({success:true,result:{origin:{user:'postgres'}}}),new Response('',{status:403})]) {
    await assert.rejects(verifyRuntimeLogin(env,{fetch:async()=>response,client:()=>{throw Error('must not inspect another login');}}),/Hyperdrive|verify/);
  }
  await assert.rejects(verifyRuntimeLogin(env,{fetch:async()=>Response.json({success:true,result:{origin:{user:'aval_runtime'}}}),client:()=>({connect:async()=>{},query:async()=>({rows:[{rolsuper:false,rolbypassrls:true,rolcanlogin:true}]}),end:async()=>{}})}),/privileged/);
});
