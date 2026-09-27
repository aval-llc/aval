import test from 'node:test';
import assert from 'node:assert/strict';
import {checkDocumentAnswerNumbers} from '../lib/agents/document-evidence.ts';
const id='2e3b579e-bdff-47d0-9a6f-10c95e0bdbe6';
const source={id:'s0',tool:'get_expiring_leases',arguments:{},failed:false,data:{leases:[{id,ends_on:'2026-10-17',rent_cents:100000}]}};
test('exact structured lease identifiers and dates are not mistaken for monetary claims',()=>{
  assert.equal(checkDocumentAnswerNumbers({narrative:`Lease ${id} ends 2026-10-17.`},new Set([100000]),[source]).ok,true);
  assert.equal(checkDocumentAnswerNumbers({narrative:`Lease ${id} owes $2026.`},new Set([100000]),[source]).ok,false);
  assert.equal(checkDocumentAnswerNumbers({narrative:'Lease ends 2027-11-29.'},new Set([100000]),[source]).ok,false);
});
test('failed or free-text evidence cannot whitelist reference-looking claims',()=>{
  assert.equal(checkDocumentAnswerNumbers({narrative:`Lease ${id} ends 2026-10-17.`},new Set(),[{...source,failed:true}]).ok,false);
  assert.equal(checkDocumentAnswerNumbers({narrative:'Ends 2026-10-17.'},new Set(),[{...source,data:{note:'ends_on: 2026-10-17'}}]).ok,false);
});
