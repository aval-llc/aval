/** Focused repeatable check; uses new synthetic identities, never resets data. */
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {postgresEvaluation} from './lib/postgres-evaluation.mjs';
import {runDesktopInferenceCases} from '../tests/postgres/desktop-inference-cases.mjs';
test('desktop queue and PMS demo on real PostgreSQL',async t=>{
  const context=await postgresEvaluation();
  try{await runDesktopInferenceCases(t,{session:context.session,userA:context.user,userB:`test_${randomUUID()}`,administrator:context.admin,config:context.config});}
  finally{await context.close();}
});
